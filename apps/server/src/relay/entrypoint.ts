import { metrics } from "@opentelemetry/api";
import type { Meter } from "@opentelemetry/api";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { Pool } from "pg";
import { poolClient } from "@seatfirst/durability";
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

import { runRelayLoop, type RelayLoopHandle } from "./daemon.js";
import { registerHealthz } from "./health.js";
import { createRelayPublisher } from "./publisher.js";
import type { RelayState } from "./state.js";

/**
 * Environment-sourced daemon configuration (S9.1/S9.4/S9.5). Every tunable is required
 * and has NO hardcoded default — an undecided number may not be encoded anywhere
 * (gate 14 / ADR 0006, `docs/gates.md:1-5`):
 *
 * - `DATABASE_URL`          — Postgres connection string. The outbox is the relay's
 *                             sole durable truth (ADR 0001).
 * - `RELAY_POLL_INTERVAL_MS` — pause between poll cycles (S9.1).
 * - `RELAY_BATCH_SIZE`       — bound passed to `SWEEP_OVERDUE_OUTBOX` (S9.1).
 * - `RELAY_RETRY_BACKOFF`    — Postgres interval literal applied by `OUTBOX_MARK_RETRY`
 *                             on publish failure, e.g. `"5 seconds"` (S9.4).
 * - `RELAY_ALARM_THRESHOLD_MS` — alarm when the oldest PENDING row exceeds this age (S9.5).
 * - `RELAY_HEALTH_PORT`      — TCP port for `GET /healthz` (S9.6).
 * - `LOG_LEVEL`              — pino/OTel level; defaults to "info" when unset (O6.8; O4.8).
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — broker address, read by
 *   S7's `redisConnectionFromEnv` (S7.2).
 */
export interface RelayEnvConfig {
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly retryBackoff: string;
  readonly alarmThresholdMs: number;
  readonly healthPort: number;
  readonly logLevel: LogLevel;
}

export function relayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayEnvConfig {
  return {
    databaseUrl: requiredString(env, "DATABASE_URL"),
    pollIntervalMs: positiveInteger(env, "RELAY_POLL_INTERVAL_MS"),
    batchSize: positiveInteger(env, "RELAY_BATCH_SIZE"),
    retryBackoff: requiredString(env, "RELAY_RETRY_BACKOFF"),
    alarmThresholdMs: positiveInteger(env, "RELAY_ALARM_THRESHOLD_MS"),
    healthPort: port(env, "RELAY_HEALTH_PORT"),
    logLevel: logLevelFromEnv(env),
  };
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default`);
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

function port(env: NodeJS.ProcessEnv, name: string): number {
  const value = positiveInteger(env, name);
  if (value > 65535) {
    throw new Error(`${name} must be in 1..65535, got ${value}`);
  }
  return value;
}
export interface RelayDaemonHandle {
  /** The shared liveness state backing `/healthz` and the OTel gauges. */
  readonly state: RelayState;
  /** Stops the loop, closes the health listener, the queues, and the pool. */
  close(): Promise<void>;
}

export interface StartRelayDaemonOptions {
  readonly config: RelayEnvConfig;
  readonly env?: NodeJS.ProcessEnv;
  /** Optional pre-built logger; production omits and the default built from `config.logLevel` is used. */
  readonly logger?: SeatfirstLogger;
  /** Overrides the process-global "seatfirst" meter; tests inject their own provider. */
  readonly meter?: Meter;
  /** External stop signal; `close()` works without one. */
  readonly signal?: AbortSignal;
}

/**
 * Assembles the daemon process: pg pool (outbox truth), BullMQ queues via S7's client,
 * the continuous poll loop, and the `GET /healthz` listener. This is the composition
 * point the deployment shape (ADR 0004, I1) invokes; `apps/server` deliberately has no
 * `start` script (CONTRIBUTING.md §5).
 *
 * pg pool sizing uses the `pg` library's own defaults — the plan authors no capacity
 * numbers, mirroring O1.4's posture on SDK-internal defaults. The health listener binds
 * `127.0.0.1` so the Docker Compose healthcheck reaches it inside the container.
 */
export async function startRelayDaemon(
  options: StartRelayDaemonOptions,
): Promise<RelayDaemonHandle> {
  const envSource = options.env ?? process.env;
  const otel: ConfiguredOtel = buildOtelFromEnv(
    envSource,
    { serviceName: "seatfirst-relay", component: "worker" },
    {},
  );
  const logger: SeatfirstLogger =
    options.logger ??
    createLogger({
      service: "seatfirst-relay",
      component: "worker",
      level: requireLogLevel(options.config.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const pool = new Pool({ connectionString: options.config.databaseUrl });
  const publisher = createRelayPublisher(redisConnectionFromEnv(envSource), logger);
  // Scope name matches packages/config/src/otel.ts's INSTRUMENTATION_SCOPE so the
  // gauges join the same scope once O1's configureOtel registers the global provider;
  // unregistered, the API returns no-op instruments (safe either way).
  const meter = options.meter ?? metrics.getMeter("seatfirst");
  const loop: RelayLoopHandle = runRelayLoop({
    db: poolClient(pool),
    publisher,
    batchSize: options.config.batchSize,
    pollIntervalMs: options.config.pollIntervalMs,
    retryBackoff: options.config.retryBackoff,
    alarmThresholdMs: options.config.alarmThresholdMs,
    meter,
    logger,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const fastify = Fastify({
    // O11.7 — the healthz listener is no longer a silent Fastify instance: it logs
    // through the daemon's own logger (a `healthz` child), matching O6's
    // plain-worker-logger expectation and app.ts's `loggerInstance` wiring. The
    // daemon logger is an O4 `createLogger` product (a real pino logger) in
    // production; tests inject structural `SeatfirstLogger` doubles, hence the
    // narrow interface assertion.
    loggerInstance: logger.child({ component: "healthz" }) as FastifyBaseLogger,
  });
  registerHealthz(fastify, loop.state);
  try {
    await fastify.listen({ port: options.config.healthPort, host: "127.0.0.1" });
    logger.info({ port: options.config.healthPort }, "healthz listening");
  } catch (error) {
    loop.stop();
    await Promise.all([
      loop.done,
      publisher.close(),
      pool.end(),
      otel.shutdown().catch(() => undefined),
    ]);
    throw error;
  }

  return {
    state: loop.state,
    async close() {
      loop.stop();
      await loop.done;
      await fastify.close();
      await publisher.close();
      await pool.end();
      await otel.shutdown().catch(() => undefined);
    },
  };
}
