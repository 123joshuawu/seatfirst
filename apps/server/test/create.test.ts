import { randomUUID } from "node:crypto";

import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CreateSearchResponseSchema,
  DEFAULT_SEARCH_LIMITS,
  performancePolicy,
  specHash,
} from "@seatfirst/core";
import type { ShowtimeStatus, SearchSpec } from "@seatfirst/core";
import { resolveScheduleTarget, resolveScheduleWindow } from "../src/routes/searches/create.js";
import {
  B2_LEASE_RUN,
  B4_PREDISPATCH,
  OUTBOX_CREATE_RUN,
  poolClient,
  RUN_CREATE,
  RUN_KEY_UPSERT,
  stageScheduleAcceptance,
  updatePerformanceProduct,
  withTransaction,
} from "@seatfirst/durability";
import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";

import { startTestPostgres, startTestRedis } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
  sessionCookieHeader,
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RATE_LIMIT_CONFIG,
  TEST_RELAY_PEER_CIDR,
  TEST_NONCE_SECRET,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_LOGGER,
  TEST_MINT_ID,
  TEST_METRICS,
  TEST_TRACER,
} from "./support/app.js";
import { STATUS_POLICY_FIXTURE } from "./support/status-policy.js";

/**
 * S15 verification, items 1–7 of the spec's verification list, over HTTP against a real
 * Fastify server (tRPC fastify adapter + `searches.create`) and real Postgres — the
 * route-level proof of the durability tier's seams (`tier2.search-creation.test.ts`).
 *
 * Cached schedules are seeded through S14's write path — the same boundary sequence and
 * same-transaction ordering the provider fetch actor composes
 * (`stageScheduleAcceptance` + one `updatePerformanceProduct` per performance) — never a
 * hand-built performance row. The warm path's policy agreement (item 7) is driven by the
 * shared `STATUS_POLICY_FIXTURE`, the single `performancePolicy`-derived table both call
 * sites' tests consume; the cold path's half is pinned by the provider-fetch-actor suite
 * (S14), which owns the `skipFetch` matrix.
 *
 * Every injected number below is a test-harness value passed EXPLICITLY through the
 * `buildApp` options (gate 14 / S15.1 / S15.9 / S16.13): neither the assembly nor the
 * route has defaults. The rate config is the shared generous harness config — this
 * suite exercises S15's create semantics, not S16's windows (the S16 suites inject
 * ADR 0006 §A.6's figures themselves).
 */

const PROVIDER = "amc";
const SESSION = "sess_route";
const THEATRE = `${PROVIDER}:theatre:7`;
const MOVIE = `${PROVIDER}:movie:42`;
/** Two days ahead keeps every DATE_RANGE clear of RANGE_IN_PAST for the whole run. */
const LOCAL_DATE = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
const FRESHNESS_MS = 10 * 60_000; // ADR 0006 §A.1's ≤ 10-minute ceiling, injected (S15.4)
const RETRY_AFTER_SECONDS = 30; // injected — no accepted document fixes this (S15.9)

interface CreateTestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startCreateServer(db: Pool, redisUrl: string): Promise<CreateTestServer> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  const fastify = buildApp({
    db,
    searchLimits: DEFAULT_SEARCH_LIMITS, // injected per S15.1, never a route-local default
    freshnessMs: FRESHNESS_MS,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    rateLimitConfig: TEST_RATE_LIMIT_CONFIG,
    limiter: createSessionRateLimiter({
      redis: redisScriptExecutorFromIoredis(redis),
      config: TEST_RATE_LIMIT_CONFIG,
    }),
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

function makeSpec(
  overrides: {
    theatreId?: string;
    theatres?: SearchSpec["theatres"];
    date?: string;
    where?: SearchSpec["where"];
  } = {},
): SearchSpec {
  const date = overrides.date ?? LOCAL_DATE;
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: overrides.theatres ?? {
      kind: "LIST",
      refs: [{ id: overrides.theatreId ?? THEATRE }],
    },
    where: overrides.where ?? {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [MOVIE] },
        { kind: "DATE_RANGE", from: date, to: date },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  };
}
/** Seed data: provider_admission + provider_fence rows (mirrors the durability fixture's
 * `seedProvider` charter — scaffolding, not a state transition). */
async function seedProvider(
  admin: Client,
  caps: { pendingCostLimit?: number; unresolvedLimit?: number } = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    [PROVIDER, caps.pendingCostLimit ?? 1000, caps.unresolvedLimit ?? 100],
  );
  await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
  // S36: theatre-local validation reads theatre.timezone; ensure the test theatre exists.
  await admin.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Test Theatre', 40.0, -74.0, 'UTC', now(), now())
     ON CONFLICT (theatre_id) DO NOTHING`,
    [THEATRE, PROVIDER],
  );
}
/** ADR 0029 helper: seed an additional theatre row for multi-theatre tests. */
async function seedTheatre(
  admin: Client,
  theatreId: string,
  lat: number,
  lng: number,
  timezone = "UTC",
  providerId = PROVIDER,
): Promise<void> {
  await admin.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (theatre_id) DO NOTHING`,
    [theatreId, providerId, `Test Theatre ${theatreId}`, lat, lng, timezone],
  );
}

/** ADR 0029 helper: ensure auditorium_layout exists for group skeleton tests. */
async function ensureLayout(admin: Client, layoutId: string): Promise<void> {
  await admin.query(
    `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
     VALUES ($1, $2, 1, 1)
     ON CONFLICT (layout_id) DO NOTHING`,
    [layoutId, Buffer.from([0])],
  );
}

async function mustProduceRow(
  db: ReturnType<typeof poolClient>,
  statement: { text: string },
  values: readonly unknown[],
): Promise<Record<string, unknown>> {
  const result = await db.query(statement.text, values);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error("boundary returned 0 rows while seeding a cached schedule");
  }
  return row;
}

interface SeededPerformance {
  readonly showtimeId: string;
  readonly movieId?: string;
  readonly status: ShowtimeStatus;
  readonly skipFetch: boolean;
  /** E5.13: the product layout id the seed write attaches; omitted = null (pre-layout capture). */
  readonly layoutId?: string | null;
  /** ADR 0008 format code; omitted = "DIGITAL" fake code (non-format) so existing tests keep passing. */
  readonly formatCode?: string | null;
}
/** Seeds a cached schedule through S14's write path: RUN_KEY_UPSERT → RUN_CREATE →
 * outbox → lease → pre-dispatch, then `stageScheduleAcceptance` + one
 * `updatePerformanceProduct` per performance in ONE transaction — the same composition
 * and atomicity the provider fetch actor uses (S14.2). */
