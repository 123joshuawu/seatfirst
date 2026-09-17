import { Queue } from "bullmq";
import type { Meter } from "@opentelemetry/api";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { registerQueueHealthMetrics } from "../queue/metrics.js";

import { publish, removeTerminalBrokerRecord } from "../queue/index.js";
import type { RedisConnectionConfig } from "../queue/index.js";

/**
 * Queue name per outbox target kind (S9.2, S25.6): JOB rows publish to `job-queue`, RUN
 * rows to `run-queue`, and TMDB_FETCH rows to `tmdb-fetch-queue` (ADR 0019 amendment
 * decision 5). S11 owns the matching consumer side for JOB/RUN
 * (`docs/tasks/S11-dispatch-worker/spec.md` S11.1); S25 owns the TMDB_FETCH consumer.
 */
export const RELAY_QUEUE_FOR_TARGET = {
  JOB: "job-queue",
  RUN: "run-queue",
  TMDB_FETCH: "tmdb-fetch-queue",
} as const;

export type OutboxTargetKind = keyof typeof RELAY_QUEUE_FOR_TARGET;

/**
 * The message body S9.2 and S11.1 agree on. `attempt` is deliberately absent.
 *
 * O7/ADR 0031 — `traceparent` carries the originating HTTP request's W3C trace context
 * so the dispatch worker can resume that trace across the outbox/BullMQ boundary. Null
 * means no request span was active at insert time (sweeper-rearmed rows, pre-O7 rows);
 * consumers must treat null as "start a fresh root trace", never fabricate a parent.
 */
export interface RelayMessage {
  readonly outboxId: string;
  readonly targetKind: OutboxTargetKind;
  readonly targetId: string;
  readonly traceparent: string | null;
}

export interface RelayPublisher {
  publish(message: RelayMessage): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ publish helper (S9.2) built on S7's typed `publish` — the relay is a consumer
 * of S7's client, not a co-owner (S9 non-goals). The Redis connection is caller-supplied
 * (`redisConnectionFromEnv` from S7); nothing here invents an address or a tunable.
 *
 * The target id is the `jobId`, which BullMQ keys dedup/idempotency on
 * (`docs/seatfirst-architecture.md:181`), so re-publishing a row whose broker record
 * is still live (waiting/active/delayed) is a no-op rather than a duplicate — first
 * delivery wins. A terminal record must not own that key forever: ADR 0001's redrive
 * path inserts a fresh outbox row for the same target (RUN_DEFER_BUSY re-arming a
 * stranded run, a re-armed JOB row) and expects it delivered, so JOB/RUN publishes
 * remove a `completed`/`failed` record before adding. The job name is the
 * `targetKind` literal ("JOB"/"RUN") — the same
 * convention S10's sweeper publish path uses for outbox messages, so the consumer
 * side (S11) sees one naming scheme across publishers.
 */
export function createRelayPublisher(
  connection: RedisConnectionConfig,
  logger: SeatfirstLogger,
  /** O11.3 — optional DispatchDeps.metrics-style seam: absent, no gauges register. */
  meter?: Meter,
): RelayPublisher {
  const jobQueue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.JOB, { connection });
  const runQueue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.RUN, { connection });
  const tmdbFetchQueue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.TMDB_FETCH, {
    connection,
  });

  // Without a listener, a broker outage would surface as an unhandled 'error' event
  // and crash the daemon — the exact outage S9.4's retry path exists to survive.
  jobQueue.on("error", onQueueError(jobQueue.name, logger));
  runQueue.on("error", onQueueError(runQueue.name, logger));
  tmdbFetchQueue.on("error", onQueueError(tmdbFetchQueue.name, logger));

  // O11.3 — O9's queue health gauges for every queue this publisher owns. Optional so
  // callers without an OTel bootstrap (tests) simply skip registration.
  if (meter !== undefined) {
    registerQueueHealthMetrics({ meter, queues: [jobQueue, runQueue, tmdbFetchQueue] });
  }

  return {
    async publish(message) {
      const queue = queueFor(message.targetKind);
      // Broker-is-a-hint redrive (ADR 0001): clear a dead completed/failed record so
      // a fresh outbox row for the same durable target is delivered again; live
      // records keep first-delivery dedup. TMDB_FETCH is fire-once: plain S9.2 path.
      if (message.targetKind !== "TMDB_FETCH") {
        await removeTerminalBrokerRecord(queue, message.targetId);
      }
      await publish(queue, message.targetKind, message.targetId, message);
    },
    async close() {
      await Promise.all([jobQueue.close(), runQueue.close(), tmdbFetchQueue.close()]);
    },
  };

  function queueFor(kind: OutboxTargetKind): Queue<RelayMessage> {
    switch (kind) {
      case "JOB":
        return jobQueue;
      case "RUN":
        return runQueue;
      case "TMDB_FETCH":
        return tmdbFetchQueue;
    }
  }
}

function onQueueError(queueName: string, logger: SeatfirstLogger) {
  return (error: Error) => {
    logger.error(
      { queue: queueName, error },
      "BullMQ connection error (publishes fail and retry with backoff)",
    );
  };
}
