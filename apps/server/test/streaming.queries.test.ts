import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../src/streaming/queries.js";
import {
  isTerminalStatus,
  readEventsAfter,
  readSearchSession,
  TERMINAL_SEARCH_STATUSES,
} from "../src/streaming/queries.js";

/**
 * S38.3 — the read-only durability-schema queries against an in-memory `Queryable`.
 * No live Postgres: the SQL's shape and parameter binding are what the stub observes.
 */

function dbWith(rows: Record<string, unknown>[]): Queryable & {
  query: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(() => Promise.resolve({ rows })),
  };
}

describe("readSearchSession", () => {
  it("returns the first row's session value", async () => {
    const db = dbWith([{ session_id: "sess_first" }, { session_id: "sess_second" }]);
    await expect(readSearchSession(db, "search_1")).resolves.toBe("sess_first");
    expect(db.query.mock.calls).toEqual([
      ["SELECT session_id FROM search WHERE search_id = $1", ["search_1"]],
    ]);
  });

  it("returns null on zero rows", async () => {
    const db = dbWith([]);
    await expect(readSearchSession(db, "search_missing")).resolves.toBeNull();
  });
});

describe("isTerminalStatus / TERMINAL_SEARCH_STATUSES", () => {
  it("accepts exactly the constant's four values", () => {
    // Fails if the constant gains a fifth member without this suite being updated.
    expect([...TERMINAL_SEARCH_STATUSES]).toEqual(["COMPLETE", "PARTIAL", "HALTED", "CANCELLED"]);
    for (const status of TERMINAL_SEARCH_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
    }
  });

  it("rejects everything else sampled", () => {
    for (const status of ["RUNNING", "PENDING", "QUEUED", "complete", "", "TERMINATED"]) {
      expect(isTerminalStatus(status)).toBe(false);
    }
  });

  it("rejects null", () => {
    expect(isTerminalStatus(null)).toBe(false);
  });
});

describe("readEventsAfter", () => {
  it("binds the afterSeq bound as a string and maps rows preserving ascending seq order", async () => {
    const rows = [
      { seq: "3", type: "PROGRESS", payload: { step: 3 } },
      { seq: "4", type: "PROGRESS", payload: { step: 4 } },
      { seq: "12", type: "COMPLETE", payload: null },
    ];
    const db = dbWith(rows);

    await expect(readEventsAfter(db, "search_1", 2n)).resolves.toEqual([
      { seq: "3", type: "PROGRESS", payload: { step: 3 } },
      { seq: "4", type: "PROGRESS", payload: { step: 4 } },
      { seq: "12", type: "COMPLETE", payload: null },
    ]);

    expect(db.query.mock.calls).toHaveLength(1);
    const [text, values] = db.query.mock.calls[0] as [string, readonly unknown[]];
    expect(text).toContain("FROM search_event");
    expect(text).toContain("seq > $2");
    expect(text).toContain("ORDER BY seq");
    expect(values).toEqual(["search_1", "2"]);
  });
});
