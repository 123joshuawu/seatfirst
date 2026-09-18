import { createTRPCClient, httpLink } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { IanaTimezoneSchema, toTheatreLocal, UtcInstantSchema } from "@seatfirst/core";
import {
  B2_LEASE_RUN,
  B4_PREDISPATCH,
  poolClient,
  stageScheduleAcceptance,
  upsertTheatre,
  withTransaction,
} from "@seatfirst/durability";
import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import { __setRefreshScheduleTuningForTests } from "../src/routes/theatres/refreshSchedule.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";

import { startTestPostgres, startTestRedis } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
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

/**
 * S63.8 verification, over HTTP against a real Fastify server and real Postgres:
 * `trpc.theatres.refreshSchedule({ theatreId })` stages a bounded single-date (D+0)
 * SCHEDULE_RESOLUTION run and polls it to a terminal outcome.
 *
 * No real fetch-worker runs in this suite — the worker is simulated with the exact
 * boundary sequence the actor uses (B2 lease → B4 pre-dispatch →
 * `stageScheduleAcceptance`, which terminalizes the run via B5A_FENCE), applied from
 * the test once the route's staging commit becomes visible. The timeout path stages
 * nothing further and relies on the injected short bound.
 */

const PROVIDER = "amc";
const THEATRE = `${PROVIDER}:theatre:refresh`;
const TIMEZONE = "America/Chicago";
const FRESHNESS_MS = 10 * 60_000;
const RETRY_AFTER_SECONDS = 30;

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startServer(db: Pool, redisUrl: string): Promise<TestServer> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  const fastify = buildApp({
    db,
    searchLimits: {
      maxDateSpanDays: 3,
      maxResolvedShowtimes: 200,
      maxPartySize: 8,
      maxTheatres: 50,
      areaSelectorEnabled: false,
      maxAreaRadiusKm: 40,
      splitGroupEnabled: false,
      maxPredicateDepth: 4,
      maxPredicateNodes: 8,
      maxRegionDepth: 3,
      maxRegionNodes: 8,
    },
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

function makeClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({ links: [httpLink({ url: baseUrl })] });
}

/** Mirrors `theatres.movies.test.ts`'s `seedProvider`: the fence `RUN_CREATE` joins on. */
async function seedProvider(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    [PROVIDER, 1000, 100],
  );
  await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
}

const seenAt = new Date("2026-08-01T00:00:00.000Z");

