import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeatfirstMetrics } from "@seatfirst/config/otel";

import { poolClient } from "@seatfirst/durability";

import { createRelayPublisher } from "../src/relay/publisher.js";
import type { RelayMessage } from "../src/relay/publisher.js";
import {
  advanceStaleSnapshotProjections,
  createSweeper,
  runSweeper,
  failExhaustedJobs,
  failExhaustedRuns,
  projectSearchEvents,
  publishAggregateHints,
  rearmStrandedJobs,
  rearmStrandedRuns,
  reclaimExpiredJobs,
  reclaimExpiredRuns,
  republishOverdueOutbox,
  type AggregateHintMessage,
  type SnapshotProjectionClaim,
  type SweepTickSummary,
} from "../src/sweeper/index.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { until } from "./support/queue-redis.js";

/**
 * S10 verification, items 1–11 of the spec's verification list — every duty against real
 * Postgres 16 and Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`), never
 * mocks. The durable effects come from the durability tier's own boundary statements;
 * these tests assert on committed rows and real BullMQ queues.
 *
 * Raw INSERTs below are seed data / precondition simulation (the two legitimate
 * non-boundary buckets, `CONTRIBUTING.md` §2) — the transitions under test are performed
 * exclusively by the durability statements the duties compose.
 */

import { capturingLogger } from "./support/logger.js";

// --- seed helpers (raw INSERTs: seed data, not state transitions) -------------------

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

interface SearchSeed {
  readonly searchId?: string;
  readonly status?: string;
  readonly aggRequestedRev?: number;
  readonly aggProcessedRev?: number;
  readonly aggLeaseExpires?: string | null;
  readonly deadlineAt?: string;
  readonly projectedThrough?: number;
  readonly nextSeq?: number;
}

async function seedSearch(pool: Pool, opts: SearchSeed = {}): Promise<string> {
  const searchId = opts.searchId ?? uniq("search");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status,
                         deadline_at, agg_requested_rev, agg_processed_rev, agg_lease_expires,
                         projected_through, next_seq)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      searchId,
      uniq("session"),
      uniq("idem"),
      `hash_${searchId}`,
      opts.status ?? "RUNNING",
      opts.deadlineAt ?? FUTURE,
      opts.aggRequestedRev ?? 0,
      opts.aggProcessedRev ?? 0,
      opts.aggLeaseExpires === undefined ? null : opts.aggLeaseExpires,
      opts.projectedThrough ?? 0,
      opts.nextSeq ?? 0,
    ],
  );
  return searchId;
}

interface RunKeySeed {
  readonly runKeyId?: string;
  readonly showtimeId?: string;
  readonly acceptedRevision?: number;
  readonly projectedRevision?: number;
  readonly latestCapturedAt?: string | null;
  readonly latestObservationId?: string | null;
}

async function seedRunKey(pool: Pool, opts: RunKeySeed = {}): Promise<string> {
  const runKeyId = opts.runKeyId ?? uniq("key");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id,
                          accepted_revision, projected_revision, latest_observation_id,
                          latest_captured_at)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2, $3, $4, $5, $6)`,
    [
      runKeyId,
      opts.showtimeId ?? uniq("showtime"),
      opts.acceptedRevision ?? 0,
      opts.projectedRevision ?? 0,
      opts.latestObservationId ?? null,
      opts.latestCapturedAt === undefined ? null : opts.latestCapturedAt,
    ],
  );
  return runKeyId;
}

interface JobSeed {
  readonly jobId?: string;
  readonly searchId: string;
  readonly runKeyId: string;
  readonly state?: string;
  readonly attempt?: number;
  readonly leaseExpiresAt?: string | null;
  readonly createdAt?: string;
  readonly deadlineAt?: string;
}

async function seedJob(pool: Pool, opts: JobSeed): Promise<string> {
  const jobId = opts.jobId ?? uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state,
                             lease_expires_at, attempt, deadline_at, created_at)
     VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 7, $4, $5, $6, $7, $8)`,
    [
      jobId,
      opts.searchId,
      opts.runKeyId,
      opts.state ?? "PENDING",
      opts.leaseExpiresAt === undefined ? null : opts.leaseExpiresAt,
      opts.attempt ?? 0,
      opts.deadlineAt ?? FUTURE,
      opts.createdAt ?? new Date().toISOString(),
    ],
  );
  return jobId;
}

