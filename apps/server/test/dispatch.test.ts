import { Queue } from "bullmq";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { poolClient } from "@seatfirst/durability";

import {
  AGGREGATE_NOT_IMPLEMENTED,
  createDispatchWorkers,
  createPlaceholderRegistry,
  implementedHandler,
  SCHEDULE_RESOLUTION_NOT_IMPLEMENTED,
  SHOWTIME_FETCH_NOT_IMPLEMENTED,
} from "../src/dispatch/index.js";
import type {
  DispatchDeps,
  DispatchHandle,
  DispatchRegistry,
  JobHandlerContext,
  RunHandlerContext,
} from "../src/dispatch/index.js";
import { publish } from "../src/queue/index.js";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { RelayMessage } from "../src/relay/publisher.js";
import type { AggregateHintMessage } from "../src/sweeper/index.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { capturingLogger as capturingCallsLogger } from "./support/logger.js";
import { until } from "./support/queue-redis.js";

/**
 * S11 verification, items 1–7 of the spec's verification list — against real Postgres 16
 * and Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`), publishing through
 * S7's own `publish()` and consuming through S11's real `createDispatchWorkers` (S7's
 * `createWorker`) — never a direct function call standing in for the broker round trip.
 *
 * Raw INSERTs below are seed data (the legitimate non-boundary bucket, `CONTRIBUTING.md`
 * §2) — the transitions under test (`B2_LEASE_JOB`, `B2_LEASE_RUN`, `B7_CLAIM`) are
 * performed exclusively by the dispatch harness under test.
 */

// --- seed helpers (raw INSERTs: seed data, not state transitions) -------------------

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

async function seedSearch(
  pool: Pool,
  opts: { searchId?: string; status?: string; aggRequestedRev?: number } = {},
): Promise<string> {
  const searchId = opts.searchId ?? uniq("search");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status,
                         deadline_at, agg_requested_rev)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7)`,
    [
      searchId,
      uniq("session"),
      uniq("idem"),
      `hash_${searchId}`,
      opts.status ?? "RUNNING",
      FUTURE,
      opts.aggRequestedRev ?? 0,
    ],
  );
  return searchId;
}

async function seedRunKey(
  pool: Pool,
  opts: {
    runKeyId?: string;
    kind?: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION";
    showtimeId?: string;
    theatreId?: string;
    localDate?: string;
  } = {},
): Promise<string> {
  const runKeyId = opts.runKeyId ?? uniq("key");
  const kind = opts.kind ?? "SHOWTIME_FETCH";
  if (kind === "SHOWTIME_FETCH") {
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
      [runKeyId, opts.showtimeId ?? uniq("showtime")],
    );
  } else {
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
       VALUES ($1, 'SCHEDULE_RESOLUTION', 'amc', 'schedule', $2, $3)`,
      [runKeyId, opts.theatreId ?? uniq("theatre"), opts.localDate ?? "2026-08-20"],
    );
  }
  return runKeyId;
}

async function seedJob(
  pool: Pool,
  opts: {
    jobId?: string;
    searchId: string;
    runKeyId: string;
    kind?: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION";
    state?: string;
  },
): Promise<string> {
  const jobId = opts.jobId ?? uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6)`,
    [
      jobId,
      opts.searchId,
      opts.kind ?? "SHOWTIME_FETCH",
      opts.runKeyId,
      opts.state ?? "PENDING",
      FUTURE,
    ],
  );
  return jobId;
}

async function seedRun(
  pool: Pool,
  opts: { runId?: string; runKeyId: string; state?: string },
): Promise<string> {
  const runId = opts.runId ?? uniq("run");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, $4, 0, 0)`,
    [runId, opts.runKeyId, uniq("obs"), opts.state ?? "PENDING"],
  );
  return runId;
}

