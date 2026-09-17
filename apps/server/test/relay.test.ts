import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import type { Meter } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import { OTEL_METRIC_DEFINITIONS } from "@seatfirst/config/otel";
import { Queue } from "bullmq";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { markOutboxPublished, poolClient } from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";

import {
  createRelayPublisher,
  createRelayState,
  type HealthzBody,
  pollOnce,
  registerHealthz,
  RELAY_METRIC_NAMES,
  runRelayLoop,
  type RelayLoopHandle,
  type RelayMessage,
  type RelayPublisher,
} from "../src/relay/index.js";
import { createWorker, redisConnectionFromEnv } from "../src/queue/index.js";

import { startTestPostgres } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { startQueueRedis, until } from "./support/queue-redis.js";
import type { QueueRedisFixture } from "./support/queue-redis.js";
import { seedJobOutbox, seedRunOutbox } from "./support/relay-db.js";
import { capturingLogger } from "./support/logger.js";

const silentLogger: SeatfirstLogger = capturingLogger();

let tagCounter = 0;
function tag(prefix: string): string {
  tagCounter += 1;
  return `${prefix}_${tagCounter}_${randomUUID().slice(0, 8)}`;
}

/** Binds and releases an ephemeral port, returning a number that is guaranteed closed. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
  });
}

const redisFixture = await startQueueRedis();
const postgres = redisFixture === null ? null : await startTestPostgres();

if (redisFixture === null || postgres === null) {
  describe.skip("outbox relay against live Postgres and Redis", () => {});
} else {
  const redis: QueueRedisFixture = redisFixture;
  const connection = redisConnectionFromEnv({ REDIS_URL: redis.url });

  describe("outbox relay against live Postgres and Redis", () => {
    let db: SqlClient;
    let pool: Pool;
    let publisher: RelayPublisher;
    let jobQueue: Queue<RelayMessage>;
    let runQueue: Queue<RelayMessage>;

    beforeAll(async () => {
      await migrateDatabase(postgres.url);
      pool = new Pool({ connectionString: postgres.url, max: 1 });
      db = poolClient(pool);
      publisher = createRelayPublisher(connection, silentLogger);
      jobQueue = new Queue<RelayMessage>("job-queue", { connection });
      runQueue = new Queue<RelayMessage>("run-queue", { connection });
      jobQueue.on("error", () => {});
      runQueue.on("error", () => {});
    });

    afterAll(async () => {
      await jobQueue.close();
      await runQueue.close();
      await publisher.close();
      await pool.end();
      await redis.container.stop();
      await postgres.stop();
    });

    async function countPending(): Promise<number> {
      const result = await db.query(
        `SELECT count(*)::integer AS n FROM outbox WHERE state = 'PENDING'`,
      );
      return (result.rows[0] as { n: number }).n;
    }

    async function outboxRow(
      outboxId: string,
    ): Promise<{ state: string; attempt: number; next_attempt_at: Date }> {
      const result = await db.query(
        `SELECT state, attempt, next_attempt_at FROM outbox WHERE outbox_id = $1`,
        [outboxId],
      );
      return result.rows[0] as { state: string; attempt: number; next_attempt_at: Date };
    }

    /**
     * A fresh PENDING outbox row for a durable target whose FK chain an earlier
     * `seedJobOutbox`/`seedRunOutbox` call already built — the redrive shape
     * (RUN_DEFER_BUSY re-arming a stranded run, a re-armed JOB row). Seed-data insert,
     * not a state transition (CONTRIBUTING.md §2 seed-data bucket): the sweep plus
     * OUTBOX_MARK_PUBLISHED still drive every transition under test. The schema allows
     * many rows per target over time — `001_schema.sql` notes the broker dedup key is
     * coalesce(job_id, run_id), unique per target, not per row.
     */
    async function seedRepeatOutbox(
      target: { readonly kind: "JOB" | "RUN"; readonly targetId: string },
      prefix: string,
    ): Promise<{ readonly outboxId: string }> {
      const outboxId = `obx_${prefix}`;
      const insert =
        target.kind === "JOB"
          ? `INSERT INTO outbox (outbox_id, target_kind, job_id, state, attempt, next_attempt_at, created_at)
             VALUES ($1, 'JOB', $2, 'PENDING', 0, now() - interval '1 second', now() - interval '1 second')`
          : `INSERT INTO outbox (outbox_id, target_kind, run_id, state, attempt, next_attempt_at, created_at)
             VALUES ($1, 'RUN', $2, 'PENDING', 0, now() - interval '1 second', now() - interval '1 second')`;
      await db.query(insert, [outboxId, target.targetId]);
      return { outboxId };
    }

    // Verification 1 — happy path.
    it("publishes a due PENDING row with the target id as dedup key and marks it PUBLISHED", async () => {
      const seeded = await seedJobOutbox(db, tag("happy"));

      const result = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 1, published: 1, publishFailed: 0 });

      const job = await jobQueue.getJob(seeded.jobId);
      expect(job).toBeDefined();
      if (job === undefined) {
        throw new Error("expected the published job to exist in job-queue");
      }
      expect(job.id).toBe(seeded.jobId);
      expect(job.name).toBe("JOB");
      expect(job.data).toEqual({
        outboxId: seeded.outboxId,
        targetKind: "JOB",
        targetId: seeded.jobId,
        traceparent: null,
      });

      expect(await outboxRow(seeded.outboxId)).toMatchObject({ state: "PUBLISHED" });
    });

    it("publishes RUN rows to run-queue keyed on run_id", async () => {
      const seeded = await seedRunOutbox(db, tag("run"));

      const result = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 1, published: 1 });

      const job = await runQueue.getJob(seeded.runId);
      expect(job).toBeDefined();
      if (job === undefined) {
        throw new Error("expected the published job to exist in run-queue");
      }
      expect(job.id).toBe(seeded.runId);
      expect(job.name).toBe("RUN");
      expect(job.data).toEqual({
        outboxId: seeded.outboxId,
        targetKind: "RUN",
        targetId: seeded.runId,
        traceparent: null,
      });
    });

    // Verification 2 — idempotent mark.
    it("marking an already-published row again returns zero rows, not an error", async () => {
      const seeded = await seedJobOutbox(db, tag("idem"));
      const result = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result.published).toBe(1);

      const again = await markOutboxPublished(db, seeded.outboxId);
      expect(again).toEqual([]);
    });

    // Verification 3 — the sweep skips PUBLISHED rows and the poll continues past them.
    it("skips an already-PUBLISHED row without error and still delivers the due rows", async () => {
      const stale = await seedJobOutbox(db, tag("stale"), { state: "PUBLISHED" });
      const due = await seedJobOutbox(db, tag("due"));

      const result = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 1, published: 1 });

      expect(await jobQueue.getJob(stale.jobId)).toBeUndefined();
      expect(await jobQueue.getJob(due.jobId)).toBeDefined();
    });

    // Verification 4 — publish failure, retry mark, and retry after the deferral passes.
    it("a broker rejection marks the row for retry with backoff; a later cycle retries it", async () => {
      const before = await countPending();
      const seeded = await seedJobOutbox(db, tag("retry"));
      const deadPort = await closedPort();
      const dead = createRelayPublisher(
        {
          host: "127.0.0.1",
          port: deadPort,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        },
        silentLogger,
      );

      const relayMeter = testMeter();
      const loop: RelayLoopHandle = runRelayLoop({
        db,
        publisher: dead,
        batchSize: 10,
        pollIntervalMs: 60_000,
        retryBackoff: "1 hour",
        // The row is seconds old: with this threshold the alarm must stay off — the
        // positive control for the alarm test below.
        alarmThresholdMs: 1_000_000,
        meter: relayMeter.meter,
        logger: silentLogger,
      });

      try {
        await until(() => Promise.resolve(loop.state.pendingBacklogDepth === before + 1), {
          label: "relay loop observes the rejected row",
        });

        const row = await outboxRow(seeded.outboxId);
        expect(row.state).toBe("PENDING");
        expect(row.attempt).toBe(1);
        // Backoff is 1 hour: the deferral must be roughly one hour out, never "now".
        expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);

        // The row is seconds old, so against the huge injected threshold the alarm
        // must stay off — the positive control for the alarm test below. (The alarm
        // metric itself is asserted there, where the age is controlled.)
        expect(loop.state.alarmActive).toBe(false);
        expect(loop.state.pendingBacklogDepth).toBe(before + 1);

        // While the deferral is in the future, the row is not due: a sweep skips it.
        expect(
          (
            await pollOnce(db, publisher, {
              batchSize: 10,
              retryBackoff: "1 hour",
              logger: silentLogger,
            })
          ).swept,
        ).toBe(0);
      } finally {
        loop.stop();
        await loop.done;
        await dead.close();
        await relayMeter.close();
      }

      // Time is data: expire the deferral by writing it, never by waiting.
      await db.query(
        `UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE outbox_id = $1`,
        [seeded.outboxId],
      );

      const retry = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "1 hour",
        logger: silentLogger,
      });
      expect(retry).toMatchObject({ swept: 1, published: 1 });
      expect(await jobQueue.getJob(seeded.jobId)).toBeDefined();
      expect(await outboxRow(seeded.outboxId)).toMatchObject({ state: "PUBLISHED", attempt: 1 });
    });

    // Verification 5 — batch correctness.
    it("publishes all five due rows in one poll, skipping none", async () => {
      const seeded = [];
      for (let i = 1; i <= 5; i += 1) {
        seeded.push(await seedJobOutbox(db, tag(`batch${i}`)));
      }
      const before = await countPending();

      const result = await pollOnce(db, publisher, {
        batchSize: 5,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 5, published: 5 });

      for (const seed of seeded) {
        const job = await jobQueue.getJob(seed.jobId);
        expect(job?.data?.outboxId).toBe(seed.outboxId);
        expect(await outboxRow(seed.outboxId)).toMatchObject({ state: "PUBLISHED" });
      }
      expect(await countPending()).toBe(before - 5);
    });

    // Verification 6 — alarm metric against the injected threshold.
    it("the alarm gauge reflects an old PENDING row against the configured threshold", async () => {
      const { meter, reader, close: closeMeter } = testMeter();
      const before = await countPending();
      await seedJobOutbox(db, tag("alarm"), {
        createdAt: new Date(Date.now() - 60_000),
      });
      const dead = createRelayPublisher(
        {
          host: "127.0.0.1",
          port: await closedPort(),
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        },
        silentLogger,
      );

      const loop = runRelayLoop({
        db,
        publisher: dead,
        batchSize: 10,
        pollIntervalMs: 60_000,
        retryBackoff: "1 hour",
        alarmThresholdMs: 30_000,
        meter,
        logger: silentLogger,
      });

      try {
        await until(() => Promise.resolve(loop.state.pendingBacklogDepth === before + 1), {
          label: "relay loop observes the aged row",
        });
        expect(loop.state.alarmActive).toBe(true);

        const alarm = await gaugeValue(reader, RELAY_METRIC_NAMES.pendingAlarm);
        expect(alarm).toBe(1);
        const age = await gaugeValue(reader, RELAY_METRIC_NAMES.oldestPendingAge);
        expect(age).toBeGreaterThan(30_000);
        const depth = await gaugeValue(reader, RELAY_METRIC_NAMES.pendingDepth);
        expect(depth).toBe(before + 1);
      } finally {
        loop.stop();
        await loop.done;
        await dead.close();
        await closeMeter();
      }
    });

    // Verification 7 — OUTBOX_MARK_RETRY zero rows under a concurrent reclaim.
    it("a retry mark fenced out by a concurrent actor returns zero rows and the relay continues", async () => {
      const seeded = await seedJobOutbox(db, tag("fence"));
      const racing: RelayPublisher = {
        // Simulates the race: a concurrent actor (sweeper or second relay) marks the
        // row PUBLISHED between the sweep and this publish, and the broker rejects.
        async publish() {
          await markOutboxPublished(db, seeded.outboxId);
          throw new Error("broker rejected the publish after a concurrent mark");
        },
        close: () => Promise.resolve(),
      };

      const result = await pollOnce(db, racing, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 1, publishFailed: 1, retryFenced: 1 });

      expect(await outboxRow(seeded.outboxId)).toMatchObject({ state: "PUBLISHED", attempt: 0 });
    });

    // S9.6 — liveness endpoint.
    it("GET /healthz reports the last successful poll and the PENDING backlog depth", async () => {
      const state = createRelayState();
      const fastify = Fastify({ logger: false });
      registerHealthz(fastify, state);

      const before = await fastify.inject({ method: "GET", url: "/healthz" });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ lastSuccessfulPollAt: null, pendingBacklogDepth: 0 });

      const healthMeter = testMeter();
      const loop = runRelayLoop(
        {
          db,
          publisher,
          batchSize: 10,
          pollIntervalMs: 20,
          retryBackoff: "5 seconds",
          alarmThresholdMs: 30_000,
          meter: healthMeter.meter,
          logger: silentLogger,
        },
        state,
      );

      try {
        await seedJobOutbox(db, tag("health"));
        await until(
          async () =>
            state.lastSuccessfulPollAt !== null &&
            state.pendingBacklogDepth === (await countPending()),
          { label: "relay loop settles its view of the outbox" },
        );

        const after = await fastify.inject({ method: "GET", url: "/healthz" });
        expect(after.statusCode).toBe(200);
        const body = after.json<HealthzBody>();
        expect(typeof body.lastSuccessfulPollAt).toBe("string");
        expect(body.pendingBacklogDepth).toBe(await countPending());
      } finally {
        loop.stop();
        await loop.done;
        await healthMeter.close();
        await fastify.close();
      }
    });

    it("records the last successful poll on the OTel gauge once the loop has run", async () => {
      const { meter, reader, close: closeMeter } = testMeter();
      const loop = runRelayLoop({
        db,
        publisher,
        batchSize: 10,
        pollIntervalMs: 20,
        retryBackoff: "5 seconds",
        alarmThresholdMs: 30_000,
        meter,
        logger: silentLogger,
      });

      try {
        await until(() => Promise.resolve(loop.state.lastSuccessfulPollAt !== null), {
          label: "relay loop records a successful poll",
        });
        const recorded = await gaugeValue(reader, RELAY_METRIC_NAMES.lastSuccessfulPoll);
        expect(recorded).toBeGreaterThan(0);
      } finally {
        loop.stop();
        await loop.done;
        await closeMeter();
      }
    });

    it("pollOnce emits info 'outbox row claimed' with structured fields before the publisher is invoked", async () => {
      const seeded = await seedJobOutbox(db, tag("claimed"));
      const logger = capturingLogger();
      const fakePublisher: RelayPublisher = {
        publish(message) {
          // Marker pushed into the same capturing array so ordering is directly
          // comparable without a second sequence — matches the spec's hint.
          logger.info({ publish_marker: true, outbox_id: message.outboxId }, "__publish__");
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };

      const result = await pollOnce(db, fakePublisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger,
      });
      expect(result.swept).toBe(1);

      const claimedIdx = logger.calls.findIndex((c) => c.message === "outbox row claimed");
      const publishIdx = logger.calls.findIndex((c) => c.message === "__publish__");
      expect(claimedIdx).toBeGreaterThanOrEqual(0);
      expect(publishIdx).toBeGreaterThanOrEqual(0);
      expect(claimedIdx).toBeLessThan(publishIdx);
      const claimed = logger.calls[claimedIdx]!;
      expect(claimed.level).toBe("info");
      expect(claimed.fields).toMatchObject({
        outbox_id: seeded.outboxId,
        target_kind: "JOB",
        target_id: seeded.jobId,
      });
    });

    // Terminal-record redrive (ADR 0001 recovery): a fresh outbox row for a target
    // whose broker record is already completed/failed must be delivered again — the
    // dead record is removed so the custom-id dedup cannot swallow the new row.
    it("redrives a fresh JOB row after the broker record for its target completed", async () => {
      const first = await seedJobOutbox(db, tag("redrive"));
      await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(await jobQueue.getJob(first.jobId)).toBeDefined();

      let deliveries = 0;
      const worker = createWorker(jobQueue, "JOB", (data) => {
        if (data.targetId === first.jobId) {
          deliveries += 1;
        }
      });
      worker.worker.on("error", () => {});
      try {
        await until(
          async () => {
            const job = await jobQueue.getJob(first.jobId);
            return (await job?.getState()) === "completed";
          },
          { label: "first JOB delivery completes" },
        );
        expect(deliveries).toBe(1);

        const second = await seedRepeatOutbox(
          { kind: "JOB", targetId: first.jobId },
          tag("redrive"),
        );
        const result = await pollOnce(db, publisher, {
          batchSize: 10,
          retryBackoff: "5 seconds",
          logger: silentLogger,
        });
        expect(result).toMatchObject({ swept: 1, published: 1, publishFailed: 0 });

        await until(() => Promise.resolve(deliveries === 2), {
          label: "fresh JOB row redelivered after the completed record was removed",
        });
        const redelivered = await jobQueue.getJob(first.jobId);
        // Same broker id, NEW record: the payload carries the fresh row's outbox id.
        // Dedup alone would have kept the old payload and skipped the add entirely.
        expect(redelivered?.data?.outboxId).toBe(second.outboxId);
        expect(await outboxRow(second.outboxId)).toMatchObject({ state: "PUBLISHED" });
      } finally {
        await worker.close();
      }
    });

    it("redrives a fresh RUN row after the broker record for its target failed", async () => {
      const first = await seedRunOutbox(db, tag("redrive"));
      await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(await runQueue.getJob(first.runId)).toBeDefined();

      let deliveries = 0;
      const worker = createWorker(runQueue, "RUN", (data) => {
        if (data.targetId === first.runId) {
          deliveries += 1;
        }
        throw new Error("provider rejected the run");
      });
      worker.worker.on("error", () => {});
      try {
        await until(
          async () => {
            const job = await runQueue.getJob(first.runId);
            return (await job?.getState()) === "failed";
          },
          { label: "first RUN delivery fails" },
        );

        const second = await seedRepeatOutbox(
          { kind: "RUN", targetId: first.runId },
          tag("redrive"),
        );
        const result = await pollOnce(db, publisher, {
          batchSize: 10,
          retryBackoff: "5 seconds",
          logger: silentLogger,
        });
        expect(result).toMatchObject({ swept: 1, published: 1, publishFailed: 0 });

        await until(() => Promise.resolve(deliveries === 2), {
          label: "fresh RUN row redelivered after the failed record was removed",
        });
        const redelivered = await runQueue.getJob(first.runId);
        expect(redelivered?.data?.outboxId).toBe(second.outboxId);
        expect(await outboxRow(second.outboxId)).toMatchObject({ state: "PUBLISHED" });
      } finally {
        await worker.close();
      }
    });

    // First-delivery dedup stays intact while the record is live: a fresh row for a
    // still-waiting target neither duplicates nor replaces the waiting job.
    it("keeps the waiting JOB record when a fresh row targets the same id", async () => {
      const first = await seedJobOutbox(db, tag("dup"));
      await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      const original = await jobQueue.getJob(first.jobId);
      expect(original).toBeDefined();
      if (original === undefined) {
        throw new Error("expected the first delivery to be waiting in job-queue");
      }
      expect(await original.getState()).toBe("waiting");

      const second = await seedRepeatOutbox({ kind: "JOB", targetId: first.jobId }, tag("dup"));
      const result = await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });
      expect(result).toMatchObject({ swept: 1, published: 1, publishFailed: 0 });

      const kept = await jobQueue.getJob(first.jobId);
      expect(kept).toBeDefined();
      if (kept === undefined) {
        throw new Error("expected the waiting JOB record to survive the fresh row");
      }
      // First delivery wins: not removed, not replaced — the record still carries
      // the FIRST row's payload and is still waiting.
      expect(kept.data.outboxId).toBe(first.outboxId);
      expect(await kept.getState()).toBe("waiting");
      expect(await outboxRow(second.outboxId)).toMatchObject({ state: "PUBLISHED" });
    });

    it("keeps the active RUN record when a fresh row targets the same id", async () => {
      const first = await seedRunOutbox(db, tag("active"));
      await pollOnce(db, publisher, {
        batchSize: 10,
        retryBackoff: "5 seconds",
        logger: silentLogger,
      });

      let deliveries = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = createWorker(runQueue, "RUN", async (data) => {
        if (data.targetId === first.runId) {
          deliveries += 1;
          await gate;
        }
      });
      worker.worker.on("error", () => {});
      try {
        await until(
          async () => {
            const job = await runQueue.getJob(first.runId);
            return (await job?.getState()) === "active";
          },
          { label: "first RUN delivery becomes active" },
        );
        expect(deliveries).toBe(1);

        const second = await seedRepeatOutbox(
          { kind: "RUN", targetId: first.runId },
          tag("active"),
        );
        const result = await pollOnce(db, publisher, {
          batchSize: 10,
          retryBackoff: "5 seconds",
          logger: silentLogger,
        });
        expect(result).toMatchObject({ swept: 1, published: 1, publishFailed: 0 });
        // The active record was left alone: no second delivery while it holds the id.
        expect(deliveries).toBe(1);

        release?.();
        await until(
          async () => {
            const job = await runQueue.getJob(first.runId);
            return (await job?.getState()) === "completed";
          },
          { label: "the active RUN completes once released" },
        );
        const kept = await runQueue.getJob(first.runId);
        expect(kept).toBeDefined();
        if (kept === undefined) {
          throw new Error("expected the active RUN record to survive the fresh row");
        }
        // Still exactly one processing, still the original payload: the duplicate
        // never displaced the active first delivery.
        expect(kept.data.outboxId).toBe(first.outboxId);
        expect(deliveries).toBe(1);
        expect(await outboxRow(second.outboxId)).toMatchObject({ state: "PUBLISHED" });
      } finally {
        release?.();
        await worker.close();
      }
    });
  });
}

