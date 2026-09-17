import { Redis } from "ioredis";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SEARCH_LIMITS, type Weekday } from "@seatfirst/core";

import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
  type SessionRateLimitConfig,
} from "../src/session/limiter.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
  sessionCookieHeader,
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RELAY_PEER_CIDR,
  TEST_NONCE_SECRET,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_LOGGER,
  TEST_MINT_ID,
  TEST_METRICS,
  TEST_TRACER,
} from "./support/app.js";

/**
 * S43 verification — `searches.facetCounts` over HTTP against a real Fastify server
 * and real Postgres (testcontainers), the same harness style as `create.test.ts`.
 * Schedules are seeded through raw INSERTs of run_key/provider_run/observation/
 * performance rows — seed data simulating a precondition, the legitimate non-boundary
 * bucket (`CONTRIBUTING.md` §2) — never a hand-built private write path.
 *
 * Every injected number below is an explicit test-harness value (gate 14); the
 * rate-limit exhaustion test injects its own tiny window via a controllable clock
 * (`createSessionRateLimiter`'s `now` seam) — no test sleeps.
 */

const PROVIDER = "amc";
const SESSION = "sess_facet";
const THEATRE_A = `${PROVIDER}:theatre:a`;
const THEATRE_B = `${PROVIDER}:theatre:b`;
const MOVIE_1 = `${PROVIDER}:movie:m1`;
const MOVIE_2 = `${PROVIDER}:movie:m2`;
/** Two days ahead keeps dates clear of RANGE_IN_PAST semantics for horizon presets. */
const DAY_OFFSET_DAYS = 2;
const FRESHNESS_MS = 10 * 60_000;

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function weekdayForIsoDate(date: string): Weekday {
  const days: readonly Weekday[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ];
  return days[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

interface FacetTestServer {
  readonly baseUrl: string;
  /** Advances the limiter's injected clock by `ms` — time is data, never a sleep. */
  advanceLimiterClock(ms: number): void;
  close(): Promise<void>;
}

function makeRateLimitConfig(
  overrides: Partial<SessionRateLimitConfig> = {},
): SessionRateLimitConfig {
  return {
    searches: { limit: 10_000, windowMs: 3_600_000 },
    fetches: { limit: 100_000, windowMs: 3_600_000 },
    recheck: { limit: 10_000, windowMs: 60_000 },
    facetCounts: { limit: 10_000, windowMs: 60_000 },
    resolvePlace: { limit: 10_000, windowMs: 60_000 },
    suggestPlace: { limit: 30, windowMs: 60_000 },
    facetCountMaxCandidates: 40,
    concurrentSearches: 10_000,
    breachWindowMs: 3_600_000,
    ...overrides,
  };
}

async function startFacetServer(
  db: Pool,
  redisUrl: string,
  config: SessionRateLimitConfig,
): Promise<FacetTestServer> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  let nowOffsetMs = 0;
  const limiter = createSessionRateLimiter({
    redis: redisScriptExecutorFromIoredis(redis),
    config,
    now: () => Date.now() + nowOffsetMs,
  });
  const fastify = buildApp({
    db,
    searchLimits: DEFAULT_SEARCH_LIMITS,
    freshnessMs: FRESHNESS_MS,
    retryAfterSeconds: 30,
    rateLimitConfig: config,
    limiter,
    cookieSecret: TEST_COOKIE_SECRET,
    cookiePolicy: TEST_COOKIE_POLICY,
    relayPeerCidr: TEST_RELAY_PEER_CIDR,
    asnLookup: TEST_ASN_LOOKUP,
    streamRedisUrl: redisUrl,
    streamBlockTimeoutMs: 250,
    providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
    nonceSecret: TEST_NONCE_SECRET,
    recheckDeadlineMs: TEST_RECHECK_DEADLINE_MS,
    recheckRecovery: TEST_RECHECK_RECOVERY,
    mapboxAccessToken: "test-mapbox-token",
    corsAllowedOrigins: ["http://localhost:8081"],
    logger: TEST_LOGGER,
    mintId: TEST_MINT_ID,
    metrics: TEST_METRICS,
    tracer: TEST_TRACER,
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/trpc`,
    advanceLimiterClock: (ms: number) => {
      nowOffsetMs += ms;
    },
    close: async () => {
      await fastify.close();
      redis.disconnect();
    },
  };
}

function makeClient(baseUrl: string, sessionId: string) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: baseUrl, headers: { cookie: sessionCookieHeader(sessionId) } })],
  });
}

// --- seed helpers (raw INSERTs: precondition simulation, not state transitions) ---

async function seedTheatre(pool: Pool, theatreId: string): Promise<void> {
  await pool.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Facet Theatre', 40.0, -74.0, 'UTC', now(), now())
     ON CONFLICT (theatre_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
    [theatreId, PROVIDER],
  );
}

interface SeededShow {
  showtimeId: string;
  movieId: string;
  status?: string;
  formatCode?: string | null;
  /** Exact UTC instant for theatre-local boundary tests. */
  startsAt?: string;
  /** "HH:MM" UTC start time on the seeded local date (the theatre timezone is UTC). */
  utcTime?: string;
}

async function seedScheduleDay(
  pool: Pool,
  theatreId: string,
  localDate: string,
  capturedAt: Date | null,
  shows: readonly SeededShow[],
): Promise<void> {
  const runKeyId = `k_sched_${theatreId}_${localDate}`;
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date, latest_captured_at)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4, $5)
     ON CONFLICT (run_key_id) DO UPDATE SET latest_captured_at = EXCLUDED.latest_captured_at`,
    [runKeyId, PROVIDER, theatreId, localDate, capturedAt],
  );
  if (shows.length === 0) return;
  const runId = `run_${runKeyId}`;
  const observationId = `obs_${runKeyId}`;
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, runKeyId, observationId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), 0)
     ON CONFLICT (observation_id) DO NOTHING`,
    [observationId, runKeyId, runId, capturedAt],
  );
  for (const show of shows) {
    await pool.query(
      `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                                observation_id, movie_id, status, format_code, deep_link_url, layout_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'https://example.invalid/showtime', null)
       ON CONFLICT (showtime_id) DO UPDATE SET status = EXCLUDED.status, format_code = EXCLUDED.format_code`,
      [
        show.showtimeId,
        PROVIDER,
        theatreId,
        localDate,
        show.startsAt ?? `${localDate}T${show.utcTime ?? "19:00"}:00.000Z`,
        observationId,
        show.movieId,
        show.status ?? "OPEN",
        show.formatCode === undefined ? null : show.formatCode,
      ],
    );
  }
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let redisUrl: string;
let server: FacetTestServer;
let pool: Pool;
let admin: Client;

beforeAll(async () => {
  pg = await startTestPostgres();
  const startedRedis = await startTestRedis();
  redisUrl = startedRedis.url;
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  server = await startFacetServer(pool, redisUrl, makeRateLimitConfig());
});

afterAll(async () => {
  await server.close();
  await admin.end();
  await pool.end();
  await Promise.all([pg.stop()]);
});

beforeEach(async () => {
  await admin.query(
    `TRUNCATE search, run_key, performance, outbox, provider_admission, provider_fence,
     provider_run, observation, admission_reservation, search_job, run_subscription CASCADE`,
  );
  await seedTheatre(pool, THEATRE_A);
  await seedTheatre(pool, THEATRE_B);
});

function facetClient() {
  return makeClient(server.baseUrl, SESSION);
}

describe("searches.facetCounts (S43)", () => {
  it("MOVIE axis counts fresh matching performances across two theatres", async () => {
    const d1 = isoDate(DAY_OFFSET_DAYS);
    await seedScheduleDay(pool, THEATRE_A, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:f1`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:f2`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:f3`, movieId: MOVIE_2 },
    ]);
    await seedScheduleDay(pool, THEATRE_B, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:f4`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:f5`, movieId: MOVIE_2 },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A, THEATRE_B],
      base: {},
      axes: [{ kind: "MOVIE", candidates: [MOVIE_1, MOVIE_2] }],
    });

    expect(response.counts).toEqual([
      { kind: "MOVIE", candidate: MOVIE_1, count: 3, coldTheatreCount: 0 },
      { kind: "MOVIE", candidate: MOVIE_2, count: 2, coldTheatreCount: 0 },
    ]);
  });

  it("sold-out performances are excluded from every count (C1 policy)", async () => {
    const d1 = isoDate(DAY_OFFSET_DAYS);
    await seedScheduleDay(pool, THEATRE_A, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:s1`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:s2`, movieId: MOVIE_1, status: "SOLD_OUT" },
      { showtimeId: `${PROVIDER}:showtime:s3`, movieId: MOVIE_1, status: "CANCELED" },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
    });

    expect(response.counts).toEqual([
      { kind: "MOVIE", candidate: MOVIE_1, count: 1, coldTheatreCount: 0 },
    ]);
  });

  it("a stale theatre-date is cold: excluded from count, reported in coldTheatreCount", async () => {
    const d1 = isoDate(DAY_OFFSET_DAYS);
    const staleCapturedAt = new Date(Date.now() - (FRESHNESS_MS + 60_000));
    await seedScheduleDay(pool, THEATRE_A, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:c1`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:c2`, movieId: MOVIE_1 },
    ]);
    await seedScheduleDay(pool, THEATRE_B, d1, staleCapturedAt, [
      { showtimeId: `${PROVIDER}:showtime:c3`, movieId: MOVIE_1 },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A, THEATRE_B],
      base: {},
      axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
    });

    // Theatre B's row exists but is stale past freshnessMs — cold, never folded into
    // either a fabricated 0 or the fresh count (ADR 0036 decision 2).
    expect(response.counts).toEqual([
      { kind: "MOVIE", candidate: MOVIE_1, count: 2, coldTheatreCount: 1 },
    ]);
  });

  it("FORMAT axis counts by ADR 0008 codes with STANDARD sentinel", async () => {
    const d1 = isoDate(DAY_OFFSET_DAYS);
    await seedScheduleDay(pool, THEATRE_A, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:fm1`, movieId: MOVIE_1, formatCode: "imax" },
      { showtimeId: `${PROVIDER}:showtime:fm2`, movieId: MOVIE_1, formatCode: null },
      {
        showtimeId: `${PROVIDER}:showtime:fm3`,
        movieId: MOVIE_1,
        formatCode: "dolbycinemaatamcprime",
      },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [{ kind: "FORMAT", candidates: ["imax", "STANDARD"] }],
    });

    expect(response.counts).toEqual([
      { kind: "FORMAT", candidate: "imax", count: 1, coldTheatreCount: 0 },
      { kind: "FORMAT", candidate: "STANDARD", count: 1, coldTheatreCount: 0 },
    ]);
  });

  it("base+axis composition: a MOVIE candidate's count reflects fixed base.horizon+base.timeOfDay evening", async () => {
    // Hand-derived: two shows on the current weekend block's Friday — one at
    // 19:00 UTC (evening under the decided 17:00–20:59 bounds) and one at
    // 12:00 UTC (not). The theatre timezone is UTC, so local wall-clock == UTC.
    const { resolveWeekendPreset } = await import("@seatfirst/core");
    const todayLocal = new Date().toISOString().slice(0, 10);
    const friday = resolveWeekendPreset("thisWeekend", todayLocal).range.from;
    await seedScheduleDay(pool, THEATRE_A, friday, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:e1`, movieId: MOVIE_1, utcTime: "19:00" },
      { showtimeId: `${PROVIDER}:showtime:e2`, movieId: MOVIE_1, utcTime: "12:00" },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: { horizon: "thisWeekend", timeOfDay: "evening" },
      axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
    });

    // Honest cold accounting: thisWeekend resolves Fri–Sun and only Friday has a
    // seeded fresh schedule — the theatre IS partially cold for this candidate.
    expect(response.counts).toEqual([
      { kind: "MOVIE", candidate: MOVIE_1, count: 1, coldTheatreCount: 1 },
    ]);
  });

  it("TIME_OF_DAY axis over four bands partitions allTimes (S50.3, ADR 0043 §1 cut points)", async () => {
    // Hand-derived partition over a single fresh theatre-day (UTC == local).
    // Shows at each band and at cut points: 00:00 morning, 11:59 morning, 12:00 afternoon,
    // 16:59 afternoon, 17:00 evening, 20:59 evening, 21:00 late, 23:59 late.
    const { resolveWeekendPreset } = await import("@seatfirst/core");
    const todayLocal = new Date().toISOString().slice(0, 10);
    const friday = resolveWeekendPreset("thisWeekend", todayLocal).range.from;
    const shows = [
      { showtimeId: `${PROVIDER}:showtime:p1`, movieId: MOVIE_1, utcTime: "00:00" },
      { showtimeId: `${PROVIDER}:showtime:p2`, movieId: MOVIE_1, utcTime: "11:59" },
      { showtimeId: `${PROVIDER}:showtime:p3`, movieId: MOVIE_1, utcTime: "12:00" },
      { showtimeId: `${PROVIDER}:showtime:p4`, movieId: MOVIE_1, utcTime: "16:59" },
      { showtimeId: `${PROVIDER}:showtime:p5`, movieId: MOVIE_1, utcTime: "17:00" },
      { showtimeId: `${PROVIDER}:showtime:p6`, movieId: MOVIE_1, utcTime: "20:59" },
      { showtimeId: `${PROVIDER}:showtime:p7`, movieId: MOVIE_1, utcTime: "21:00" },
      { showtimeId: `${PROVIDER}:showtime:p8`, movieId: MOVIE_1, utcTime: "23:59" },
    ];
    await seedScheduleDay(pool, THEATRE_A, friday, new Date(), shows);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: { horizon: "thisWeekend" },
      axes: [{ kind: "TIME_OF_DAY", candidates: ["morning", "afternoon", "evening", "late"] }],
    });
    const byCand = new Map(response.counts.map((c) => [c.candidate, c.count] as const));
    expect(byCand.get("morning")).toBe(2);
    expect(byCand.get("afternoon")).toBe(2);
    expect(byCand.get("evening")).toBe(2);
    expect(byCand.get("late")).toBe(2);

    // Sum equals allTimes count for same base
    const all = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: { horizon: "thisWeekend" },
      axes: [{ kind: "TIME_OF_DAY", candidates: ["allTimes"] }],
    });
    const sum =
      (byCand.get("morning") ?? 0) +
      (byCand.get("afternoon") ?? 0) +
      (byCand.get("evening") ?? 0) +
      (byCand.get("late") ?? 0);
    expect(all.counts[0]!.count).toBe(sum);
    // Cut-point behaviour: each boundary belongs to exactly one band is already
    // proven by the per-candidate expectations above (e.g. 12:00 counted only in afternoon).
  });

  it("rejects invalid, empty, and oversized date scopes before any DB read (S54.3)", async () => {
    const querySpy = vi.spyOn(pool, "query");
    const callsBefore = querySpy.mock.calls.length;
    const invalidInputs: readonly unknown[] = [
      {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: {
          dateScope: {
            kind: "OR",
            of: [
              { kind: "DATE_RANGE", from: "2026-09-01", to: "2026-09-02" },
              { kind: "MOVIE", ids: [MOVIE_1] },
            ],
          },
        },
        axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
      },
      {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: {},
        axes: [{ kind: "DATE", candidates: ["2026-02-30"] }],
      },
      {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: {},
        axes: [
          { kind: "DATE_SCOPE", candidates: [{ key: "bad", dateScope: { kind: "OR", of: [] } }] },
        ],
      },
      {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: { dateScope: { kind: "DATE_RANGE", from: "2026-01-01", to: "2026-12-31" } },
        axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
      },
      {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: { dateScope: { kind: "DATE_RANGE", from: "2026-09-05", to: "2026-09-05" } },
        axes: [{ kind: "WEEKDAY", candidates: ["MONDAY"] }],
      },
    ];
    try {
      for (const input of invalidInputs) {
        let rejected: unknown;
        try {
          await facetClient().searches.facetCounts.query(input as never);
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(TRPCClientError);
        expect((rejected as TRPCClientError<AppRouter>).data?.code).toBe("BAD_REQUEST");
      }
      expect(querySpy.mock.calls.length).toBe(callsBefore);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("DATE candidates isolate one theatre-local DST-transition date (S54.4)", async () => {
    const date = "2026-03-08";
    await pool.query(`UPDATE theatre SET timezone = 'America/New_York' WHERE theatre_id = $1`, [
      THEATRE_A,
    ]);
    await seedScheduleDay(pool, THEATRE_A, date, new Date(), [
      {
        showtimeId: `${PROVIDER}:showtime:dst-before`,
        movieId: MOVIE_1,
        startsAt: "2026-03-08T04:30:00.000Z", // 23:30 on the prior local date
      },
      {
        showtimeId: `${PROVIDER}:showtime:dst-inside`,
        movieId: MOVIE_1,
        startsAt: "2026-03-08T07:30:00.000Z", // 03:30 after the spring-forward transition
      },
      {
        showtimeId: `${PROVIDER}:showtime:dst-after`,
        movieId: MOVIE_1,
        startsAt: "2026-03-09T04:30:00.000Z", // 00:30 on the following local date
      },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [{ kind: "DATE", candidates: [date] }],
    });
    expect(response.counts).toEqual([
      { kind: "DATE", candidate: date, count: 1, coldTheatreCount: 0 },
    ]);
  });

  it("DATE_SCOPE candidates count sparse runs, not their gap, and echo their key (S54.5)", async () => {
    const first = isoDate(DAY_OFFSET_DAYS + 3);
    const gap = isoDate(DAY_OFFSET_DAYS + 4);
    const last = isoDate(DAY_OFFSET_DAYS + 5);
    await seedScheduleDay(pool, THEATRE_A, first, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:scope-first`, movieId: MOVIE_1 },
    ]);
    await seedScheduleDay(pool, THEATRE_A, gap, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:scope-gap`, movieId: MOVIE_1 },
    ]);
    await seedScheduleDay(pool, THEATRE_A, last, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:scope-last`, movieId: MOVIE_1 },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [
        {
          kind: "DATE_SCOPE",
          candidates: [
            {
              key: "sparse-chip",
              dateScope: {
                kind: "OR",
                of: [
                  { kind: "DATE_RANGE", from: first, to: first },
                  { kind: "DATE_RANGE", from: last, to: last },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(response.counts).toEqual([
      { kind: "DATE_SCOPE", candidate: "sparse-chip", count: 2, coldTheatreCount: 0 },
    ]);
  });

  it("base.dateScope narrows MOVIE, WEEKDAY, TIME_OF_DAY, and FORMAT axes (S54.6)", async () => {
    const first = isoDate(DAY_OFFSET_DAYS + 7);
    const gap = isoDate(DAY_OFFSET_DAYS + 8);
    const last = isoDate(DAY_OFFSET_DAYS + 9);
    await seedScheduleDay(pool, THEATRE_A, first, new Date(), [
      {
        showtimeId: `${PROVIDER}:showtime:base-first-morning`,
        movieId: MOVIE_1,
        formatCode: "imax",
        utcTime: "09:00",
      },
      {
        showtimeId: `${PROVIDER}:showtime:base-first-evening`,
        movieId: MOVIE_1,
        formatCode: "imax",
        utcTime: "19:00",
      },
    ]);
    await seedScheduleDay(pool, THEATRE_A, gap, new Date(), [
      {
        showtimeId: `${PROVIDER}:showtime:base-gap`,
        movieId: MOVIE_1,
        formatCode: "imax",
        utcTime: "09:00",
      },
    ]);
    await seedScheduleDay(pool, THEATRE_A, last, new Date(), [
      {
        showtimeId: `${PROVIDER}:showtime:base-last`,
        movieId: MOVIE_1,
        formatCode: "imax",
        utcTime: "09:00",
      },
    ]);

    const response = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {
        dateScope: {
          kind: "OR",
          of: [
            { kind: "DATE_RANGE", from: first, to: first },
            { kind: "DATE_RANGE", from: last, to: last },
          ],
        },
      },
      axes: [
        { kind: "MOVIE", candidates: [MOVIE_1] },
        { kind: "WEEKDAY", candidates: [weekdayForIsoDate(first)] },
        { kind: "TIME_OF_DAY", candidates: ["allTimes", "morning", "evening"] },
        { kind: "FORMAT", candidates: ["imax"] },
      ],
    });
    expect(response.counts).toEqual([
      { kind: "MOVIE", candidate: MOVIE_1, count: 3, coldTheatreCount: 0 },
      {
        kind: "WEEKDAY",
        candidate: weekdayForIsoDate(first),
        count: 2,
        coldTheatreCount: 0,
      },
      { kind: "TIME_OF_DAY", candidate: "allTimes", count: 3, coldTheatreCount: 0 },
      { kind: "TIME_OF_DAY", candidate: "morning", count: 2, coldTheatreCount: 0 },
      { kind: "TIME_OF_DAY", candidate: "evening", count: 1, coldTheatreCount: 0 },
      { kind: "FORMAT", candidate: "imax", count: 3, coldTheatreCount: 0 },
    ]);
  });

  it("preserves warm, partial, and cold tri-state on date forms and base scopes (S54.7)", async () => {
    const partial = isoDate(DAY_OFFSET_DAYS + 11);
    const cold = isoDate(DAY_OFFSET_DAYS + 12);
    const warm = isoDate(DAY_OFFSET_DAYS + 13);
    const staleCapturedAt = new Date(Date.now() - (FRESHNESS_MS + 60_000));
    await seedScheduleDay(pool, THEATRE_A, partial, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:partial-open`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:partial-soldout`, movieId: MOVIE_1, status: "SOLD_OUT" },
    ]);
    await seedScheduleDay(pool, THEATRE_B, partial, staleCapturedAt, [
      { showtimeId: `${PROVIDER}:showtime:partial-stale`, movieId: MOVIE_1 },
    ]);
    await seedScheduleDay(pool, THEATRE_A, warm, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:warm-a`, movieId: MOVIE_1 },
      { showtimeId: `${PROVIDER}:showtime:warm-soldout`, movieId: MOVIE_1, status: "SOLD_OUT" },
    ]);
    await seedScheduleDay(pool, THEATRE_B, warm, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:warm-b`, movieId: MOVIE_1 },
    ]);

    const dateForms = await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A, THEATRE_B],
      base: {},
      axes: [
        { kind: "DATE", candidates: [partial, cold] },
        {
          kind: "DATE_SCOPE",
          candidates: [
            {
              key: "warm-chip",
              dateScope: { kind: "DATE_RANGE", from: warm, to: warm },
            },
          ],
        },
      ],
    });
    expect(dateForms.counts).toEqual([
      { kind: "DATE", candidate: partial, count: 1, coldTheatreCount: 1 },
      { kind: "DATE", candidate: cold, count: 0, coldTheatreCount: 2 },
      { kind: "DATE_SCOPE", candidate: "warm-chip", count: 2, coldTheatreCount: 0 },
    ]);

    for (const [date, expected] of [
      [partial, { count: 1, coldTheatreCount: 1 }],
      [cold, { count: 0, coldTheatreCount: 2 }],
      [warm, { count: 2, coldTheatreCount: 0 }],
    ] as const) {
      const response = await facetClient().searches.facetCounts.query({
        providerId: PROVIDER,
        theatreIds: [THEATRE_A, THEATRE_B],
        base: { dateScope: { kind: "DATE_RANGE", from: date, to: date } },
        axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
      });
      expect(response.counts).toEqual([{ kind: "MOVIE", candidate: MOVIE_1, ...expected }]);
    }
  });

  it("candidate cap rejection issues zero DB queries; under-cap succeeds (positive control)", async () => {
    const tight = await startFacetServer(
      pool,
      redisUrl,
      makeRateLimitConfig({ facetCountMaxCandidates: 2 }),
    );
    try {
      // Distinct session ids: the sliding windows live in the SHARED Redis instance,
      // so reusing SESSION would inherit budget spent by earlier tests.
      const client = makeClient(tight.baseUrl, `${SESSION}_tight`);
      const querySpy = vi.spyOn(pool, "query");
      const callCountBefore = querySpy.mock.calls.length;
      let rejected: unknown;
      try {
        await client.searches.facetCounts.query({
          providerId: PROVIDER,
          theatreIds: [THEATRE_A],
          base: {},
          axes: [
            {
              kind: "MOVIE",
              candidates: [`${PROVIDER}:movie:x1`, `${PROVIDER}:movie:x2`, `${PROVIDER}:movie:x3`],
            },
          ],
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(TRPCClientError);
      expect((rejected as TRPCClientError<AppRouter>).data?.code).toBe("BAD_REQUEST");
      // Zero DB queries issued between the spy reset and the rejected call — the cap
      // check runs before any read (S43.4).
      expect(querySpy.mock.calls.length).toBe(callCountBefore);

      const ok = await client.searches.facetCounts.query({
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: {},
        axes: [{ kind: "MOVIE", candidates: [`${PROVIDER}:movie:y1`, `${PROVIDER}:movie:y2`] }],
      });
      expect(ok.counts).toHaveLength(2);
      querySpy.mockRestore();
    } finally {
      await tight.close();
    }
  });

  it("rate-limit exhaustion denies with facet_counts_per_minute and recovers after the window rolls", async () => {
    const tiny = await startFacetServer(
      pool,
      redisUrl,
      makeRateLimitConfig({ facetCounts: { limit: 1, windowMs: 60_000 } }),
    );
    try {
      const client = makeClient(tiny.baseUrl, `${SESSION}_tiny`);
      const input = {
        providerId: PROVIDER,
        theatreIds: [THEATRE_A],
        base: {} as Record<string, never>,
        axes: [{ kind: "MOVIE" as const, candidates: [MOVIE_1] }],
      };
      await client.searches.facetCounts.query(input);
      let denied: unknown;
      try {
        await client.searches.facetCounts.query(input);
      } catch (error) {
        denied = error;
      }
      expect(denied).toBeInstanceOf(TRPCClientError);
      // The error formatter replaces `data` with the structured body outright
      // (create.ts errorFormatter), so `code`/`limit` sit directly on `data`.
      const denialData = (denied as TRPCClientError<AppRouter>).data as
        { code?: string; limit?: string } | undefined;
      expect(denialData?.code).toBe("RATE_LIMITED");
      expect(denialData?.limit).toBe("facet_counts_per_minute");

      // Roll the injected limiter clock past the window — budget recovers, no sleep.
      tiny.advanceLimiterClock(60_000);
      const recovered = await client.searches.facetCounts.query(input);
      expect(recovered.counts).toEqual([
        { kind: "MOVIE", candidate: MOVIE_1, count: 0, coldTheatreCount: 0 },
      ]);
    } finally {
      await tiny.close();
    }
  });

  it("DATE, DATE_SCOPE, and base.dateScope calls append no durable rows (S54.8)", async () => {
    const d1 = isoDate(DAY_OFFSET_DAYS);
    const d2 = isoDate(DAY_OFFSET_DAYS + 1);
    await seedScheduleDay(pool, THEATRE_A, d1, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:r1`, movieId: MOVIE_1, formatCode: "imax" },
    ]);
    await seedScheduleDay(pool, THEATRE_A, d2, new Date(), [
      { showtimeId: `${PROVIDER}:showtime:r2`, movieId: MOVIE_1, formatCode: "imax" },
    ]);
    async function tableCounts(): Promise<Record<string, string>> {
      const result = await admin.query<{
        search: string;
        admission_reservation: string;
        run_key: string;
        provider_run: string;
        outbox: string;
      }>(
        `SELECT (SELECT count(*) FROM search)::text AS search,
                (SELECT count(*) FROM admission_reservation)::text AS admission_reservation,
                (SELECT count(*) FROM run_key)::text AS run_key,
                (SELECT count(*) FROM provider_run)::text AS provider_run,
                (SELECT count(*) FROM outbox)::text AS outbox`,
      );
      return result.rows[0] as unknown as Record<string, string>;
    }
    const before = await tableCounts();
    await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [{ kind: "DATE", candidates: [d1] }],
    });
    await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: {},
      axes: [
        {
          kind: "DATE_SCOPE",
          candidates: [{ key: "one-day", dateScope: { kind: "DATE_RANGE", from: d2, to: d2 } }],
        },
      ],
    });
    await facetClient().searches.facetCounts.query({
      providerId: PROVIDER,
      theatreIds: [THEATRE_A],
      base: { dateScope: { kind: "DATE_RANGE", from: d1, to: d1 } },
      axes: [{ kind: "MOVIE", candidates: [MOVIE_1] }],
    });
    const after = await tableCounts();
    expect(after).toEqual(before);
  });
});
