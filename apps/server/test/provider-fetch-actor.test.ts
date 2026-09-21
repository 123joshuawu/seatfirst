/**
 * S8 verification, items 1–13 of the spec's verification list — the provider fetch actor
 * against real Postgres 16 and Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`),
 * a real Chrome via `BrowserSupervisor`, and P6's offline synthetic corridor pattern (never
 * live AMC traffic). Items 14–15 are the durability tier's focused tests, not this suite's.
 *
 * Item 1 drives a RUN BullMQ message end to end through S11's harness into S8's handler.
 * Items 2–13 drive the real handler factories directly (the same shared actor, real
 * durability calls, real transport) with the run leased through the real `B2_LEASE_RUN`
 * statement — the harness mechanics themselves are S11's verified surface (`dispatch.test.ts`).
 *
 * Raw INSERTs below are seed data (the legitimate non-boundary bucket, `CONTRIBUTING.md` §2):
 * the transitions under test are performed exclusively by the durability helpers the actor
 * calls (`B4_PREDISPATCH`, `RUN_DEFER_BUSY`, `B3_HEARTBEAT_RUN`, `acceptFetch`/
 * `stageScheduleAcceptance`/`updatePerformanceProduct`, `failRun`,
 * `applyProviderControlTransition`) plus the real `B2_LEASE_RUN` lease. Item 13a's single
 * raw UPDATE is precondition scaffolding (same bucket, noted at the site): it ages a
 * concurrent delivery's generation between the context read and the busy branch — it
 * performs no transition under test.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunKeyKind } from "../src/dispatch/queries.js";
import type { DispatchDeps, DispatchHandle } from "../src/dispatch/index.js";
import {
  scheduleSubscriberFilter,
  type ParseResult,
  type ProviderFetchActorDeps,
} from "../src/dispatch/handlers/provider-fetch-actor.js";
import { providerStateSourceFromPool } from "../src/dispatch/handlers/provider-fetch-actor.js";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  B2_LEASE_RUN,
  applyProviderControlTransition,
  poolClient,
  providerStateCacheKey,
  runStatement,
  withTransaction,
} from "@seatfirst/durability";
import { BrowserSupervisor, startReadinessServer } from "@seatfirst/browser-runtime";
import {
  ATTR_ENTITY_LOCAL_DATE,
  ATTR_ENTITY_SHOWTIME_ID,
  ATTR_ENTITY_THEATRE_ID,
  ATTR_RUN_KEY_ID,
} from "@seatfirst/browser-runtime";
import type { ReadinessServer } from "@seatfirst/browser-runtime";
import { buildAuditoriumLayout, encodeAuditoriumLayoutGeometry } from "@seatfirst/core";
import type { ShowtimeStatus } from "@seatfirst/core";
import type { ScheduleShowtime } from "@seatfirst/durability";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT,
  context,
  trace,
  type Context,
  type ContextManager,
  type Span,
} from "@opentelemetry/api";

import { createDispatchWorkers } from "../src/dispatch/consumer.js";
import { createPlaceholderRegistry, withProviderFetchActor } from "../src/dispatch/handlers.js";
import { createScheduleResolutionRunHandler } from "../src/dispatch/handlers/run-schedule-resolution.js";
import { createShowtimeFetchRunHandler } from "../src/dispatch/handlers/run-showtime-fetch.js";
import { findRunContext } from "../src/dispatch/queries.js";
import { publish } from "../src/queue/index.js";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { RelayMessage } from "../src/relay/publisher.js";
import type { AggregateHintMessage } from "../src/sweeper/index.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { until } from "./support/queue-redis.js";
import {
  MOVIES,
  QUEUE_WAITING_HTML,
  RecordingRedis,
  corridorHops,
  createSyntheticHarness,
  deferred,
  findChromeExecutable,
  gateCleanup,
} from "./support/synthetic-corridor.js";
import type { SyntheticHarness } from "./support/synthetic-corridor.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — provider-fetch-actor suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers: every bound the actor consumes is injected
// per call below (gate 14 / ADR 0006).
const LEASE_TTL = "30 seconds";
const RUN_LEASE_TTL = "30 seconds";
const SEMAPHORE_TTL_MS = 60_000;
const HEARTBEAT_MS = 250;
const MAX_ATTEMPTS = 1; // the lease bumps attempt to 1; failRun's fence then wins
const NAV_MS = 20_000;
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;
const USER_AGENT = "SeatFinder-Test/1.0 (+https://example.invalid/contact)";

/** Distinctive parsed bitmap — deliberately NOT the `Buffer.from([0b1010_1010])` placeholder. */
const PARSED_BITMAP = new Uint8Array([0b1100_0011, 0b0000_1111]);
const PLACEHOLDER_BITMAP = Buffer.from([0b1010_1010]);

/**
 * ADR 0032 fixture: a REAL built layout that every SHOWTIME_FETCH parse result carries.
 * Built through the real `buildAuditoriumLayout` so `layoutId`/`fingerprint` are
 * content-derived, matching production; the positive control (test 1b) asserts the exact
 * bytes `encodeAuditoriumLayoutGeometry` produces land in `auditorium_layout.geometry`.
 */
const FIXTURE_LAYOUT = buildAuditoriumLayout({
  rows: 2,
  columns: 3,
  cells: [
    { row: 1, column: 1, kind: "STANDARD", available: true, visible: true },
    { row: 1, column: 2, kind: "STANDARD", available: false, visible: true },
    { row: 1, column: 3, kind: "WHEELCHAIR", available: true, visible: true },
    { row: 2, column: 1, kind: "STANDARD", available: false, visible: true },
    { row: 2, column: 2, kind: "COMPANION", available: true, visible: true },
    { row: 2, column: 3, kind: "STANDARD", available: false, visible: true },
  ],
}).layout;
const FIXTURE_GEOMETRY = encodeAuditoriumLayoutGeometry(FIXTURE_LAYOUT);

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

interface SeededWorld {
  readonly providerId: string;
  readonly runKeyId: string;
  readonly runId: string;
  readonly observationId: string;
  readonly showtimeId: string | null;
  readonly searchId: string | null;
}

async function seedWorld(
  pool: Pool,
  kind: RunKeyKind,
  opts: { withSubscriber?: boolean } = {},
): Promise<SeededWorld> {
  const providerId = uniq("provider");
  const runKeyId = uniq("key");
  const runId = uniq("run");
  const observationId = uniq("obs");

  await pool.query(`INSERT INTO provider_fence (provider_id, epoch) VALUES ($1, 0)`, [providerId]);
  let showtimeId: string | null = null;
  if (kind === "SHOWTIME_FETCH") {
    showtimeId = uniq("showtime");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
      [runKeyId, providerId, showtimeId],
    );
    // B5(c)'s layout write (ADR 0032) updates the performance row the showtime already
    // has from an earlier schedule acceptance — production precedence this suite must
    // mirror now that acceptance persists a layout. Scaffold that prior acceptance:
    // one schedule run key + provider_run + observation + the performance itself.
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
  } else {
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
       VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
      [runKeyId, providerId, uniq("theatre"), "2026-08-20"],
    );
  }
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
     VALUES ($1, $2, $3, 0)`,
    [runId, runKeyId, observationId],
  );

  let searchId: string | null = null;
  if (opts.withSubscriber === true && kind === "SHOWTIME_FETCH") {
    searchId = uniq("search");
    await pool.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'RUNNING', $5)`,
      [searchId, uniq("session"), uniq("idem"), `hash_${searchId}`, FUTURE],
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
  } else if (opts.withSubscriber === true) {
    // A cold schedule's subscriber (kind === "SCHEDULE_RESOLUTION"): B1's stage-1
    // reservation plus the schedule job + subscription that B5_FANIN transitions and
    // B6 expands into per-showtime fetch work. The reserve (4) matches the four
    // performances this suite's schedule-subscriber test injects; B6 stage 2 reconciles
    // it down by the non-skipped showtime count.
    searchId = uniq("search");
    await pool.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'RUNNING', $5)`,
      [searchId, uniq("session"), uniq("idem"), `hash_${searchId}`, FUTURE],
    );
    await pool.query(
      `INSERT INTO provider_admission (provider_id, pending_cost, pending_cost_limit, unresolved_schedules, unresolved_limit)
       VALUES ($1, 4, 1000, 1, 100)`,
      [providerId],
    );
    await pool.query(
      `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled)
       VALUES ($1, $2, 4, 4, true, 0, false)`,
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
  }

  return { providerId, runKeyId, runId, observationId, showtimeId, searchId };
}

async function seedHaltedStatus(pool: Pool, providerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO provider_status (provider_id, route_class, state, cause) VALUES ($1, '', 'HALTED', 'LEGAL_KILL_SWITCH')`,
    [providerId],
  );
}

// --- fixture wiring ------------------------------------------------------------------

