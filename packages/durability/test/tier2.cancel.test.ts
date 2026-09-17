import { describe, expect, it } from "vitest";

import { cancelSearch } from "../src/transactions.js";
import type { RankedAnswer } from "../src/lifecycle.js";

import {
  createSearch,
  dispatchRun,
  expireSearchDeadline,
  PROVIDER,
  scheduleKey,
  seedProvider,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import type { Db } from "./support/pg.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the `searches.cancel` transaction (S23.3) and its ADR 0018 CANCELLED contract.
 *
 * The cancel path reuses the existing B8 statements (cancel jobs → expire subs → release
 * admission → clear slots → mark reservation released → cancel orphaned runs → terminal
 * event) behind a new fenced transition to CANCELLED. The `resultPayload` is supplied by
 * the caller (the route composes it from frozen pre-cancel facts, S23.3 step (3)); here it
 * is a revealable EMPTY:HALTED answer (valid for CANCELLED per assertAnswerRevealable),
 * derived independently as `deriveRankedAnswer`'s zero-evidence result.
 *
 * Every test ends with the full invariant sweep in `useDatabase()` — the widened
 * `terminal_has_result_version`/`terminal_has_no_live_children` include CANCELLED rows.
 */

const EMPTY_HALTED: RankedAnswer = { mode: "EMPTY", cause: "HALTED", suggestions: [] };

const cancelledPayload = (): { status: "CANCELLED"; cause: null; answer: RankedAnswer } => ({
  status: "CANCELLED",
  cause: null,
  answer: EMPTY_HALTED,
});

describe("tier 2 — searches.cancel (S23.3)", () => {
  const db = useDatabase();

  it("cancel with live work cancels jobs/runs, expires subscriptions, and releases admission", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1, { reserve: 10 });
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key); // SCHEDULE_RESOLUTION sub: admission_counted, unresolved_schedules=1
    const run = await dispatchRun(db(), key); // live LEASED provider_run on the key

    const before = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
      `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
      [PROVIDER],
    );
    expect(before.pending_cost).toBe("10");
    expect(before.unresolved_schedules).toBe(1);

    const state = await cancelSearch(db(), search.searchId, {
      resultPayload: cancelledPayload,
    });
    expect(state).toEqual({ status: "CANCELLED", cause: null });

    const row = await db().one<{ status: string; terminalized_at: Date | null }>(
      `SELECT status, terminalized_at FROM search WHERE search_id = $1`,
      [search.searchId],
    );
    expect(row.status).toBe("CANCELLED");
    expect(row.terminalized_at).not.toBeNull();

    // Every subscription is non-LIVE; every job is CANCELLED.
    const liveSubs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_subscription WHERE search_id = $1 AND state = 'LIVE'`,
      [search.searchId],
    );
    expect(liveSubs.n).toBe("0");
    const liveJobs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM search_job WHERE search_id = $1 AND state IN ('PENDING','LEASED')`,
      [search.searchId],
    );
    expect(liveJobs.n).toBe("0");

    // Admission fully released: reservation marked released, ceilings back to baseline.
    // S36: released reservations must not hold a slot (search_window_accounting held_on_released).
    const res = await db().one<{
      released: boolean;
      reserved_remaining: string;
      schedule_slot_held: boolean;
    }>(
      `SELECT released, reserved_remaining, schedule_slot_held FROM admission_reservation WHERE search_id = $1`,
      [search.searchId],
    );
    expect(res.released).toBe(true);
    expect(res.reserved_remaining).toBe("0");
    expect(res.schedule_slot_held).toBe(false);
    const after = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
      `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
      [PROVIDER],
    );
    expect(after.pending_cost).toBe("0");
    expect(after.unresolved_schedules).toBe(0);
    // The shared run is cancelled with its generation bumped (the heartbeat fence).
    const runRow = await db().one<{ state: string; generation: number }>(
      `SELECT state, generation FROM provider_run WHERE run_id = $1`,
      [run.runId],
    );
    expect(runRow.state).toBe("CANCELLED");
    expect(runRow.generation).toBe(run.generation + 1);

    // Exactly one result version and one SEARCH_TERMINAL event carrying the frozen answer.
    const versions = await db().rows<{ payload: { status: string; answer: RankedAnswer } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1`,
      [search.searchId],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.payload).toEqual({
      status: "CANCELLED",
      cause: null,
      answer: EMPTY_HALTED,
    });
    const events = await db().rows<{
      type: string;
      payload: { status: string; cause: null; answer: RankedAnswer };
    }>(`SELECT type, payload FROM search_event WHERE search_id = $1 AND type = 'SEARCH_TERMINAL'`, [
      search.searchId,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      status: "CANCELLED",
      cause: null,
      answer: EMPTY_HALTED,
    });
  });

  it("cancel of an already-terminal search is a zero-row no-op returning null", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1);
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key);
    // Make the search genuinely terminal first: expire its deadline, then terminalize.
    // The unresolved schedule subscription + unfinished job derive PARTIAL (ADR 0003 T29).
    await expireSearchDeadline(db(), search.searchId);
    const state = await terminalize(db(), search.searchId);
    expect(state).toEqual({ status: "PARTIAL", cause: null });

    const countsBefore = await rowCounts(db(), search.searchId);
    const again = await cancelSearch(db(), search.searchId, {
      resultPayload: cancelledPayload,
    });
    expect(again).toBeNull(); // fence: not PENDING_SCHEDULE/RUNNING → no-op

    const countsAfter = await rowCounts(db(), search.searchId);
    expect(countsAfter).toEqual(countsBefore);
  });

  it("per-run_key isolation: cancelling one search does not cancel a run another search still subscribes to", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    // Cold searches: each reserves its own schedule slot (coldDelta 1), so the counted
    // admission slot matches what B1_STAGE1_ADMISSION added — no unresolved_schedules drift.
    const a = await createSearch(db(), 1);
    const b = await createSearch(db(), 1);
    await subscribe(db(), a, key);
    await subscribe(db(), b, key);
    const run = await dispatchRun(db(), key); // shared run

    await cancelSearch(db(), a.searchId, { resultPayload: cancelledPayload });

    const aSub = await db().rows<{ state: string }>(
      `SELECT state FROM run_subscription WHERE search_id = $1`,
      [a.searchId],
    );
    expect(aSub).toEqual([{ state: "EXPIRED" }]);
    const bSub = await db().one<{ state: string }>(
      `SELECT state FROM run_subscription WHERE search_id = $1`,
      [b.searchId],
    );
    expect(bSub.state).toBe("LIVE"); // still subscribed → the shared run survives
    const runRow = await db().one<{ state: string }>(
      `SELECT state FROM provider_run WHERE run_id = $1`,
      [run.runId],
    );
    expect(runRow.state).not.toBe("CANCELLED");
  });

  it("a second cancel is a zero-row no-op — no double release", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1, { reserve: 10 });
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key);
    await dispatchRun(db(), key);

    const first = await cancelSearch(db(), search.searchId, {
      resultPayload: cancelledPayload,
    });
    expect(first?.status).toBe("CANCELLED");

    const second = await cancelSearch(db(), search.searchId, {
      resultPayload: cancelledPayload,
    });
    expect(second).toBeNull(); // fence: status is now CANCELLED

    const res = await db().one<{ released: boolean; reserved_remaining: string }>(
      `SELECT released, reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [search.searchId],
    );
    expect(res.released).toBe(true);
    expect(res.reserved_remaining).toBe("0");
    const cap = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
      `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
      [PROVIDER],
    );
    expect(cap.pending_cost).toBe("0"); // released once, never twice
    expect(cap.unresolved_schedules).toBe(0);
  });

  it("no retroactive erasure: already-revealed search_event rows are unchanged by cancel", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1);
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key);
    // A progress event already revealed — allocate its seq and bump next_seq so the
    // terminal event lands at the next free seq (event_seq_gapless).
    await db().query(`UPDATE search SET next_seq = next_seq + 1 WHERE search_id = $1`, [
      search.searchId,
    ]);
    await db().query(
      `INSERT INTO search_event (search_id, seq, type, payload)
       VALUES ($1, 1, 'SEARCH_STARTED', '{"n":1}'::jsonb)`,
      [search.searchId],
    );

    const before = await db().rows<{ seq: number; type: string; payload: unknown }>(
      `SELECT seq, type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [search.searchId],
    );

    await cancelSearch(db(), search.searchId, { resultPayload: cancelledPayload });

    const after = await db().rows<{ seq: number; type: string; payload: unknown }>(
      `SELECT seq, type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [search.searchId],
    );
    // Only the SEARCH_TERMINAL row is appended; the already-revealed row is byte-identical.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  it("CANCELLED reveal gate: a HEDGED answer is accepted, a CONFIDENT answer is rejected and rolls back", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1);
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key);

    const hedged = await cancelSearch(db(), search.searchId, {
      resultPayload: () => ({
        status: "CANCELLED",
        cause: null,
        answer: {
          mode: "HEDGED",
          alternatives: [
            {
              placement: {
                layoutId: "L",
                theatreId: "T",
                row: 1,
                startCol: 1,
                rowSpan: 1,
                count: 1,
                seatNames: ["A"],
                placementKey: "k1",
              },
              reasons: [{ kind: "TOGETHER", count: 1 }],
              relaxed: [{ kind: "OUTSIDE_REGION", region: "x" }],
              showtimes: [
                {
                  showtimeId: "sh_1",
                  showDateTimeUtc: "2026-08-02T00:00:00.000Z",
                  deepLinkUrl: "https://example.invalid/x",
                  status: "OPEN",
                  minPrice: null,
                },
              ],
              runScore: 1,
              showtimeCount: 1,
            },
            {
              placement: {
                layoutId: "L",
                theatreId: "T",
                row: 2,
                startCol: 1,
                rowSpan: 1,
                count: 1,
                seatNames: ["B"],
                placementKey: "k2",
              },
              reasons: [{ kind: "TOGETHER", count: 1 }],
              relaxed: [{ kind: "OUTSIDE_REGION", region: "x" }],
              showtimes: [
                {
                  showtimeId: "sh_1",
                  showDateTimeUtc: "2026-08-02T00:00:00.000Z",
                  deepLinkUrl: "https://example.invalid/x",
                  status: "OPEN",
                  minPrice: null,
                },
              ],
              runScore: 1,
              showtimeCount: 1,
            },
          ],
          otherFormats: [],
        },
      }),
    });
    expect(hedged?.status).toBe("CANCELLED");

    const again = await createSearch(db(), 1);
    const key2 = await scheduleKey(db(), "theatre_2", "2026-08-03");
    await subscribe(db(), again, key2);
    await expect(
      cancelSearch(db(), again.searchId, {
        resultPayload: () => ({
          status: "CANCELLED",
          cause: null,
          answer: {
            mode: "CONFIDENT",
            primary: {
              placement: {
                layoutId: "L",
                theatreId: "T",
                row: 1,
                startCol: 1,
                rowSpan: 1,
                count: 1,
                seatNames: ["A"],
                placementKey: "k1",
              },
              reasons: [{ kind: "TOGETHER", count: 1 }],
              relaxed: [],
              showtimes: [
                {
                  showtimeId: "sh_1",
                  showDateTimeUtc: "2026-08-02T00:00:00.000Z",
                  deepLinkUrl: "https://example.invalid/x",
                  status: "OPEN",
                  minPrice: null,
                },
              ],
              runScore: 1,
              showtimeCount: 1,
            },
            otherFormats: [],
          },
        }),
      }),
    ).rejects.toThrow(/CANCELLED/);
    const still = await db().one<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [again.searchId],
    );
    expect(still.status).toBe("PENDING_SCHEDULE"); // rolled back — no status change
  });

  it("cancelled before any partial state persists exactly one result version with EMPTY:HALTED (ADR 0018 edge, matrix A9)", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1);
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    await subscribe(db(), search, key);
    // No accepted fetches, no search_aggregate row — zero prior partial state.

    const state = await cancelSearch(db(), search.searchId, {
      resultPayload: cancelledPayload,
    });
    expect(state?.status).toBe("CANCELLED");

    const versions = await db().rows<{ payload: { answer: RankedAnswer } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1`,
      [search.searchId],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.payload.answer).toEqual(EMPTY_HALTED); // never null, never an error
  });
});

/** Counts of rows across the tables cancel may touch, for the zero-change no-op assertion. */
async function rowCounts(db: Db, searchId: string): Promise<Record<string, string>> {
  const tables = [
    ["search", `SELECT count(*) AS n FROM search WHERE search_id = $1`],
    ["search_job", `SELECT count(*) AS n FROM search_job WHERE search_id = $1`],
    ["run_subscription", `SELECT count(*) AS n FROM run_subscription WHERE search_id = $1`],
    ["search_event", `SELECT count(*) AS n FROM search_event WHERE search_id = $1`],
    [
      "search_result_version",
      `SELECT count(*) AS n FROM search_result_version WHERE search_id = $1`,
    ],
  ] as const;
  const out: Record<string, string> = {};
  for (const [name, sql] of tables) {
    out[name] = (await db.one<{ n: string }>(sql, [searchId])).n;
  }
  return out;
}
