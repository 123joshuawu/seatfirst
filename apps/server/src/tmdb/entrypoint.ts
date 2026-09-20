/**
 * TMDB worker entrypoint (S25.5): assembles the whole dependency set — Postgres
 * pool and the `tmdb-fetch-queue` BullMQ worker — from a caller-supplied config,
 * exactly as the relay/dispatch/sweeper entrypoints do. (ADR 0102 decision 7
 * decommissioned the S25.3 daily pre-warm loop; the TMDB_FETCH outbox consumer is
 * all that remains.)
 *
 * The single TMDB Bearer key and token bucket exist for the fetch duty's live
 * search/enrichment calls. There is deliberately no HTTP listener here (no healthz):
 * this worker is a pure daemon, like the dispatch worker
 * (`apps/server/src/dispatch/entry.ts`), and its liveness is the deployment supervisor's
 * concern (ADR 0004 / I1; CONTRIBUTING.md §5 — `apps/server` has no `start` script).
 *
 * pg pool sizing uses the `pg` library's own defaults — no capacity numbers are authored,
 * mirroring the relay entrypoint (`apps/server/src/relay/entrypoint.ts:96-98`).
 */
import { Queue } from "bullmq";
import { Pool } from "pg";

import {
  markTmdbFetchDone,
  markTmdbFetchFailed,
  poolClient,
  readTmdbFetchById,
  upsertTmdbMovie,
} from "@seatfirst/durability";

import {
  createLogger,
  logLevelFromEnv,
  requireLogLevel,
  type LogLevel,
  type SeatfirstLogger,
} from "@seatfirst/config/logger";
import { installCrashHandlers } from "../crash-handlers.js";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel, SeatfirstMetrics } from "@seatfirst/config/otel";
import { createWorker, redisConnectionFromEnv } from "../queue/index.js";
import type { CreateWorkerOptions, RedisConnectionConfig } from "../queue/index.js";
import { registerQueueHealthMetrics } from "../queue/metrics.js";
import { RELAY_QUEUE_FOR_TARGET } from "../relay/publisher.js";
import type { RelayMessage } from "../relay/publisher.js";
import { createTmdbClient } from "./client.js";
import { tmdbConfigFromEnv } from "./config.js";
import { processTmdbFetch } from "./duties.js";
import type { TmdbFetchDeps, TmdbFetchTick } from "./duties.js";
import { createTokenBucket } from "./token-bucket.js";

export interface TmdbWorkerConfig {
  readonly apiKey: string;
  readonly databaseUrl: string;
  readonly connection: RedisConnectionConfig;
  readonly logger?: SeatfirstLogger;
  readonly workerOptions?: CreateWorkerOptions;
  readonly onFetchTick?: (tick: TmdbFetchTick) => void;
  readonly logLevel?: LogLevel;
  readonly env?: NodeJS.ProcessEnv;
  readonly metrics?: SeatfirstMetrics;
}
export interface TmdbWorkerHandle {
  close(): Promise<void>;
}

/**
 * Reads `TMDB_API_KEY` (decision 4), `DATABASE_URL`, and the broker address
 * (`redisConnectionFromEnv`, S7.2). Every value is required and has no hardcoded default
 * (gate 14 / ADR 0006). The token-bucket numbers (30/30) are NOT read here — they are
 * ADR-pinned literals in `token-bucket.ts`.
 */
export function tmdbWorkerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TmdbWorkerConfig {
  return {
    apiKey: tmdbConfigFromEnv(env).apiKey,
    databaseUrl: requiredString(env, "DATABASE_URL"),
    connection: redisConnectionFromEnv(env),
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

export function startTmdbWorker(config: TmdbWorkerConfig): TmdbWorkerHandle {
  const envSource = config.env ?? process.env;
  const otel: ConfiguredOtel = buildOtelFromEnv(
    envSource,
    { serviceName: "seatfirst-tmdb", component: "worker" },
    {},
  );
  const logger =
    config.logger ??
    createLogger({
      service: "seatfirst-tmdb",
      component: "worker",
      level: requireLogLevel(config.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const metrics = config.metrics ?? otel.metrics;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = poolClient(pool);
  const bucket = createTokenBucket();
  const client = createTmdbClient({ apiKey: config.apiKey, bucket, logger });

  const fetchDeps: TmdbFetchDeps = {
    db,
    readFetch: readTmdbFetchById,
    markDone: markTmdbFetchDone,
    markFailed: markTmdbFetchFailed,
    searchMovie: (query) => client.searchMovie(query),
    movieDetails: (tmdbId) => client.movieDetails(tmdbId),
    upsertMovie: upsertTmdbMovie,
    logger,
  };

  const queue = new Queue<RelayMessage>(RELAY_QUEUE_FOR_TARGET.TMDB_FETCH, {
    connection: config.connection,
  });
  queue.on("error", (error: Error) => {
    logger.error(
      { queue: queue.name, error },
      "BullMQ connection error (tmdb fetches stall until reconnect)",
    );
  });

  // O11.3 — O9's queue health gauges for this process's TMDB fetch queue, registered once
  // at startup against this bootstrap's own meter (collection happens on OTel's schedule).
  registerQueueHealthMetrics({ meter: otel.meter, queues: [queue] });

  // Job name is the publisher-side convention: RELAY_QUEUE_FOR_TARGET.TMDB_FETCH's value's
  // kind literal ("TMDB_FETCH"), the same one-key-per-queue scheme S9.2/S11.1 agree on.
  const fetchWorker = createWorker<RelayMessage>(
    queue,
    "TMDB_FETCH",
    async (message) => {
      const started = Date.now();
      let succeeded = false;
      let tick: TmdbFetchTick | undefined;
      try {
        tick = await processTmdbFetch(fetchDeps, message);
        config.onFetchTick?.(tick);
        succeeded = true;
      } finally {
        const duration = Date.now() - started;
        // Metrics seam (O6.6): record only when defined — production passes otel.metrics.
        if (metrics !== undefined) {
          metrics.tmdbFetchCount.add(1);
          metrics.tmdbFetchDuration.record(duration, { tmdb_fetch_id: message.targetId });
        }
        if (succeeded) {
          logger.info({ tmdb_fetch_id: message.targetId }, "tmdb fetch completed");
        } else if (tick?.kind === "FETCH_FAILED") {
          // O11.4 — the duty swallows upstream errors by design (the FAILED durable row is
          // the recovery mechanism), so this line is the job outcome's only error record.
          logger.error({ tmdb_fetch_id: message.targetId, cause: tick.cause }, "tmdb fetch failed");
        }
      }
    },
    config.workerOptions,
  );

  return {
    async close() {
      await fetchWorker.close();
      await queue.close();
      await pool.end();
      await otel.shutdown().catch(() => undefined);
    },
  };
}