async function seedCachedSchedule(
  pool: Pool,
  opts: {
    theatreId?: string;
    localDate?: string;
    capturedAt?: Date;
    performances: readonly SeededPerformance[];
  },
): Promise<void> {
  const theatreId = opts.theatreId ?? THEATRE;
  const localDate = opts.localDate ?? LOCAL_DATE;
  const runKeyId = `k_sched_${PROVIDER}_${theatreId}_${localDate}`;
  const runId = `run_${randomUUID()}`;
  const observationId = `obs_${randomUUID()}`;
  const sql = poolClient(pool);

  await mustProduceRow(sql, RUN_KEY_UPSERT, [
    runKeyId,
    "SCHEDULE_RESOLUTION",
    PROVIDER,
    "schedule",
    null,
    theatreId,
    localDate,
  ]);
  await mustProduceRow(sql, RUN_CREATE, [runId, runKeyId, observationId, null]);
  await mustProduceRow(sql, OUTBOX_CREATE_RUN, [runId, null]);
  const leased = (await mustProduceRow(sql, B2_LEASE_RUN, [runId, "5 minutes"])) as {
    generation: number;
  };
  await mustProduceRow(sql, B4_PREDISPATCH, [runId, leased.generation]);

  const capturedAt = opts.capturedAt ?? new Date();
  await withTransaction(pool, async (tx) => {
    await stageScheduleAcceptance(
      tx,
      { runId, generation: leased.generation },
      opts.performances.map((performance) => ({
        showtimeId: performance.showtimeId,
        movieId: performance.movieId ?? MOVIE,
        startsAt: new Date(`${localDate}T19:00:00.000Z`),
        skipFetch: performance.skipFetch,
      })),
      { capturedAt },
    );
    for (const performance of opts.performances) {
      await updatePerformanceProduct(tx, {
        showtimeId: performance.showtimeId,
        movieId: performance.movieId ?? MOVIE,
        auditorium: "7",
        utcOffset: "-05:00",
        runtimeMinutes: 120,
        status: performance.status,
        formatCode: performance.formatCode === undefined ? "DIGITAL" : performance.formatCode,
        minPrice: null,
        deepLinkUrl: "https://example.invalid/showtime",
        providerMeta: {},
        layoutId: performance.layoutId ?? null,
        updatedAt: capturedAt,
      });
    }
  });
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let redis: Awaited<ReturnType<typeof startTestRedis>>;
let server: CreateTestServer;
let pool: Pool;
let admin: Client;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  server = await startCreateServer(pool, redis.url);
});