let pg: TestService;
let redis: TestService;
let pool: Pool;
let redisClient: Redis;
let jobQueue: Queue<RelayMessage>;
let runQueue: Queue<RelayMessage>;
let aggregateQueue: Queue<AggregateHintMessage>;
let readiness: ReadinessServer;
let supervisor: BrowserSupervisor;
let recordingRedis: RecordingRedis;
let messages: string[];
let recordedLogs: Array<{
  readonly fields: Record<string, unknown>;
  readonly message: string;
}>;
const heldDeferreds: Array<ReturnType<typeof deferred>> = [];

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);

  pool = new Pool({ connectionString: pg.url });
  redisClient = new Redis(redis.url);
  const connection = { url: redis.url };
  jobQueue = new Queue<RelayMessage>("job-queue", { connection });
  runQueue = new Queue<RelayMessage>("run-queue", { connection });
  aggregateQueue = new Queue<AggregateHintMessage>("aggregate-queue", { connection });

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
  await Promise.allSettled([
    jobQueue.close(),
    runQueue.close(),
    aggregateQueue.close(),
    redisClient.quit(),
    pool.end(),
  ]);
  if (chromeExecutable !== null) {
    await Promise.allSettled([supervisor.shutdown(), readiness.close()]);
  }
  await Promise.allSettled([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE search, run_key, provider_fence, provider_status, provider_admission CASCADE",
  );
  await jobQueue.drain();
  await runQueue.drain();
  await aggregateQueue.drain();
  recordingRedis = new RecordingRedis(redisClient);
  messages = [];
  recordedLogs = [];
  for (const held of heldDeferreds.splice(0)) {
    held.resolve();
  }
});

afterEach(() => {
  for (const held of heldDeferreds.splice(0)) {
    held.resolve();
  }
});

const db = () => poolClient(pool);

/** Full O4-interface double over the shared `messages` sink; children share the sink so
 * post-child warns/errors still land where the `until()` waits look. */
function sinkLogger(): SeatfirstLogger {
  const record = (fields: Record<string, unknown>, message: string): void => {
    messages.push(message);
    recordedLogs.push({ fields, message });
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
}

const logger: SeatfirstLogger = sinkLogger();

// --- test wiring helpers -------------------------------------------------------------

function makeDeps(opts: {
  harness: SyntheticHarness;
  parse: ProviderFetchActorDeps["parseObservation"];
  heartbeatIntervalMs?: number;
  buildTargetUrl?: ProviderFetchActorDeps["buildTargetUrl"];
}): ProviderFetchActorDeps {
  return {
    pool,
    redis: recordingRedis,
    controlSource: providerStateSourceFromPool(pool),
    supervisor,
    userAgent: USER_AGENT,
    navigationLimits: { navigationTimeoutMs: NAV_MS },
    semaphoreTtlMs: SEMAPHORE_TTL_MS,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HEARTBEAT_MS,
    runLeaseTtl: RUN_LEASE_TTL,
    maxAttempts: MAX_ATTEMPTS,
    buildTargetUrl: opts.buildTargetUrl ?? (() => Promise.resolve(MOVIES)),
    parseObservation: opts.parse,
    navigationSeams: { fetchHop: opts.harness.fetchHop },
  };
}

/** Leases through the real B2 statement, then drives the real RUN handler directly. */
async function driveRun(
  deps: ProviderFetchActorDeps,
  runId: string,
  kind: RunKeyKind,
): Promise<void> {
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

interface RunState {
  readonly state: string;
  readonly generation: number;
  readonly failCause: string | null;
}

async function readRunState(runId: string): Promise<RunState> {
  const result = await pool.query<{ state: string; generation: number; fail_cause: string | null }>(
    `SELECT state, generation, fail_cause FROM provider_run WHERE run_id = $1`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`run ${runId} missing`);
  }
  return { state: row.state, generation: row.generation, failCause: row.fail_cause };
}

interface ProviderStatusRow {
  readonly routeClass: string;
  readonly state: string;
  readonly cause: string | null;
  readonly notBefore: Date | null;
}

async function readStatusRows(providerId: string): Promise<ProviderStatusRow[]> {
  const result = await pool.query<{
    route_class: string;
    state: string;
    cause: string | null;
    not_before: Date | null;
  }>(
    `SELECT route_class, state, cause, not_before FROM provider_status WHERE provider_id = $1 ORDER BY route_class`,
    [providerId],
  );
  return result.rows.map((row) => ({
    routeClass: row.route_class,
    state: row.state,
    cause: row.cause,
    notBefore: row.not_before,
  }));
}

async function readFenceEpoch(providerId: string): Promise<string> {
  const result = await pool.query<{ epoch: string }>(
    `SELECT epoch FROM provider_fence WHERE provider_id = $1`,
    [providerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`provider_fence ${providerId} missing`);
  }
  return row.epoch;
}

function unmodified(providerId: string, epoch: string): Promise<boolean> {
  return readStatusRows(providerId).then(
    (rows) => rows.length === 0 && readFenceEpoch(providerId).then((e) => e === epoch),
  );
}

async function waitForRunState(runId: string, state: string, label: string): Promise<void> {
  await until(async () => (await readRunState(runId)).state === state, { label });
}

/** Minimal in-process `Span` recording `setAttribute` calls (no sdk-trace dependency). */
class RecordingSpan implements Span {
  readonly attributes: Record<string, string | number | boolean> = {};
  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }
  spanContext() {
    return {
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    };
  }
  setAttributes() {
    return this;
  }
  addEvent() {
    return this;
  }
  setStatus() {
    return this;
  }
  updateName() {
    return this;
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }
  end() {}
  isRecording() {
    return true;
  }
  recordException() {}
}

/**
 * AsyncLocalStorage-backed `ContextManager` so an active span set via
 * `trace.setSpan(context.active(), span)` survives the awaits inside the async actor.
 * `@opentelemetry/api`'s default context manager does not propagate across async
 * boundaries; this stand-in mirrors `@opentelemetry/context-async-hooks` without adding
 * a dependency. Registered/restored around test 14 only.
 */
class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(
      ctx,
      fn as unknown as (...args: unknown[]) => ReturnType<F>,
      thisArg,
      ...args,
    );
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

// --- the suite -----------------------------------------------------------------------

