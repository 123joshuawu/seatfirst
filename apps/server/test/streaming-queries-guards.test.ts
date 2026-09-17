import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../src/streaming/queries.js";
import {
  readCancelFrozenFacts,
  readEventsAfter,
  readLatestSearchAggregate,
  readLatestSearchResultVersion,
  readSearchSession,
  readSearchStatus,
} from "../src/streaming/queries.js";

/**
 * S40.4 — the streaming read boundaries against an in-memory `Queryable`: well-formed
 * rows map exactly as before (S38's suite pins those shapes), and drifted primitives
 * now throw naming the column instead of casting silently. `search_aggregate.revision`
 * is a `bigint` column, so its realistic pg delivery — a decimal string — is asserted
 * to keep flowing through the explicit number-or-decimal-string guard.
 */

function dbWith(rows: Record<string, unknown>[]): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(() => Promise.resolve({ rows })) };
}

/** Serves each scripted response in order, repeating the last one. */
function dbScripted(
  scripts: { rows: Record<string, unknown>[] }[],
): Queryable & { query: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    query: vi.fn(() => Promise.resolve(scripts[Math.min(call++, scripts.length - 1)]!)),
  };
}

describe("readSearchSession", () => {
  it("returns the session string", async () => {
    await expect(readSearchSession(dbWith([{ session_id: "sess_1" }]), "srch_1")).resolves.toBe(
      "sess_1",
    );
  });

  it("returns null on zero rows", async () => {
    await expect(readSearchSession(dbWith([]), "srch_x")).resolves.toBeNull();
  });

  it("throws naming the column when session_id is not a string", async () => {
    await expect(readSearchSession(dbWith([{ session_id: 7 }]), "srch_1")).rejects.toThrow(
      `pg row column "session_id": expected string, received number`,
    );
  });
});

describe("readSearchStatus", () => {
  it("returns the status string", async () => {
    await expect(readSearchStatus(dbWith([{ status: "RUNNING" }]), "srch_1")).resolves.toBe(
      "RUNNING",
    );
  });

  it("returns null on zero rows", async () => {
    await expect(readSearchStatus(dbWith([]), "srch_x")).resolves.toBeNull();
  });

  it("throws naming the column when status is not a string", async () => {
    await expect(readSearchStatus(dbWith([{ status: null }]), "srch_1")).rejects.toThrow(
      `pg row column "status": expected string, received null`,
    );
  });
});

describe("readEventsAfter", () => {
  it("maps seq/type strings and passes the payload through", async () => {
    const db = dbWith([
      { seq: "3", type: "PROGRESS", payload: { step: 3 } },
      { seq: "12", type: "SEARCH_TERMINAL", payload: null },
    ]);
    await expect(readEventsAfter(db, "srch_1", 2n)).resolves.toEqual([
      { seq: "3", type: "PROGRESS", payload: { step: 3 } },
      { seq: "12", type: "SEARCH_TERMINAL", payload: null },
    ]);
  });

  it("throws naming the column when seq arrives as a number", async () => {
    const db = dbWith([{ seq: 3, type: "PROGRESS", payload: null }]);
    await expect(readEventsAfter(db, "srch_1", 2n)).rejects.toThrow(
      `pg row column "seq": expected string, received number`,
    );
  });

  it("throws naming the column when type arrives null", async () => {
    const db = dbWith([{ seq: "3", type: null, payload: null }]);
    await expect(readEventsAfter(db, "srch_1", 2n)).rejects.toThrow(
      `pg row column "type": expected string, received null`,
    );
  });
});

describe("readCancelFrozenFacts", () => {
  it("falls back to zero counts, no aggregate, and rev 0 when all reads are empty", async () => {
    const db = dbScripted([{ rows: [] }, { rows: [] }, { rows: [] }]);
    await expect(readCancelFrozenFacts(db, "srch_1")).resolves.toEqual({
      acceptedFetches: 0,
      freeSeats: 0,
      aggregate: null,
      aggRequestedRev: 0,
    });
  });

  it("maps well-formed counts and keeps a decimal-string bigint revision numeric", async () => {
    const evidence = { exact: null, hedged: null };
    const db = dbScripted([
      { rows: [{ accepted_fetches: 2, free_seats: 30 }] },
      { rows: [{ revision: "7", payload: { groups: [] }, evidence }] },
      { rows: [{ agg_requested_rev: 9 }] },
    ]);
    await expect(readCancelFrozenFacts(db, "srch_1")).resolves.toEqual({
      acceptedFetches: 2,
      freeSeats: 30,
      aggregate: { revision: 7, payload: { groups: [] }, evidence },
      aggRequestedRev: 9,
    });
  });

  it("throws naming the column when a count arrives as a string", async () => {
    const db = dbScripted([{ rows: [{ accepted_fetches: "2", free_seats: 30 }] }, { rows: [] }]);
    await expect(readCancelFrozenFacts(db, "srch_1")).rejects.toThrow(
      `pg row column "accepted_fetches": expected number, received string`,
    );
  });

  it("throws naming the column when revision is neither number nor decimal string", async () => {
    const db = dbScripted([
      { rows: [{ accepted_fetches: 0, free_seats: 0 }] },
      { rows: [{ revision: true, payload: null }] },
    ]);
    await expect(readCancelFrozenFacts(db, "srch_1")).rejects.toThrow(
      `pg row column "revision": expected a number or decimal string, received true`,
    );
  });
});

describe("readLatestSearchAggregate", () => {
  it("returns null when no aggregate row exists", async () => {
    await expect(readLatestSearchAggregate(dbWith([]), "srch_1")).resolves.toBeNull();
  });

  it("keeps the realistic decimal-string bigint revision numeric", async () => {
    const db = dbWith([{ revision: "12", payload: { status: "RUNNING" } }]);
    await expect(readLatestSearchAggregate(db, "srch_1")).resolves.toEqual({
      revision: 12,
      payload: { status: "RUNNING" },
    });
  });

  it("throws naming the column on a non-numeric revision", async () => {
    const db = dbWith([{ revision: null, payload: null }]);
    await expect(readLatestSearchAggregate(db, "srch_1")).rejects.toThrow(
      `pg row column "revision": expected a number or decimal string, received null`,
    );
  });
});

describe("readLatestSearchResultVersion", () => {
  it("returns null when no version row exists", async () => {
    await expect(readLatestSearchResultVersion(dbWith([]), "srch_1")).resolves.toBeNull();
  });

  it("maps an integer version and the payload", async () => {
    const db = dbWith([{ version: 4, payload: { status: "COMPLETE" } }]);
    await expect(readLatestSearchResultVersion(db, "srch_1")).resolves.toEqual({
      version: 4,
      payload: { status: "COMPLETE" },
    });
  });

  it("throws naming the column when version arrives as a string", async () => {
    const db = dbWith([{ version: "4", payload: null }]);
    await expect(readLatestSearchResultVersion(db, "srch_1")).rejects.toThrow(
      `pg row column "version": expected number, received string`,
    );
  });
});
