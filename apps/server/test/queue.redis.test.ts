import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { createServer } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWorker,
  InvalidPayloadError,
  publish,
  redisConnectionFromEnv,
  redisHealth,
  redriveAllFailed,
  redriveFailed,
  type WorkerHandle,
  type WorkerHandler,
} from "../src/queue/index.js";
import { startQueueRedis, until } from "./support/queue-redis.js";
import type { QueueRedisFixture } from "./support/queue-redis.js";

// Payload contract for the type-safety + runtime-validation round-trip
// (verification item 6). The schema is the single source for both the
// inferred type and the runtime check.
const showtimeFetchSchema = z.object({
  theatreId: z.string(),
  localDate: z.string(),
  attempt: z.number().int(),
});
type ShowtimeFetchPayload = z.infer<typeof showtimeFetchSchema>;

/** Compile-time-only helper: fails the build unless `A` is assignable to `B`. */
type AssertAssignable<A extends B, B> = A;
export type _WrongTypedPayloadMustNotTypecheck = AssertAssignable<
  // @ts-expect-error — attempt must be a number; a string fails the payload type
  { theatreId: string; localDate: string; attempt: string },
  ShowtimeFetchPayload
>;
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

const fixture = await startQueueRedis();

if (fixture === null) {
  describe.skip("queue client against a live Redis (persistence disabled)", () => {});
} else {
  const redis: QueueRedisFixture = fixture;
  const connection = redisConnectionFromEnv({ REDIS_URL: redis.url });

  describe("queue client against a live Redis (persistence disabled)", () => {
    const openQueues: Queue[] = [];
    const openWorkers: WorkerHandle[] = [];
    const openEvents: QueueEvents[] = [];

    function queue<T = unknown>(name: string): Queue<T> {
      const q = new Queue<T>(name, { connection });
      // Tests deliberately kill and revive Redis; a listener keeps the
      // connection 'error' events from crashing the test process.
      q.on("error", () => {});
      openQueues.push(q);
      return q;
    }

    function worker<T>(q: Queue<T>, name: string, handler: WorkerHandler<T>): WorkerHandle {
      const handle = createWorker<T>(q, name, handler);
      handle.worker.on("error", () => {});
      openWorkers.push(handle);
      return handle;
    }

    function eventsFor(q: Queue): QueueEvents {
      const events = new QueueEvents(q.name, { connection });
      events.on("error", () => {});
      openEvents.push(events);
      return events;
    }

    afterEach(async () => {
      for (const handle of openWorkers.splice(0)) {
        await handle.close().catch(() => undefined);
      }
      for (const events of openEvents.splice(0)) {
        await events.close().catch(() => undefined);
      }
      for (const q of openQueues.splice(0)) {
        await q.obliterate({ force: true }).catch(() => undefined);
        await q.close().catch(() => undefined);
      }
    });

    afterAll(async () => {
      // autoRemove is off (the restart test needs the same container back),
      // so removal is explicit here.
      await redis.container.stop({ remove: true });
    });

    it("connects, publishes a typed job with an explicit jobId, and a worker receives the payload intact", async () => {
      const q = queue<ShowtimeFetchPayload>("s7-connect");
      const events = eventsFor(q);

      const payload: ShowtimeFetchPayload = {
        theatreId: "theatre-1",
        localDate: "2026-08-12",
        attempt: 1,
      };
      const job = await publish(q, "showtime.fetch", "job-connect-1", payload);

      // The job appears in BullMQ's wait list under the caller's jobId.
      expect(await job.getState()).toBe("waiting");
      const waitingIds = (await q.getWaiting()).map((j) => j.id);
      expect(waitingIds).toContain("job-connect-1");

      const received: ShowtimeFetchPayload[] = [];
      const handle = worker<ShowtimeFetchPayload>(q, "showtime.fetch", (data) => {
        received.push(data);
      });
      await handle.worker.waitUntilReady();

      await job.waitUntilFinished(events, 15_000);

      expect(received).toEqual([payload]);
      expect(await job.getState()).toBe("completed");
    });

    it("dedups by jobId: a second publish with the same id is a no-op, not a duplicate", async () => {
      const q = queue<{ n: number }>("s7-dedup");

      const first = await publish(q, "dedup", "same-job-id", { n: 1 });
      const second = await publish(q, "dedup", "same-job-id", { n: 2 });

      // BullMQ returns the existing job; the first payload survives.
      expect(second.id).toBe(first.id);
      expect((await q.getJob("same-job-id"))?.data).toEqual({ n: 1 });

      const waiting = await q.getWaiting();
      expect(waiting.filter((j) => j.id === "same-job-id")).toHaveLength(1);
    });

    it("tolerates a persistence-disabled restart: reconnects cleanly, queue empty, republish works", async () => {
      const q = queue<{ marker: string }>("s7-restart");
      const events = eventsFor(q);

      const markers: string[] = [];
      const handle = worker<{ marker: string }>(q, "evaporates", (data) => {
        markers.push(data.marker);
      });
      await handle.worker.waitUntilReady();

      const jobId = "before-restart";
      const before = await publish(q, "evaporates", jobId, { marker: "before" });
      expect(before).toBeDefined();
      await before.waitUntilFinished(events, 15_000);
      expect(markers).toEqual(["before"]);

      await redis.container.stop();
      // While Redis is down the health check reports unreachable — and throws nothing.
      expect((await redisHealth(q)).ok).toBe(false);

      await redis.container.restart();
      // The client reconnects (BullMQ's retry loop), not a crash loop.
      await until(async () => (await redisHealth(q)).ok, {
        label: "client reconnects after restart",
        timeoutMs: 60_000,
      });

      // Persistence is disabled (ADR 0005 §A): BullMQ's job data evaporated.
      // The Postgres outbox is the sole durable truth.
      expect(await q.getJob(jobId)).toBeUndefined();
      const waitingIds = (await q.getWaiting()).map((j) => j.id);
      expect(waitingIds).not.toContain(jobId);

      // And the reconnected client still publishes and delivers.
      const after = await publish(q, "evaporates", "after-restart", {
        marker: "after",
      });
      await after.waitUntilFinished(events, 15_000);
      expect(markers).toEqual(["before", "after"]);
    });

    it("dead-letters after the caller-supplied attempts, then redrives exactly one successful consumption", async () => {
      const q = queue<{ v: number }>("s7-redrive");

      let invocations = 0;
      const handle = worker<{ v: number }>(q, "flaky", () => {
        invocations += 1;
        if (invocations <= 2) {
          throw new Error("boom");
        }
      });
      await handle.worker.waitUntilReady();

      // attempts: 2 is injected by the test — the module defaults nothing (S7.8).
      const job = await publish(q, "flaky", "dlq-job", { v: 1 }, { attempts: 2 });

      await until(async () => (await job.getState()) === "failed", {
        label: "job exhausts the caller-supplied attempts",
      });

      // Both attempts were consumed: the caller's 2 was honored, not a fixed default.
      expect(invocations).toBe(2);
      expect((await q.getFailed()).map((j) => j.id)).toContain("dlq-job");

      const redriven = await redriveFailed(q, "dlq-job");
      expect(redriven).toBeDefined();

      await until(async () => (await job.getState()) === "completed", {
        label: "redriven job completes on its second life",
      });

      // Exactly one redrive, one successful consumption — no duplicates.
      expect(invocations).toBe(3);
      const counts = await q.getJobCounts("waiting", "active", "failed", "delayed");
      expect(counts).toMatchObject({ waiting: 0, active: 0, failed: 0, delayed: 0 });
    });
    it("redriveAllFailed retries every failed job, optionally filtered by name", async () => {
      const q = queue<{ v: number }>("s7-redrive-all");

      let invocations = 0;
      const handle = worker<{ v: number }>(q, "good", () => {
        invocations += 1;
        if (invocations <= 2) {
          throw new Error("boom");
        }
      });
      await handle.worker.waitUntilReady();

      await publish(q, "good", "fail-1", { v: 1 }, { attempts: 1 });
      await publish(q, "good", "fail-2", { v: 2 }, { attempts: 1 });
      await until(async () => (await q.getFailed()).length === 2, {
        label: "both jobs exhaust attempts into the failed set",
      });

      // The name filter returns nothing for names that are not failed.
      expect(await redriveAllFailed(q, "other")).toBe(0);

      const redriven = await redriveAllFailed(q, "good");
      expect(redriven).toBe(2);

      for (const id of ["fail-1", "fail-2"]) {
        await until(async () => (await (await q.getJob(id))?.getState()) === "completed", {
          label: `${id} completes after bulk redrive`,
        });
      }
      expect(invocations).toBe(4); // two initial attempts + one successful life each
    });

    it("redisHealth reports up with positive latency and down without throwing", async () => {
      const q = queue("s7-health");
      await q.waitUntilReady();

      const up = await redisHealth(q);
      expect(up.ok).toBe(true);
      expect(up.latencyMs).toBeGreaterThan(0);
      // Unreachable instance: the connect attempt rejects (expected — consumed
      // here so it is not an unhandled rejection); redisHealth must then
      const port = await closedPort();
      const unreachable = new IORedis.Redis({
        host: "127.0.0.1",
        port,
        lazyConnect: true,
        retryStrategy: null,
      });
      unreachable.on("error", () => {});
      await unreachable.connect().catch(() => undefined);
      try {
        const down = await redisHealth(unreachable);
        expect(down.ok).toBe(false);
      } finally {
        unreachable.disconnect();
      }

      // The queue-path down state (ok:false while Redis is stopped, without
      // throwing) is proven in the persistence-disabled restart test, where a
      // live queue's Redis is actually taken down and brought back.
    });

    it("typechecks the payload at compile time and schema-validates at runtime before enqueue", async () => {
      const q = queue<ShowtimeFetchPayload>("s7-validation");
      const events = eventsFor(q);

      // Compile-time half: a payload whose `attempt` is a string must not
      // satisfy `ShowtimeFetchPayload` — asserted at module scope below (it
      // emits no runtime code); if the publish/worker typing ever regressed,
      // that assertion's @ts-expect-error would become unused and tsc would
      // fail the build.

      const received: string[] = [];
      const handle = worker<ShowtimeFetchPayload>(q, "showtime.fetch", (data) => {
        // data is ShowtimeFetchPayload — compile-time, no runtime claims here.
        received.push(data.theatreId.toUpperCase());
      });
      await handle.worker.waitUntilReady();

      const valid: ShowtimeFetchPayload = {
        theatreId: "theatre-9",
        localDate: "2026-08-12",
        attempt: 3,
      };
      const job = await publish(q, "showtime.fetch", "valid-job", valid, {
        schema: showtimeFetchSchema,
      });
      await job.waitUntilFinished(events, 15_000);
      expect(received).toEqual(["THEATRE-9"]);

      // Runtime half: deliberately malformed (but valid-JSON) payload, cast
      // through the compiler — with a schema supplied, publish must throw
      // InvalidPayloadError BEFORE the job reaches Redis.
      const malformed = {
        theatreId: 123,
        localDate: "2026-08-12",
        attempt: 1,
      } as unknown as ShowtimeFetchPayload;
      await expect(
        publish(q, "showtime.fetch", "malformed-job", malformed, {
          schema: showtimeFetchSchema,
        }),
      ).rejects.toBeInstanceOf(InvalidPayloadError);
      expect(await q.getJob("malformed-job")).toBeUndefined();
    });

    it("fails a job whose name does not match the worker's scope, without retrying", async () => {
      const q = queue<{ v: number }>("s7-name-guard");

      const handle = worker<{ v: number }>(q, "expected", async () => {});
      await handle.worker.waitUntilReady();

      const job = await publish(
        q,
        "other",
        "foreign-job",
        { v: 1 },
        {
          attempts: 3,
        },
      );

      await until(async () => (await job.getState()) === "failed", {
        label: "foreign-name job is failed without retry",
      });

      const failed = await q.getJob("foreign-job");
      expect(failed?.attemptsMade).toBe(1);
      expect(failed?.failedReason).toContain('cannot process job "other"');
    });
  });
}
