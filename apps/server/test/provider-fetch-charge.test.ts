/**
 * S16 verification item 5 — the weighted fetch charge at the dispatch layer, exactly
 * once per applied subscriber (S16.14): one SHOWTIME_FETCH run with 3 live subscribers
 * charges each subscriber's `fetches` window by exactly 1; re-running the application
 * (an idempotent re-apply on the same run key) adds zero; a SCHEDULE_RESOLUTION run
 * charges its subscribers 1 each.
 *
 * Same infrastructure as the S8 suite (`provider-fetch-actor.test.ts`): real Postgres 16
 * + Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`), a real Chrome via
 * `BrowserSupervisor`, and P6's offline synthetic corridor (never live AMC traffic). The
 * suite skips when no Chrome binary is found — CI's pinned browser test image (I1)
 * supplies it. The actor's `chargeSubscriberFetch` seam is wired to a recording
 * function that ALSO charges a real `SessionRateLimiter` over the shared Redis, so the
 * assertions observe the real `rl:fetches:{sessionId}` windows.
 */
import { buildAuditoriumLayout } from "@seatfirst/core";
import { B2_LEASE_RUN, poolClient, runStatement } from "@seatfirst/durability";
import { BrowserSupervisor, startReadinessServer } from "@seatfirst/browser-runtime";
import type { ReadinessServer } from "@seatfirst/browser-runtime";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunKeyKind } from "../src/dispatch/queries.js";
import { findRunContext } from "../src/dispatch/queries.js";
import { createScheduleResolutionRunHandler } from "../src/dispatch/handlers/run-schedule-resolution.js";
import { createShowtimeFetchRunHandler } from "../src/dispatch/handlers/run-showtime-fetch.js";
import type {
  ParseResult,
  ProviderFetchActorDeps,
} from "../src/dispatch/handlers/provider-fetch-actor.js";
import { providerStateSourceFromPool } from "../src/dispatch/handlers/provider-fetch-actor.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";
import type { SessionRateLimitConfig } from "../src/session/limiter.js";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
  corridorHops,
  createSyntheticHarness,
  findChromeExecutable,
  MOVIES,
  RecordingRedis,
} from "./support/synthetic-corridor.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — provider-fetch-charge suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers (gate 14); same figures as the S8 suite.
const LEASE_TTL = "30 seconds";
const RUN_LEASE_TTL = "30 seconds";
const SEMAPHORE_TTL_MS = 60_000;
const HEARTBEAT_MS = 250;
const MAX_ATTEMPTS = 1;
const NAV_MS = 20_000;
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;
const USER_AGENT = "SeatFinder-Test/1.0 (+https://example.invalid/contact)";

/** The fetches window this suite charges: ADR 0006 §A.6's 600/hr (weighted). */
const RATE_CONFIG: SessionRateLimitConfig = {
  searches: { limit: 20, windowMs: 3_600_000 },
  fetches: { limit: 600, windowMs: 3_600_000 },
  recheck: { limit: 10, windowMs: 60_000 },
  facetCounts: { limit: 10_000, windowMs: 60_000 },
  resolvePlace: { limit: 10_000, windowMs: 60_000 },
  suggestPlace: { limit: 30, windowMs: 60_000 },
  facetCountMaxCandidates: 40,
  concurrentSearches: 3,
  breachWindowMs: 60_000,
};

const PARSED_BITMAP = new Uint8Array([0b1100_0011, 0b0000_1111]);

/** ADR 0032: the SHOWTIME_FETCH parse seam now requires a built layout (mechanical type
 * consequence of widening ParseResult); built through the real builder like production. */
const FIXTURE_LAYOUT = buildAuditoriumLayout({
  rows: 1,
  columns: 2,
  cells: [
    { row: 1, column: 1, kind: "STANDARD", available: true, visible: true },
    { row: 1, column: 2, kind: "STANDARD", available: false, visible: true },
  ],
}).layout;
const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