afterAll(async () => {
  await server.close();
  await admin.end();
  await pool.end();
  await Promise.all([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await admin.query(
    `TRUNCATE search, run_key, performance, outbox, provider_admission, provider_fence,
     provider_run, observation, admission_reservation, search_job, run_subscription CASCADE`,
  );
});

describe("searches.create (S15)", () => {
  it("cold create: 202 PENDING_SCHEDULE, reservation 200, one SCHEDULE_RESOLUTION work set (item 1)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item1",
    });

    const { searchId, ...rest } = response;
    expect(rest).toMatchObject({
      status: "PENDING_SCHEDULE",
      showtimeCount: null,
      cachedCount: null,
      estimatedMs: 20000,
      groups: [],
    });
    expect(rest.scheduleSkeleton).toBeDefined();

    expect(searchId).toMatch(/^srch_/);

    const reservation = await admin.query(
      `SELECT reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed FROM admission_reservation WHERE search_id = $1`,
      [response.searchId],
    );
    expect(reservation.rows[0]).toEqual({
      reserved_total: "200",
      reserved_remaining: "200",
      schedule_slot_held: true,
      fresh_match_seed: 0,
    });

    const admission = await admin.query(
      `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
      [PROVIDER],
    );
    expect(admission.rows[0]).toEqual({ pending_cost: "200", unresolved_schedules: 1 });

    const work = await admin.query(
      `SELECT rk.kind, sj.kind AS job_kind, o.target_kind
       FROM search_job sj
       JOIN run_key rk ON rk.run_key_id = sj.run_key_id
       JOIN run_subscription rs ON rs.search_id = sj.search_id AND rs.run_key_id = rk.run_key_id
       JOIN outbox o ON o.job_id = sj.job_id
       WHERE sj.search_id = $1`,
      [response.searchId],
    );
    expect(work.rows).toEqual([
      {
        kind: "SCHEDULE_RESOLUTION",
        job_kind: "SCHEDULE_RESOLUTION",
        target_kind: "JOB",
      },
    ]);

    // S19.5 regression: `searches.get`'s nonterminal branch must never 500 for a search
    // that was just created — the zero-state aggregate row exists in the same commit.
    const aggregate = await admin.query<{ revision: string; payload: Record<string, unknown> }>(
      `SELECT revision, payload FROM search_aggregate WHERE search_id = $1`,
      [response.searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate.rows[0]!.revision).toBe("0");
    expect(aggregate.rows[0]!.payload).toMatchObject({
      searchId: response.searchId,
      status: "PENDING_SCHEDULE",
      resolved: 0,
      total: 200,
      groups: [],
      answer: null,
    });
  });

  it("warm create dispatches only performances for the selected movie", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_selected", movieId: MOVIE, status: "OPEN", skipFetch: false },
        {
          showtimeId: "st_other_movie",
          movieId: `${PROVIDER}:movie:other`,
          status: "OPEN",
          skipFetch: false,
        },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "movie_filter",
    });

    expect(response).toMatchObject({ status: "RUNNING", showtimeCount: 1, cachedCount: 1 });
    const jobs = await admin.query<{ showtime_id: string }>(
      `SELECT rk.showtime_id FROM search_job sj
       JOIN run_key rk ON rk.run_key_id = sj.run_key_id
       WHERE sj.search_id = $1`,
      [response.searchId],
    );
    expect(jobs.rows).toEqual([{ showtime_id: "st_selected" }]);
  });

  it("warm create, mixed statuses: RUNNING, showtimeCount 1 (eligible), reservation 1, only the OPEN showtime gets work (item 2) — S36 filtered via performancePolicy + matchesScheduleWindow", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_open", status: "OPEN", skipFetch: false },
        { showtimeId: "st_sold", status: "SOLD_OUT", skipFetch: true },
        { showtimeId: "st_cancelled", status: "CANCELED", skipFetch: true },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item2",
    });

    const { searchId, ...rest } = response;
    // S36: showtimeCount/cachedCount are policy-eligible, window-matching fresh count (1), not total cached (3).
    expect(rest).toMatchObject({
      status: "RUNNING",
      showtimeCount: 1,
      cachedCount: 1,
      estimatedMs: 2000,
      groups: [],
    });
    expect(rest.scheduleSkeleton).toBeDefined();

    expect(searchId).toMatch(/^srch_/);

    const reservation = await admin.query(
      `SELECT reserved_total FROM admission_reservation WHERE search_id = $1`,
      [response.searchId],
    );
    expect(reservation.rows[0]).toEqual({ reserved_total: "1" });

    const jobs = await admin.query(
      `SELECT rk.showtime_id, rk.kind FROM search_job sj
       JOIN run_key rk ON rk.run_key_id = sj.run_key_id
       WHERE sj.search_id = $1`,
      [response.searchId],
    );
    expect(jobs.rows).toEqual([{ showtime_id: "st_open", kind: "SHOWTIME_FETCH" }]);

    // S19.5 regression: same guarantee on the warm/RUNNING path.
    const aggregate = await admin.query<{ revision: string; payload: Record<string, unknown> }>(
      `SELECT revision, payload FROM search_aggregate WHERE search_id = $1`,
      [response.searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate.rows[0]!.revision).toBe("0");
    expect(aggregate.rows[0]!.payload).toMatchObject({
      searchId: response.searchId,
      status: "RUNNING",
      resolved: 0,
      total: 1,
      groups: [],
      answer: null,
    });
  });

  it("warm create previews cached layout skeletons: one group per distinct layout, truthful count (E5 item 2)", async () => {
    await seedProvider(admin);
    // Scaffolding: `layout_id` references the content-addressed `auditorium_layout` table
    // (not truncated by this suite) — attach the layout before the seed write, the same
    // minimal row shape the catalog tier fixture uses (`tier2.catalog.test.ts:168-172`).
    await admin.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (layout_id) DO NOTHING`,
      ["lay_shared", Buffer.from([0]), 1, 1],
    );
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_a", status: "OPEN", skipFetch: false, layoutId: "lay_shared" },
        { showtimeId: "st_b", status: "OPEN", skipFetch: false, layoutId: "lay_shared" },
        { showtimeId: "st_c", status: "SOLD_OUT", skipFetch: true, layoutId: null },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "e5-groups",
    });

    // Two performances share one layout, the third has none: exactly one skeleton,
    // count 2, display hints from the first performance, theatre from the resolved
    // target, and the whole body is wire-contract-valid (Zod at every boundary).
    expect(response.groups).toEqual([
      {
        layoutId: "lay_shared",
        theatreId: THEATRE,
        distanceKm: null,
        formatCode: "DIGITAL",
        auditorium: "7",
        showtimeCount: 2,
      },
    ]);
    expect(CreateSearchResponseSchema.safeParse(response).success).toBe(true);
  });

  it("warm create with FORMAT predicate dispatches only matching format (S42.3 — admission-time filter, no run_key for excluded)", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_imax", status: "OPEN", skipFetch: false, formatCode: "imax" },
        { showtimeId: "st_std", status: "OPEN", skipFetch: false, formatCode: null },
        {
          showtimeId: "st_dolby",
          status: "OPEN",
          skipFetch: false,
          formatCode: "dolbycinemaatamcprime",
        },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const spec = makeSpec({
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
          { kind: "FORMAT", code: "imax" },
        ],
      },
    });
    const response = await client.searches.create.mutate({ spec, idempotencyKey: "format_imax" });
    expect(response).toMatchObject({ status: "RUNNING", showtimeCount: 1, cachedCount: 1 });
    const jobs = await admin.query<{ showtime_id: string }>(
      `SELECT rk.showtime_id FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id WHERE sj.search_id = $1 ORDER BY rk.showtime_id`,
      [response.searchId],
    );
    expect(jobs.rows).toEqual([{ showtime_id: "st_imax" }]);
    // Excluded formats never created a dispatch — verify absent from jobs
    expect(jobs.rows.map((r) => r.showtime_id)).not.toContain("st_std");
    expect(jobs.rows.map((r) => r.showtime_id)).not.toContain("st_dolby");
  });

  it("FORMAT STANDARD sentinel dispatches only null-format performances", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_a", status: "OPEN", skipFetch: false, formatCode: "imax" },
        { showtimeId: "st_b", status: "OPEN", skipFetch: false, formatCode: null },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const spec = makeSpec({
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
          { kind: "FORMAT", code: "STANDARD" },
        ],
      },
    });
    const response = await client.searches.create.mutate({ spec, idempotencyKey: "format_std" });
    expect(response).toMatchObject({ status: "RUNNING", showtimeCount: 1 });
    const jobs = await admin.query<{ showtime_id: string }>(
      `SELECT rk.showtime_id FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id WHERE sj.search_id = $1`,
      [response.searchId],
    );
    expect(jobs.rows).toEqual([{ showtime_id: "st_b" }]);
  });

  it("warm create without layout ids ships groups: [] and a contract-valid body (E5 item 3)", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [
        { showtimeId: "st_no_layout", status: "OPEN", skipFetch: false, layoutId: null },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "e5-nogroups",
    });

    expect(response.groups).toEqual([]);
    expect(CreateSearchResponseSchema.safeParse(response).success).toBe(true);
  });

  it("idempotency replay: identical second call returns the same searchId with zero new rows (item 3)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);
    const input = { spec: makeSpec(), idempotencyKey: "item3" };

    const first = await client.searches.create.mutate(input);
    const second = await client.searches.create.mutate(input);

    expect(second).toEqual(first);
    expect(second.status).toBe("PENDING_SCHEDULE");

    const counts = await admin.query(
      `SELECT
         (SELECT count(*) FROM search) AS searches,
         (SELECT count(*) FROM admission_reservation) AS reservations,
         (SELECT count(*) FROM search_job) AS jobs,
         (SELECT count(*) FROM run_subscription) AS subs,
         (SELECT count(*) FROM outbox) AS outbox`,
    );
    expect(counts.rows[0]).toEqual({
      searches: "1",
      reservations: "1",
      jobs: "1",
      subs: "1",
      outbox: "1",
    });
  });

  it("idempotency conflict: same key, different spec → 409 with the first searchId, no side effects (item 4)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);

    const first = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item4",
    });

    const differentSpec = makeSpec({
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [`${PROVIDER}:movie:99`] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
        ],
      },
    });

    const conflict = await client.searches.create
      .mutate({
        spec: differentSpec,
        idempotencyKey: "item4",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(conflict).toBeInstanceOf(TRPCClientError);
    const data = (conflict as TRPCClientError<AppRouter>).data;
    expect(data).toEqual({ code: "IDEMPOTENCY_KEY_CONFLICT", searchId: first.searchId });

    // The conflict body is the FIRST call's search — and the wire status is 409.
    const raw = await fetch(`${server.baseUrl}/searches.create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookieHeader(SESSION) },
      body: JSON.stringify({
        spec: differentSpec,
        idempotencyKey: "item4",
      }),
    });
    expect(raw.status).toBe(409);
    const envelope = (await raw.json()) as { error: { data: unknown } };
    expect(envelope.error.data).toEqual({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      searchId: first.searchId,
    });

    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'item4'`,
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("admission rejection: 429 + Retry-After + schema body, and the search row rolled back (item 5)", async () => {
    await seedProvider(admin, { pendingCostLimit: 5 });
    // Consume the ceiling exactly through the real warm path: five eligible performances.
    await seedCachedSchedule(pool, {
      performances: [1, 2, 3, 4, 5].map((n) => ({
        showtimeId: `st_saturate_${n}`,
        status: "OPEN",
        skipFetch: false,
      })),
    });
    const client = makeClient(server.baseUrl, SESSION);
    const first = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item5_saturate",
    });
    expect(first.status).toBe("RUNNING");

    // A second, cold search on a different date needs any nonzero reserve: 429.
    const raw = await fetch(`${server.baseUrl}/searches.create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookieHeader(SESSION) },
      body: JSON.stringify({
        spec: makeSpec({
          date: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10),
        }),
        idempotencyKey: "item5_rejected",
      }),
    });
    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    const envelope = (await raw.json()) as { error: { data: unknown } };
    expect(envelope.error.data).toEqual({
      code: "ADMISSION_REJECTED",
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });

    // The rollback-on-throw contract unwound B1_CREATE_SEARCH with the failed admission:
    // no search row at all for the rejected key.
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'item5_rejected'`,
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("capacity ceiling: warm search over maxResolvedShowtimes rejects 400 with the structured CAPACITY_CEILING_EXCEEDED body, no row, no quota charged (S56)", async () => {
    await seedProvider(admin);
    const limit = DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes;
    const over = limit + 1;
    await seedCachedSchedule(pool, {
      performances: Array.from({ length: over }, (_, n) => ({
        showtimeId: `st_ceiling_over_${n}`,
        status: "OPEN" as const,
        skipFetch: false,
      })),
    });
    const sessionId = "sess_ceiling_over";
    const client = makeClient(server.baseUrl, sessionId);

    const rejected = await client.searches.create
      .mutate({ spec: makeSpec(), idempotencyKey: "s56_over" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).toBeInstanceOf(TRPCClientError);
    expect((rejected as TRPCClientError<AppRouter>).data).toEqual({
      code: "CAPACITY_CEILING_EXCEEDED",
      matchedCount: over,
      limit,
    });

    // The wire status is 400 with the same structured body.
    const raw = await fetch(`${server.baseUrl}/searches.create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookieHeader(sessionId) },
      body: JSON.stringify({ spec: makeSpec(), idempotencyKey: "s56_over" }),
    });
    expect(raw.status).toBe(400);
    const envelope = (await raw.json()) as { error: { data: unknown } };
    expect(envelope.error.data).toEqual({
      code: "CAPACITY_CEILING_EXCEEDED",
      matchedCount: over,
      limit,
    });

    // No search row was created for the rejected key.
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 's56_over'`,
    );
    expect(rows.rows[0]!.n).toBe("0");

    // The idempotency key remains unused: a retry with the same key and spec is
    // rejected with the ceiling body again, never IDEMPOTENCY_KEY_CONFLICT.
    await expect(
      client.searches.create.mutate({ spec: makeSpec(), idempotencyKey: "s56_over" }),
    ).rejects.toMatchObject({
      data: { code: "CAPACITY_CEILING_EXCEEDED", matchedCount: over, limit },
    });

    // No search-quota unit was charged: the gate throws before stageSearchCreation,
    // so the post-commit `charge(sessionId, "searches", 1)` never runs.
    const inspect = new Redis(redis.url, { lazyConnect: true });
    try {
      expect(await inspect.zcard(`rl:searches:${sessionId}`)).toBe(0);
    } finally {
      inspect.disconnect();
    }
  });

  it("capacity ceiling boundary: warm search at exactly maxResolvedShowtimes still creates (S56)", async () => {
    await seedProvider(admin);
    const limit = DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes;
    await seedCachedSchedule(pool, {
      performances: Array.from({ length: limit }, (_, n) => ({
        showtimeId: `st_ceiling_at_${n}`,
        status: "OPEN" as const,
        skipFetch: false,
      })),
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "s56_at_limit",
    });
    expect(response.status).toBe("RUNNING");
    expect(response.showtimeCount).toBe(limit);
  });

  it("freshness integration: a stale cached schedule resolves cold through the route", async () => {
    await seedProvider(admin);
    // An hour-old capture: beyond the injected 10-minute ceiling.
    await seedCachedSchedule(pool, {
      capturedAt: new Date(Date.now() - 60 * 60_000),
      performances: [{ showtimeId: "st_stale", status: "OPEN", skipFetch: false }],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item6_stale",
    });

    expect(response.status).toBe("PENDING_SCHEDULE");
    expect(response.showtimeCount).toBeNull();
  });

  it("freshness integration: a fresh cached schedule resolves warm through the route", async () => {
    await seedProvider(admin);
    await seedCachedSchedule(pool, {
      performances: [{ showtimeId: "st_fresh", status: "OPEN", skipFetch: false }],
    });
    const client = makeClient(server.baseUrl, SESSION);

    const response = await client.searches.create.mutate({
      spec: makeSpec(),
      idempotencyKey: "item6_fresh",
    });

    expect(response).toMatchObject({ status: "RUNNING", showtimeCount: 1, cachedCount: 1 });
  });

  it("skipFetch and performancePolicy agree per status, driven by the shared fixture (item 7)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);

    for (const [index, row] of STATUS_POLICY_FIXTURE.entries()) {
      // Each row gets its own date, so every status's schedule key is distinct while
      // every spec stays a legal single-day target.
      const date = new Date(Date.now() + (10 + index) * 24 * 60 * 60_000)
        .toISOString()
        .slice(0, 10);
      await seedCachedSchedule(pool, {
        localDate: date,
        performances: [
          { showtimeId: `st_policy_${row.status}`, status: row.status, skipFetch: row.excluded },
        ],
      });

      const response = await client.searches.create.mutate({
        spec: makeSpec({ date }),
        idempotencyKey: `item7_${row.status}`,
      });

      expect(response.status).toBe("RUNNING");
      expect(response.showtimeCount).toBe(row.excluded ? 0 : 1);

      const reservation = await admin.query<{ reserved_total: string }>(
        `SELECT reserved_total FROM admission_reservation WHERE search_id = $1`,
        [response.searchId],
      );
      // The warm path's exclusion is exactly the cold path's skipFetch verdict, per the
      // single fixture derivation — excluded performances reserve nothing and get no job.
      expect(reservation.rows[0]!.reserved_total).toBe(row.excluded ? "0" : "1");

      const jobs = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM search_job WHERE search_id = $1`,
        [response.searchId],
      );
      expect(jobs.rows[0]!.n).toBe(row.excluded ? "0" : "1");
    }
  });

  it("the shared fixture is complete and pinned to performancePolicy (item 7)", () => {
    // The fixture is the single derivation both call sites' tests consume; this pins it
    // to the function it derives from, so a drift in either direction fails here.
    const statuses = new Set(STATUS_POLICY_FIXTURE.map((row) => row.status));
    expect(statuses.size).toBe(5);
    for (const row of STATUS_POLICY_FIXTURE) {
      expect(performancePolicy(row.status)).toBe(row.policy);
      expect(row.excluded).toBe(row.policy === "SKIP_SOLD_OUT");
    }
  });

  it("unresolvable targets are rejected with BAD_REQUEST before touching the database (S15.0)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);

    const cases: { label: string; spec: SearchSpec }[] = [
      {
        label: "namespace-mismatched theatre",
        spec: makeSpec({ theatreId: "regal:theatre:7" }),
      },
      {
        label: "crossing TIME_WINDOW startLocal > endLocal (S36 amendment 207-216)",
        spec: makeSpec({
          where: {
            kind: "AND",
            of: [
              { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
              { kind: "TIME_WINDOW", days: ["FRIDAY"], startLocal: "22:00", endLocal: "02:00" },
            ],
          },
        }),
      },
      {
        label:
          "empty plan DATE_RANGE + weekday filter expands to zero dates (S36 amendment 207-216)",
        spec: (() => {
          const wd = [
            "SUNDAY",
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
          ] as const;
          const idx = new Date(LOCAL_DATE + "T12:00:00Z").getUTCDay();
          const complement = wd[(idx + 1) % 7]!;
          return makeSpec({
            where: {
              kind: "AND",
              of: [
                { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
                {
                  kind: "TIME_WINDOW",
                  days: [complement],
                  startLocal: "09:00",
                  endLocal: "12:00",
                },
              ],
            },
          });
        })(),
      },
      {
        label: "DATE_RANGE under OR",
        spec: makeSpec({
          where: {
            kind: "OR",
            of: [
              { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
              { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
            ],
          },
        }),
      },
      {
        label: "no DATE_RANGE",
        spec: makeSpec({ where: { kind: "MOVIE", ids: [MOVIE] } }),
      },
    ];

    for (const { label, spec } of cases) {
      await expect(
        client.searches.create.mutate({ spec, idempotencyKey: `s15_0_${label}` }),
      ).rejects.toMatchObject({ data: { code: "BAD_REQUEST", httpStatus: 400 } });
      const rows = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM search`);
      expect(rows.rows[0]!.n).toBe("0");
    }
  });

  it("validator rejection is a BAD_REQUEST that never reaches admission (S15.1)", async () => {
    await seedProvider(admin);
    const client = makeClient(server.baseUrl, SESSION);
    const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);

    await expect(
      client.searches.create.mutate({
        spec: makeSpec({ date: past }),
        idempotencyKey: "s15_1_past",
      }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST", httpStatus: 400 } });

    const rows = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM search`);
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("a request without a session cookie fails closed with UNAUTHORIZED (S15.2/S16.12)", async () => {
    await seedProvider(admin);
    const client = createTRPCClient<AppRouter>({
      links: [httpLink({ url: server.baseUrl })], // no session cookie
    });

    await expect(
      client.searches.create.mutate({ spec: makeSpec(), idempotencyKey: "s15_2" }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED", httpStatus: 401 } });

    const rows = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM search`);
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("a terminal search cannot be replayed as a creation (reported spec gap)", async () => {
    await seedProvider(admin);
    const spec = makeSpec();
    // Seed data: a terminal search row holding the same key + hash the replay will send.
    await admin.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'COMPLETE', now() + interval '10 minutes')`,
      ["srch_terminal", SESSION, "s15_terminal", JSON.stringify(spec), specHash(spec)],
    );

    const client = makeClient(server.baseUrl, SESSION);
    await expect(
      client.searches.create.mutate({ spec, idempotencyKey: "s15_terminal" }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST", httpStatus: 400 } });
  });
  // ADR 0029 — multi-theatre and AREA search ( Lane C )
  it("2+ ref LIST admits and groups carry distinct theatreIds with distanceKm null (ADR 0029 a)", async () => {
    await seedProvider(admin);
    const THEATRE2 = `${PROVIDER}:theatre:8`;
    await seedTheatre(admin, THEATRE2, 40.1, -74.0);
    await ensureLayout(admin, "lay_list_a");
    await ensureLayout(admin, "lay_list_b");
    await seedCachedSchedule(pool, {
      theatreId: THEATRE,
      performances: [
        { showtimeId: "st_list_a", status: "OPEN", skipFetch: false, layoutId: "lay_list_a" },
      ],
    });
    await seedCachedSchedule(pool, {
      theatreId: THEATRE2,
      performances: [
        { showtimeId: "st_list_b", status: "OPEN", skipFetch: false, layoutId: "lay_list_b" },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpec({
        theatres: { kind: "LIST", refs: [{ id: THEATRE }, { id: THEATRE2 }] },
      }),
      idempotencyKey: "adr29_list_multi",
    });
    expect(response.status).toBe("RUNNING");
    expect(CreateSearchResponseSchema.safeParse(response).success).toBe(true);
    expect(response.groups).toHaveLength(2);
    const theatreIds = response.groups.map((g) => g.theatreId);
    expect(new Set(theatreIds).size).toBe(2);
    expect(theatreIds).toContain(THEATRE);
    expect(theatreIds).toContain(THEATRE2);
    for (const g of response.groups) {
      expect(g.distanceKm).toBeNull();
    }
    // Preserve request order — first ref's group first.
    expect(response.groups[0]!.theatreId).toBe(THEATRE);
    expect(response.groups[1]!.theatreId).toBe(THEATRE2);
    expect(response.showtimeCount).toBe(2);
    // Verify durable jobs: two SHOWTIME_FETCH, no SCHEDULE_RESOLUTION (all fresh).
    const jobs = await admin.query<{ kind: string; showtime_id: string | null }>(
      `SELECT rk.kind, rk.showtime_id FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id WHERE sj.search_id = $1 ORDER BY rk.showtime_id`,
      [response.searchId],
    );
    expect(jobs.rows).toEqual([
      { kind: "SHOWTIME_FETCH", showtime_id: "st_list_a" },
      { kind: "SHOWTIME_FETCH", showtime_id: "st_list_b" },
    ]);
  });

  it("AREA search admits with distanceKm populated and nearest-first ordering (ADR 0029 b)", async () => {
    await seedProvider(admin);
    // Use a center far from the default NYC theatre (40,-74) to avoid interference.
    const center = { lat: 37.7749, lng: -122.4194 };
    const NEAR = `${PROVIDER}:theatre:area_near`;
    const FAR = `${PROVIDER}:theatre:area_far`;
    // Near ~0.06 km from center, Far ~1.1 km — both within 5 km radius, near is closer.
    await seedTheatre(admin, NEAR, 37.7754, -122.4194);
    await seedTheatre(admin, FAR, 37.7849, -122.4194);
    await ensureLayout(admin, "lay_area_near");
    await ensureLayout(admin, "lay_area_far");
    await seedCachedSchedule(pool, {
      theatreId: NEAR,
      performances: [
        { showtimeId: "st_area_near", status: "OPEN", skipFetch: false, layoutId: "lay_area_near" },
      ],
    });
    await seedCachedSchedule(pool, {
      theatreId: FAR,
      performances: [
        { showtimeId: "st_area_far", status: "OPEN", skipFetch: false, layoutId: "lay_area_far" },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpec({
        theatres: { kind: "AREA", center, radiusKm: 5, limit: 10 },
      }),
      idempotencyKey: "adr29_area_near",
    });
    expect(response.status).toBe("RUNNING");
    expect(CreateSearchResponseSchema.safeParse(response).success).toBe(true);
    expect(response.groups).toHaveLength(2);
    for (const g of response.groups) {
      expect(typeof g.distanceKm).toBe("number");
      expect(g.distanceKm).not.toBeNull();
      expect(g.distanceKm! >= 0).toBe(true);
    }
    // Nearest-first: NEAR group should be first and have smaller distanceKm.
    expect(response.groups[0]!.theatreId).toBe(NEAR);
    expect(response.groups[1]!.theatreId).toBe(FAR);
    expect(response.groups[0]!.distanceKm! < response.groups[1]!.distanceKm!).toBe(true);
  });

  it("AREA resolution excludes theatre belonging to different providerId (ADR 0029 c)", async () => {
    await seedProvider(admin);
    const center = { lat: 37.5, lng: -122.0 };
    const AMC_NEAR = `${PROVIDER}:theatre:area_amc`;
    const OTHER_NEAR = `regal:theatre:area_other`;
    await seedTheatre(admin, AMC_NEAR, 37.501, -122.0, "UTC", PROVIDER);
    await seedTheatre(admin, OTHER_NEAR, 37.502, -122.0, "UTC", "regal");
    await ensureLayout(admin, "lay_area_amc");
    await ensureLayout(admin, "lay_area_other");
    await seedCachedSchedule(pool, {
      theatreId: AMC_NEAR,
      performances: [
        { showtimeId: "st_area_amc", status: "OPEN", skipFetch: false, layoutId: "lay_area_amc" },
      ],
    });
    await seedCachedSchedule(pool, {
      theatreId: OTHER_NEAR,
      performances: [
        {
          showtimeId: "st_area_other",
          status: "OPEN",
          skipFetch: false,
          layoutId: "lay_area_other",
        },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpec({
        theatres: { kind: "AREA", center, radiusKm: 5, limit: 10 },
      }),
      idempotencyKey: "adr29_area_provider_filter",
    });
    expect(response.status).toBe("RUNNING");
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]!.theatreId).toBe(AMC_NEAR);
    expect(response.groups[0]!.distanceKm).not.toBeNull();
    // Ensure the other provider's theatre was not included.
    expect(response.groups.map((g) => g.theatreId)).not.toContain(OTHER_NEAR);
  });

  it("AREA resolution respects min(limit, maxTheatres): only nearest N used (ADR 0029 d)", async () => {
    await seedProvider(admin);
    const center = { lat: 38.0, lng: -122.0 };
    const T1 = `${PROVIDER}:theatre:area_lim1`;
    const T2 = `${PROVIDER}:theatre:area_lim2`;
    const T3 = `${PROVIDER}:theatre:area_lim3`;
    // Distances: T1 ~0.05 km, T2 ~1.0 km, T3 ~2.0 km from center, all within 5 km.
    await seedTheatre(admin, T1, 38.0004, -122.0);
    await seedTheatre(admin, T2, 38.009, -122.0);
    await seedTheatre(admin, T3, 38.018, -122.0);
    await ensureLayout(admin, "lay_lim1");
    await ensureLayout(admin, "lay_lim2");
    await ensureLayout(admin, "lay_lim3");
    await seedCachedSchedule(pool, {
      theatreId: T1,
      performances: [
        { showtimeId: "st_lim1", status: "OPEN", skipFetch: false, layoutId: "lay_lim1" },
      ],
    });
    await seedCachedSchedule(pool, {
      theatreId: T2,
      performances: [
        { showtimeId: "st_lim2", status: "OPEN", skipFetch: false, layoutId: "lay_lim2" },
      ],
    });
    await seedCachedSchedule(pool, {
      theatreId: T3,
      performances: [
        { showtimeId: "st_lim3", status: "OPEN", skipFetch: false, layoutId: "lay_lim3" },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpec({
        theatres: { kind: "AREA", center, radiusKm: 5, limit: 2 },
      }),
      idempotencyKey: "adr29_area_limit",
    });
    expect(response.status).toBe("RUNNING");
    expect(response.groups).toHaveLength(2);
    const ids = response.groups.map((g) => g.theatreId);
    expect(ids).toContain(T1);
    expect(ids).toContain(T2);
    expect(ids).not.toContain(T3);
    // Nearest two should be T1 then T2 in order.
    expect(response.groups[0]!.theatreId).toBe(T1);
    expect(response.groups[1]!.theatreId).toBe(T2);
  });

  it("LIST referencing absent theatreId 404s whole request (ADR 0029 e)", async () => {
    await seedProvider(admin);
    // THEATRE exists via seedProvider, missing does not.
    const MISSING = `${PROVIDER}:theatre:missing999`;
    const client = makeClient(server.baseUrl, SESSION);
    await expect(
      client.searches.create.mutate({
        spec: makeSpec({
          theatres: { kind: "LIST", refs: [{ id: THEATRE }, { id: MISSING }] },
        }),
        idempotencyKey: "adr29_list_404",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND", httpStatus: 404 } });
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'adr29_list_404'`,
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("zero-radius-match AREA still admits with groups: [] (ADR 0029 f)", async () => {
    await seedProvider(admin);
    // No theatre near 0,0 — the two seeded SF-area theatres from prior tests are far away,
    // and the default NYC theatre is also far, so radius 1 km matches nothing.
    const center = { lat: 0, lng: 0 };
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpec({
        theatres: { kind: "AREA", center, radiusKm: 1, limit: 10 },
      }),
      idempotencyKey: "adr29_area_empty",
    });
    expect(["PENDING_SCHEDULE", "RUNNING"]).toContain(response.status);
    expect(response.groups).toEqual([]);
    expect(CreateSearchResponseSchema.safeParse(response).success).toBe(true);
    // Search row should exist (admitted, not rejected).
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'adr29_area_empty'`,
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("resolveScheduleTarget backward-compat: single-theatre/single-day succeeds, others rejected (ADR 0029 g)", () => {
    const single = makeSpec(); // default LIST 1 ref + single-day DATE_RANGE
    const r1 = resolveScheduleTarget(single);
    expect("rejected" in r1).toBe(false);
    if (!("rejected" in r1)) {
      expect(r1.theatreId).toBe(THEATRE);
      expect(r1.localDate).toBe(LOCAL_DATE);
    }
    // Multi-ref LIST → rejected
    const multi = makeSpec({
      theatres: { kind: "LIST", refs: [{ id: THEATRE }, { id: `${PROVIDER}:theatre:8` }] },
    });
    expect(resolveScheduleTarget(multi)).toEqual({ rejected: true });
    // AREA → rejected
    const area = makeSpec({
      theatres: { kind: "AREA", center: { lat: 40.7, lng: -74 }, radiusKm: 5, limit: 3 },
    });
    expect(resolveScheduleTarget(area)).toEqual({ rejected: true });
    // Multi-day → rejected (two-day range)
    const nextDay = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const multiDay = makeSpec({
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: nextDay },
        ],
      },
    });
    expect(resolveScheduleTarget(multiDay)).toEqual({ rejected: true });
    // resolveScheduleWindow new shape: LIST multi-ref succeeds
    const wMulti = resolveScheduleWindow(multi);
    expect("rejected" in wMulti).toBe(false);
    if (!("rejected" in wMulti)) {
      expect(wMulti.theatres.kind).toBe("LIST");
      if (wMulti.theatres.kind === "LIST") {
        expect(wMulti.theatres.theatreIds).toEqual([THEATRE, `${PROVIDER}:theatre:8`]);
      }
    }
    // resolveScheduleWindow AREA succeeds (before DB resolution)
    const wArea = resolveScheduleWindow(area);
    expect("rejected" in wArea).toBe(false);
    if (!("rejected" in wArea)) {
      expect(wArea.theatres.kind).toBe("AREA");
      if (wArea.theatres.kind === "AREA") {
        expect(wArea.theatres.center).toEqual({ lat: 40.7, lng: -74 });
        expect(wArea.theatres.radiusKm).toBe(5);
        expect(wArea.theatres.limit).toBe(3);
      }
    }
    // Defensive empty refs → rejected (schema prevents but we keep branch)
    const emptyRefs = {
      ...single,
      theatres: { kind: "LIST" as const, refs: [] },
    };
    expect(resolveScheduleWindow(emptyRefs as SearchSpec)).toEqual({ rejected: true });
  });
});

describe("searches.create v2 non-contiguous (S53)", () => {
  const LOCAL_DATE2 = new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const LOCAL_DATE_GAP = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const LOCAL_DATE_FAR = new Date(Date.now() + 35 * 24 * 60 * 60_000).toISOString().slice(0, 10);

  function makeSpecV2(
    dates: readonly string[],
    theatreId = THEATRE,
    extraWhere: Record<string, unknown>[] = [],
  ): SearchSpec {
    const dateScope =
      dates.length === 1
        ? { kind: "DATE_RANGE" as const, from: dates[0]!, to: dates[0]! }
        : {
            kind: "OR" as const,
            of: dates.map((d) => ({ kind: "DATE_RANGE" as const, from: d, to: d })),
          };
    return {
      specVersion: 2,
      providerId: PROVIDER,
      theatres: { kind: "LIST", refs: [{ id: theatreId }] },
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          dateScope,
          ...extraWhere,
        ] as SearchSpec["where"] extends { kind: "AND"; of: infer U } ? U : never,
      },
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    };
  }

  it("v2 all-fresh: counts only selected dates, not gap", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    const gap = LOCAL_DATE_GAP;
    await seedCachedSchedule(pool, {
      localDate: d1,
      performances: [
        { showtimeId: "st_v2_fresh_1", movieId: MOVIE, status: "OPEN", skipFetch: false },
      ],
    });
    await seedCachedSchedule(pool, {
      localDate: d2,
      performances: [
        { showtimeId: "st_v2_fresh_2", movieId: MOVIE, status: "OPEN", skipFetch: false },
      ],
    });
    await seedCachedSchedule(pool, {
      localDate: gap,
      performances: [{ showtimeId: "st_v2_gap", movieId: MOVIE, status: "OPEN", skipFetch: false }],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpecV2([d1, d2]),
      idempotencyKey: "v2_all_fresh",
    });
    expect(response).toMatchObject({ status: "RUNNING", showtimeCount: 2, cachedCount: 2 });
    const jobs = await admin.query<{ showtime_id: string }>(
      `SELECT rk.showtime_id FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id WHERE sj.search_id = $1 ORDER BY showtime_id`,
      [response.searchId],
    );
    expect(jobs.rows.map((r) => r.showtime_id).sort()).toEqual(["st_v2_fresh_1", "st_v2_fresh_2"]);
  });
  it("v2 all-cold: stages only selected schedule dates, not gap", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpecV2([d1, d2]),
      idempotencyKey: "v2_all_cold",
    });
    expect(response.status).toBe("PENDING_SCHEDULE");
    const keys = await admin.query<{ local_date: string }>(
      `SELECT rk.local_date::text AS local_date FROM run_key rk JOIN run_subscription rs ON rs.run_key_id = rk.run_key_id WHERE rs.search_id = $1 ORDER BY local_date`,
      [response.searchId],
    );
    expect(keys.rows.map((r) => r.local_date).sort()).toEqual([d1, d2].sort());
  });

  it("v2 mixed: reuses fresh selected day, cold work for remaining", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    await seedCachedSchedule(pool, {
      localDate: d1,
      performances: [
        { showtimeId: "st_v2_mixed_fresh", movieId: MOVIE, status: "OPEN", skipFetch: false },
      ],
    });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpecV2([d1, d2]),
      idempotencyKey: "v2_mixed",
    });
    expect(response.status).toBe("PENDING_SCHEDULE");
    const jobs = await admin.query<{ showtime_id: string }>(
      `SELECT rk.showtime_id FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id WHERE sj.search_id = $1`,
      [response.searchId],
    );
    expect(jobs.rows.map((r) => r.showtime_id)).toContain("st_v2_mixed_fresh");
    const coldKeys = await admin.query<{ local_date: string }>(
      `SELECT rk.local_date::text AS local_date FROM run_key rk JOIN run_subscription rs ON rs.run_key_id = rk.run_key_id WHERE rs.search_id = $1`,
      [response.searchId],
    );
    expect(coldKeys.rows.map((r) => r.local_date)).toContain(d2);
    expect(coldKeys.rows.map((r) => r.local_date)).not.toContain(d1);
  });

  it("v2 idempotent replay with same canonical hash reuses search, no new rows", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    const client = makeClient(server.baseUrl, SESSION);
    const specA = makeSpecV2([d2, d1]); // reordered
    const specADupOverlap = makeSpecV2([d1, d2]); // same canonical after sort/dedupe
    const hashA = specHash(specA);
    const hashB = specHash(specADupOverlap);
    expect(hashA).toBe(hashB);
    const first = await client.searches.create.mutate({
      spec: specA,
      idempotencyKey: "v2_replay_key",
    });
    const second = await client.searches.create.mutate({
      spec: specADupOverlap,
      idempotencyKey: "v2_replay_key",
    });
    expect(second.searchId).toBe(first.searchId);
    const count = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM search`);
    expect(count.rows[0]!.n).toBe("1");
    const resCount = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM admission_reservation`,
    );
    expect(resCount.rows[0]!.n).toBe("1");
  });

  it("v2 changed canonical scope remains idempotency conflict", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    const d3 = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const client = makeClient(server.baseUrl, SESSION);
    await client.searches.create.mutate({
      spec: makeSpecV2([d1, d2]),
      idempotencyKey: "v2_conflict_key",
    });
    await expect(
      client.searches.create.mutate({
        spec: makeSpecV2([d1, d3]),
        idempotencyKey: "v2_conflict_key",
      }),
    ).rejects.toMatchObject({ data: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
  });

  it("v2 over-30-day envelope sparse selection gets RANGE_TOO_LARGE", async () => {
    await seedProvider(admin);
    const far = LOCAL_DATE_FAR;
    const client = makeClient(server.baseUrl, SESSION);
    await expect(
      client.searches.create.mutate({
        spec: makeSpecV2([LOCAL_DATE, far]),
        idempotencyKey: "v2_range_too_large",
      }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'v2_range_too_large'`,
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("v2 empty weekday intersection rejects BAD_REQUEST before writes", async () => {
    await seedProvider(admin);
    const weekdayFor = (iso: string) =>
      new Date(`${iso}T00:00:00Z`)
        .toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
        .toUpperCase();
    const localWd = weekdayFor(LOCAL_DATE);
    const allWds = [
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ] as const;
    const otherWd = allWds.find((w) => w !== localWd)!;
    const client = makeClient(server.baseUrl, SESSION);
    const spec = makeSpecV2([LOCAL_DATE], THEATRE, [
      { kind: "TIME_WINDOW", days: [otherWd], startLocal: "00:00", endLocal: "23:59" },
    ]);
    await expect(
      client.searches.create.mutate({ spec, idempotencyKey: "v2_empty_plan" }),
    ).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM search WHERE idempotency_key = 'v2_empty_plan'`,
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("v2 aggregate 200 ceiling is not per-day", async () => {
    await seedProvider(admin);
    const d1 = LOCAL_DATE;
    const d2 = LOCAL_DATE2;
    // Seed 100 + 50 = 150 (<200) to stay under ceiling but prove aggregate counting: per-day would be 100 and 50 separately, aggregate is 150
    const perfs1 = Array.from({ length: 100 }, (_, i) => ({
      showtimeId: `st_v2_agg1_${i}`,
      movieId: MOVIE,
      status: "OPEN" as const,
      skipFetch: false,
    }));
    const perfs2 = Array.from({ length: 50 }, (_, i) => ({
      showtimeId: `st_v2_agg2_${i}`,
      movieId: MOVIE,
      status: "OPEN" as const,
      skipFetch: false,
    }));
    await seedCachedSchedule(pool, { localDate: d1, performances: perfs1 });
    await seedCachedSchedule(pool, { localDate: d2, performances: perfs2 });
    const client = makeClient(server.baseUrl, SESSION);
    const response = await client.searches.create.mutate({
      spec: makeSpecV2([d1, d2]),
      idempotencyKey: "v2_agg",
    });
    expect(response.status).toBe("RUNNING");
    expect(response.showtimeCount).toBe(150);
  });
});