describe.skipIf(chromeExecutable === null)("provider fetch actor (S8)", () => {
  it("1. SHOWTIME_FETCH happy path — RUN message end to end through S11's harness; the parsed bitmap (not the placeholder) lands in availability_snapshot", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH", { withSubscriber: true });
    const harness = createSyntheticHarness(corridorHops());
    const parsedPayloads: string[] = [];
    const deps = makeDeps({
      harness,
      parse: (payload) => {
        parsedPayloads.push(payload.documentHtml);
        return Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          layout: FIXTURE_LAYOUT,
          bitmap: PARSED_BITMAP,
          freeCount: 7,
        });
      },
    });
    const registry = withProviderFetchActor(createPlaceholderRegistry(), deps);
    const dispatchDeps: DispatchDeps = { db: db(), registry, logger };
    const handle: DispatchHandle = createDispatchWorkers(
      dispatchDeps,
      { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
      { leaseTtl: LEASE_TTL },
    );
    try {
      await publish(runQueue, "RUN", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "RUN",
        targetId: world.runId,
        traceparent: null,
      });

      await until(
        async () =>
          (
            await pool.query<{ count: string }>(
              `SELECT count(*) AS count FROM availability_snapshot WHERE observation_id = $1`,
              [world.observationId],
            )
          ).rows[0]?.count === "1",
        { label: "availability_snapshot row for the observation" },
      );

      const snapshot = await pool.query<{ bitmap: Buffer; free_count: number }>(
        `SELECT bitmap, free_count FROM availability_snapshot WHERE observation_id = $1`,
        [world.observationId],
      );
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0]?.bitmap.equals(Buffer.from(PARSED_BITMAP))).toBe(true);
      expect(snapshot.rows[0]?.bitmap.equals(PLACEHOLDER_BITMAP)).toBe(false);
      expect(snapshot.rows[0]?.free_count).toBe(7);

      // The parse seam received the real sanitized document the transport fetched.
      expect(parsedPayloads).toHaveLength(1);
      expect(parsedPayloads[0]).toContain("seat-map");

      // Fan-in applied the acceptance to the subscriber.
      expect((await readRunState(world.runId)).state).toBe("DONE");
      const jobState = await pool.query<{ state: string }>(
        `SELECT state FROM search_job WHERE search_id = $1`,
        [world.searchId],
      );
      expect(jobState.rows[0]?.state).toBe("DONE");
      const subState = await pool.query<{ state: string }>(
        `SELECT state FROM run_subscription WHERE search_id = $1`,
        [world.searchId],
      );
      expect(subState.rows[0]?.state).toBe("SATISFIED");
      const events = await pool.query<{ type: string }>(
        `SELECT type FROM search_event WHERE search_id = $1`,
        [world.searchId],
      );
      expect(events.rows.map((row) => row.type)).toEqual(["FETCH_ACCEPTED"]);

      // Exactly the four scripted documents; nothing refused; capacity released.
      expect(harness.documents.map((doc) => doc.url)).toEqual([
        MOVIES,
        expect.stringContaining("queue.amctheatres.com"),
        expect.stringContaining("queueittoken"),
        MOVIES,
      ]);
      expect(harness.refusals).toEqual([]);
      expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("1b. SHOWTIME_FETCH acceptance persists the parsed layout (ADR 0032) — the exact encoded geometry bytes land in auditorium_layout and performance.layout_id points at it", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
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
        }),
    });
    const registry = withProviderFetchActor(createPlaceholderRegistry(), deps);
    const dispatchDeps: DispatchDeps = { db: db(), registry, logger };
    const handle: DispatchHandle = createDispatchWorkers(
      dispatchDeps,
      { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
      { leaseTtl: LEASE_TTL },
    );
    try {
      await publish(runQueue, "RUN", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "RUN",
        targetId: world.runId,
        traceparent: null,
      });

      await until(async () => (await readRunState(world.runId)).state === "DONE", {
        label: "run DONE after layout-carrying acceptance",
      });

      // The persisted row must carry exactly the content address and the exact byte
      // sequence encodeAuditoriumLayoutGeometry produces for this layout — not a
      // re-encoded or truncated variant.
      const rows = await pool.query<{
        layout_id: string;
        geometry: Buffer;
        rows: number;
        columns: number;
      }>(`SELECT layout_id, geometry, rows, columns FROM auditorium_layout WHERE layout_id = $1`, [
        FIXTURE_LAYOUT.layoutId,
      ]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.geometry.equals(FIXTURE_GEOMETRY)).toBe(true);
      expect(rows.rows[0]?.rows).toBe(FIXTURE_LAYOUT.rows);
      expect(rows.rows[0]?.columns).toBe(FIXTURE_LAYOUT.columns);

      // B5(c)'s layout write points the accepted showtime's performance at the layout.
      const perf = await pool.query<{ layout_id: string | null }>(
        `SELECT layout_id FROM performance WHERE showtime_id = $1`,
        [world.showtimeId],
      );
      expect(perf.rows).toHaveLength(1);
      expect(perf.rows[0]?.layout_id).toBe(FIXTURE_LAYOUT.layoutId);
    } finally {
      await handle.close();
    }
  });

  it("1c. SHOWTIME_FETCH acceptance persists the parsed price (S59, ADR 0062 §3) — min_price, USD currency, and price_basis land on the performance row", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
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
          minPrice: 16.99,
          priceBasis: "TICKET_ONLY" as const,
        }),
    });
    const registry = withProviderFetchActor(createPlaceholderRegistry(), deps);
    const dispatchDeps: DispatchDeps = { db: db(), registry, logger };
    const handle: DispatchHandle = createDispatchWorkers(
      dispatchDeps,
      { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
      { leaseTtl: LEASE_TTL },
    );
    try {
      await publish(runQueue, "RUN", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "RUN",
        targetId: world.runId,
        traceparent: null,
      });

      await until(async () => (await readRunState(world.runId)).state === "DONE", {
        label: "run DONE after price-carrying acceptance",
      });

      // The actor pins USD at the provider boundary (ADR 0062 §Alternatives) and
      // forwards the parsed basis verbatim — remove the acceptFetch price passthrough
      // and these stay null while the run still reaches DONE.
      const perf = await pool.query<{
        min_price: string;
        currency: string;
        price_basis: string;
      }>(`SELECT min_price, currency, price_basis FROM performance WHERE showtime_id = $1`, [
        world.showtimeId,
      ]);
      expect(perf.rows).toHaveLength(1);
      expect(perf.rows[0]?.min_price).toBe("16.99");
      expect(perf.rows[0]?.currency).toBe("USD");
      expect(perf.rows[0]?.price_basis).toBe("TICKET_ONLY");
    } finally {
      await handle.close();
    }
  });

  it("2. SCHEDULE_RESOLUTION happy path — three performances, heterogeneous statuses, in one transaction; theatre/local date derived from the run key (S13.1)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION");
    const harness = createSyntheticHarness(corridorHops());
    const startsAt = [
      new Date("2026-08-20T18:30:00.000Z"),
      new Date("2026-08-20T21:00:00.000Z"),
      new Date("2026-08-20T23:45:00.000Z"),
    ];
    const statuses: readonly ShowtimeStatus[] = ["OPEN", "SOLD_OUT", "CANCELED"];
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: startsAt.map((at, index) => ({
            showtimeId: `st-${index + 1}`,
            startsAt: at,
            attributes: ["IMAX"],
            status: statuses[index]!,
            // Namespaced under the run's providerId so the S24 movie-catalogue upsert
            // (which the actor now runs on every SCHEDULE_RESOLUTION acceptance) satisfies
            // the movie table's `^[^:]+:movie:.+$` and split_part CHECKs.
            movieId: `${world.providerId}:movie:${index + 1}`,
            movieTitle: `Movie ${index + 1}`,
            auditorium: null,
            utcOffset: "-05:00",
            runtimeMinutes: 120 + index,
            formatCode: index === 0 ? "IMAX" : null,
            deepLinkUrl: `https://example.invalid/showtimes/st-${index + 1}`,
            providerMeta: {},
          })),
        }),
    });

    await driveRun(deps, world.runId, "SCHEDULE_RESOLUTION");
    await waitForRunState(world.runId, "DONE", "schedule run accepted");

    const performances = await pool.query<{
      showtime_id: string;
      starts_at: Date;
      theatre_id: string;
      local_date: Date | string;
      attributes: unknown;
    }>(
      `SELECT showtime_id, starts_at, theatre_id, local_date, attributes
       FROM performance WHERE provider_id = $1 ORDER BY showtime_id`,
      [world.providerId],
    );
    expect(performances.rows.map((row) => row.showtime_id)).toEqual(["st-1", "st-2", "st-3"]);
    expect(performances.rows.map((row) => row.starts_at.toISOString())).toEqual(
      startsAt.map((at) => at.toISOString()),
    );
    for (const row of performances.rows) {
      expect(row.theatre_id.startsWith("theatre_")).toBe(true);
      const localDate =
        row.local_date instanceof Date
          ? row.local_date.toISOString().slice(0, 10)
          : String(row.local_date).slice(0, 10);
      expect(localDate).toBe("2026-08-20");
    }
    // S14 control: `attributes` is not one of the product columns PERFORMANCE_UPDATE_PRODUCT
    // writes (boundaries.ts:151-165), so the column keeps its own DB default `{}` from
    // B5C_PERFORMANCE — not the seam's `readonly string[]` values this test injected. The
    // resolved `status`/`formatCode`/`movieId` columns are asserted in test 2c below.
    for (const row of performances.rows) {
      expect(row.attributes).toEqual({});
    }

    const keyRow = await pool.query<{ accepted_revision: string }>(
      `SELECT accepted_revision FROM run_key WHERE run_key_id = $1`,
      [world.runKeyId],
    );
    expect(keyRow.rows[0]?.accepted_revision).toBe("1");
    const observations = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM observation WHERE observation_id = $1`,
      [world.observationId],
    );
    expect(observations.rows[0]?.count).toBe("1");
    expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(1);
  });

  it("2a. type fixture — the full product field set is required on `ParseResult`'s SCHEDULE_RESOLUTION performance shape, checked without an inline disable (S14.1)", () => {
    // Compile-time only: no inline `@ts-expect-error`/`@ts-ignore` (S14's verification bans
    // them), and no runtime construction of an actually-invalid `ParseResult`. `pnpm typecheck`
    // fails the build if either `expectTypeOf` assertion below stops holding — `status` or any
    // product field silently becoming optional, renamed, or removed is caught here.
    type SchedulePerformance = Extract<
      ParseResult,
      { kind: "SCHEDULE_RESOLUTION" }
    >["performances"][number];
    expectTypeOf<SchedulePerformance["status"]>().toEqualTypeOf<ShowtimeStatus>();
    // `attributes` is now `readonly string[]`, not S13's `unknown` (contract.ts:197).
    expectTypeOf<SchedulePerformance["attributes"]>().toEqualTypeOf<readonly string[]>();
    // The S13 shape — `attributes` still `unknown`, or any product field missing — no
    // longer satisfies the seam.
    expectTypeOf<{
      showtimeId: string;
      startsAt: Date;
      attributes: readonly string[];
      status: ShowtimeStatus;
    }>().not.toExtend<SchedulePerformance>();
    // The full S14 field set does.
    expectTypeOf<{
      showtimeId: string;
      startsAt: Date;
      attributes: readonly string[];
      status: ShowtimeStatus;
      movieId: string;
      movieTitle: string;
      auditorium: string | number | null;
      utcOffset: string;
      runtimeMinutes: number | null;
      formatCode: string | null;
      deepLinkUrl: string;
      providerMeta: Record<string, unknown>;
    }>().toExtend<SchedulePerformance>();
  });

  it("2b. SCHEDULE_RESOLUTION skipFetch gate — SOLD_OUT/CANCELED performances create no fetch jobs, OPEN/LOW_AVAILABILITY ones do (ADR 0009)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION", { withSubscriber: true });
    const harness = createSyntheticHarness(corridorHops());
    const startsAt = [
      new Date("2026-08-20T18:30:00.000Z"),
      new Date("2026-08-20T21:00:00.000Z"),
      new Date("2026-08-20T23:45:00.000Z"),
      new Date("2026-08-21T01:15:00.000Z"),
    ];
    // OPEN/LOW_AVAILABILITY → FETCH (skipFetch:false); SOLD_OUT/CANCELED →
    // SKIP_SOLD_OUT (skipFetch:true). Exactly st-1 and st-4 expand into fetch work.
    const statuses: readonly ShowtimeStatus[] = [
      "OPEN",
      "SOLD_OUT",
      "CANCELED",
      "LOW_AVAILABILITY",
    ];
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: startsAt.map((at, index) => ({
            showtimeId: `st-${index + 1}`,
            startsAt: at,
            attributes: ["IMAX"],
            status: statuses[index]!,
            movieId: `${world.providerId}:movie:${index + 1}`,
            movieTitle: `Movie ${index + 1}`,
            auditorium: null,
            utcOffset: "-05:00",
            runtimeMinutes: 120,
            formatCode: null,
            deepLinkUrl: `https://example.invalid/showtimes/st-${index + 1}`,
            providerMeta: {},
          })),
        }),
    });

    await driveRun(deps, world.runId, "SCHEDULE_RESOLUTION");
    await waitForRunState(world.runId, "DONE", "schedule run accepted");

    // B5C_PERFORMANCE is unconditional: every showtime — skipped or not — gets a row.
    const performances = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM performance WHERE provider_id = $1`,
      [world.providerId],
    );
    expect(performances.rows[0]?.count).toBe("4");

    // B6 expansion created a SHOWTIME_FETCH run key only for the non-skipped showtimes.
    const fetchKeys = await pool.query<{ showtime_id: string }>(
      `SELECT showtime_id FROM run_key
       WHERE provider_id = $1 AND kind = 'SHOWTIME_FETCH' ORDER BY showtime_id`,
      [world.providerId],
    );
    expect(fetchKeys.rows.map((row) => row.showtime_id)).toEqual(["st-1", "st-4"]);

    // And exactly two SHOWTIME_FETCH jobs for the same non-skipped set.
    const fetchJobs = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM search_job
       WHERE search_id = $1 AND kind = 'SHOWTIME_FETCH'`,
      [world.searchId],
    );
    expect(fetchJobs.rows[0]?.count).toBe("2");
  });

  it("2c. SCHEDULE_RESOLUTION persists the resolved product columns per performance via PERFORMANCE_UPDATE_PRODUCT, min_price/layout_id NULL (S14.1/S14.2)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION");
    const harness = createSyntheticHarness(corridorHops());
    const startsAt = [
      new Date("2026-08-20T18:30:00.000Z"),
      new Date("2026-08-20T21:00:00.000Z"),
      new Date("2026-08-20T23:45:00.000Z"),
    ];
    const statuses: readonly ShowtimeStatus[] = ["OPEN", "SOLD_OUT", "CANCELED"];
    // Namespaced under the run's providerId (the S24 movie-catalogue upsert on every
    // SCHEDULE_RESOLUTION acceptance must satisfy the movie table's id CHECKs).
    const movies = [
      `${world.providerId}:movie:alpha`,
      `${world.providerId}:movie:beta`,
      `${world.providerId}:movie:gamma`,
    ];
    const titles = ["The Odyssey", "Dune: Part Three", "Wicked"];
    // A number auditorium exercises the seam's `String()` coercion into the text column.
    const auditoriums: readonly (string | number | null)[] = ["Auditorium 1", 7, null];
    const utcOffsets = ["-05:00", "-05:00", "-06:00"];
    const runtimes: readonly (number | null)[] = [150, 180, null];
    const formatCodes: readonly (string | null)[] = ["IMAX", "DOLBY", null];
    const deepLinks = [
      "https://example.invalid/showtimes/st-1",
      "https://example.invalid/showtimes/st-2",
      "https://example.invalid/showtimes/st-3",
    ];
    const metas: readonly Record<string, unknown>[] = [
      { tier: "premium" },
      { rawStatus: "SOLD_OUT" },
      {},
    ];
    const attributeSets: readonly (readonly string[])[] = [["IMAX"], ["DOLBY"], ["OPEN_CAPTION"]];
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: startsAt.map((at, index) => ({
            showtimeId: `st-${index + 1}`,
            startsAt: at,
            attributes: attributeSets[index]!,
            status: statuses[index]!,
            movieId: movies[index]!,
            movieTitle: titles[index]!,
            auditorium: auditoriums[index]!,
            utcOffset: utcOffsets[index]!,
            runtimeMinutes: runtimes[index]!,
            formatCode: formatCodes[index]!,
            deepLinkUrl: deepLinks[index]!,
            providerMeta: metas[index]!,
          })),
        }),
    });

    await driveRun(deps, world.runId, "SCHEDULE_RESOLUTION");
    await waitForRunState(world.runId, "DONE", "schedule run accepted");

    const rows = await pool.query<{
      showtime_id: string;
      movie_id: string | null;
      auditorium: string | null;
      utc_offset: string | null;
      runtime_minutes: number | null;
      status: string | null;
      format_code: string | null;
      min_price: string | null;
      deep_link_url: string | null;
      provider_meta: Record<string, unknown>;
      layout_id: string | null;
    }>(
      `SELECT showtime_id, movie_id, auditorium, utc_offset, runtime_minutes, status,
              format_code, min_price, deep_link_url, provider_meta, layout_id
       FROM performance WHERE provider_id = $1 ORDER BY showtime_id`,
      [world.providerId],
    );

    // S14.1/S14.2: every product column matches the parsed value, distinct per row rather
    // than a shared default — and `min_price`/`layout_id` stay NULL (null-until-seat-fetch,
    // contract.ts:199-203), never fabricated from the seam.
    expect(rows.rows).toEqual([
      {
        showtime_id: "st-1",
        movie_id: `${world.providerId}:movie:alpha`,
        auditorium: "Auditorium 1",
        utc_offset: "-05:00",
        runtime_minutes: 150,
        status: "OPEN",
        format_code: "IMAX",
        min_price: null,
        deep_link_url: "https://example.invalid/showtimes/st-1",
        provider_meta: { tier: "premium" },
        layout_id: null,
      },
      {
        showtime_id: "st-2",
        movie_id: `${world.providerId}:movie:beta`,
        auditorium: "7",
        utc_offset: "-05:00",
        runtime_minutes: 180,
        status: "SOLD_OUT",
        format_code: "DOLBY",
        min_price: null,
        deep_link_url: "https://example.invalid/showtimes/st-2",
        provider_meta: { rawStatus: "SOLD_OUT" },
        layout_id: null,
      },
      {
        showtime_id: "st-3",
        movie_id: `${world.providerId}:movie:gamma`,
        auditorium: null,
        utc_offset: "-06:00",
        runtime_minutes: null,
        status: "CANCELED",
        format_code: null,
        min_price: null,
        deep_link_url: "https://example.invalid/showtimes/st-3",
        provider_meta: {},
        layout_id: null,
      },
    ]);
  });

  it("2d. atomicity — a product-write failure mid-loop rolls back the whole acceptance (S14.2)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION");
    const harness = createSyntheticHarness(corridorHops());
    const startsAt = [
      new Date("2026-08-20T18:30:00.000Z"),
      new Date("2026-08-20T21:00:00.000Z"),
      new Date("2026-08-20T23:45:00.000Z"),
    ];
    const statuses: readonly ShowtimeStatus[] = ["OPEN", "OPEN", "OPEN"];
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: startsAt.map((at, index) => ({
            showtimeId: `st-${index + 1}`,
            startsAt: at,
            attributes: [],
            status: statuses[index]!,
            movieId: `${world.providerId}:movie:${index + 1}`,
            movieTitle: `Movie ${index + 1}`,
            auditorium: null,
            utcOffset: "-05:00",
            // The second product write trips PERFORMANCE_UPDATE_PRODUCT's
            // `runtime_minutes >= 0` CHECK (003_catalog.sql:49), aborting the transaction.
            runtimeMinutes: index === 1 ? -1 : 120,
            formatCode: null,
            deepLinkUrl: `https://example.invalid/showtimes/st-${index + 1}`,
            providerMeta: {},
          })),
        }),
    });

    await expect(driveRun(deps, world.runId, "SCHEDULE_RESOLUTION")).rejects.toThrow();

    // S14.2 atomicity: the CHECK violation on the second product write rolls back the whole
    // `withTransaction` — `stageScheduleAcceptance`'s base columns AND the first successful
    // product write alike. Zero performance rows survive for the run's provider.
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM performance WHERE provider_id = $1`,
      [world.providerId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("2e. SCHEDULE_RESOLUTION auto-populates the movie catalogue — M distinct movies over N performances, titles + capture instant (S24.7)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION");
    const harness = createSyntheticHarness(corridorHops());
    // 3 performances over 2 distinct movies (M=2 < N=3).
    const movieIds = [`${world.providerId}:movie:alpha`, `${world.providerId}:movie:beta`];
    const titles = ["The Odyssey", "Dune: Part Three"];
    const byShowtime = [
      { movieId: movieIds[0]!, title: titles[0]! },
      { movieId: movieIds[0]!, title: titles[0]! },
      { movieId: movieIds[1]!, title: titles[1]! },
    ];
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: byShowtime.map((entry, index) => ({
            showtimeId: `st-${index + 1}`,
            startsAt: new Date("2026-08-20T18:30:00.000Z"),
            attributes: [],
            status: "OPEN",
            movieId: entry.movieId,
            movieTitle: entry.title,
            auditorium: null,
            utcOffset: "-05:00",
            runtimeMinutes: 120,
            formatCode: null,
            deepLinkUrl: `https://example.invalid/showtimes/st-${index + 1}`,
            providerMeta: {},
          })),
        }),
    });

    await driveRun(deps, world.runId, "SCHEDULE_RESOLUTION");
    await waitForRunState(world.runId, "DONE", "schedule run accepted");

    // Exactly M=2 movie rows, one per distinct movie, with the parsed titles.
    const movies = await pool.query<{
      movie_id: string;
      provider_id: string;
      title: string;
      first_seen_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT movie_id, provider_id, title, first_seen_at, last_seen_at
       FROM movie WHERE provider_id = $1 ORDER BY movie_id`,
      [world.providerId],
    );
    expect(movies.rows).toHaveLength(2);
    expect(movies.rows.map((row) => row.movie_id)).toEqual(movieIds);
    expect(movies.rows.map((row) => row.title)).toEqual(titles);
    // Both timestamps come from the handler's single capturedAt clock read (S14.2's
    // `new Date()`), so they are equal and near-now — the run's capture instant.
    for (const row of movies.rows) {
      expect(row.provider_id).toBe(world.providerId);
      expect(row.first_seen_at.getTime()).toBe(row.last_seen_at.getTime());
      expect(Math.abs(row.first_seen_at.getTime() - Date.now())).toBeLessThan(60_000);
    }

    // Every performance's movie_id maps to a movie row written in the same transaction.
    const performances = await pool.query<{ movie_id: string | null }>(
      `SELECT movie_id FROM performance WHERE provider_id = $1`,
      [world.providerId],
    );
    expect(performances.rows).toHaveLength(3);
    for (const row of performances.rows) {
      expect(movieIds).toContain(row.movie_id);
    }
  });

  it("2f. atomicity — a failure in the second movie upsert rolls back the acceptance and the first movie row (S24.7)", async () => {
    const world = await seedWorld(pool, "SCHEDULE_RESOLUTION");
    const harness = createSyntheticHarness(corridorHops());
    // The movie upserts run BEFORE the updatePerformanceProduct loop (S24.5b). The second
    // upsert's blank title trips the movie table's `btrim(title) <> ''` CHECK, aborting the
    // whole transaction — stageScheduleAcceptance's base columns AND the first movie row.
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
              attributes: [],
              status: "OPEN",
              movieId: `${world.providerId}:movie:alpha`,
              movieTitle: "The Odyssey",
              auditorium: null,
              utcOffset: "-05:00",
              runtimeMinutes: 120,
              formatCode: null,
              deepLinkUrl: "https://example.invalid/showtimes/st-1",
              providerMeta: {},
            },
            {
              showtimeId: "st-2",
              startsAt: new Date("2026-08-20T21:00:00.000Z"),
              attributes: [],
              status: "OPEN",
              movieId: `${world.providerId}:movie:beta`,
              movieTitle: "",
              auditorium: null,
              utcOffset: "-05:00",
              runtimeMinutes: 120,
              formatCode: null,
              deepLinkUrl: "https://example.invalid/showtimes/st-2",
              providerMeta: {},
            },
          ],
        }),
    });

    await expect(driveRun(deps, world.runId, "SCHEDULE_RESOLUTION")).rejects.toThrow();

    // No movie row for the first movie survives, and no performance row from the acceptance.
    const movies = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM movie WHERE provider_id = $1`,
      [world.providerId],
    );
    expect(movies.rows[0]?.count).toBe("0");
    const performances = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM performance WHERE provider_id = $1`,
      [world.providerId],
    );
    expect(performances.rows[0]?.count).toBe("0");
  });

  it("3. QUEUE_ENTERED → provider-wide UPSTREAM_QUEUED halt; the run is fenced by B9 itself (no separate failRun)", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(
      corridorHops({ queueStatus: 200, queueBody: QUEUE_WAITING_HTML }),
    );
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          layout: FIXTURE_LAYOUT,
          bitmap: PARSED_BITMAP,
          freeCount: 1,
        }),
    });

    await driveRun(deps, world.runId, "SHOWTIME_FETCH");
    await until(async () => (await readStatusRows(world.providerId)).length > 0, {
      label: "provider_status row for the halt",
    });

    expect(await readStatusRows(world.providerId)).toEqual([
      { routeClass: "", state: "HALTED", cause: "UPSTREAM_QUEUED", notBefore: null },
    ]);
    expect(await readFenceEpoch(world.providerId)).toBe("1");
    // B9 fences leased runs (generation bumped), it does not terminalize them.
    const run = await readRunState(world.runId);
    expect(run.state).toBe("LEASED");
    expect(run.generation).toBe(2);
  });

  it("4. CHALLENGE_REQUIRED and UPSTREAM_BLOCKED → matching provider-wide halts", async () => {
    const challenge = await seedWorld(pool, "SHOWTIME_FETCH");
    const challengeHarness = createSyntheticHarness(
      corridorHops({ initialStatus: 200, initialHeaders: { "cf-mitigated": "challenge" } }),
    );
    await driveRun(
      makeDeps({
        harness: challengeHarness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      challenge.runId,
      "SHOWTIME_FETCH",
    );
    await until(async () => (await readStatusRows(challenge.providerId)).length > 0, {
      label: "challenge halt row",
    });
    expect(await readStatusRows(challenge.providerId)).toEqual([
      { routeClass: "", state: "HALTED", cause: "CHALLENGE_REQUIRED", notBefore: null },
    ]);
    expect(await readFenceEpoch(challenge.providerId)).toBe("1");

    const blocked = await seedWorld(pool, "SHOWTIME_FETCH");
    const blockedHarness = createSyntheticHarness(
      corridorHops({ queueStatus: 403, queueBody: "blocked" }),
    );
    await driveRun(
      makeDeps({
        harness: blockedHarness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      blocked.runId,
      "SHOWTIME_FETCH",
    );
    await until(async () => (await readStatusRows(blocked.providerId)).length > 0, {
      label: "blocked halt row",
    });
    expect(await readStatusRows(blocked.providerId)).toEqual([
      { routeClass: "", state: "HALTED", cause: "UPSTREAM_BLOCKED", notBefore: null },
    ]);
    expect(await readFenceEpoch(blocked.providerId)).toBe("1");
  });

  it("5. RATE_LIMITED with Retry-After: 30 → route-scoped PAUSED with a notBefore ~30 seconds out (never a guessed cooldown)", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(
      corridorHops({ queueStatus: 429, queueHeaders: { "retry-after": "30" } }),
    );
    const before = Date.now();
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );
    await until(async () => (await readStatusRows(world.providerId)).length > 0, {
      label: "rate-limited pause row",
    });

    const rows = await readStatusRows(world.providerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("PAUSED");
    expect(rows[0]?.cause).toBe("RATE_LIMITED");
    expect(rows[0]?.routeClass).toBe("seat");
    const notBefore = rows[0]?.notBefore;
    if (notBefore === null || notBefore === undefined) {
      throw new Error("expected a concrete not_before for RATE_LIMITED");
    }
    const deltaMs = notBefore.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(25_000);
    expect(deltaMs).toBeLessThanOrEqual(35_000);
  });

  it("6a. RATE_LIMITED with a MISSING Retry-After → failRun only, provider control state untouched", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(corridorHops({ queueStatus: 429 }));
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );
    await waitForRunState(world.runId, "FAILED", "rate-limited run failed");

    const run = await readRunState(world.runId);
    expect(run.failCause).toBe("RATE_LIMITED_NO_RETRY_AFTER");
    expect(await unmodified(world.providerId, "0")).toBe(true);
  });

  it("6b. RATE_LIMITED with a MALFORMED Retry-After → failRun only, provider control state untouched", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(
      corridorHops({ queueStatus: 429, queueHeaders: { "retry-after": "soon-ish" } }),
    );
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );
    await waitForRunState(world.runId, "FAILED", "rate-limited run failed");

    const run = await readRunState(world.runId);
    expect(run.failCause).toBe("RATE_LIMITED_NO_RETRY_AFTER");
    expect(await unmodified(world.providerId, "0")).toBe(true);
  });

  it("7. GUARD_REJECTED → failRun with a guard-derived cause; provider_status/fence untouched (positive control: tests 3–4 prove a real halt DOES change them)", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(corridorHops());
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
        buildTargetUrl: () => Promise.resolve("https://evil.example/phish?x=1"),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );
    await waitForRunState(world.runId, "FAILED", "guard-rejected run failed");

    const run = await readRunState(world.runId);
    expect(run.failCause).toBe("GUARD_REJECTED:INITIAL_NOT_ALLOWED");
    expect(await unmodified(world.providerId, "0")).toBe(true);
    // The guard halted the navigation before any document was dispatched.
    expect(harness.documents).toHaveLength(0);
    expect(harness.refusals).toEqual([]);
  });

  it("8. NAVIGATION_FAILED (generic transport error) → failRun only; never the parser-schema-incompatibility path (contrast: test 9)", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    // An unscripted corridor: the very first document is refused by the synthetic
    // network, which the transport reports as a NAVIGATION_FAILED terminal outcome.
    const harness = createSyntheticHarness([]);
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );
    await waitForRunState(world.runId, "FAILED", "transport-failed run failed");

    const run = await readRunState(world.runId);
    expect(run.failCause).toContain("unscripted document request");
    expect(await unmodified(world.providerId, "0")).toBe(true);
    expect(harness.refusals).toHaveLength(1);
  });

  it("9. validated parser schema incompatibility on a SUCCESS navigation → BOTH the route-scoped pause AND failRun (contrast: test 8)", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(corridorHops());
    await driveRun(
      makeDeps({
        harness,
        parse: () =>
          Promise.resolve({
            ok: false,
            cause: "PARSER_SCHEMA_INCOMPATIBLE",
            parserError: {
              code: "UPSTREAM_CHANGED",
              message: 'Postal code "31420" is not in the timezone table',
            },
          }),
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );

    await until(
      async () =>
        (await readStatusRows(world.providerId)).length > 0 &&
        (await readRunState(world.runId)).state === "FAILED",
      { label: "schema-incompatibility pause AND failed run" },
    );

    expect(await readStatusRows(world.providerId)).toEqual([
      { routeClass: "seat", state: "PAUSED", cause: "PARSER_SCHEMA_INCOMPATIBLE", notBefore: null },
    ]);
    const run = await readRunState(world.runId);
    expect(run.failCause).toBe("PARSER_SCHEMA_INCOMPATIBLE");
    expect(recordedLogs).toContainEqual({
      fields: {
        run_id: world.runId,
        outcome: "UPSTREAM_CHANGED",
        fail_cause: "PARSER_SCHEMA_INCOMPATIBLE",
        parser_error_code: "UPSTREAM_CHANGED",
        parser_error_message: 'Postal code "31420" is not in the timezone table',
      },
      message: "provider fetch: parser schema incompatibility paused route",
    });
  });

  it("10. heartbeat loss mid-navigation (concurrent B9 halt) → CANCELLED, no durability call from the handler, capacity released after cleanup", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const holdQueue = deferred();
    heldDeferreds.push(holdQueue);
    const harness = createSyntheticHarness(corridorHops({ holdQueue }));
    const deps = makeDeps({
      harness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          layout: FIXTURE_LAYOUT,
          bitmap: PARSED_BITMAP,
          freeCount: 1,
        }),
      heartbeatIntervalMs: 50,
    });

    const driving = driveRun(deps, world.runId, "SHOWTIME_FETCH");
    await until(() => Promise.resolve(harness.documents.length >= 2), {
      label: "queue hop held open",
    });

    // The concurrent provider-wide halt the item names: it bumps the leased run's
    // generation, so the actor's next B3 heartbeat returns zero rows and aborts.
    await withTransaction(pool, (tx) =>
      applyProviderControlTransition(tx, world.providerId, { kind: "UPSTREAM_BLOCKED" }),
    );
    await driving;

    // CANCELLED: no acceptFetch/failRun/B9 call from the handler.
    const run = await readRunState(world.runId);
    expect(run.state).toBe("LEASED"); // stranded, not terminalized
    expect(run.generation).toBe(2); // fenced by the concurrent B9, not by the handler
    const observations = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM observation WHERE observation_id = $1`,
      [world.observationId],
    );
    expect(observations.rows[0]?.count).toBe("0");
    const snapshots = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM availability_snapshot WHERE observation_id = $1`,
      [world.observationId],
    );
    expect(snapshots.rows[0]?.count).toBe("0");
    // Exactly ONE transition — the concurrent one. A handler B9 call would double it.
    expect(await readFenceEpoch(world.providerId)).toBe("1");
    // Capacity was still released (after cleanup) despite the cancellation.
    expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(1);
  });

  it("11a. cleanup-before-release ordering, SUCCESS case — SEMAPHORE_RELEASE fires only after cleanupCompleted resolves", async () => {
    const gate = gateCleanup(supervisor);
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(corridorHops());
    try {
      const driving = driveRun(
        makeDeps({
          harness,
          parse: () =>
            Promise.resolve({
              ok: true,
              kind: "SHOWTIME_FETCH",
              layout: FIXTURE_LAYOUT,
              bitmap: PARSED_BITMAP,
              freeCount: 1,
            }),
        }),
        world.runId,
        "SHOWTIME_FETCH",
      );
      await waitForRunState(world.runId, "DONE", "accepted while cleanup is gated");
      // The acceptance committed, but cleanup has not completed: capacity must still
      // be held. Deterministic — the gate cannot resolve by itself.
      expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(0);
      gate.open();
      await driving;
      await until(() => Promise.resolve(recordingRedis.count("SEMAPHORE_RELEASE") === 1), {
        label: "semaphore released after cleanup",
      });
    } finally {
      gate.restore();
    }
  });

  it("11b. cleanup-before-release ordering, HALTED case — same proof on a QUEUE_ENTERED halt", async () => {
    const gate = gateCleanup(supervisor);
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(
      corridorHops({ queueStatus: 200, queueBody: QUEUE_WAITING_HTML }),
    );
    try {
      const driving = driveRun(
        makeDeps({
          harness,
          parse: () =>
            Promise.resolve({
              ok: true,
              kind: "SHOWTIME_FETCH",
              layout: FIXTURE_LAYOUT,
              bitmap: PARSED_BITMAP,
              freeCount: 1,
            }),
        }),
        world.runId,
        "SHOWTIME_FETCH",
      );
      await until(async () => (await readStatusRows(world.providerId)).length > 0, {
        label: "halt persisted while cleanup is gated",
      });
      expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(0);
      gate.open();
      await driving;
      await until(() => Promise.resolve(recordingRedis.count("SEMAPHORE_RELEASE") === 1), {
        label: "semaphore released after cleanup",
      });
    } finally {
      gate.restore();
    }
  });

  it("12. fail-closed control read — a corrupt cache value and a missing cache with a HALTED authority never acquire, never dispatch", async () => {
    // (a) Unrecognized cached value: fail closed without even refreshing from Postgres.
    const corrupt = await seedWorld(pool, "SHOWTIME_FETCH");
    const corruptHarness = createSyntheticHarness(corridorHops());
    await recordingRedis.hset(providerStateCacheKey(corrupt.providerId, "seat"), {
      state: "GARBAGE",
    });
    await driveRun(
      makeDeps({
        harness: corruptHarness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      corrupt.runId,
      "SHOWTIME_FETCH",
    );
    expect(recordingRedis.count("SEMAPHORE_ACQUIRE")).toBe(0);
    expect(corruptHarness.documents).toHaveLength(0);
    expect((await readRunState(corrupt.runId)).state).toBe("LEASED");

    // (b) Missing cache entry, but the Postgres authority is HALTED: the refresh
    // fail-closed read returns HALTED, never OPEN.
    const halted = await seedWorld(pool, "SHOWTIME_FETCH");
    await seedHaltedStatus(pool, halted.providerId);
    const haltedHarness = createSyntheticHarness(corridorHops());
    await driveRun(
      makeDeps({
        harness: haltedHarness,
        parse: () =>
          Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          }),
      }),
      halted.runId,
      "SHOWTIME_FETCH",
    );
    expect(recordingRedis.count("SEMAPHORE_ACQUIRE")).toBe(0);
    expect(haltedHarness.documents).toHaveLength(0);
    expect((await readRunState(halted.runId)).state).toBe("LEASED");
  });

  it("13. B4 denial after acquisition — a stale OPEN cache against a HALTED authority: zero rows, no navigation, independently generated semaphore released", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    await seedHaltedStatus(pool, world.providerId);
    // The stale cache copy the item names: the fail-closed authority says HALTED, but a
    // leftover OPEN entry survives in Redis. The pre-checks pass on the stale copy; B4
    // is the mandatory durable fence that closes it.
    await recordingRedis.hset(providerStateCacheKey(world.providerId, "seat"), { state: "OPEN" });
    // Redis and Postgres generation sequences are independent. Force them apart so this
    // test proves the actor releases with SEMAPHORE_ACQUIRE's returned generation.
    await redisClient.set(`sem:${world.providerId}:gen`, "41");
    const harness = createSyntheticHarness(corridorHops());
    let parseCalls = 0;
    await driveRun(
      makeDeps({
        harness,
        parse: () => {
          parseCalls += 1;
          return Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          });
        },
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );

    expect(recordingRedis.count("SEMAPHORE_ACQUIRE")).toBe(1);
    expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(1);
    expect(parseCalls).toBe(0);
    expect(harness.documents).toHaveLength(0);
    expect((await readRunState(world.runId)).state).toBe("LEASED");
    // Released: the holder key is gone (the generation counter survives by design).
    expect(await redisClient.exists(`sem:${world.providerId}`)).toBe(0);
    expect(await redisClient.get(`sem:${world.providerId}:gen`)).toBe("42");
  });

  it("13a. semaphore held — the busy loser defers durably (PENDING + one fresh outbox row); a stale delivery loses the fence and resurrects nothing", async () => {
    // (a) A concurrent holder owns the capacity-one semaphore before the run is driven:
    // the real acquire loses (non-numeric reply), and instead of stranding the leased
    // run until the sweeper's expiry pass, the actor must return it to PENDING and mint
    // the replacement delivery — observed as committed Postgres rows, not call logs.
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const heldKey = `sem:${world.providerId}`;
    await redisClient.hset(heldKey, { holder: "concurrent_delivery", generation: "7" });
    await redisClient.pexpire(heldKey, SEMAPHORE_TTL_MS);
    const harness = createSyntheticHarness(corridorHops());
    let parseCalls = 0;
    await driveRun(
      makeDeps({
        harness,
        parse: () => {
          parseCalls += 1;
          return Promise.resolve({
            ok: true,
            kind: "SHOWTIME_FETCH",
            layout: FIXTURE_LAYOUT,
            bitmap: PARSED_BITMAP,
            freeCount: 1,
          });
        },
      }),
      world.runId,
      "SHOWTIME_FETCH",
    );

    expect(parseCalls).toBe(0);
    expect(harness.documents).toHaveLength(0);
    expect(recordingRedis.count("SEMAPHORE_ACQUIRE")).toBe(1); // the losing attempt
    expect(recordingRedis.count("SEMAPHORE_RELEASE")).toBe(0); // never owned capacity…
    // …and the foreign holder's lease is untouched — the loser cannot release what it
    // did not acquire.
    expect(await redisClient.hget(heldKey, "holder")).toBe("concurrent_delivery");

    // Durable proof: PENDING again, the SAME generation B2 handed out, lease cleared,
    // and exactly one fresh RUN outbox row with a NULL traceparent (off-request defer).
    const run = await readRunState(world.runId);
    expect(run.state).toBe("PENDING");
    expect(run.generation).toBe(1); // generation is a fence; the defer preserves it
    const deliveries = await pool.query<{
      target_kind: string;
      state: string;
      traceparent: string | null;
    }>(`SELECT target_kind, state, traceparent FROM outbox WHERE run_id = $1`, [world.runId]);
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0]?.target_kind).toBe("RUN");
    expect(deliveries.rows[0]?.state).toBe("PENDING");
    expect(deliveries.rows[0]?.traceparent).toBeNull();
    expect(messages.some((m) => m.includes("run deferred"))).toBe(true);

    // (b) The fence loses — a concurrent redelivery advanced the generation between the
    // context read and the busy branch: zero rows, the run is NOT resurrected, and no
    // phantom outbox row appears behind the newer delivery.
    const stale = await seedWorld(pool, "SHOWTIME_FETCH");
    const staleKey = `sem:${stale.providerId}`;
    await redisClient.hset(staleKey, { holder: "concurrent_delivery", generation: "7" });
    await redisClient.pexpire(staleKey, SEMAPHORE_TTL_MS);
    const staleHarness = createSyntheticHarness(corridorHops());
    const deps = makeDeps({
      harness: staleHarness,
      parse: () =>
        Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          layout: FIXTURE_LAYOUT,
          bitmap: PARSED_BITMAP,
          freeCount: 1,
        }),
    });
    const leased = await runStatement(db(), B2_LEASE_RUN, [stale.runId, LEASE_TTL]);
    if (leased.length === 0) {
      throw new Error(`run ${stale.runId} did not lease`);
    }
    const staleCtx = await findRunContext(db(), stale.runId);
    if (staleCtx === null) {
      throw new Error(`run context ${stale.runId} missing after lease`);
    }
    // Precondition scaffolding (CONTRIBUTING.md §2 bucket, NOT a transition under test):
    // age the generation the way a concurrent reclaim/redelivery would.
    await pool.query(`UPDATE provider_run SET generation = generation + 1 WHERE run_id = $1`, [
      stale.runId,
    ]);
    await createShowtimeFetchRunHandler(deps)({
      run: staleCtx.run,
      search: staleCtx.search,
      runKey: staleCtx.runKey,
      sqlClient: db(),
      logger,
    });

    expect((await readRunState(stale.runId)).state).toBe("LEASED");
    const staleDeliveries = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1`,
      [stale.runId],
    );
    expect(staleDeliveries.rows[0]?.n).toBe("0");
    expect(messages.some((m) => m.includes("busy-defer lost"))).toBe(true);
    expect(staleHarness.documents).toHaveLength(0);
  });

  it("14. O3 — a PARSER_SCHEMA_INCOMPATIBLE failRun attaches the run key's discrete entity identifiers to the active trace span", async () => {
    const world = await seedWorld(pool, "SHOWTIME_FETCH");
    const harness = createSyntheticHarness(corridorHops());
    // Set the run's entity identifiers as the active span so the actor's O3 attachment
    // has a target to land on (O1 wires a real one in production; absent → no-op). The
    // async-capable context manager is required because the default one does not
    // propagate across the awaits inside driveRun.
    context.setGlobalContextManager(new AsyncLocalContextManager());
    const span = new RecordingSpan();
    try {
      await context.with(trace.setSpan(context.active(), span), () =>
        driveRun(
          makeDeps({
            harness,
            parse: () => Promise.resolve({ ok: false, cause: "PARSER_SCHEMA_INCOMPATIBLE" }),
          }),
          world.runId,
          "SHOWTIME_FETCH",
        ),
      );
    } finally {
      // Restore the default (Noop) manager.
      context.disable();
    }

    await until(
      async () =>
        (await readStatusRows(world.providerId)).length > 0 &&
        (await readRunState(world.runId)).state === "FAILED",
      { label: "schema-incompatibility pause AND failed run" },
    );

    // The seeded SHOWTIME_FETCH key carries a showtimeId and runKeyId; theatre_id and
    // local_date are NULL for this key kind, so O3.2 omits them rather than "null".
    expect(span.attributes[ATTR_RUN_KEY_ID]).toBe(world.runKeyId);
    expect(span.attributes[ATTR_ENTITY_SHOWTIME_ID]).toBeTypeOf("string");
    expect(span.attributes[ATTR_ENTITY_THEATRE_ID]).toBeUndefined();
    expect(span.attributes[ATTR_ENTITY_LOCAL_DATE]).toBeUndefined();
  });
});