async function seedSubscription(
  pool: Pool,
  opts: { runKeyId: string; searchId: string; jobId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at)
     VALUES ($1, $2, $3, 'LIVE', $4)`,
    [opts.runKeyId, opts.searchId, opts.jobId, FUTURE],
  );
}

/** Captures every `error`/`warn` call so placeholder-path assertions have evidence to
 * wait on, without an arbitrary sleep. */
function capturingLogger(): { logger: SeatfirstLogger; messages: string[] } {
  const messages: string[] = [];
  const record =
    (push: boolean) =>
    (_fields: Record<string, unknown>, message: string): void => {
      if (push) {
        messages.push(message);
      }
    };
  const build = (): SeatfirstLogger => ({
    trace: record(false),
    debug: record(false),
    info: record(false),
    warn: record(true),
    error: record(true),
    fatal: record(true),
    // Children share the same sink — lease-loss and other post-child warns must land
    // in `messages` for the `until()` waits below.
    child: () => build(),
  });
  return { messages, logger: build() };
}

// --- fixture wiring ------------------------------------------------------------------

let pg: TestService;
let redis: TestService;
let pool: Pool;
let jobQueue: Queue<RelayMessage>;
let runQueue: Queue<RelayMessage>;
let aggregateQueue: Queue<AggregateHintMessage>;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);

  pool = new Pool({ connectionString: pg.url });
  const connection = { url: redis.url };
  jobQueue = new Queue<RelayMessage>("job-queue", { connection });
  runQueue = new Queue<RelayMessage>("run-queue", { connection });
  aggregateQueue = new Queue<AggregateHintMessage>("aggregate-queue", { connection });
});

afterAll(async () => {
  await Promise.allSettled([
    jobQueue.close(),
    runQueue.close(),
    aggregateQueue.close(),
    pool.end(),
  ]);
  await Promise.allSettled([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await pool.query("TRUNCATE search, run_key CASCADE");
  await jobQueue.drain();
  await runQueue.drain();
  await aggregateQueue.drain();
});

const db = () => poolClient(pool);

/** Starts a harness for one test with the given registry + lease TTL; caller closes it. */
function startHarness(
  registry: DispatchRegistry,
  leaseTtl: string,
  logger: SeatfirstLogger,
): DispatchHandle {
  const deps: DispatchDeps = { db: db(), registry, logger };
  return createDispatchWorkers(
    deps,
    { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
    { leaseTtl },
  );
}

describe("dispatch worker (S11)", () => {
  it("1. happy-path JOB lease-and-route: leases via B2_LEASE_JOB and dispatches with correct context", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });

    const captured: JobHandlerContext[] = [];
    const registry: DispatchRegistry = {
      ...createPlaceholderRegistry(),
      job: {
        ...createPlaceholderRegistry().job,
        SHOWTIME_FETCH: implementedHandler<(ctx: JobHandlerContext) => void>((ctx) => {
          captured.push(ctx);
        }),
      },
    };
    const { logger } = capturingLogger();
    const handle = startHarness(registry, "5 minutes", logger);
    try {
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      await until(() => Promise.resolve(captured.length > 0), { label: "JOB handler invoked" });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.job.jobId).toBe(jobId);
      expect(captured[0]?.job.state).toBe("LEASED");
      expect(captured[0]?.job.generation).toBe(1);
      expect(captured[0]?.search.searchId).toBe(searchId);
      expect(captured[0]?.runKey.runKeyId).toBe(keyId);

      const row = (
        await pool.query<{ state: string; generation: number }>(
          `SELECT state, generation FROM search_job WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];
      expect(row?.state).toBe("LEASED");
      expect(row?.generation).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("2. duplicate-lease rejection: the second of two competing messages gets zero rows and is not dispatched", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });

    const captured: JobHandlerContext[] = [];
    const registry: DispatchRegistry = {
      ...createPlaceholderRegistry(),
      job: {
        ...createPlaceholderRegistry().job,
        SHOWTIME_FETCH: implementedHandler<(ctx: JobHandlerContext) => void>((ctx) => {
          captured.push(ctx);
        }),
      },
    };
    const { logger, messages } = capturingLogger();
    const handle = startHarness(registry, "5 minutes", logger);
    try {
      // Two DISTINCT BullMQ deliveries for the SAME job_id: different BullMQ dedup keys
      // (outboxId), same message.targetId — bypassing the relay publisher's own
      // targetId-keyed dedup, exactly as the spec directs (verification item 2).
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      await until(() => Promise.resolve(messages.some((m) => m.includes("lease lost"))), {
        label: "second message's lease-lost warning",
      });

      expect(captured).toHaveLength(1);
      const row = (
        await pool.query<{ generation: number }>(
          `SELECT generation FROM search_job WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];
      expect(row?.generation).toBe(1); // bumped exactly once, not twice
    } finally {
      await handle.close();
    }
  });

  it("3. RUN branch routes through run_key.kind: leases via B2_LEASE_RUN and dispatches with correct context", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });
    await seedSubscription(pool, { runKeyId: keyId, searchId, jobId });
    const runId = await seedRun(pool, { runKeyId: keyId });

    const captured: RunHandlerContext[] = [];
    const registry: DispatchRegistry = {
      ...createPlaceholderRegistry(),
      run: {
        ...createPlaceholderRegistry().run,
        SHOWTIME_FETCH: implementedHandler<(ctx: RunHandlerContext) => void>((ctx) => {
          captured.push(ctx);
        }),
      },
    };
    const { logger } = capturingLogger();
    const handle = startHarness(registry, "5 minutes", logger);
    try {
      await publish(runQueue, "RUN", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "RUN",
        targetId: runId,
        traceparent: null,
      });

      await until(() => Promise.resolve(captured.length > 0), { label: "RUN handler invoked" });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.run.runId).toBe(runId);
      expect(captured[0]?.run.state).toBe("LEASED");
      expect(captured[0]?.run.generation).toBe(1);
      expect(captured[0]?.runKey.runKeyId).toBe(keyId);
      expect(captured[0]?.search?.searchId).toBe(searchId); // best-effort LIVE subscriber

      const row = (
        await pool.query<{ state: string; generation: number }>(
          `SELECT state, generation FROM provider_run WHERE run_id = $1`,
          [runId],
        )
      ).rows[0];
      expect(row?.state).toBe("LEASED");
      expect(row?.generation).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("4. loud-fail BEFORE lease — SHOWTIME_FETCH JOB placeholder: B2_LEASE_JOB never called, row stays PENDING", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });

    const { logger, messages } = capturingLogger();
    const handle = startHarness(createPlaceholderRegistry(), "5 minutes", logger);
    try {
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      await until(
        () => Promise.resolve(messages.some((m) => m.includes(SHOWTIME_FETCH_NOT_IMPLEMENTED))),
        { label: "SHOWTIME_FETCH placeholder logged" },
      );

      const row = (
        await pool.query<{ state: string; generation: number }>(
          `SELECT state, generation FROM search_job WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];
      expect(row?.state).toBe("PENDING");
      expect(row?.generation).toBe(0);
      const failedIds = (await jobQueue.getFailed()).map((j) => j.id);
      expect(failedIds).not.toContain(jobId);
    } finally {
      await handle.close();
    }
  });

  it("5. loud-fail BEFORE lease — SCHEDULE_RESOLUTION JOB placeholder: row stays PENDING", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SCHEDULE_RESOLUTION" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SCHEDULE_RESOLUTION" });

    const { logger, messages } = capturingLogger();
    const handle = startHarness(createPlaceholderRegistry(), "5 minutes", logger);
    try {
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      await until(
        () =>
          Promise.resolve(messages.some((m) => m.includes(SCHEDULE_RESOLUTION_NOT_IMPLEMENTED))),
        { label: "SCHEDULE_RESOLUTION placeholder logged" },
      );

      const row = (
        await pool.query<{ state: string; generation: number }>(
          `SELECT state, generation FROM search_job WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];
      expect(row?.state).toBe("PENDING");
      expect(row?.generation).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("6. AGGREGATE hint — loud-fail BEFORE claim: B7_CLAIM never called, search row unmodified", async () => {
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });

    const { logger, messages } = capturingLogger();
    const handle = startHarness(createPlaceholderRegistry(), "1 minute", logger);
    try {
      await publish(aggregateQueue, "AGGREGATE", searchId, { searchId });

      await until(
        () => Promise.resolve(messages.some((m) => m.includes(AGGREGATE_NOT_IMPLEMENTED))),
        { label: "AGGREGATE placeholder logged" },
      );

      const row = (
        await pool.query<{ agg_generation: number; agg_lease_expires: string | null }>(
          `SELECT agg_generation, agg_lease_expires FROM search WHERE search_id = $1`,
          [searchId],
        )
      ).rows[0];
      expect(row?.agg_generation).toBe(0);
      expect(row?.agg_lease_expires).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("7. JOB handler lookup with injected lease TTL: B2_LEASE_JOB receives it and lease_expires_at reflects it", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });

    const captured: JobHandlerContext[] = [];
    const registry: DispatchRegistry = {
      ...createPlaceholderRegistry(),
      job: {
        ...createPlaceholderRegistry().job,
        SHOWTIME_FETCH: implementedHandler<(ctx: JobHandlerContext) => void>((ctx) => {
          captured.push(ctx);
        }),
      },
    };
    const { logger } = capturingLogger();
    const handle = startHarness(registry, "15 seconds", logger);
    try {
      await publish(jobQueue, "JOB", uniq("outbox"), {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      await until(() => Promise.resolve(captured.length > 0), { label: "JOB handler invoked" });

      const row = (
        await pool.query<{ lease_expires_at: string }>(
          `SELECT lease_expires_at FROM search_job WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];
      expect(row).toBeDefined();
      const ttlMs = new Date(row!.lease_expires_at).getTime() - Date.now();
      // 15s injected TTL, not the 5-minute value other tests use — wide tolerance for
      // test-runtime jitter, tight enough to distinguish from a 5-minute default.
      expect(ttlMs).toBeGreaterThan(5_000);
      expect(ttlMs).toBeLessThan(25_000);
    } finally {
      await handle.close();
    }
  });

  it("8. handler failure: logs 'handler failed' with target_id before rethrowing into BullMQ's failed set", async () => {
    const searchId = await seedSearch(pool);
    const keyId = await seedRunKey(pool, { kind: "SHOWTIME_FETCH" });
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId, kind: "SHOWTIME_FETCH" });

    const registry: DispatchRegistry = {
      ...createPlaceholderRegistry(),
      job: {
        ...createPlaceholderRegistry().job,
        SHOWTIME_FETCH: implementedHandler<(ctx: JobHandlerContext) => void>(() => {
          throw new Error("boom: handler exploded");
        }),
      },
    };
    const logger = capturingCallsLogger();
    const handle = startHarness(registry, "5 minutes", logger);
    try {
      const dedupId = uniq("outbox");
      await publish(jobQueue, "JOB", dedupId, {
        outboxId: uniq("outbox"),
        targetKind: "JOB",
        targetId: jobId,
        traceparent: null,
      });

      // O11.4 — the failure is logged with identity fields BEFORE the rethrow.
      await until(
        () =>
          Promise.resolve(
            logger.calls.some((c) => c.level === "error" && c.message === "handler failed"),
          ),
        { label: "handler-failed error log" },
      );
      const failure = logger.calls.find((c) => c.message === "handler failed");
      expect(failure?.level).toBe("error");
      expect(failure?.fields.target_id).toBe(jobId);
      expect(failure?.fields.target_kind).toBe("JOB");
      expect(failure?.fields.error).toBeInstanceOf(Error);

      // NB: BullMQ keys the job by publish()'s third argument (the outbox dedup key),
      // not by the message's targetId.
      await until(async () => (await jobQueue.getFailed()).some((j) => j.id === dedupId), {
        label: "job moved to BullMQ's failed set",
      });
    } finally {
      await handle.close();
    }
  });
});