interface RunSeed {
  readonly runId?: string;
  readonly runKeyId: string;
  readonly state?: string;
  readonly attempt?: number;
  readonly generation?: number;
  readonly leaseExpiresAt?: string | null;
  readonly createdAt?: string;
}

async function seedRun(pool: Pool, opts: RunSeed): Promise<string> {
  const runId = opts.runId ?? uniq("run");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation,
                               lease_expires_at, attempt, provider_epoch, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [
      runId,
      opts.runKeyId,
      uniq("obs"),
      opts.state ?? "PENDING",
      opts.generation ?? 0,
      opts.leaseExpiresAt === undefined ? null : opts.leaseExpiresAt,
      opts.attempt ?? 0,
      opts.createdAt ?? new Date().toISOString(),
    ],
  );
  return runId;
}

interface SubscriptionSeed {
  readonly runKeyId: string;
  readonly searchId: string;
  readonly jobId: string;
  readonly state?: string;
  readonly deadlineAt?: string;
}

async function seedSubscription(pool: Pool, opts: SubscriptionSeed): Promise<void> {
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.runKeyId, opts.searchId, opts.jobId, opts.state ?? "LIVE", opts.deadlineAt ?? FUTURE],
  );
}

interface OutboxSeed {
  readonly targetKind: "JOB" | "RUN";
  readonly jobId?: string;
  readonly runId?: string;
  readonly state?: string;
  readonly nextAttemptAt?: string;
}