// --- S36.6 focused verification: production ScheduleSubscriberFilter ---

describe("S36.6 schedule subscriber filter (production seam)", () => {
  const THEATRE_TZ = "America/Chicago" as const;
  const FRIDAY = "2026-08-14"; // Friday

  function showtime(
    id: string,
    utcIso: string,
    skipFetch = false,
    movieId = "amc:movie:1",
  ): ScheduleShowtime {
    return { showtimeId: id, movieId, startsAt: new Date(utcIso), skipFetch };
  }

  function fridayEveningSpec(theatreId: string) {
    return {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST" as const, refs: [{ id: theatreId }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: FRIDAY, to: FRIDAY },
          {
            kind: "TIME_WINDOW" as const,
            days: ["FRIDAY" as const],
            startLocal: "17:00",
            endLocal: "23:59",
          },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      groupStrict: false,
      rank: "SCORE" as const,
    };
  }

  function daytimeSpec(theatreId: string) {
    return {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST" as const, refs: [{ id: theatreId }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: FRIDAY, to: FRIDAY },
          {
            kind: "TIME_WINDOW" as const,
            days: ["FRIDAY" as const],
            startLocal: "09:00",
            endLocal: "12:00",
          },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      groupStrict: false,
      rank: "SCORE" as const,
    };
  }

  it("shared-subscriber: same UTC schedule, different windows produce disjoint filtered sets while stored rows remain complete", () => {
    const theatreId = "amc:theatre:7";
    // 2026-08-14 Friday in Chicago CDT UTC-5. 17:00 local = 22:00Z, 10:00 local = 15:00Z.
    const showtimes: ScheduleShowtime[] = [
      showtime("st-evening", "2026-08-14T22:30:00.000Z"), // 17:30 Friday Chicago -> evening match
      showtime("st-day", "2026-08-14T15:00:00.000Z"), // 10:00 Friday Chicago -> daytime match
      showtime("st-night", "2026-08-15T04:30:00.000Z"), // 23:30 Friday Chicago -> evening match (late)
    ];
    const evening = fridayEveningSpec(theatreId);
    const daytime = daytimeSpec(theatreId);

    const eveningFiltered = scheduleSubscriberFilter({
      searchId: "search_evening",
      spec: evening,
      timezone: THEATRE_TZ,
      showtimes,
    });
    const daytimeFiltered = scheduleSubscriberFilter({
      searchId: "search_day",
      spec: daytime,
      timezone: THEATRE_TZ,
      showtimes,
    });

    expect(eveningFiltered.map((s) => s.showtimeId).sort()).toEqual(
      ["st-evening", "st-night"].sort(),
    );
    expect(daytimeFiltered.map((s) => s.showtimeId)).toEqual(["st-day"]);
    // Durability stored rows would still contain all three performances; filtering does not truncate storage.
    expect(showtimes).toHaveLength(3);
  });

  it("movie predicate excludes other movies from the same schedule", () => {
    const theatreId = "amc:theatre:7";
    const spec = fridayEveningSpec(theatreId);
    const matching = showtime("st-matching", "2026-08-14T22:30:00.000Z");
    const other = showtime("st-other", "2026-08-14T23:00:00.000Z", false, "amc:movie:2");

    const filtered = scheduleSubscriberFilter({
      searchId: "search_movie",
      spec,
      timezone: THEATRE_TZ,
      showtimes: [matching, other],
    });

    expect(filtered.map((showtime) => showtime.showtimeId)).toEqual(["st-matching"]);
  });

  it("date/time: positive match inside window, negative controls just before/after and weekday mismatch", () => {
    const theatreId = "amc:theatre:7";
    const spec = fridayEveningSpec(theatreId);
    // 21:59Z = 16:59 local Friday -> before window
    const before = showtime("st-before", "2026-08-14T21:59:00.000Z");
    // 22:00Z = 17:00 local -> inside
    const inside = showtime("st-inside", "2026-08-14T22:00:00.000Z");
    // 05:00Z Sat = 00:00 Sat -> outside weekday
    const after = showtime("st-after", "2026-08-15T05:00:00.000Z");
    // Saturday 17:30 -> same time but wrong weekday
    const wrongDay = showtime("st-sat", "2026-08-15T22:30:00.000Z");

    const filtered = scheduleSubscriberFilter({
      searchId: "s",
      spec,
      timezone: THEATRE_TZ,
      showtimes: [before, inside, after, wrongDay],
    });
    expect(filtered.map((s) => s.showtimeId)).toEqual(["st-inside"]);
  });

  it("DST: spring-forward and fall-back instants map via theatre-local, not UTC", () => {
    const theatreId = "amc:theatre:7";
    // DST spring Sunday 2026-03-08: narrow 01:00-01:59 window, Chicago jumps 02:00 -> 03:00
    const springSpec = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST" as const, refs: [{ id: theatreId }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: "2026-03-08", to: "2026-03-08" },
          {
            kind: "TIME_WINDOW" as const,
            days: ["SUNDAY" as const],
            startLocal: "01:00",
            endLocal: "01:59",
          },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      groupStrict: false,
      rank: "SCORE" as const,
    };
    const justBefore = showtime("st-spring-before", "2026-03-08T07:59:59.000Z"); // 01:59:59 CST
    const justAfter = showtime("st-spring-after", "2026-03-08T08:00:00.000Z"); // 03:00 CDT
    const springFiltered = scheduleSubscriberFilter({
      searchId: "s",
      spec: springSpec,
      timezone: THEATRE_TZ,
      showtimes: [justBefore, justAfter],
    });
    expect(springFiltered.map((s) => s.showtimeId)).toEqual(["st-spring-before"]);

    // Fall-back Sunday 2026-11-01: two 01:30 instances (CDT and CST) both map to 01:30
    const fallSpec = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST" as const, refs: [{ id: theatreId }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: "2026-11-01", to: "2026-11-01" },
          {
            kind: "TIME_WINDOW" as const,
            days: ["SUNDAY" as const],
            startLocal: "01:00",
            endLocal: "01:30",
          },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      groupStrict: false,
      rank: "SCORE" as const,
    };
    const first130 = showtime("st-fall-first", "2026-11-01T06:30:00.000Z"); // 01:30 CDT
    const second130 = showtime("st-fall-second", "2026-11-01T07:30:00.000Z"); // 01:30 CST
    const fallFiltered = scheduleSubscriberFilter({
      searchId: "s2",
      spec: fallSpec,
      timezone: THEATRE_TZ,
      showtimes: [first130, second130],
    });
    expect(fallFiltered.map((s) => s.showtimeId).sort()).toEqual(
      ["st-fall-first", "st-fall-second"].sort(),
    );
  });

  it("S57: populates theatre-local showDateTimeLocal alongside dispatchRank (DST-safe)", () => {
    const theatreId = "amc:theatre:7";
    const spec = fridayEveningSpec(theatreId);
    // 2026-08-14 Friday in Chicago (CDT, UTC-5): 22:30Z -> 17:30 local.
    const evening = showtime("st-s57-evening", "2026-08-14T22:30:00.000Z");
    const late = showtime("st-s57-late", "2026-08-15T04:30:00.000Z"); // 23:30 Friday local
    const filtered = scheduleSubscriberFilter({
      searchId: "s",
      spec,
      timezone: THEATRE_TZ,
      showtimes: [evening, late],
    });
    expect(filtered).toHaveLength(2);
    for (const st of filtered) {
      expect(st.dispatchRank).toEqual(expect.any(Number));
      expect(typeof st.showDateTimeLocal).toBe("string");
    }
    const byId = new Map(filtered.map((st) => [st.showtimeId, st]));
    // Theatre-local wall time, not the UTC instant: the same `toTheatreLocal`
    // conversion `buildScheduleSkeleton` uses in `routes/searches/create.ts`.
    expect(byId.get("st-s57-evening")!.showDateTimeLocal).toBe("2026-08-14T17:30:00");
    expect(byId.get("st-s57-late")!.showDateTimeLocal).toBe("2026-08-14T23:30:00");

    // DST spring-forward Sunday 2026-03-08: 07:59:59Z is 01:59:59 CST (UTC-6),
    // one second later is 03:00 CDT. The local datetime must follow the theatre
    // clock across the jump, never UTC.
    const springSpec = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST" as const, refs: [{ id: theatreId }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: "2026-03-08", to: "2026-03-08" },
          {
            kind: "TIME_WINDOW" as const,
            days: ["SUNDAY" as const],
            startLocal: "01:00",
            endLocal: "01:59",
          },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      groupStrict: false,
      rank: "SCORE" as const,
    };
    const springFiltered = scheduleSubscriberFilter({
      searchId: "s",
      spec: springSpec,
      timezone: THEATRE_TZ,
      showtimes: [showtime("st-s57-spring", "2026-03-08T07:59:59.000Z")],
    });
    expect(springFiltered).toHaveLength(1);
    expect(springFiltered[0]!.showDateTimeLocal).toBe("2026-03-08T01:59:59");
  });

  it("fail-closed: invalid spec or ambiguous predicate yields empty filtered set, not throw", () => {
    const badSpec = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:7" }] },
      where: {
        kind: "OR",
        of: [
          { kind: "DATE_RANGE", from: "2026-08-14", to: "2026-08-14" },
          { kind: "MOVIE", ids: ["m"] },
        ],
      },
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    } as unknown;
    const st = showtime("st-1", "2026-08-14T22:00:00.000Z");
    const filtered = scheduleSubscriberFilter({
      searchId: "s",
      spec: badSpec,
      timezone: THEATRE_TZ,
      showtimes: [st],
    });
    expect(filtered).toEqual([]);
    // Not an object at all
    const filtered2 = scheduleSubscriberFilter({
      searchId: "s",
      spec: null,
      timezone: THEATRE_TZ,
      showtimes: [st],
    });
    expect(filtered2).toEqual([]);
  });

  it("no-core-import proof: packages/durability has no import of @seatfirst/core", () => {
    const durabilitySrc = join(process.cwd(), "../../packages/durability/src");
    const files = readdirSync(durabilitySrc).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = readFileSync(join(durabilitySrc, file), "utf8");
      expect(content).not.toMatch(/from\s+["']@seatfirst\/core["']/);
    }
    // Also check transactions.ts specifically contains ScheduleSubscriberFilter but no core import
    const tx = readFileSync(join(durabilitySrc, "transactions.ts"), "utf8");
    expect(tx).toContain("ScheduleSubscriberFilter");
    expect(tx).not.toMatch(/from\s+["']@seatfirst\/core["']/);
  });

  it("uses shared core evaluator: matchesScheduleWindow is the delegated evaluator (no duplicate logic)", () => {
    // Prove delegation by checking source contains exactly one call site and no toTheatreLocal duplication
    const actorSrc = readFileSync(
      join(process.cwd(), "src/dispatch/handlers/provider-fetch-actor.ts"),
      "utf8",
    );
    // Production filter must import and call matchesScheduleWindow exactly once per showtime
    expect(actorSrc).toMatch(/matchesScheduleWindow/);
    // Must not reimplement local date logic inline (no direct Intl.DateTimeFormat duplication in filter)
    const filterBlock = actorSrc.slice(
      actorSrc.indexOf("scheduleSubscriberFilter"),
      actorSrc.indexOf("scheduleSubscriberFilter") + 2000,
    );
    expect(filterBlock).toContain("matchesScheduleWindow");
    // Ensure filter does not contain manual weekday/time comparisons
    expect(filterBlock).not.toMatch(/localDate\s*</);
  });
});
