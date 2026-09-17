import { describe, expect, it } from "vitest";

import { readCachedSchedule, updatePerformanceProduct } from "../src/repository.js";
import {
  acceptSearchCreation,
  AdmissionRejectedError,
  IdempotencyKeyConflictError,
  stageSearchCreation,
} from "../src/transactions.js";
import type { SearchCreationResult } from "../src/transactions.js";

import {
  acceptSchedule,
  createSearch,
  dispatchRun,
  id,
  scheduleKey,
  seedProvider,
  subscribe,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — S15's two additive durability seams: the `stageSearchCreation`/`acceptSearchCreation`
 * composition (S15.7, the B1 flow the production route composes via `withTransaction`) and the
 * `readCachedSchedule` cache read (S15.4) plus its freshness edge.
 *
 * Imports bind DIRECTLY to `src/` — `transactions.ts`/`repository.ts`, not the fixture
 * mirrors — so deleting the production homes fails this file. The policy itself
 * (`performancePolicy`) is deliberately absent here: durability only ever receives plain
 * `reserve`/`coldDelta`/`{ showtimeId }` inputs (S15.13); the status→policy agreement is
 * proven by the apps/server route suite against the shared fixture (S15 item 7).
 *
 * Every `useDatabase` test ends with the invariant sweep (`support/pg.ts`), so each
 * scenario below also proves the new B1 write paths satisfy `admission_conservation`
 * (`invariants.ts:58-79`) — no widening was needed, as S15's verification list asked to
 * confirm.
 */

interface SearchRow {
  search_id: string;
  status: string;
  spec_hash: string;
}

const PROVIDER = "amc";

describe("tier 2 — S15 search creation seams", () => {
  const db = useDatabase();

  describe("stageSearchCreation / acceptSearchCreation (S15.7/S36.5)", () => {
    it("cold create: one transaction writes search, reservation, schedule job/subscription/outbox (item 1)", async () => {
      await seedProvider(db());
      const result = await acceptSearchCreation(db(), {
        searchId: id("srch_cold"),
        sessionId: id("sess"),
        idempotencyKey: id("idem"),
        spec: { v: 1 },
        specHash: "hash_cold",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 200,
        scheduleKeys: [{ theatreId: "theatre_cold", localDate: "2026-08-20" }],
        freshMatchCount: 0,
        showtimes: [],
        traceparent: null,
      });

      expect(result).toEqual({
        kind: "created",
        searchId: expect.any(String),
        status: "PENDING_SCHEDULE",
      });

      const search = await db().one<SearchRow>(`SELECT search_id, status, spec_hash FROM search`);
      expect(search.status).toBe("PENDING_SCHEDULE");
      expect(search.spec_hash).toBe("hash_cold");
      const reservation = await db().one<{
        reserved_total: string;
        reserved_remaining: string;
        released: boolean;
        schedule_slot_held: boolean;
        fresh_match_seed: number;
        schedule_reconciled: boolean;
      }>(
        `SELECT reserved_total, reserved_remaining, released, schedule_slot_held, fresh_match_seed, schedule_reconciled FROM admission_reservation`,
      );
      expect(reservation).toEqual({
        reserved_total: "200",
        reserved_remaining: "200",
        released: false,
        schedule_slot_held: true,
        fresh_match_seed: 0,
        schedule_reconciled: false,
      });

      const admission = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
        `SELECT pending_cost, unresolved_schedules FROM provider_admission`,
      );
      expect(admission).toEqual({ pending_cost: "200", unresolved_schedules: 1 });
      const key = await db().one<{
        run_key_id: string;
        kind: string;
        theatre_id: string;
        local_date: Date;
      }>(`SELECT run_key_id, kind, theatre_id, local_date FROM run_key`);
      expect(key).toEqual({
        run_key_id: `k_sched_${PROVIDER}_theatre_cold_2026-08-20`,
        kind: "SCHEDULE_RESOLUTION",
        theatre_id: "theatre_cold",
        local_date: expect.any(Date),
      });
      expect(key.local_date.toISOString().slice(0, 10)).toBe("2026-08-20");

      const jobs = await db().rows<{ kind: string }>(`SELECT kind FROM search_job ORDER BY kind`);
      expect(jobs).toEqual([{ kind: "SCHEDULE_RESOLUTION" }]);

      const subscription = await db().one<{ schedule_match_count: number | null }>(
        `SELECT schedule_match_count FROM run_subscription`,
      );
      expect(subscription.schedule_match_count).toBe(null);

      const outbox = await db().one<{ target_kind: string }>(`SELECT target_kind FROM outbox`);
      expect(outbox.target_kind).toBe("JOB");

      // S19.5: the zero-state aggregate row exists from the SAME transaction, before any
      // AGGREGATE pass ever runs — this is what makes `searches.get`'s nonterminal branch
      // never see a missing row.
      const aggregate = await db().one<{ revision: string; payload: Record<string, unknown> }>(
        `SELECT revision, payload FROM search_aggregate WHERE search_id = $1`,
        [result.searchId],
      );
      expect(aggregate.revision).toBe("0");
      expect(aggregate.payload).toMatchObject({
        searchId: result.searchId,
        status: "PENDING_SCHEDULE",
        resolved: 0,
        total: 200,
        capturedAtRange: null,
        groups: [],
        answer: null,
      });
    });

    it("warm create: per-showtime work with fresh seed, RUNNING transition (item 2/S36)", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_warm", "2026-08-20");
      const run = await dispatchRun(db(), key);
      await acceptSchedule(
        db(),
        run,
        [
          {
            showtimeId: "st_open",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T19:00:00.000Z"),
            skipFetch: false,
          },
          {
            showtimeId: "st_sold",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T20:00:00.000Z"),
            skipFetch: true,
          },
          {
            showtimeId: "st_cancelled",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T21:00:00.000Z"),
            skipFetch: true,
          },
        ],
        { capturedAt: new Date() },
      );

      const result = await acceptSearchCreation(db(), {
        searchId: id("srch_warm"),
        sessionId: id("sess"),
        idempotencyKey: id("idem"),
        spec: { v: 1 },
        specHash: "hash_warm",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 1, // the caller already filtered to the policy-eligible set (S15.13)
        scheduleKeys: [] as const,
        freshMatchCount: 1,
        showtimes: [{ showtimeId: "st_open" }],
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      });

      expect(result).toEqual({
        kind: "created",
        searchId: expect.any(String),
        status: "RUNNING",
      });

      const search = await db().one<SearchRow>(`SELECT search_id, status FROM search`);
      expect(search.status).toBe("RUNNING");

      const reservation = await db().one<{
        reserved_total: string;
        fresh_match_seed: number;
        schedule_slot_held: boolean;
      }>(`SELECT reserved_total, fresh_match_seed, schedule_slot_held FROM admission_reservation`);
      expect(reservation).toEqual({
        reserved_total: "1",
        fresh_match_seed: 1,
        schedule_slot_held: false,
      });

      const jobs = await db().rows<{ job_id: string; kind: string }>(
        `SELECT job_id, kind FROM search_job ORDER BY kind`,
      );
      expect(jobs).toEqual([{ job_id: expect.any(String), kind: "SHOWTIME_FETCH" }]);
      // O7.8 positive case: the stage threads the HTTP-boundary traceparent onto the
      // outbox row it creates, so the relay's delivery continues this request's trace.
      const outboxTrace = await db().one<{ traceparent: string | null }>(
        `SELECT traceparent FROM outbox WHERE job_id = $1::text`,
        [jobs[0]!.job_id],
      );
      expect(outboxTrace.traceparent).toBe(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      );
      const keys = await db().rows<{ run_key_id: string; kind: string }>(
        `SELECT run_key_id, kind FROM run_key ORDER BY kind`,
      );
      expect(keys).toEqual([
        { run_key_id: `k_sched_${PROVIDER}_theatre_warm_2026-08-20`, kind: "SCHEDULE_RESOLUTION" },
        { run_key_id: `k_fetch_${PROVIDER}_st_open`, kind: "SHOWTIME_FETCH" },
      ]);
      const subscription = await db().one<{ schedule_match_count: number | null }>(
        `SELECT schedule_match_count FROM run_subscription WHERE run_key_id = $1`,
        [`k_fetch_${PROVIDER}_st_open`],
      );
      // S36: SHOWTIME_FETCH subscriptions never carry schedule_match_count (only SCHEDULE keys).
      expect(subscription.schedule_match_count).toBe(null);

      // The stage-1 reservation already paid the warm cost: unresolved stays 0 (search-level slot).
      const admission = await db().one<{ unresolved_schedules: number }>(
        `SELECT unresolved_schedules FROM provider_admission`,
      );
      expect(admission.unresolved_schedules).toBe(0);

      // S19.5: warm path also gets the zero-state row, status RUNNING, total = reserve (1).
      const aggregate = await db().one<{ revision: string; payload: Record<string, unknown> }>(
        `SELECT revision, payload FROM search_aggregate WHERE search_id = $1`,
        [result.searchId],
      );
      expect(aggregate.revision).toBe("0");
      expect(aggregate.payload).toMatchObject({
        searchId: result.searchId,
        status: "RUNNING",
        resolved: 0,
        total: 1,
        capturedAtRange: null,
        groups: [],
        answer: null,
      });
    });

    it("idempotent replay short-circuits before admission: identical input returns the stored row, zero new rows (item 3)", async () => {
      await seedProvider(db());
      const input = {
        searchId: id("srch_replay"),
        sessionId: id("sess"),
        idempotencyKey: id("idem"),
        spec: { v: 1 },
        specHash: "hash_replay",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 200,
        scheduleKeys: [{ theatreId: "theatre_replay", localDate: "2026-08-20" }] as const,
        freshMatchCount: 0,
        showtimes: [] as readonly { showtimeId: string }[],
        traceparent: null,
      };

      const first = await acceptSearchCreation(db(), input);
      const second = await acceptSearchCreation(db(), input);

      expect(first.kind).toBe("created");
      expect(second).toEqual({
        kind: "replay",
        searchId: (first as Extract<SearchCreationResult, { kind: "created" }>).searchId,
        status: "PENDING_SCHEDULE",
        fetchJobCount: 0,
      });

      const counts = await db().one<{
        searches: string;
        reservations: string;
        jobs: string;
        subs: string;
        outbox: string;
      }>(
        `SELECT
           (SELECT count(*) FROM search) AS searches,
           (SELECT count(*) FROM admission_reservation) AS reservations,
           (SELECT count(*) FROM search_job) AS jobs,
           (SELECT count(*) FROM run_subscription) AS subs,
           (SELECT count(*) FROM outbox) AS outbox`,
      );
      expect(counts).toEqual({
        searches: "1",
        reservations: "1",
        jobs: "1",
        subs: "1",
        outbox: "1",
      });
    });

    it("idempotency conflict: different spec_hash throws IdempotencyKeyConflictError carrying the first searchId (item 4)", async () => {
      await seedProvider(db());
      const base = {
        searchId: id("srch_conflict"),
        sessionId: id("sess"),
        idempotencyKey: id("idem"),
        spec: { v: 1 },
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 200,
        scheduleKeys: [{ theatreId: "theatre_conflict", localDate: "2026-08-20" }] as const,
        freshMatchCount: 0,
        showtimes: [] as readonly { showtimeId: string }[],
        traceparent: null,
      };

      await acceptSearchCreation(db(), { ...base, specHash: "hash_a" });
      const conflict = await acceptSearchCreation(db(), { ...base, specHash: "hash_b" }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
      expect((conflict as IdempotencyKeyConflictError).searchId).toBe(base.searchId);

      const counts = await db().one<{ searches: string; reservations: string }>(
        `SELECT (SELECT count(*) FROM search) AS searches,
                (SELECT count(*) FROM admission_reservation) AS reservations`,
      );
      expect(counts).toEqual({ searches: "1", reservations: "1" });
    });

    it("admission rejection: zero-row gate throws AdmissionRejectedError and rolls the search row back (item 5)", async () => {
      await seedProvider(db(), { pendingCostLimit: 5 });
      // Consume the ceiling exactly: a warm create reserving 5 (zero eligible showtimes
      // is a legal warm search — the schedule resolved empty).
      await acceptSearchCreation(db(), {
        searchId: id("srch_saturate"),
        sessionId: id("sess"),
        idempotencyKey: id("idem_saturate"),
        spec: { v: 1 },
        specHash: "hash_saturate",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 5,
        scheduleKeys: [] as const,
        freshMatchCount: 0,
        showtimes: [],
        traceparent: null,
      });

      const rejected = await acceptSearchCreation(db(), {
        searchId: id("srch_rejected"),
        sessionId: id("sess"),
        idempotencyKey: id("idem_rejected"),
        spec: { v: 1 },
        specHash: "hash_rejected",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 1,
        scheduleKeys: [{ theatreId: "theatre_rejected", localDate: "2026-08-20" }] as const,
        freshMatchCount: 0,
        showtimes: [],
        traceparent: null,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejected).toBeInstanceOf(AdmissionRejectedError);
      expect((rejected as AdmissionRejectedError).providerId).toBe(PROVIDER);

      // The failed create's B1_CREATE_SEARCH insert must have rolled back with the
      // throw: not even a PENDING_SCHEDULE search row exists for it.
      const rows = await db().rows<{ search_id: string }>(
        `SELECT search_id FROM search ORDER BY search_id`,
      );
      expect(rows.map((row) => row.search_id)).toEqual([expect.any(String)]);
      expect(rows).toHaveLength(1);
    });

    it("stageSearchCreation runs without transaction control (crash-test hook)", async () => {
      await seedProvider(db());
      const result = await stageSearchCreation(db(), {
        searchId: id("srch_stage"),
        sessionId: id("sess"),
        idempotencyKey: id("idem_stage"),
        spec: { v: 1 },
        specHash: "hash_stage",
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        providerId: PROVIDER,
        reserve: 200,
        scheduleKeys: [{ theatreId: "theatre_stage", localDate: "2026-08-20" }] as const,
        freshMatchCount: 0,
        showtimes: [],
        traceparent: null,
      });
      expect(result.kind).toBe("created");
      const search = await db().one<SearchRow>(`SELECT search_id, status FROM search`);
      expect(search.status).toBe("PENDING_SCHEDULE");
    });
  });

  describe("readCachedSchedule (S15.4)", () => {
    it("no run_key row resolves COLD", async () => {
      await seedProvider(db());
      const cached = await readCachedSchedule(db(), {
        providerId: PROVIDER,
        theatreId: "theatre_missing",
        localDate: "2026-08-20",
        freshnessMs: 10 * 60_000,
      });
      expect(cached).toBeNull();
    });

    it("a key that never captured resolves COLD", async () => {
      await seedProvider(db());
      await scheduleKey(db(), "theatre_never", "2026-08-20");
      const cached = await readCachedSchedule(db(), {
        providerId: PROVIDER,
        theatreId: "theatre_never",
        localDate: "2026-08-20",
        freshnessMs: 10 * 60_000,
      });
      expect(cached).toBeNull();
    });

    it("freshness boundary: capturedAt exactly at the ceiling is WARM; one second past is COLD (item 6)", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_fresh", "2026-08-20");
      const run = await dispatchRun(db(), key);
      const capturedAt = new Date("2026-08-14T12:00:00.000Z");
      await acceptSchedule(
        db(),
        run,
        [
          {
            showtimeId: "st_fresh",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T19:00:00.000Z"),
            skipFetch: false,
          },
        ],
        { capturedAt },
      );
      const freshnessMs = 10 * 60_000;

      const exactlyAt = await readCachedSchedule(db(), {
        providerId: PROVIDER,
        theatreId: "theatre_fresh",
        localDate: "2026-08-20",
        freshnessMs,
        now: new Date(capturedAt.getTime() + freshnessMs),
      });
      expect(exactlyAt).not.toBeNull();
      expect(exactlyAt?.performances.map((performance) => performance.showtimeId)).toEqual([
        "st_fresh",
      ]);

      const oneSecondPast = await readCachedSchedule(db(), {
        providerId: PROVIDER,
        theatreId: "theatre_fresh",
        localDate: "2026-08-20",
        freshnessMs,
        now: new Date(capturedAt.getTime() + freshnessMs + 1_000),
      });
      expect(oneSecondPast).toBeNull();
    });

    it("returns every performance with the status S14's write path persisted", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_product", "2026-08-20");
      const run = await dispatchRun(db(), key);
      const capturedAt = new Date("2026-08-14T12:00:00.000Z");
      await acceptSchedule(
        db(),
        run,
        [
          {
            showtimeId: "st_a",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T19:00:00.000Z"),
            skipFetch: false,
          },
          {
            showtimeId: "st_b",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T20:00:00.000Z"),
            skipFetch: true,
          },
          {
            showtimeId: "st_c",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-20T21:00:00.000Z"),
            skipFetch: true,
          },
        ],
        { capturedAt },
      );
      for (const [showtimeId, status] of [
        ["st_a", "OPEN"],
        ["st_b", "SOLD_OUT"],
        ["st_c", "CANCELED"],
      ] as const) {
        await updatePerformanceProduct(db(), {
          showtimeId,
          movieId: "amc:movie:42",
          auditorium: "7",
          utcOffset: "-05:00",
          runtimeMinutes: 120,
          status,
          formatCode: "DIGITAL",
          minPrice: null,
          deepLinkUrl: "https://example.invalid/showtime",
          providerMeta: {},
          layoutId: null,
          updatedAt: capturedAt,
        });
      }

      const cached = await readCachedSchedule(db(), {
        providerId: PROVIDER,
        theatreId: "theatre_product",
        localDate: "2026-08-20",
        freshnessMs: 10 * 60_000,
        now: new Date(capturedAt.getTime() + 1_000),
      });
      // E5.13 (declared-file-list deviation, Main-approved — S17's tier2.catalog.test.ts
      // precedent): the widened cache read carries the product columns verbatim.
      expect(cached?.performances).toEqual([
        {
          showtimeId: "st_a",
          status: "OPEN",
          layoutId: null,
          formatCode: "DIGITAL",
          auditorium: "7",
        },
        {
          showtimeId: "st_b",
          status: "SOLD_OUT",
          layoutId: null,
          formatCode: "DIGITAL",
          auditorium: "7",
        },
        {
          showtimeId: "st_c",
          status: "CANCELED",
          layoutId: null,
          formatCode: "DIGITAL",
          auditorium: "7",
        },
      ]);
    });
  });

  it("B1's warm and cold write paths satisfy the admission-conservation invariant sweep (runs after every test above)", async () => {
    // The invariant sweep (`support/pg.ts`) runs automatically at the end of every test
    // in this file, so the assertions in this test only pin the scenario the sweep
    // re-checks: a cold search (reservation + admission_counted subscription) followed
    // by a warm search on the same provider must keep
    // `pending_cost = Σ reserved_remaining` and
    // `unresolved_schedules = count(admission_counted subscriptions)`.
    await seedProvider(db());
    const cold = await createSearch(db(), 1, { reserve: 3 });
    const key = await scheduleKey(db(), "theatre_mixed", "2026-08-20");
    await subscribe(db(), cold, key);

    const warm = await createSearch(db(), 0, { reserve: 2 });
    const fetch = await scheduleKey(db(), "theatre_mixed", "2026-08-21");
    // Warm subscriptions are admission_counted=false, so only the cold one counts.
    const warmSub = await subscribe(db(), warm, fetch, { admissionCounted: false });
    expect(warmSub.jobId).toEqual(expect.any(String));

    const state = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
      `SELECT pending_cost, unresolved_schedules FROM provider_admission`,
    );
    expect(state.pending_cost).toBe("5");
    expect(state.unresolved_schedules).toBe(1);
  });
});