async function seedTheatre(pool: Pool): Promise<void> {
  await upsertTheatre(poolClient(pool), {
    theatreId: THEATRE,
    providerId: PROVIDER,
    name: "Refresh Theatre",
    lat: 41,
    lng: -87,
    marketSlug: null,
    timezone: TIMEZONE,
    city: null,
    address: null,
    slugs: { detail: THEATRE },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
}

/** Today in the theatre's timezone — the D+0 the route must refresh and echo. */
function expectedLocalDate(): string {
  return toTheatreLocal(
    UtcInstantSchema.parse(new Date().toISOString()),
    IanaTimezoneSchema.parse(TIMEZONE),
  ).localDate;
}

/**
 * Waits until the route's staging commit becomes visible, then returns its run id.
 * Matches by theatre (not by predicted date) so the test never duplicates the
 * route's own D+0 derivation.
 */
async function waitForStagedRun(pool: Pool, theatreId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await pool.query<{ run_id: string }>(
      `SELECT pr.run_id AS run_id
       FROM provider_run pr JOIN run_key k USING (run_key_id)
       WHERE k.theatre_id = $1
       ORDER BY pr.created_at DESC LIMIT 1`,
      [theatreId],
    );
    const found = result.rows[0]?.run_id;
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for refreshSchedule to stage its run");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface WorkerShow {
  readonly showtimeId: string;
  readonly movieId: string;
  readonly startsAt: Date;
}

/**
 * Simulates the fetch-worker completing the staged run: B2 lease → B4 pre-dispatch →
 * `stageScheduleAcceptance` (B5A_FENCE terminalizes LEASED → DONE). Empty `shows`
 * means `EMPTY_RESOLVED`. No search subscribes, so fan-in/expansion are no-ops.
 */
async function completeRunAsWorker(
  pool: Pool,
  runId: string,
  shows: readonly WorkerShow[],
): Promise<void> {
  const sql = poolClient(pool);
  const leased = (await sql.query(B2_LEASE_RUN.text, [runId, "5 minutes"])).rows[0] as
    { generation: number } | undefined;
  if (leased === undefined) {
    throw new Error(`worker simulation could not lease run ${runId}`);
  }
  await sql.query(B4_PREDISPATCH.text, [runId, leased.generation]);
  await withTransaction(pool, (tx) =>
    stageScheduleAcceptance(
      tx,
      { runId, generation: leased.generation },
      shows.map((show) => ({
        showtimeId: show.showtimeId,
        movieId: show.movieId,
        startsAt: show.startsAt,
        skipFetch: false,
      })),
      { capturedAt: new Date() },
    ),
  );
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let redis: Awaited<ReturnType<typeof startTestRedis>>;
let server: TestServer;
let pool: Pool;
let admin: Client;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  server = await startServer(pool, redis.url);
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
     provider_run, observation, admission_reservation, search_job, run_subscription,
     theatre, movie, tmdb_movie, tmdb_fetch, tmdb_prewarm_state CASCADE`,
  );
  await seedProvider(admin);
  await seedTheatre(pool);
  // Fast deterministic bound for every test (production default is 20 s — the
  // suite must never wait it out); the timeout test below narrows it further.
  __setRefreshScheduleTuningForTests({ deadlineMs: 5_000, pollIntervalMs: 25 });
});

afterEach(() => {
  __setRefreshScheduleTuningForTests(null);
});

describe("theatres.refreshSchedule (S63.5/S63.8)", () => {
  it("returns RESOLVED with the D+0 localDate when the run resolves with performances", async () => {
    const client = makeClient(server.baseUrl);
    const pending = client.theatres.refreshSchedule.mutate({ theatreId: THEATRE });
    const runId = await waitForStagedRun(pool, THEATRE);
    await completeRunAsWorker(pool, runId, [
      {
        showtimeId: `${PROVIDER}:showtime:refresh-1`,
        movieId: `${PROVIDER}:movie:refresh-1`,
        startsAt: new Date("2026-08-20T19:00:00.000Z"),
      },
    ]);
    const body = await pending;
    expect(body).toEqual({ status: "RESOLVED", localDate: expectedLocalDate() });
  });

  it("returns EMPTY when the run resolves with zero performances", async () => {
    const client = makeClient(server.baseUrl);
    const pending = client.theatres.refreshSchedule.mutate({ theatreId: THEATRE });
    const runId = await waitForStagedRun(pool, THEATRE);
    await completeRunAsWorker(pool, runId, []);
    const body = await pending;
    expect(body).toEqual({ status: "EMPTY", localDate: expectedLocalDate() });
  });

  it("returns FAILED when the run fails", async () => {
    const client = makeClient(server.baseUrl);
    const pending = client.theatres.refreshSchedule.mutate({ theatreId: THEATRE });
    const runId = await waitForStagedRun(pool, THEATRE);
    await admin.query(
      `UPDATE provider_run SET state = 'FAILED', fail_cause = 'test-failure' WHERE run_id = $1`,
      [runId],
    );
    const body = await pending;
    expect(body).toEqual({ status: "FAILED", localDate: expectedLocalDate() });
  });

  it("returns FAILED (not a hang) when the bound elapses with the run still pending", async () => {
    __setRefreshScheduleTuningForTests({ deadlineMs: 300, pollIntervalMs: 25 });
    const client = makeClient(server.baseUrl);
    const startedAt = Date.now();
    // No worker simulation: the run stays PENDING until the injected bound.
    const body = await client.theatres.refreshSchedule.mutate({ theatreId: THEATRE });
    expect(body).toEqual({ status: "FAILED", localDate: expectedLocalDate() });
    // Sanity: the suite waited out the injected 300 ms bound, not the 20 s production one.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("404s for an unknown theatre with the boundary's zeroRowsMeans", async () => {
    const client = makeClient(server.baseUrl);
    await expect(
      client.theatres.refreshSchedule.mutate({ theatreId: "amc:theatre:missing" }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND", httpStatus: 404 } });
  });
});