describe("relay publisher queue health gauges (O11.3)", () => {
  it("registers O9's counts+memory gauges for the publisher's three queues when a meter is supplied", async () => {
    const created: string[] = [];
    const meter = {
      createObservableGauge: vi.fn((name: string) => {
        created.push(name);
        return { addCallback: () => undefined };
      }),
    } as unknown as Meter;
    // Dead port: queue construction is lazy, gauge callbacks are never collected here,
    // so nothing dials Redis — the same posture as the broker-rejection tests above.
    const publisher = createRelayPublisher(
      {
        host: "127.0.0.1",
        port: await closedPort(),
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      },
      silentLogger,
      meter,
    );
    try {
      expect(created).toEqual([
        OTEL_METRIC_DEFINITIONS.queueJobCounts.name,
        OTEL_METRIC_DEFINITIONS.queueMemoryUsed.name,
      ]);
    } finally {
      await publisher.close();
    }
  });
});

function testMeter(): {
  readonly meter: Meter;
  readonly reader: PeriodicExportingMetricReader;
  close: () => Promise<void>;
} {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  });
  const meter = new MeterProvider({ readers: [reader] }).getMeter("relay-test");
  return { meter, reader, close: () => reader.shutdown() };
}

async function gaugeValue(
  reader: PeriodicExportingMetricReader,
  name: string,
): Promise<number | undefined> {
  const { resourceMetrics } = await reader.collect();
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      if (metric.descriptor.name !== name) {
        continue;
      }
      if (metric.dataPointType !== DataPointType.GAUGE) {
        continue;
      }
      const point = metric.dataPoints[0];
      return point === undefined ? undefined : (point as { value: number }).value;
    }
  }
  return undefined;
}
