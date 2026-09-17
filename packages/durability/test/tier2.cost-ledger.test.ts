import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { checkInvariants } from "../src/invariants.js";
import { acceptSearchCreation, AdmissionRejectedError } from "../src/transactions.js";

import { expireRunLease } from "./support/clock.js";
import {
  acceptSchedule,
  createSearch,
  dispatchRun,
  fetchKey,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  scheduleKey,
  seedProvider,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — ADR 0005 §I's cost ledger (S17): the four durable, idempotent event writes that
 * compose gate 19's three counters (`docs/gates.md:24`), each committed atomically with the
 * state change it records and keyed on `(run_id, attempt)` where the counter is per-attempt.
 *
 * Expectations are derived independently from ADR 0005 §I's accounting model and
 * hand-computed counts (never by re-running the implementation's own logic):
 * `docs/adr/0005-security-privacy-operations.md:685-933`. Every negative assertion is
 * paired with a positive control (the same statement succeeding once its blocking condition
 * is removed), and every `useDatabase` test ends with the invariant sweep, which now
 * includes the three S17.7 ledger invariants.
 */

type EventRow = {
  event_id: string;
  event_type: string;
  run_id: string | null;
  attempt: number | null;
  search_id: string | null;
  run_key_id: string | null;
  units: string;
};
async function events(db: ReturnType<typeof useDatabase>): Promise<EventRow[]> {
  return db().rows<EventRow>(
    `SELECT event_id, event_type, run_id, attempt, search_id, run_key_id, units::text AS units
     FROM cost_event ORDER BY event_type, attempt NULLS FIRST, search_id, run_key_id`,
  );
}

const warm = (searchId: string, showtimes: string[]) => ({
  searchId,
  sessionId: id("sess"),
  idempotencyKey: id("idem"),
  spec: { v: 1 },
  specHash: id("hash"),
  deadlineAt: new Date(Date.now() + 10 * 60_000),
  providerId: PROVIDER,
  reserve: showtimes.length,
  scheduleKeys: [] as const,
  freshMatchCount: showtimes.length,
  showtimes: showtimes.map((showtimeId) => ({ showtimeId })),
  traceparent: null,
});

describe("tier 2 — cost ledger (S17, ADR 0005 §I)", () => {
  const db = useDatabase();

  describe("ADMISSION_RESERVATION — B1 stage 1 (S17.1)", () => {
    it("scenario 1: cold create records one event of units = reserve (200); none reconciled", async () => {
      await seedProvider(db());
      const result = await acceptSearchCreation(db(), {
        searchId: id("srch_cold_evt"),
        sessionId: id("sess"),
        idempotencyKey: id("idem"),
        spec: { v: 1 },
        specHash: "hash_cold_evt",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 200,
        scheduleKeys: [{ theatreId: "theatre_ledger_cold", localDate: "2026-08-20" }],
        freshMatchCount: 0,
        showtimes: [],
        traceparent: null,
      });
      expect(result.kind).toBe("created");

      // Hand-computed from ADR 0005 §I: the cold stage-1 event carries the validator
      // maximum (200) and the search has no schedule keys reconciled yet.
      expect(await events(db)).toEqual([
        expect.objectContaining({
          event_type: "ADMISSION_RESERVATION",
          search_id: result.searchId,
          units: "200",
          run_id: null,
          attempt: null,
          run_key_id: null,
        }),
      ]);
      // Conservation (S17.7a) is proven by the afterEach sweep: reserved_total (200)
      // equals the reservation event (200) plus zero reconciled deltas.
    });

    it("scenario 2: warm create records units = reserve (3) — the warm stage-1 event is final", async () => {
      await seedProvider(db());
      const result = await acceptSearchCreation(
        db(),
        warm(id("srch_warm_evt"), ["st_warm_a", "st_warm_b", "st_warm_c"]),
      );
      expect(result.status).toBe("RUNNING");

      expect(await events(db)).toEqual([
        expect.objectContaining({
          event_type: "ADMISSION_RESERVATION",
          search_id: result.searchId,
          units: "3",
        }),
      ]);
    });

    it("scenario 3: an identical replay short-circuits before admission — zero new events", async () => {
      await seedProvider(db());
      const input = warm(id("srch_replay"), ["st_replay"]);
      const first = await acceptSearchCreation(db(), input);
      expect(first.kind).toBe("created");

      const before = await events(db);
      const second = await acceptSearchCreation(db(), input);
      expect(second.kind).toBe("replay");
      expect(await events(db)).toEqual(before);
    });

    it("scenario 4: an admission rejection rolls back — no ADMISSION_RESERVATION row survives", async () => {
      await seedProvider(db(), { pendingCostLimit: 200 });
      // Positive control: the ceiling-filling search admits and its event exists.
      await createSearch(db(), 0, { reserve: 200 });
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'ADMISSION_RESERVATION'`,
          )
        ).n,
      ).toBe("1");

      const rejectedId = id("srch_rejected");
      await expect(
        acceptSearchCreation(db(), warm(rejectedId, ["st_rejected"])),
      ).rejects.toBeInstanceOf(AdmissionRejectedError);

      // The gate failed inside the extended statement AND the transaction rolled back:
      // no event, and no search row either.
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE search_id = $1`,
            [rejectedId],
          )
        ).n,
      ).toBe("0");
      expect(
        (
          await db().one<{ n: string }>(`SELECT count(*) AS n FROM search WHERE search_id = $1`, [
            rejectedId,
          ])
        ).n,
      ).toBe("0");
    });
  });

  describe("PROVIDER_WORK + dispatch-time ABUSE_WEIGHTED — B4 (S17.2)", () => {
    it("scenario 5: dispatch with 3 LIVE subscribers writes 1 PROVIDER_WORK and 3 ABUSE_WEIGHTED rows, with the epoch refresh", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_b4_ledger");
      const subscribers = [];
      for (let i = 0; i < 3; i++) {
        const s = await createSearch(db(), 0, { reserve: 1 });
        await subscribe(db(), s, key);
        subscribers.push(s);
      }

      const runId = id("run_b4_ledger");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);
      // The actor's unchanged call contract: the first row still carries provider_epoch.
      const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
        runId,
        leased.generation,
      ]);
      expect(dispatched.provider_epoch).toBe("0");

      // Hand-computed: B2 bumped attempt to 1; B4 records one PROVIDER_WORK (units 1) and
      // one ABUSE_WEIGHTED per subscriber LIVE at that instant (3), all units 1.
      const rows = await events(db);
      const work = rows.filter((r) => r.event_type === "PROVIDER_WORK");
      expect(work).toEqual([
        expect.objectContaining({ run_id: runId, attempt: 1, search_id: null, units: "1" }),
      ]);
      const abuse = rows.filter((r) => r.event_type === "ABUSE_WEIGHTED");
      expect(abuse).toHaveLength(3);
      expect(new Set(abuse.map((r) => r.search_id))).toEqual(
        new Set(subscribers.map((s) => s.searchId)),
      );
      for (const row of abuse) {
        expect(row).toMatchObject({ run_id: runId, attempt: 1, units: "1" });
      }
      // each subscriber's own create recorded its reservation event too
      expect(rows.filter((r) => r.event_type === "ADMISSION_RESERVATION")).toHaveLength(3);
    });

    it("scenario 6: B4 denial writes zero events; the reopened scope dispatches and writes them (positive control)", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_b4_denied");
      const runId = id("run_b4_denied");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);

      await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
      await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "HALTED", "BLOCKED", null]);

      const denied = await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation]);
      expect(denied.rows).toHaveLength(0);
      expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM cost_event`)).n).toBe("0");

      // Reopen: the same fenced call succeeds and the ledger events land with it.
      await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
      await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "OPEN", null, null]);
      const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
        runId,
        leased.generation,
      ]);
      expect(dispatched.provider_epoch).toBe("2");
      expect(await events(db)).toEqual([
        expect.objectContaining({ event_type: "PROVIDER_WORK", run_id: runId, attempt: 1 }),
      ]);
    });

    it("scenario 9: a crash-and-retry re-lease in place bumps attempt — a second PROVIDER_WORK and one ABUSE_WEIGHTED per attempt", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_crash_retry");
      const search = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), search, key);

      const runId = id("run_crash");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const first = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);
      await mustWin(db(), B.B4_PREDISPATCH, [runId, first.generation]); // attempt 1

      // The crashed worker's lease expires; the sweeper reclaims the SAME run_id in place
      // (generation+1, attempt unchanged) and it is re-leased and re-dispatched.
      await expireRunLease(db(), runId);
      await mustWin(db(), B.SWEEP_RECLAIM_RUNS, [5]);
      const second = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);
      await mustWin(db(), B.B4_PREDISPATCH, [runId, second.generation]); // attempt 2

      // Hand-computed from ADR 0005 §I: keyed on (run_id, attempt), never run_id alone —
      // each real dispatch is its own fact, and the LIVE subscriber holds one charge per
      // attempt it shared in (2), not one collapsed charge.
      const rows = await events(db).then((all) =>
        all.filter((r) => r.event_type !== "ADMISSION_RESERVATION"),
      );
      expect(rows).toEqual([
        expect.objectContaining({
          event_type: "ABUSE_WEIGHTED",
          attempt: 1,
          search_id: search.searchId,
        }),
        expect.objectContaining({
          event_type: "ABUSE_WEIGHTED",
          attempt: 2,
          search_id: search.searchId,
        }),
        expect.objectContaining({ event_type: "PROVIDER_WORK", attempt: 1, search_id: null }),
        expect.objectContaining({ event_type: "PROVIDER_WORK", attempt: 2, search_id: null }),
      ]);
    });
  });

  describe("join charge — COST_ABUSE_JOIN after SUBSCRIPTION_CREATE (S17.4/S17.5)", () => {
    it("scenario 7: a search joining an already-dispatched live run is charged one ABUSE_WEIGHTED (units 1) through the wired transaction", async () => {
      await seedProvider(db());
      // A warms in first and subscribes; its fetch run then dispatches.
      const a = await acceptSearchCreation(db(), warm(id("srch_join_a"), ["st_join"]));
      const key = await fetchKey(db(), "st_join"); // the same deterministic key
      const run = await dispatchRun(db(), key); // B4: PROVIDER_WORK + 1 charge for A

      // B warms in after the dispatch: the join charge fires in the same transaction as
      // its subscription creation (the coalesced rider is never cheaper).
      const b = await acceptSearchCreation(db(), warm(id("srch_join_b"), ["st_join"]));

      const abuse = (await events(db)).filter((r) => r.event_type === "ABUSE_WEIGHTED");
      // Hand-computed: exactly one charge per subscriber — A at dispatch, B at join.
      expect(abuse.map((r) => r.search_id).sort()).toEqual([a.searchId, b.searchId].sort());
      for (const row of abuse) {
        expect(row).toMatchObject({ run_id: run.runId, attempt: 1, units: "1" });
      }
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'PROVIDER_WORK'`,
          )
        ).n,
      ).toBe("1");
    });

    it("scenario 8a: joining a LEASED-but-not-yet-dispatched run charges nothing now; the dispatch charges the subscriber once", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_join_race_a");
      const search = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), search, key);

      const runId = id("run_race_a");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);

      // LEASED but no PROVIDER_WORK yet: state alone does not prove dispatch.
      const join = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, search.searchId]);
      expect(join.rows).toHaveLength(0);
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'ABUSE_WEIGHTED'`,
          )
        ).n,
      ).toBe("0");

      // Dispatch now: the still-LIVE subscriber is charged exactly once, at dispatch.
      await mustWin(db(), B.B4_PREDISPATCH, [runId, leased.generation]);
      const abuse = (await events(db)).filter((r) => r.event_type === "ABUSE_WEIGHTED");
      expect(abuse).toEqual([
        expect.objectContaining({
          run_id: runId,
          attempt: 1,
          search_id: search.searchId,
          units: "1",
        }),
      ]);

      // Crash-tier replay of the same join inserts no duplicate (the partial index holds).
      const replay = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, search.searchId]);
      expect(replay.rows).toHaveLength(0);
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'ABUSE_WEIGHTED'`,
          )
        ).n,
      ).toBe("1");
    });

    it("scenario 8b: joining against an expired lease charges nothing (the stale attempt must not bill a joiner)", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_join_race_b");
      const run = await dispatchRun(db(), key); // PROVIDER_WORK exists

      // Positive control: with a live lease the join charges.
      const joined = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), joined, key);
      const live = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, joined.searchId]);
      expect(live.rows).toHaveLength(1);
      // crash-tier replay of the same join inserts no duplicate
      expect(
        (await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, joined.searchId])).rows,
      ).toHaveLength(0);

      // Expire the lease: the same statement now owes nothing.
      const late = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), late, key);
      await expireRunLease(db(), run.runId);
      const denied = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, late.searchId]);
      expect(denied.rows).toHaveLength(0);

      // Hand-computed: exactly one ABUSE_WEIGHTED row (the positive control's).
      const abuse = (await events(db)).filter((r) => r.event_type === "ABUSE_WEIGHTED");
      expect(abuse.map((r) => r.search_id)).toEqual([joined.searchId]);
    });
    it("scenario 8c: joining after a B9 halt charges nothing, even with PROVIDER_WORK and a live lease intact", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_join_race_c");
      await dispatchRun(db(), key); // PROVIDER_WORK exists, lease live

      // Positive control: before the halt, the join charges.
      const before = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), before, key);
      const live = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, before.searchId]);
      expect(live.rows).toHaveLength(1);

      // Halt: the run stays LEASED with its lease and PROVIDER_WORK intact, but the fence
      // is no longer open — the same openness shape B4 itself checks.
      await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
      await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "HALTED", "BLOCKED", null]);
      const after = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), after, key);
      const denied = await runQuery(db(), B.COST_ABUSE_JOIN, [key.runKeyId, after.searchId]);
      expect(denied.rows).toHaveLength(0);

      // Hand-computed: one charge only — the pre-halt join's.
      const abuse = (await events(db)).filter((r) => r.event_type === "ABUSE_WEIGHTED");
      expect(abuse.map((r) => r.search_id)).toEqual([before.searchId]);
    });
  });

  describe("ADMISSION_RECONCILED — B6 stage 2 (S17.3) — search-wide (S36)", () => {
    it("scenario 10: two schedule keys reconcile to one search-wide event whose units equal the aggregate delta", async () => {
      await seedProvider(db());
      // S36: one provisional 200 and one unresolved slot for the whole cold multi-key search
      // (coldDelta = 1, not per-key). Each date records its filtered match count; the final
      // date reconciles once search-wide with units = durableAggregate - 200.
      const search = await createSearch(db(), 1, { reserve: 200 });
      const keyA = await scheduleKey(db(), "theatre_ledger_a", "2026-08-20");
      const keyB = await scheduleKey(db(), "theatre_ledger_b", "2026-08-20");
      await subscribe(db(), search, keyA);
      await subscribe(db(), search, keyB);

      // Provisional: one slot held, not yet reconciled, total is the validator maximum.
      expect(
        await db().one<{
          schedule_slot_held: boolean;
          schedule_reconciled: boolean;
          reserved_total: string;
        }>(
          `SELECT schedule_slot_held, schedule_reconciled, reserved_total::text AS reserved_total FROM admission_reservation WHERE search_id = $1`,
          [search.searchId],
        ),
      ).toEqual({ schedule_slot_held: true, schedule_reconciled: false, reserved_total: "200" });

      const shows = (keyPrefix: string) => [
        {
          showtimeId: `${keyPrefix}_1`,
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
        {
          showtimeId: `${keyPrefix}_2`,
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
      ];
      // First date resolves to 2 filtered showtimes; search still has one pending date so
      // no reconciliation fires yet — the count is durable (WHERE schedule_match_count IS NULL).
      await acceptSchedule(db(), await dispatchRun(db(), keyA), shows("st_a"));

      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'ADMISSION_RECONCILED'`,
          )
        ).n,
      ).toBe("0");
      const midCounts = await db().rows<{
        run_key_id: string;
        schedule_match_count: number | null;
      }>(
        `SELECT rs.run_key_id, rs.schedule_match_count
         FROM run_subscription rs
         JOIN run_key k ON k.run_key_id = rs.run_key_id
         WHERE rs.search_id = $1 AND k.kind = 'SCHEDULE_RESOLUTION'
         ORDER BY rs.run_key_id`,
        [search.searchId],
      );
      expect(midCounts).toEqual([
        expect.objectContaining({ run_key_id: keyA.runKeyId, schedule_match_count: 2 }),
        expect.objectContaining({ run_key_id: keyB.runKeyId, schedule_match_count: null }),
      ]);
      expect(
        (
          await db().one<{ schedule_reconciled: boolean }>(
            `SELECT schedule_reconciled FROM admission_reservation WHERE search_id = $1`,
            [search.searchId],
          )
        ).schedule_reconciled,
      ).toBe(false);

      // Second (final) date resolves to 2 filtered showtimes: durable aggregate = 0 (fresh) + 2 + 2 = 4.
      // Hand-computed search-wide delta: 4 - 200 = -196 (ADR 0028 §5, migration 013d).
      await acceptSchedule(db(), await dispatchRun(db(), keyB), shows("st_b"));

      const reconciled = (await events(db)).filter((r) => r.event_type === "ADMISSION_RECONCILED");
      expect(reconciled).toEqual([
        expect.objectContaining({ search_id: search.searchId, run_key_id: null, units: "-196" }),
      ]);
      // Per-schedule match counts remain durable and sum to the aggregate.
      const finalCounts = await db().rows<{ run_key_id: string; schedule_match_count: number }>(
        `SELECT rs.run_key_id, rs.schedule_match_count
         FROM run_subscription rs
         JOIN run_key k ON k.run_key_id = rs.run_key_id
         WHERE rs.search_id = $1 AND k.kind = 'SCHEDULE_RESOLUTION'
         ORDER BY rs.run_key_id`,
        [search.searchId],
      );
      expect(finalCounts).toEqual([
        expect.objectContaining({ run_key_id: keyA.runKeyId, schedule_match_count: 2 }),
        expect.objectContaining({ run_key_id: keyB.runKeyId, schedule_match_count: 2 }),
      ]);
      // Hand-computed conservation (S17.7a / S36 search_window_accounting): reserved_total 4 = 200 + (-196).
      expect(
        await db().one<{
          reserved_total: string;
          schedule_reconciled: boolean;
          fresh_match_seed: number;
        }>(
          `SELECT reserved_total::text AS reserved_total, schedule_reconciled, fresh_match_seed FROM admission_reservation WHERE search_id = $1`,
          [search.searchId],
        ),
      ).toEqual(
        expect.objectContaining({
          reserved_total: "4",
          schedule_reconciled: true,
          fresh_match_seed: 0,
        }),
      );
      expect(
        (
          await db().one<{ s: string }>(
            `SELECT coalesce(sum(units), 0)::text AS s FROM cost_event
           WHERE search_id = $1 AND event_type IN ('ADMISSION_RESERVATION','ADMISSION_RECONCILED')`,
            [search.searchId],
          )
        ).s,
      ).toBe("4");
    });

    it("scenario 10 (denial): an unobtainable shortfall records no event, and the later release keeps conservation intact", async () => {
      await seedProvider(db(), { pendingCostLimit: 6 });
      const search = await createSearch(db(), 1, { reserve: 6 });
      const key = await scheduleKey(db(), "theatre_ledger_deny", "2026-08-20");
      await subscribe(db(), search, key);

      // Headroom 0, delta = 8 - 3 = +5: unobtainable.
      await acceptSchedule(
        db(),
        await dispatchRun(db(), key),
        ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({
          showtimeId: `st_deny_${x}`,
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        })),
        { stage1Share: 3 },
      );

      expect(
        (
          await db().one<{ capacity_denied_at: Date | null }>(
            `SELECT capacity_denied_at FROM search WHERE search_id = $1`,
            [search.searchId],
          )
        ).capacity_denied_at,
      ).not.toBeNull();
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE event_type = 'ADMISSION_RECONCILED'`,
          )
        ).n,
      ).toBe("0");

      const terminal = await terminalize(db(), search.searchId);
      expect(terminal?.status).toBe("HALTED");
      expect(
        await db().one<{
          reserved_total: string;
          reserved_remaining: string;
          released: boolean;
        }>(
          `SELECT reserved_total::text AS reserved_total, reserved_remaining::text AS reserved_remaining, released FROM admission_reservation WHERE search_id = $1`,
          [search.searchId],
        ),
      ).toEqual({ reserved_total: "6", reserved_remaining: "0", released: true });
      // Conservation after release: 6 = reservation event (6) + no reconciled rows.
      expect(
        (
          await db().one<{ s: string }>(
            `SELECT coalesce(sum(units), 0)::text AS s FROM cost_event
           WHERE search_id = $1 AND event_type IN ('ADMISSION_RESERVATION','ADMISSION_RECONCILED')`,
            [search.searchId],
          )
        ).s,
      ).toBe("6");
    });
  });

  describe("invariant sweep (S17.7)", () => {
    it("scenario 11: the sweep names each hand-produced violation, and is clean after removal", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_sweep_ledger");
      const search = await createSearch(db(), 0, { reserve: 6 });
      await subscribe(db(), search, key);
      const runId = id("run_sweep");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);
      await mustWin(db(), B.B4_PREDISPATCH, [runId, leased.generation]);
      // Baseline: the legitimately-produced events satisfy every invariant.
      expect(await checkInvariants(db())).toEqual([]);

      // (a) ledger conservation — precondition simulation: a reconciled delta the
      // reservation never received (6 reserved vs a fabricated +5).
      const badDeltaId = id("evt_bad_delta");
      await db().query(
        `INSERT INTO cost_event (event_id, event_type, search_id, run_key_id, units)
         VALUES ($1, 'ADMISSION_RECONCILED', $2, $3, 5)`,
        [badDeltaId, search.searchId, key.runKeyId],
      );
      const deltaViolations = await checkInvariants(db());
      expect(deltaViolations.map((v) => v.invariant)).toContain("ledger_conservation");
      expect(
        JSON.stringify(deltaViolations.find((v) => v.invariant === "ledger_conservation")?.rows),
      ).toContain(search.searchId);
      await db().query(`DELETE FROM cost_event WHERE event_id = $1`, [badDeltaId]);

      // (b) ABUSE_WEIGHTED requires PROVIDER_WORK — precondition simulation: a charge
      // against a run that was leased but never dispatched.
      const keyB = await fetchKey(db(), "st_sweep_b");
      await subscribe(db(), search, keyB);
      const runB = id("run_sweep_b");
      await mustWin(db(), B.RUN_CREATE, [runB, keyB.runKeyId, id("obs"), null]);
      await mustWin(db(), B.B2_LEASE_RUN, [runB, "5 minutes"]); // LEASED, never B4
      const badPwId = id("evt_bad_pw");
      await db().query(
        `INSERT INTO cost_event (event_id, event_type, run_id, attempt, search_id, units)
         VALUES ($1, 'ABUSE_WEIGHTED', $2, 1, $3, 1)`,
        [badPwId, runB, search.searchId],
      );
      const pwViolations = await checkInvariants(db());
      expect(pwViolations.map((v) => v.invariant)).toContain("abuse_weighted_has_provider_work");
      expect(
        JSON.stringify(
          pwViolations.find((v) => v.invariant === "abuse_weighted_has_provider_work")?.rows,
        ),
      ).toContain(runB);
      await db().query(`DELETE FROM cost_event WHERE event_id = $1`, [badPwId]);

      // (c) ABUSE_WEIGHTED requires a subscriber — precondition simulation: a charge for a
      // search that never subscribed to the charged run's key (the dispatched run above has
      // its PROVIDER_WORK, so only this invariant fires).
      const outsider = await createSearch(db(), 0, { reserve: 1 });
      const badSubId = id("evt_bad_sub");
      await db().query(
        `INSERT INTO cost_event (event_id, event_type, run_id, attempt, search_id, units)
         VALUES ($1, 'ABUSE_WEIGHTED', $2, 1, $3, 1)`,
        [badSubId, runId, outsider.searchId],
      );
      const subViolations = await checkInvariants(db());
      expect(subViolations.map((v) => v.invariant)).toContain("abuse_weighted_has_subscriber");
      expect(
        JSON.stringify(
          subViolations.find((v) => v.invariant === "abuse_weighted_has_subscriber")?.rows,
        ),
      ).toContain(outsider.searchId);
      await db().query(`DELETE FROM cost_event WHERE event_id = $1`, [badSubId]);

      // All three counterexamples removed: the sweep is clean.
      expect(await checkInvariants(db())).toEqual([]);
    });
  });

  describe("retention cascade (S17.0, ADR 0005 CASCADE decision)", () => {
    it("cost_event.search_id ON DELETE CASCADE: a search's ledger rows die with it", async () => {
      await seedProvider(db());
      // Seed data (precondition): a bare search row with its ADMISSION_RESERVATION event and
      // no reservation/jobs/subs, so the cascade proof does not need to clear dependents.
      const orphan = id("srch_cascade");
      await db().query(
        `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, deadline_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'hash_cascade', now() + interval '1 hour')`,
        [orphan, id("sess_cascade"), id("idem_cascade")],
      );
      await db().query(
        `INSERT INTO cost_event (event_id, event_type, search_id, units)
         VALUES ($1, 'ADMISSION_RESERVATION', $2, 1)`,
        [id("evt_cascade"), orphan],
      );

      // Positive control: the event exists before the delete.
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE search_id = $1`,
            [orphan],
          )
        ).n,
      ).toBe("1");

      await db().query(`DELETE FROM search WHERE search_id = $1`, [orphan]);

      // Without CASCADE this DELETE would have thrown an FK violation; with it the event went.
      expect(
        (
          await db().one<{ n: string }>(
            `SELECT count(*) AS n FROM cost_event WHERE search_id = $1`,
            [orphan],
          )
        ).n,
      ).toBe("0");
    });
  });
});
