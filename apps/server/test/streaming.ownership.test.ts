import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { assertCallerOwnsSearch } from "../src/streaming/ownership.js";
import type { Queryable } from "../src/streaming/queries.js";

/**
 * S38.2 — the mandatory fail-closed ownership check's truth table. A missing search row
 * is UNAUTHORIZED (not NOT_FOUND): do not leak which search ids exist to a caller who
 * cannot own them.
 */

function dbReturning(
  rows: Record<string, unknown>[],
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(() => Promise.resolve({ rows })),
  };
}

async function errorCode(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(TRPCError);
    return (cause as TRPCError).code;
  }
  throw new Error("expected assertCallerOwnsSearch to throw");
}

describe("assertCallerOwnsSearch", () => {
  it("resolves when the search row's session exactly matches the caller's session", async () => {
    const db = dbReturning([{ session_id: "sess_owner" }]);
    await expect(assertCallerOwnsSearch(db, "search_1", "sess_owner")).resolves.toBeUndefined();
    expect(db.query.mock.calls).toHaveLength(1);
    expect(db.query.mock.calls).toEqual([
      ["SELECT session_id FROM search WHERE search_id = $1", ["search_1"]],
    ]);
  });

  it("throws UNAUTHORIZED — not NOT_FOUND — when the search row is missing", async () => {
    const db = dbReturning([]);
    await expect(
      errorCode(() => assertCallerOwnsSearch(db, "search_missing", "sess_a")),
    ).resolves.toBe("UNAUTHORIZED");
  });

  it("throws UNAUTHORIZED when the row's session mismatches the caller's session", async () => {
    const db = dbReturning([{ session_id: "sess_other" }]);
    await expect(errorCode(() => assertCallerOwnsSearch(db, "search_2", "sess_a"))).resolves.toBe(
      "UNAUTHORIZED",
    );
  });

  it("throws UNAUTHORIZED when the caller presented no session at all", async () => {
    const db = dbReturning([{ session_id: "sess_owner" }]);
    await expect(errorCode(() => assertCallerOwnsSearch(db, "search_3", undefined))).resolves.toBe(
      "UNAUTHORIZED",
    );
  });
});
