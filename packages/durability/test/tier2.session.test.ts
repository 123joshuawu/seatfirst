import { describe, expect, expectTypeOf, it } from "vitest";

import { checkInvariants } from "../src/invariants.js";
import { countOpenSearches, createSearch, upsertSession } from "../src/repository.js";
import type { SessionRow, UpsertSessionInput } from "../src/repository.js";
import type { SqlClient } from "../src/transactions.js";

import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — S16.2/S16.3's session repository functions (S16 verification items 2–3),
 * over a per-test database whose afterEach runs the full ADR 0001 invariant sweep. The
 * sweep passing with `session` rows and open searches present IS the proof that the
 * standalone `session` table needs no new invariant (S16.2's reasoning; the spec's
 * explicit "show the sweep still passes with session rows present" check).
 */

describe("tier 2 — session repository (S16.2/S16.3)", () => {
  const db = useDatabase();

  it("upsertSession inserts and returns created_at ≈ last_seen_at (item 2, first half)", async () => {
    const row = await upsertSession(db(), { sessionId: "sess_u1" });
    expect(row).toEqual({
      sessionId: "sess_u1",
      createdAt: expect.any(Date),
      lastSeenAt: expect.any(Date),
    });
    expect(row.lastSeenAt.getTime()).toBe(row.createdAt.getTime());
  });

  it("upsertSession is idempotent: same id → identical created_at, advanced last_seen_at, exactly one row (item 2)", async () => {
    const first = await upsertSession(db(), { sessionId: "sess_u2" });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await upsertSession(db(), { sessionId: "sess_u2" });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());

    const count = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE session_id = 'sess_u2'`,
    );
    expect(count.n).toBe("1");
  });

  it("countOpenSearches counts only PENDING_SCHEDULE and RUNNING rows of the session (item 3)", async () => {
    const seed = async (sessionId: string, statuses: readonly string[]) => {
      let i = 0;
      for (const status of statuses) {
        i += 1;
        const searchId = `srch_${sessionId}_${i}`;
        await createSearch(db(), {
          searchId,
          sessionId,
          idempotencyKey: `idem_${searchId}`,
          spec: { v: 1 },
          specHash: `hash_${searchId}`,
          deadlineAt: new Date(Date.now() + 60_000),
        });
        if (status !== "PENDING_SCHEDULE") {
          await db().query(`UPDATE search SET status = $1 WHERE search_id = $2`, [
            status,
            searchId,
          ]);
          if (status === "COMPLETE") {
            // A terminal row must carry its result version (ADR 0001 invariant
            // `terminal_has_result_version`) — the seed data is kept sweep-clean.
            await db().query(
              `INSERT INTO search_result_version (search_id, version, payload)
               VALUES ($1, 1, '{}'::jsonb)`,
              [searchId],
            );
          }
        }
      }
    };

    // 0 open: no rows at all.
    expect(await countOpenSearches(db(), "sess_empty")).toBe(0);

    // 3 open: 2 PENDING_SCHEDULE + 1 RUNNING, plus a terminal row that must not count.
    await seed("sess_three", ["PENDING_SCHEDULE", "PENDING_SCHEDULE", "RUNNING", "COMPLETE"]);
    expect(await countOpenSearches(db(), "sess_three")).toBe(3);

    // 4 open: 3 RUNNING + 1 PENDING_SCHEDULE, plus a terminal row that must not count.
    await seed("sess_four", ["RUNNING", "RUNNING", "PENDING_SCHEDULE", "RUNNING", "COMPLETE"]);
    expect(await countOpenSearches(db(), "sess_four")).toBe(4);

    // Another session's open rows never leak into this session's count.
    expect(await countOpenSearches(db(), "sess_empty")).toBe(0);
  });

  // S39.2/S39.3 — the zero-row/mistyped-field negative cases for the two hand-written
  // session reads. A missing row must throw a named error (never a bare TypeError from
  // destructuring `undefined`), and the aggregate must be checked to actually be a
  // number. Per CONTRIBUTING §3, each case fails if its guard is deleted: without
  // `firstRow`/`requireFields` the cast succeeds and `row.session_id` is undefined.
  const emptyClient: SqlClient = {
    query: () => Promise.resolve({ rows: [] }),
  };

  it("upsertSession throws a named error when the INSERT returns zero rows (S39.2)", async () => {
    await expect(upsertSession(emptyClient, { sessionId: "sess_zero_row" })).rejects.toThrow(
      /upsertSession returned 0 rows/,
    );
  });

  it("countOpenSearches throws a named error on a missing or non-numeric aggregate row (S39.3)", async () => {
    await expect(countOpenSearches(emptyClient, "sess_zero_row")).rejects.toThrow(
      /countOpenSearches returned 0 rows/,
    );
    // `n` arriving as anything but a number (e.g. a driver change dropping ::integer)
    // must fail the field check, not flow into the caller's limit comparison.
    const stringNClient: SqlClient = {
      query: () => Promise.resolve({ rows: [{ n: "3" }] }),
    };
    await expect(countOpenSearches(stringNClient, "sess_string_n")).rejects.toThrow(
      /countOpenSearches expected field `n` to be number/,
    );
  });

  it("the invariant sweep passes with session rows and open searches present (no new invariant needed)", async () => {
    // Populate exactly the row sets S16 introduces: standalone session rows plus open
    // searches the gauge counts. Then run the sweep explicitly — the afterEach would
    // fail this test anyway if it broke.
    await upsertSession(db(), { sessionId: "sess_inv_1" });
    await upsertSession(db(), { sessionId: "sess_inv_2" });
    for (let i = 1; i <= 3; i++) {
      const searchId = `srch_inv_${i}`;
      await createSearch(db(), {
        searchId,
        sessionId: "sess_inv_1",
        idempotencyKey: `idem_${searchId}`,
        spec: { v: 1 },
        specHash: `hash_${searchId}`,
        deadlineAt: new Date(Date.now() + 60_000),
      });
    }

    const violations = await checkInvariants(db());
    expect(violations).toEqual([]);
  });

  it("exports the typed row/input shapes", () => {
    expectTypeOf(upsertSession).returns.resolves.toEqualTypeOf<SessionRow>();
    expectTypeOf<{ sessionId: string }>().toExtend<UpsertSessionInput>();
    expectTypeOf(countOpenSearches).returns.resolves.toEqualTypeOf<number>();
  });
});