async function seedOutbox(pool: Pool, opts: OutboxSeed): Promise<string> {
  const outboxId = uniq("outbox");
  await pool.query(
    `INSERT INTO outbox (outbox_id, target_kind, job_id, run_id, state, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      outboxId,
      opts.targetKind,
      opts.jobId ?? null,
      opts.runId ?? null,
      opts.state ?? "PENDING",
      opts.nextAttemptAt ?? PAST,
    ],
  );
  return outboxId;
}

// --- fixture wiring ----------------------------------------------------------------

let pg: TestService;
let redis: TestService;
let pool: Pool;
let redisAdmin: IORedis.Redis;
let jobQueue: Queue<RelayMessage>;
let runQueue: Queue<RelayMessage>;
let aggregateQueue: Queue<AggregateHintMessage>;

const silent = capturingLogger();

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);

  pool = new Pool({ connectionString: pg.url });
  redisAdmin = new IORedis.Redis(redis.url, { lazyConnect: true });
  await redisAdmin.connect();

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
  redisAdmin.disconnect();
  await Promise.allSettled([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await pool.query("TRUNCATE search, run_key CASCADE");
  await jobQueue.drain();
  await runQueue.drain();
  await aggregateQueue.drain();
});

const db = () => poolClient(pool);
const publisher = () => createRelayPublisher({ url: redis.url }, silent);

describe("sweeper duties (S10)", () => {
  it("1. republishes an overdue PENDING outbox row via BullMQ and marks it PUBLISHED", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId });
    const outboxId = await seedOutbox(pool, { targetKind: "JOB", jobId });

    const published = await republishOverdueOutbox(db(), publisher(), 10);
    expect(published).toBe(1);

    const job = await jobQueue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.name).toBe("JOB");
    expect(job!.data).toEqual({ outboxId, targetKind: "JOB", targetId: jobId, traceparent: null });

    const row = (
      await pool.query<{ state: string }>(`SELECT state FROM outbox WHERE outbox_id = $1`, [
        outboxId,
      ])
    ).rows[0];
    expect(row?.state).toBe("PUBLISHED");

    // Already published: the next pass republishes nothing for it (idempotent fence).
    expect(await republishOverdueOutbox(db(), publisher(), 10)).toBe(0);
  });

  it("2. re-arms a stranded job whose outbox row is already PUBLISHED", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, {
      searchId,
      runKeyId: keyId,
      createdAt: PAST,
    });
    // Simulate the dead-lettered delivery: the message went out, the lease never came.
    await seedOutbox(pool, { targetKind: "JOB", jobId, state: "PUBLISHED" });

    expect(await rearmStrandedJobs(db(), "1 minute")).toBe(1);

    const counts = (
      await pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE job_id = $1`, [jobId])
    ).rows[0];
    expect(counts?.n).toBe("2");
    const job = (
      await pool.query<{ state: string }>(`SELECT state FROM search_job WHERE job_id = $1`, [jobId])
    ).rows[0];
    expect(job?.state).toBe("PENDING");
  });

  it("3. re-arms a stranded run (RUN-targeted outbox row) but never a terminal search's run", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId });
    await seedSubscription(pool, { runKeyId: keyId, searchId, jobId });
    const runId = await seedRun(pool, { runKeyId: keyId, createdAt: PAST });
    await seedOutbox(pool, { targetKind: "RUN", runId, state: "PUBLISHED" });

    expect(await rearmStrandedRuns(db(), "1 minute")).toBe(1);

    const counts = (
      await pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE run_id = $1`, [runId])
    ).rows[0];
    expect(counts?.n).toBe("2");
    const row = (
      await pool.query<{ target_kind: string }>(
        `SELECT target_kind FROM outbox WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [runId],
      )
    ).rows[0];
    expect(row?.target_kind).toBe("RUN");
    const run = (
      await pool.query<{ state: string }>(`SELECT state FROM provider_run WHERE run_id = $1`, [
        runId,
      ])
    ).rows[0];
    expect(run?.state).toBe("PENDING");

    // Positive control: the same aged PENDING run under a terminal search is skipped —
    // re-arm is for stranded live work, not resurrection (S10.3).
    await pool.query(`UPDATE search SET status = 'COMPLETE' WHERE search_id = $1`, [searchId]);
    expect(await rearmStrandedRuns(db(), "1 minute")).toBe(0);
  });

  it("4. reclaims an expired job lease: back to PENDING, generation bumped, fresh outbox row", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, {
      searchId,
      runKeyId: keyId,
      state: "LEASED",
      attempt: 2,
      leaseExpiresAt: PAST,
    });
    await seedOutbox(pool, { targetKind: "JOB", jobId, state: "PUBLISHED" });

    expect(await reclaimExpiredJobs(db(), 5)).toBe(1);

    const job = (
      await pool.query<{ state: string; generation: number; lease_expires_at: string | null }>(
        `SELECT state, generation, lease_expires_at FROM search_job WHERE job_id = $1`,
        [jobId],
      )
    ).rows[0];
    expect(job?.state).toBe("PENDING");
    expect(job?.generation).toBe(8);
    expect(job?.lease_expires_at).toBeNull();
    const counts = (
      await pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE job_id = $1`, [jobId])
    ).rows[0];
    expect(counts?.n).toBe("2");
  });

  it("5. fails an exhausted job through the composed helper: FAILED + cancelled sub + FETCH_FAILED event", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, {
      searchId,
      runKeyId: keyId,
      state: "LEASED",
      attempt: 5,
      leaseExpiresAt: PAST,
    });
    await seedSubscription(pool, { runKeyId: keyId, searchId, jobId });

    const outcome = await failExhaustedJobs(pool, 5);
    expect(outcome.failed).toBe(1);
    expect(outcome.affectedSearchIds).toEqual([searchId]);

    const job = (
      await pool.query<{ state: string; fail_cause: string }>(
        `SELECT state, fail_cause FROM search_job WHERE job_id = $1`,
        [jobId],
      )
    ).rows[0];
    expect(job?.state).toBe("FAILED");
    expect(job?.fail_cause).toBe("ATTEMPTS_EXHAUSTED");

    const sub = (
      await pool.query<{ state: string }>(
        `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
        [keyId, searchId],
      )
    ).rows[0];
    expect(sub?.state).toBe("CANCELLED");

    const event = (
      await pool.query<{ type: string }>(
        `SELECT type FROM search_event WHERE search_id = $1 AND seq = 1`,
        [searchId],
      )
    ).rows[0];
    expect(event?.type).toBe("FETCH_FAILED");
  });

  it("6. reclaims an expired run lease: back to PENDING with a fresh outbox row", async () => {
    const keyId = await seedRunKey(pool, {});
    const runId = await seedRun(pool, {
      runKeyId: keyId,
      state: "LEASED",
      attempt: 1,
      generation: 1,
      leaseExpiresAt: PAST,
    });
    await seedOutbox(pool, { targetKind: "RUN", runId, state: "PUBLISHED" });

    expect(await reclaimExpiredRuns(db(), 5)).toBe(1);

    const run = (
      await pool.query<{ state: string; generation: number; lease_expires_at: string | null }>(
        `SELECT state, generation, lease_expires_at FROM provider_run WHERE run_id = $1`,
        [runId],
      )
    ).rows[0];
    expect(run?.state).toBe("PENDING");
    expect(run?.generation).toBe(2);
    expect(run?.lease_expires_at).toBeNull();
    const counts = (
      await pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE run_id = $1`, [runId])
    ).rows[0];
    expect(counts?.n).toBe("2");
  });

  it("7. fails an exhausted run through the composed helper: B5F effects apply atomically", async () => {
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    const jobId = await seedJob(pool, { searchId, runKeyId: keyId });
    await seedSubscription(pool, { runKeyId: keyId, searchId, jobId });
    const runId = await seedRun(pool, {
      runKeyId: keyId,
      state: "LEASED",
      attempt: 5,
      generation: 1,
      leaseExpiresAt: PAST,
    });

    const outcome = await failExhaustedRuns(pool, 5);
    expect(outcome.failed).toBe(1);
    expect(outcome.affectedSearchIds).toEqual([searchId]);

    const run = (
      await pool.query<{ state: string; fail_cause: string }>(
        `SELECT state, fail_cause FROM provider_run WHERE run_id = $1`,
        [runId],
      )
    ).rows[0];
    expect(run?.state).toBe("FAILED");
    expect(run?.fail_cause).toBe("ATTEMPTS_EXHAUSTED");

    const sub = (
      await pool.query<{ state: string }>(
        `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
        [keyId, searchId],
      )
    ).rows[0];
    expect(sub?.state).toBe("CANCELLED");

    const event = (
      await pool.query<{ type: string }>(
        `SELECT type FROM search_event WHERE search_id = $1 AND seq = 1`,
        [searchId],
      )
    ).rows[0];
    expect(event?.type).toBe("FETCH_FAILED");
  });

  it("8. publishes an AGGREGATE B7 hint { searchId } directly — never through the outbox", async () => {
    const searchId = await seedSearch(pool, { aggRequestedRev: 2, aggProcessedRev: 0 });

    const outcome = await publishAggregateHints(db(), aggregateQueue);
    expect(outcome).toEqual({ published: 1, searchIds: [searchId] });

    const hint = await aggregateQueue.getJob(searchId);
    expect(hint).toBeDefined();
    expect(hint!.name).toBe("AGGREGATE");
    expect(hint!.data).toEqual({ searchId });
    // No outboxId/targetKind: the hint is transport-only, not an outbox target kind.
    expect("outboxId" in (hint!.data as object)).toBe(false);
    expect("targetKind" in (hint!.data as object)).toBe(false);

    const outboxCount = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM outbox`))
      .rows[0];
    expect(outboxCount?.n).toBe("0");

    const worker = new Worker<AggregateHintMessage>("aggregate-queue", () => Promise.resolve(), {
      connection: { url: redis.url },
    });
    try {
      await until(async () => (await hint!.getState()) === "completed", {
        label: "first aggregate hint completed",
      });
    } finally {
      await worker.close();
    }

    await pool.query(
      `UPDATE search SET agg_processed_rev = 2, agg_requested_rev = 3 WHERE search_id = $1`,
      [searchId],
    );
    const later = await publishAggregateHints(db(), aggregateQueue);
    expect(later).toEqual({ published: 1, searchIds: [searchId] });
    const replacement = await aggregateQueue.getJob(searchId);
    expect(replacement).toBeDefined();
    expect(await replacement!.getState()).toBe("waiting");
  });

  it("9. projects unprojected events with crash recovery (entry IDs 1-0 and 2-0, watermark 2)", async () => {
    const searchId = await seedSearch(pool, { projectedThrough: 0, nextSeq: 2 });
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES
         ($1, 1, 'FETCH_ACCEPTED', '{"observationId":"obs_1"}'),
         ($1, 2, 'FETCH_ACCEPTED', '{"observationId":"obs_2"}')`,
      [searchId],
    );

    expect(await projectSearchEvents(db(), redisAdmin, searchId)).toBe(2);

    const streamKey = `search:${searchId}`;
    const entries = await redisAdmin.xrange(streamKey, "-", "+");
    expect(entries.map(([id]) => id)).toEqual(["1-0", "2-0"]);
    // I15.3 (ADR 0080 SRE-01): every projected event carries the 24h baseline TTL, so
    // abandoned streams stay eligible for volatile-lru eviction. A missing EXPIRE reads
    // back as -1; the terminal 1h tier would read back ≤ 3600.
    expect(await redisAdmin.ttl(streamKey)).toBeGreaterThan(3600);
    expect(await redisAdmin.ttl(streamKey)).toBeLessThanOrEqual(86400);
    const watermark = (
      await pool.query<{ projected_through: string }>(
        `SELECT projected_through FROM search WHERE search_id = $1`,
        [searchId],
      )
    ).rows[0];
    expect(watermark?.projected_through).toBe("2");

    // Crash recovery (T23): entry 2-0 exists but the durable watermark is behind — the
    // projector must detect the existing entry via XRANGE and reconcile, not fail, and
    // never duplicate the entry.
    await pool.query(`UPDATE search SET projected_through = 1 WHERE search_id = $1`, [searchId]);
    expect(await projectSearchEvents(db(), redisAdmin, searchId)).toBe(1);
    expect(await redisAdmin.xlen(streamKey)).toBe(2);
    const recovered = (
      await pool.query<{ projected_through: string }>(
        `SELECT projected_through FROM search WHERE search_id = $1`,
        [searchId],
      )
    ).rows[0];
    expect(recovered?.projected_through).toBe("2");
  });

  it("9b. tightens the stream TTL to 1h on SEARCH_TERMINAL (I15.3)", async () => {
    const searchId = await seedSearch(pool, { projectedThrough: 0, nextSeq: 1 });
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES
         ($1, 1, 'SEARCH_TERMINAL', '{"status":"COMPLETE","cause":null,"answer":null}')`,
      [searchId],
    );

    expect(await projectSearchEvents(db(), redisAdmin, searchId)).toBe(1);

    const streamKey = `search:${searchId}`;
    expect(await redisAdmin.xlen(streamKey)).toBe(1);
    // The terminal tier reads back ≤ 3600; a missing EXPIRE reads back as -1 and the
    // 24h baseline would read back > 3600.
    expect(await redisAdmin.ttl(streamKey)).toBeGreaterThan(0);
    expect(await redisAdmin.ttl(streamKey)).toBeLessThanOrEqual(3600);
  });

  it("10. advances a stale snapshot projection: discover → claim → compute → advance", async () => {
    const keyId = await seedRunKey(pool, {
      acceptedRevision: 3,
      projectedRevision: 1,
      latestCapturedAt: PAST,
      latestObservationId: "obs_latest",
    });
    const computed: SnapshotProjectionClaim[] = [];

    const advanced = await advanceStaleSnapshotProjections(db(), {
      age: "1 minute",
      compute: (claim) => {
        computed.push(claim);
        return Promise.resolve();
      },
    });
    expect(advanced).toBe(1);
    expect(computed).toEqual([
      { runKeyId: keyId, acceptedRevision: "3", latestObservationId: "obs_latest" },
    ]);

    const key = (
      await pool.query<{ projected_revision: string }>(
        `SELECT projected_revision FROM run_key WHERE run_key_id = $1`,
        [keyId],
      )
    ).rows[0];
    expect(key?.projected_revision).toBe("3");

    // Caught up: the next pass discovers nothing.
    expect(
      await advanceStaleSnapshotProjections(db(), {
        age: "1 minute",
        compute: () => Promise.resolve(),
      }),
    ).toBe(0);
  });

  it("10b. isolates a poisoned snapshot row: sibling rows still advance, failure resurfaces", async () => {
    // Regression for the poison-pill bug: one failing row (e.g. a transient Redis blip)
    // used to abort the whole loop, permanently blocking every other stale key — including
    // fixable SHOWTIME_FETCH rows — from ever advancing.
    const poisonedKeyId = await seedRunKey(pool, {
      acceptedRevision: 3,
      projectedRevision: 1,
      latestCapturedAt: PAST,
      latestObservationId: "obs_poison",
    });
    const healthyKeyId = await seedRunKey(pool, {
      acceptedRevision: 3,
      projectedRevision: 1,
      latestCapturedAt: PAST,
      latestObservationId: "obs_healthy",
    });

    // The overall call must reject — the failure is surfaced to duty()'s logging, not
    // silently swallowed — but only after the healthy row has been attempted too.
    await expect(
      advanceStaleSnapshotProjections(db(), {
        age: "1 minute",
        compute: (claim) =>
          claim.runKeyId === poisonedKeyId
            ? Promise.reject(new Error(`compute blew up for ${claim.runKeyId}`))
            : Promise.resolve(),
      }),
    ).rejects.toThrow(`compute blew up for ${poisonedKeyId}`);

    const revisions = (
      await pool.query<{ run_key_id: string; projected_revision: string }>(
        `SELECT run_key_id, projected_revision FROM run_key WHERE run_key_id IN ($1, $2)`,
        [poisonedKeyId, healthyKeyId],
      )
    ).rows;
    expect(revisions.find((r) => r.run_key_id === healthyKeyId)?.projected_revision).toBe("3");
    expect(revisions.find((r) => r.run_key_id === poisonedKeyId)?.projected_revision).toBe("1");
  });

  it("11. poll loop: a short injected interval ticks repeatedly with no duplicate effects", async () => {
    // Seeded world: one due outbox row, one aggregation-ready search with two unprojected
    // events, one stale snapshot key, one expired-lease run (under attempt budget).
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      aggProcessedRev: 0,
      projectedThrough: 0,
      nextSeq: 2,
    });
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES
         ($1, 1, 'FETCH_ACCEPTED', '{}'),
         ($1, 2, 'FETCH_ACCEPTED', '{}')`,
      [searchId],
    );
    const outboxKeyId = await seedRunKey(pool, {});
    const outboxJobId = await seedJob(pool, { searchId, runKeyId: outboxKeyId });
    const outboxId = await seedOutbox(pool, { targetKind: "JOB", jobId: outboxJobId });
    const staleKeyId = await seedRunKey(pool, {
      acceptedRevision: 3,
      projectedRevision: 1,
      latestCapturedAt: PAST,
    });
    const reclaimKeyId = await seedRunKey(pool, {});
    const reclaimRunId = await seedRun(pool, {
      runKeyId: reclaimKeyId,
      state: "LEASED",
      attempt: 1,
      generation: 1,
      leaseExpiresAt: PAST,
    });

    const computed: SnapshotProjectionClaim[] = [];
    const summaries: SweepTickSummary[] = [];
    const sweeper = createSweeper({
      postgres: {
        connectionString: pg.url,
        max: 4,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 2000,
      },
      connection: { url: redis.url },
      tickIntervalMs: 50,
      outboxBatch: 10,
      rearmAge: "1 minute",
      maxAttempts: 5,
      snapshotAge: "1 minute",
      computeSnapshotProjection: (claim) => {
        computed.push(claim);
        return Promise.resolve();
      },
      logger: silent,
      onTickComplete: (summary) => {
        summaries.push(summary);
      },
    });

    try {
      // At least two complete ticks, each running all ten duties.
      await until(() => Promise.resolve(summaries.length >= 2), {
        label: "two sweeper ticks",
        timeoutMs: 15_000,
        intervalMs: 20,
      });
    } finally {
      await sweeper.stop();
    }

    for (const summary of summaries) {
      expect(summary.failedDuties, JSON.stringify(summary)).toEqual([]);
    }

    // Duty 1: the overdue row went out exactly once and is PUBLISHED; BullMQ dedup means
    // repeated ticks never duplicate the message.
    expect((await jobQueue.getJob(outboxJobId))?.data).toEqual({
      outboxId,
      targetKind: "JOB",
      targetId: outboxJobId,
      traceparent: null,
    });
    const outboxRow = (
      await pool.query<{ state: string }>(`SELECT state FROM outbox WHERE outbox_id = $1`, [
        outboxId,
      ])
    ).rows[0];
    expect(outboxRow?.state).toBe("PUBLISHED");
    expect((await jobQueue.getJobs(["waiting"])).filter((j) => j.id === outboxJobId)).toHaveLength(
      1,
    );

    // Duty 4/1 composed: the reclaimed run's fresh outbox row was relayed on a later tick
    // — exactly one RUN message for it, published on run-queue.
    const reclaimRow = (
      await pool.query<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox WHERE run_id = $1 AND outbox_id <> '' ORDER BY created_at DESC LIMIT 1`,
        [reclaimRunId],
      )
    ).rows[0];
    expect(reclaimRow).toBeDefined();
    const reclaimed = await runQueue.getJob(reclaimRunId);
    expect(reclaimed?.name).toBe("RUN");
    expect(reclaimed?.data).toEqual({
      outboxId: reclaimRow!.outbox_id,
      targetKind: "RUN",
      targetId: reclaimRunId,
      traceparent: null,
    });

    // Duty 8: the hint is published every tick while aggregation lags — but BullMQ's
    // jobId dedup collapses it to exactly one message for the search.
    expect(
      (await aggregateQueue.getJobs(["waiting"])).filter((j) => j.id === searchId),
    ).toHaveLength(1);
    expect((await aggregateQueue.getJob(searchId))?.data).toEqual({ searchId });

    // Duty 9: both events projected exactly once; repeated ticks add nothing.
    expect(await redisAdmin.xlen(`search:${searchId}`)).toBe(2);
    expect((await redisAdmin.xrange(`search:${searchId}`, "-", "+")).map(([id]) => id)).toEqual([
      "1-0",
      "2-0",
    ]);

    // Duty 10: computed once, watermark advanced; later ticks discover nothing.
    expect(computed).toEqual([
      { runKeyId: staleKeyId, acceptedRevision: "3", latestObservationId: null },
    ]);
    const staleKey = (
      await pool.query<{ projected_revision: string }>(
        `SELECT projected_revision FROM run_key WHERE run_key_id = $1`,
        [staleKeyId],
      )
    ).rows[0];
    expect(staleKey?.projected_revision).toBe("3");

    const projected = summaries.reduce((sum, s) => sum + s.eventsProjected, 0);
    const advancedSnapshots = summaries.reduce((sum, s) => sum + s.snapshotsAdvanced, 0);
    const rearmed = summaries.reduce((sum, s) => sum + s.jobsRearmed + s.runsRearmed, 0);
    expect(projected).toBe(2);
    expect(advancedSnapshots).toBe(1);
    // No stranded aged jobs/runs were seeded, so nothing is ever re-armed.
    expect(rearmed).toBe(0);
  });

  it("12. O6: emits tick start/completed debug lines with counts and records tick metrics", async () => {
    // One expired-lease job under its attempt budget: the first tick must reclaim it,
    // so the completed line and the metrics carry a nonzero jobs_reclaimed count.
    const searchId = await seedSearch(pool, {});
    const keyId = await seedRunKey(pool, {});
    await seedJob(pool, {
      searchId,
      runKeyId: keyId,
      state: "LEASED",
      attempt: 1,
      leaseExpiresAt: PAST,
    });

    const logger = capturingLogger();
    const counter = () => ({ add: vi.fn() });
    const histogram = () => ({ record: vi.fn() });
    const rawMetrics = {
      rpcRequests: counter(),
      rpcErrors: counter(),
      rpcDuration: histogram(),
      activeSubscriptions: counter(),
      subscriptionDuration: histogram(),
      queueDepth: counter(),
      queueJobDuration: histogram(),
      cacheAccess: counter(),
      searchFunnelAcceptedDuration: histogram(),
      searchFunnelFirstGroupDuration: histogram(),
      searchFunnelCompleteDuration: histogram(),
      searchOutcomes: counter(),
      dispatchHandlerDuration: histogram(),
      dispatchHandlerCompleted: counter(),
      sweeperTickDuration: histogram(),
      sweeperRowsReclaimed: counter(),
      tmdbFetchCount: counter(),
      tmdbFetchDuration: histogram(),
      fetchJobDuration: histogram(),
      catalogueCrawlTickDuration: histogram(),
      httpRequestDuration: histogram(),
      httpRequestCount: counter(),
    };
    const metrics = rawMetrics as unknown as SeatfirstMetrics;

    const summaries: SweepTickSummary[] = [];
    const handle = runSweeper(
      {
        pool,
        publisher: publisher(),
        aggregateQueue,
        redis: redisAdmin,
        logger,
        metrics,
      },
      {
        outboxBatch: 10,
        rearmAge: "1 minute",
        maxAttempts: 5,
        snapshotAge: "1 minute",
        computeSnapshotProjection: () => Promise.resolve(),
        // Long interval: exactly one tick runs, then stop() aborts the sleep.
        tickIntervalMs: 60_000,
        onTickComplete: (summary) => {
          summaries.push(summary);
        },
      },
    );
    try {
      await until(() => Promise.resolve(summaries.length >= 1), {
        label: "one sweeper tick",
        timeoutMs: 15_000,
        intervalMs: 20,
      });
    } finally {
      await handle.stop();
    }
    expect(summaries).toHaveLength(1);
    const startedLine = logger.calls.find((call) => call.message === "sweeper tick started");
    expect(startedLine?.level).toBe("debug");
    expect(typeof startedLine?.fields.started_at).toBe("string");
    const completedLine = logger.calls.find((call) => call.message === "sweeper tick completed");
    expect(completedLine?.level).toBe("debug");
    expect(completedLine?.fields).toMatchObject({
      outbox_published: summaries[0]!.outboxPublished,
      jobs_reclaimed: 1,
      failed_duties: 0,
    });
    expect(typeof completedLine?.fields.duration_ms).toBe("number");

    // O6.6: tick duration recorded once; reclaimed rows counted per row kind.
    expect(rawMetrics.sweeperTickDuration.record).toHaveBeenCalledTimes(1);
    expect(rawMetrics.sweeperRowsReclaimed.add).toHaveBeenCalledWith(1, { row_kind: "job" });
    expect(rawMetrics.sweeperRowsReclaimed.add).toHaveBeenCalledWith(0, { row_kind: "run" });
  });
});
