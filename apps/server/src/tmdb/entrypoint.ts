/**
 * TMDB worker entrypoint (S25.3/S25.5): assembles the whole dependency set — Postgres
 * pool, the `tmdb-fetch-queue` BullMQ worker, and the daily pre-warm loop — from a
 * caller-supplied config, exactly as the relay/dispatch/sweeper entrypoints do.
 *
 * One process hosts both duties because they share one token bucket (a single TMDB rate
 * limit across pre-warm and fetch calls) and one TMDB Bearer key. There is deliberately no
 * HTTP listener here (no healthz): this worker is a pure daemon, like the dispatch worker
 * (`apps/server/src/dispatch/entry.ts`), and its liveness is the deployment supervisor's
 * concern (ADR 0004 / I1; CONTRIBUTING.md §5 — `apps/server` has no `start` script).
 *
 * pg pool sizing uses the `pg` library's own defaults — no capacity numbers are authored,
 * mirroring the relay entrypoint (`apps/server/src/relay/entrypoint.ts:96-98`).
 */
import { Queue } from "bullmq";
import { Pool } from "pg";

import {
  completeTmdbPrewarm,
  markTmdbFetchDone,
  markTmdbFetchFailed,
  poolClient,
  readTmdbFetchById,
  readTmdbPrewarmState,
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
import { nextFourAmEastern } from "./due.js";
import { processTmdbFetch, runTmdbPrewarmTick } from "./duties.js";
import type { TmdbFetchDeps, TmdbFetchTick, TmdbPrewarmDeps, TmdbPrewarmTick } from "./duties.js";
import { createTokenBucket } from "./token-bucket.js";

export interface TmdbWorkerConfig {
  readonly apiKey: string;
  readonly databaseUrl: string;
  readonly connection: RedisConnectionConfig;
  readonly logger?: SeatfirstLogger;
  readonly workerOptions?: CreateWorkerOptions;
  readonly onPrewarmTick?: (tick: TmdbPrewarmTick) => void;
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
 * (gate 14 / ADR 0006). The token-bucket numbers (30/30) and cron time (04:00 ET) are NOT
 * read here — they are ADR-pinned literals in `token-bucket.ts`/`due.ts`.
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

  const prewarmDeps: TmdbPrewarmDeps = {
    db,
    readPrewarmState: readTmdbPrewarmState,
    completePrewarm: completeTmdbPrewarm,
    nowPlaying: () => client.nowPlaying(),
    upcoming: () => client.upcoming(),
    movieDetails: (tmdbId) => client.movieDetails(tmdbId),
    upsertMovie: upsertTmdbMovie,
    now: () => new Date(),
  };

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
  const prewarmLoop = runTmdbPrewarmLoop(prewarmDeps, {
    logger,
    ...(config.onPrewarmTick === undefined ? {} : { onTickComplete: config.onPrewarmTick }),
  });

  return {
    async close() {
      prewarmLoop.stop();
      await fetchWorker.close();
      await queue.close();
      await pool.end();
      await otel.shutdown().catch(() => undefined);
    },
  };
}

/**
 * The daily pre-warm loop: run the duty immediately (due-ness is re-checked inside, so a
 * restart before 04:00 is a cheap SKIPPED_NOT_DUE), then sleep exactly until the next
 * 04:00 `America/New_York` boundary. No poll interval is authored — the loop targets the
 * ADR-pinned boundary itself, so there is no invented gate-14 number.
 */
function runTmdbPrewarmLoop(
  deps: TmdbPrewarmDeps,
  options: {
    readonly logger: SeatfirstLogger;
    readonly onTickComplete?: (tick: TmdbPrewarmTick) => void;
  },
): { stop(): void } {
  const { logger, onTickComplete } = options;
  const controller = new AbortController();
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      try {
        const tick = await runTmdbPrewarmTick(deps);
        onTickComplete?.(tick);
      } catch (error) {
        logger.error({ error }, "tmdb pre-warm tick failed");
      }
      const sleepMs = nextFourAmEastern(new Date()).getTime() - Date.now();
      await delay(Math.max(0, sleepMs), controller.signal);
    }
  };

  void loop();

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}

/** Abortable sleep — `stop()` does not wait out a (up to 24h) boundary interval. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
