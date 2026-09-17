/**
 * Sweeper entrypoint: builds the whole dependency set (Postgres pool, relay publisher,
 * AGGREGATE-hint queue, Redis Stream writer) from a caller-supplied config and hands it
 * to the periodic loop. Everything here is injected — no addresses, no tunables, no
 * defaults (gate 14).
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { createPool, poolClient } from "@seatfirst/durability";
import type { PoolOptions } from "@seatfirst/durability";

import { redisConnectionFromEnv } from "../queue/index.js";
import type { RedisConnectionConfig } from "../queue/index.js";
import { registerQueueHealthMetrics } from "../queue/metrics.js";
import {
  createLogger,
  logLevelFromEnv,
  requireLogLevel,
  type LogLevel,
} from "@seatfirst/config/logger";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel, SeatfirstMetrics } from "@seatfirst/config/otel";
import { installCrashHandlers } from "../crash-handlers.js";
import { createRelayPublisher } from "../relay/publisher.js";
import { redisScriptExecutorFromIoredis } from "../session/limiter.js";

import { AGGREGATE_HINT_QUEUE } from "./duties.js";
import type { AggregateHintMessage, SnapshotProjectionClaim } from "./duties.js";
import { createSnapshotProjector } from "./projector.js";
import { runSweeper } from "./sweeper.js";
import type { SweeperHandle, SweeperLogger, SweepTickSummary, SweepTunables } from "./sweeper.js";

export interface SweeperConfig extends Omit<SweepTunables, "computeSnapshotProjection"> {
  /** Postgres pool options (durability's `createPool`) — fully caller-supplied. */
  readonly postgres: PoolOptions;
  /**
   * The broker connection for the BullMQ queues — S7.2's contract
   * (`redisConnectionFromEnv` from `../queue`). The same Redis serves the event Streams;
   * the stream client is derived from this config, never a second address.
   */
  readonly connection: RedisConnectionConfig;
  /** Tick interval — injected, no default (gate 14). */
  readonly tickIntervalMs: number;
  /**
   * The snapshot-projection compute step (see `duties.ts`). Defaults to the real producer
   * `createSweeper` builds from its pool + Redis (S33.4); tests inject a fake through this
   * seam, unchanged.
   */
  readonly computeSnapshotProjection?: (claim: SnapshotProjectionClaim) => Promise<void>;
  readonly logger?: SweeperLogger;
  readonly onTickComplete?: (summary: SweepTickSummary) => void;
  /** Minimum log level — read from `LOG_LEVEL` by `sweeperConfigFromEnv`. Optional only
   *  when an explicit `logger` is injected; the default logger requires it. */
  readonly logLevel?: LogLevel;
  /** Process-env override (test seam); production omits it and gets `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface SweeperService extends SweeperHandle {
  stop(): Promise<void>;
}

/**
 * Assembles and starts the sweeper. `stop()` stops the loop first, then closes every
 * connection the service opened.
 */
