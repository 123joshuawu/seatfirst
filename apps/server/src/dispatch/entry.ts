/**
 * Dispatch worker entrypoint: builds the whole dependency set (Postgres pool, the three
 * BullMQ queues, the placeholder-seeded handler registry) from caller-supplied config and
 * starts the consumer workers (S11.1). Every tunable is injected — no addresses, no lease
 * TTL default (gate 14).
 */

import { Queue } from "bullmq";

import { createPool, poolClient } from "@seatfirst/durability";
import type { PoolOptions } from "@seatfirst/durability";

import {
  createLogger,
  logLevelFromEnv,
  requireLogLevel,
  type LogLevel,
  type SeatfirstLogger,
} from "@seatfirst/config/logger";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel } from "@seatfirst/config/otel";
import { installCrashHandlers } from "../crash-handlers.js";

import { redisConnectionFromEnv } from "../queue/index.js";
import type { RedisConnectionConfig } from "../queue/index.js";
import { registerQueueHealthMetrics } from "../queue/metrics.js";
import { RELAY_QUEUE_FOR_TARGET } from "../relay/publisher.js";
import type { RelayMessage } from "../relay/publisher.js";
import { AGGREGATE_HINT_QUEUE } from "../sweeper/index.js";
import type { AggregateHintMessage } from "../sweeper/index.js";

import { createDispatchWorkers } from "./consumer.js";
import type { DispatchHandle, DispatchWorkerOptions } from "./consumer.js";
import { createPlaceholderRegistry } from "./handlers.js";
import type { DispatchRegistry } from "./types.js";

export interface DispatchConfig {
  /** Postgres pool options (durability's `createPool`) — fully caller-supplied. */
  readonly postgres: PoolOptions;
  /** Postgres interval literal (e.g. `"30 seconds"`) — injected, no default (gate 14). */
  readonly leaseTtl: string;
  /** BullMQ/Redis connection — fully caller-supplied (gate 14). */
  readonly connection: RedisConnectionConfig;
  /** Defaults to the loud-fail placeholder registry (S11.7/S11.8). */
  readonly registry?: DispatchRegistry;
  /** Injected logger; omitted → the O6 default built from `logLevel` below. */
  readonly logger?: SeatfirstLogger;
  /** O6.8 — required by `requireLogLevel` when `logger` is omitted. */
  readonly logLevel?: LogLevel;
  /** Env source for OTel bootstrap (test seam); production omits → `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly workerOptions?: DispatchWorkerOptions;
}

export type DispatchService = DispatchHandle;

/** Reads `DATABASE_URL` and the pool/lease tunables from the environment. Every value is
 * required and has no hardcoded default (gate 14 / ADR 0006, `docs/gates.md:1-5`). Redis
 * addressing is delegated to S7's own `redisConnectionFromEnv`. */
export function dispatchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<DispatchConfig, "registry" | "logger" | "workerOptions"> {
  return {
    postgres: {
      connectionString: requiredString(env, "DATABASE_URL"),
      max: positiveInteger(env, "DISPATCH_PG_POOL_MAX"),
      idleTimeoutMillis: positiveInteger(env, "DISPATCH_PG_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: positiveInteger(env, "DISPATCH_PG_CONNECT_TIMEOUT_MS"),
    },
    connection: redisConnectionFromEnv(env),
    leaseTtl: requiredString(env, "DISPATCH_LEASE_TTL"),
    logLevel: logLevelFromEnv(env),
  };
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default (gate 14)`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredString(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Assembles and starts the dispatch worker. `close()` stops the three BullMQ workers
 * first, then closes every connection this module opened.
 */
export function startDispatchWorker(config: DispatchConfig): DispatchService {
  const envSource = config.env ?? process.env;
  const otel: ConfiguredOtel = buildOtelFromEnv(
    envSource,
    { serviceName: "seatfirst-dispatch", component: "worker" },
    {},
  );
  const logger =
    config.logger ??
    createLogger({
      service: "seatfirst-dispatch",
      component: "worker",
      level: requireLogLevel(config.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const pool = createPool(config.postgres);
  const jobQueue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.JOB, {
    connection: config.connection,
  });
  const runQueue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.RUN, {
    connection: config.connection,
  });
  const aggregateQueue = new Queue<AggregateHintMessage>(AGGREGATE_HINT_QUEUE, {
    connection: config.connection,
  });
  for (const queue of [jobQueue, runQueue, aggregateQueue]) {
    queue.on("error", (error: Error) => {
      logger.error(
        { queue: queue.name, error },
        "BullMQ connection error (dispatch stalls until reconnect)",
      );
    });
  }

  // O11.3 — O9's queue health gauges for this process's three dispatch queues, registered
  // once at startup against this bootstrap's own meter.
  registerQueueHealthMetrics({
    meter: otel.meter,
    queues: [jobQueue, runQueue, aggregateQueue],
  });

  const registry = config.registry ?? createPlaceholderRegistry();
  const handle = createDispatchWorkers(
    { db: poolClient(pool), registry, logger, metrics: otel.metrics },
    { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
    { leaseTtl: config.leaseTtl },
    config.workerOptions,
  );

  return {
    pause: async () => {
      await handle.pause();
    },
    resume: async () => {
      await handle.resume();
    },
    close: async () => {
      await handle.close();
      await Promise.allSettled([
        jobQueue.close(),
        runQueue.close(),
        aggregateQueue.close(),
        pool.end(),
        otel.shutdown().catch(() => undefined),
      ]);
    },
  };
}