interface SeededWorld {
  readonly providerId: string;
  readonly runKeyId: string;
  readonly runId: string;
  readonly searchIds: readonly string[];
  readonly sessionIds: readonly string[];
}

/** Seeds a SHOWTIME_FETCH run with N live subscribers (the S8 suite's seed shape). */
async function seedFetchWorld(pool: Pool, subscriberCount: number): Promise<SeededWorld> {
  const providerId = uniq("provider");
  const runKeyId = uniq("key");
  const runId = uniq("run");
  const showtimeId = uniq("showtime");
  await pool.query(`INSERT INTO provider_fence (provider_id, epoch) VALUES ($1, 0)`, [providerId]);
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
    [runKeyId, providerId, showtimeId],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
     VALUES ($1, $2, $3, 0)`,
    [runId, runKeyId, uniq("obs")],
  );
  // B5(c)'s layout write (ADR 0032) updates the performance row the showtime already
  // has from an earlier schedule acceptance — scaffold that prior acceptance so the
  // acceptance's layout update finds its row.
  const schedKeyId = uniq("sched-key");
  const schedRunId = uniq("sched-run");
  const schedObsId = uniq("sched-obs");
  const schedTheatreId = uniq("theatre");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
    [schedKeyId, providerId, schedTheatreId, "2026-08-20"],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
     VALUES ($1, $2, $3, 0)`,
    [schedRunId, schedKeyId, schedObsId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, now(), 0)`,
    [schedObsId, schedKeyId, schedRunId],
  );
  await pool.query(
    `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at, observation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [showtimeId, providerId, schedTheatreId, "2026-08-21", FUTURE, schedObsId],
  );

  const searchIds: string[] = [];
  const sessionIds: string[] = [];
  for (let i = 0; i < subscriberCount; i++) {
    const searchId = uniq("search");
    const sessionId = uniq("session");
    searchIds.push(searchId);
    sessionIds.push(sessionId);
    await pool.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'RUNNING', $5)`,
      [searchId, sessionId, uniq("idem"), `hash_${searchId}`, FUTURE],
    );
    const jobId = uniq("job");
    await pool.query(
      `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
       VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'PENDING', $4)`,
      [jobId, searchId, runKeyId, FUTURE],
    );
    await pool.query(
      `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at)
       VALUES ($1, $2, $3, 'LIVE', $4)`,
      [runKeyId, searchId, jobId, FUTURE],
    );
  }

  return { providerId, runKeyId, runId, searchIds, sessionIds };
}

/** Seeds a SCHEDULE_RESOLUTION run with one cold subscriber (S8's schedule seed shape). */
async function seedScheduleWorld(pool: Pool): Promise<SeededWorld> {
  const providerId = uniq("provider");
  const runKeyId = uniq("key");
  const runId = uniq("run");
  await pool.query(`INSERT INTO provider_fence (provider_id, epoch) VALUES ($1, 0)`, [providerId]);
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
    [runKeyId, providerId, uniq("theatre"), "2026-08-20"],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
     VALUES ($1, $2, $3, 0)`,
    [runId, runKeyId, uniq("obs")],
  );

  const searchId = uniq("search");
  const sessionId = uniq("session");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'RUNNING', $5)`,
    [searchId, sessionId, uniq("idem"), `hash_${searchId}`, FUTURE],
  );
  await pool.query(
    `INSERT INTO provider_admission (provider_id, pending_cost, pending_cost_limit, unresolved_schedules, unresolved_limit)
     VALUES ($1, 1, 1000, 1, 100)`,
    [providerId],
  );
  await pool.query(
    `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled)
     VALUES ($1, $2, 1, 1, true, 0, false)`,
    [searchId, providerId],
  );
  const jobId = uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, 'SCHEDULE_RESOLUTION', $3, 0, 'PENDING', $4)`,
    [jobId, searchId, runKeyId, FUTURE],
  );
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at, schedule_match_count)
     VALUES ($1, $2, $3, 'LIVE', $4, NULL)`,
    [runKeyId, searchId, jobId, FUTURE],
  );

  return { providerId, runKeyId, runId, searchIds: [searchId], sessionIds: [sessionId] };
}

let pg: TestService;
let redisService: TestService;
let pool: Pool;
let redisClient: Redis;
let readiness: ReadinessServer;
let supervisor: BrowserSupervisor;

beforeAll(async () => {
  pg = await startTestPostgres();
  redisService = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  redisClient = new Redis(redisService.url);

  if (chromeExecutable !== null) {
    readiness = await startReadinessServer();
    supervisor = await BrowserSupervisor.start({
      executablePath: chromeExecutable,
      egressIdentityLabel: "test-relay-eip-label",
      providerId: "amc",
      cleanupGracePeriodMs: GRACE_MS,
      readinessTimeoutMs: READINESS_MS,
      readinessTargetUrl: readiness.baseUrl,
    });
  }
});

afterAll(async () => {
  await Promise.allSettled([redisClient.quit(), pool.end()]);
  if (chromeExecutable !== null) {
    await Promise.allSettled([supervisor.shutdown(), readiness.close()]);
  }
  await Promise.allSettled([pg.stop(), redisService.stop()]);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE search, run_key, provider_fence, provider_status, provider_admission CASCADE",
  );
});

const db = () => poolClient(pool);

const messages: string[] = [];
const logger: SeatfirstLogger = (() => {
  const record = (_fields: Record<string, unknown>, message: string): void => {
    messages.push(message);
  };
  const quiet = (): void => undefined;
  const build = (): SeatfirstLogger => ({
    trace: quiet,
    debug: quiet,
    info: quiet,
    warn: record,
    error: record,
    fatal: record,
    child: () => build(),
  });
  return build();
})();

/** The charge seam: records every subscriber session AND charges the real window. */
function makeChargeSeam(chargedSessions: string[]) {
  const limiter = createSessionRateLimiter({
    redis: redisScriptExecutorFromIoredis(redisClient),
    config: RATE_CONFIG,
  });
  return {
    limiter,
    seam: async (sessionId: string): Promise<void> => {
      chargedSessions.push(sessionId);
      await limiter.charge(sessionId, "fetches", 1);
    },
  };
}

function makeDeps(opts: {
  harness: ReturnType<typeof createSyntheticHarness>;
  parse: ProviderFetchActorDeps["parseObservation"];
  chargeSubscriberFetch: (sessionId: string) => Promise<void>;
}): ProviderFetchActorDeps {
  return {
    pool,
    redis: new RecordingRedis(redisClient),
    controlSource: providerStateSourceFromPool(pool),
    supervisor,
    userAgent: USER_AGENT,
    navigationLimits: { navigationTimeoutMs: NAV_MS },
    semaphoreTtlMs: SEMAPHORE_TTL_MS,
    heartbeatIntervalMs: HEARTBEAT_MS,
    runLeaseTtl: RUN_LEASE_TTL,
    maxAttempts: MAX_ATTEMPTS,
    buildTargetUrl: () => Promise.resolve(MOVIES),
    parseObservation: opts.parse,
    navigationSeams: { fetchHop: opts.harness.fetchHop },
    chargeSubscriberFetch: opts.chargeSubscriberFetch,
  };
}

/** Leases through the real B2 statement, then drives the real RUN handler directly. */
async function driveRun(deps: ProviderFetchActorDeps, runId: string, kind: RunKeyKind) {
  const leased = await runStatement(db(), B2_LEASE_RUN, [runId, LEASE_TTL]);
  if (leased.length === 0) {
    throw new Error(`run ${runId} did not lease`);
  }
  const ctx = await findRunContext(db(), runId);
  if (ctx === null) {
    throw new Error(`run context ${runId} missing after lease`);
  }
  const handler =
    kind === "SHOWTIME_FETCH"
      ? createShowtimeFetchRunHandler(deps)
      : createScheduleResolutionRunHandler(deps);
  await handler({
    run: ctx.run,
    search: ctx.search,
    runKey: ctx.runKey,
    sqlClient: db(),
    logger,
  });
}

describe.skipIf(chromeExecutable === null)("provider fetch charge (S16.14)", () => {
  it("SHOWTIME_FETCH: 3 live subscribers → each subscriber's fetches window grows by exactly 1", async () => {
    const world = await seedFetchWorld(pool, 3);
    const chargedSessions: string[] = [];
    const { seam } = makeChargeSeam(chargedSessions);
    const harness = createSyntheticHarness(corridorHops());
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          bitmap: PARSED_BITMAP,
          freeCount: 7,
          layout: FIXTURE_LAYOUT,
        } satisfies ParseResult),
      chargeSubscriberFetch: seam,
    });

    await driveRun(deps, world.runId, "SHOWTIME_FETCH");

    expect([...chargedSessions].sort()).toEqual([...world.sessionIds].sort());
    for (const sessionId of world.sessionIds) {
      expect(await redisClient.zcard(`rl:fetches:${sessionId}`)).toBe(1);
    }
  });

  it("SHOWTIME_FETCH idempotent re-apply: a second run over the same key adds zero charges", async () => {
    const world = await seedFetchWorld(pool, 2);
    const chargedSessions: string[] = [];
    const { seam } = makeChargeSeam(chargedSessions);
    const harness = createSyntheticHarness(corridorHops());
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          bitmap: PARSED_BITMAP,
          freeCount: 7,
          layout: FIXTURE_LAYOUT,
        } satisfies ParseResult),
      chargeSubscriberFetch: seam,
    });

    await driveRun(deps, world.runId, "SHOWTIME_FETCH");
    expect(chargedSessions).toHaveLength(2);

    // Re-running the application: a fresh run over the SAME run key. The subscribers
    // already transitioned (fan-in is transition-only), so the re-apply charges zero.
    await pool.query(
      `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
       VALUES ($1, $2, $3, 0)`,
      [uniq("run"), world.runKeyId, uniq("obs")],
    );
    const reRunId = (
      await pool.query<{ run_id: string }>(
        `SELECT run_id FROM provider_run WHERE run_key_id = $1 ORDER BY run_id DESC LIMIT 1`,
        [world.runKeyId],
      )
    ).rows[0]!.run_id;
    await driveRun(deps, reRunId, "SHOWTIME_FETCH");

    expect(chargedSessions).toHaveLength(2);
    for (const sessionId of world.sessionIds) {
      expect(await redisClient.zcard(`rl:fetches:${sessionId}`)).toBe(1);
    }
  });

  it("SCHEDULE_RESOLUTION: charges its subscriber 1", async () => {
    const world = await seedScheduleWorld(pool);
    const chargedSessions: string[] = [];
    const { seam } = makeChargeSeam(chargedSessions);
    const harness = createSyntheticHarness(corridorHops());
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: [
            {
              showtimeId: "st-1",
              startsAt: new Date("2026-08-20T18:30:00.000Z"),
              attributes: ["IMAX"],
              status: "OPEN",
              // Namespaced under the run's providerId so the S24 movie-catalogue upsert on
              // every SCHEDULE_RESOLUTION acceptance satisfies the movie table's id CHECKs.
              movieId: `${world.providerId}:movie:1`,
              movieTitle: "The Odyssey",
              auditorium: null,
              utcOffset: "-05:00",
              runtimeMinutes: 120,
              formatCode: "IMAX",
              deepLinkUrl: "https://example.invalid/showtimes/st-1",
              providerMeta: {},
            },
          ],
        } satisfies ParseResult),
      chargeSubscriberFetch: seam,
    });

    await driveRun(deps, world.runId, "SCHEDULE_RESOLUTION");

    expect(chargedSessions).toEqual(world.sessionIds);
    expect(await redisClient.zcard(`rl:fetches:${world.sessionIds[0]}`)).toBe(1);
  });
});