export function createSweeper(config: SweeperConfig): SweeperService {
  // O6.2: one OTel bootstrap per process entrypoint; exports only when the operator set
  // OTEL_EXPORTER_OTLP_ENDPOINT, otherwise a structural no-op.
  const otel: ConfiguredOtel = buildOtelFromEnv(
    config.env ?? process.env,
    { serviceName: "seatfirst-sweeper", component: "worker" },
    {},
  );
  const logger =
    config.logger ??
    createLogger({
      service: "seatfirst-sweeper",
      component: "worker",
      level: requireLogLevel(config.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const metrics: SeatfirstMetrics = otel.metrics;
  const pool = createPool(config.postgres);
  const publisher = createRelayPublisher(config.connection, logger, otel.meter);
  // The relay publisher owns job-queue/run-queue; the hint channel is this module's.
  const aggregateQueue = new Queue<AggregateHintMessage>(AGGREGATE_HINT_QUEUE, {
    connection: config.connection,
  });
  // Same outage posture as the relay's queues (S9): without a listener, a broker outage
  // would surface as an unhandled 'error' event and crash the loop.
  aggregateQueue.on("error", (error: Error) => {
    logger.error(
      { error },
      `BullMQ ${AGGREGATE_HINT_QUEUE} connection error (hint publishes fail; the next tick retries)`,
    );
  });

  // O11.3 — O9's gauges for this process's own queue; the relay publisher's job/run/tmdb
  // queues register inside createRelayPublisher via the meter passed above.
  registerQueueHealthMetrics({ meter: otel.meter, queues: [aggregateQueue] });
  const redis = openStreamClient(config.connection);
  // The real producer is built from the already-open pool + Redis client (S33.4); a
  // caller-supplied compute (tests) wins, so the injected-compute seam stays honored.
  const computeSnapshotProjection =
    config.computeSnapshotProjection ??
    createSnapshotProjector(poolClient(pool), redisScriptExecutorFromIoredis(redis));

  const handle = runSweeper(
    { pool, publisher, aggregateQueue, redis, logger, metrics },
    {
      outboxBatch: config.outboxBatch,
      rearmAge: config.rearmAge,
      maxAttempts: config.maxAttempts,
      snapshotAge: config.snapshotAge,
      computeSnapshotProjection,
      tickIntervalMs: config.tickIntervalMs,
      ...(config.onTickComplete === undefined ? {} : { onTickComplete: config.onTickComplete }),
    },
  );

  return {
    async stop() {
      await handle.stop();
      await Promise.allSettled([aggregateQueue.close(), publisher.close(), pool.end()]);
      await otel.shutdown().catch(() => undefined);
      // disconnect() (not quit()) — an in-flight command would make quit() wait forever.
      redis.disconnect();
    },
  };
}

/**
 * Derives the stream writer from the same connection config the BullMQ queues use — the
 * two forms `redisConnectionFromEnv` produces (a `redis://` URL, or host/port/password)
 * map straight onto ioredis's own constructors.
 */
function openStreamClient(connection: RedisConnectionConfig): IORedis.Redis {
  if (connection.url !== undefined) {
    return new IORedis.Redis(connection.url, { lazyConnect: true });
  }
  const options: {
    host?: string;
    port?: number;
    password?: string;
    lazyConnect: true;
  } = { lazyConnect: true };
  if (connection.host !== undefined) {
    options.host = connection.host;
  }
  if (connection.port !== undefined) {
    options.port = connection.port;
  }
  if (connection.password !== undefined) {
    options.password = connection.password;
  }
  return new IORedis.Redis(options);
}

/**
 * Environment-sourced sweeper configuration (S28.3). Every tunable is REQUIRED with no
 * hardcoded default (gate 14 / ADR 0006):
 *
 * - `DATABASE_URL`            — Postgres connection string.
 * - `SWEEP_PG_POOL_MAX`       — pg pool size (durability's `createPool`).
 * - `SWEEP_PG_POOL_IDLE_TIMEOUT_MS` — pg pool idle timeout.
 * - `SWEEP_PG_CONNECT_TIMEOUT_MS`   — pg pool connect timeout.
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — broker, via S7's
 *   `redisConnectionFromEnv` (the same Redis serves the event Streams).
 * - `SWEEP_TICK_INTERVAL_MS`  — pause between ticks.
 * - `SWEEP_OUTBOX_BATCH`      — `SWEEP_OVERDUE_OUTBOX` batch size.
 * - `SWEEP_REARM_AGE`         — Postgres interval literal for re-arm duties.
 * - `SWEEP_MAX_ATTEMPTS`      — attempt budget for reclaim/fail-exhausted duties.
 * - `SWEEP_SNAPSHOT_AGE`      — Postgres interval literal for the snapshot-projection duty.
 * - `LOG_LEVEL`              — minimum log level (`logLevelFromEnv`, O4.8).
 *
 * `computeSnapshotProjection` is code-wired, not env-read — it is a function (S10.10's
 * snapshot-projection compute step), and there is deliberately no env knob for a function.
 * `createSweeper` builds the real producer from the pool + Redis client it already opens
 * (`createSnapshotProjector`, S33.4); `sweeperConfigFromEnv` therefore returns no throwing
 * function.
 */
export function sweeperConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SweeperConfig {
  return {
    postgres: {
      connectionString: requiredString(env, "DATABASE_URL"),
      max: positiveInteger(env, "SWEEP_PG_POOL_MAX"),
      idleTimeoutMillis: positiveInteger(env, "SWEEP_PG_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: positiveInteger(env, "SWEEP_PG_CONNECT_TIMEOUT_MS"),
    },
    connection: redisConnectionFromEnv(env),
    tickIntervalMs: positiveInteger(env, "SWEEP_TICK_INTERVAL_MS"),
    logLevel: logLevelFromEnv(env),
    outboxBatch: positiveInteger(env, "SWEEP_OUTBOX_BATCH"),
    rearmAge: requiredString(env, "SWEEP_REARM_AGE"),
    maxAttempts: positiveInteger(env, "SWEEP_MAX_ATTEMPTS"),
    snapshotAge: requiredString(env, "SWEEP_SNAPSHOT_AGE"),
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
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
