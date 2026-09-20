import IORedis from "ioredis";
import type { Route } from "playwright-core";

import type { BrowserSupervisor } from "@seatfirst/browser-runtime";
import { runCorridorNavigation } from "@seatfirst/browser-runtime";
import type { HopResponse } from "@seatfirst/browser-runtime";
import {
  SEMAPHORE_ACQUIRE,
  SEMAPHORE_RELEASE,
  completeAmcMovieCatalogueCrawl,
  createPool,
  poolClient,
  readAmcMovieCatalogueState,
  readProviderControlState,
  upsertAmcMovieCatalogue,
} from "@seatfirst/durability";
import type { PoolOptions } from "@seatfirst/durability";
import { buildMoviesUrl, parseMovies } from "@seatfirst/providers";

import {
  createLogger,
  logLevelFromEnv,
  requireLogLevel,
  type LogLevel,
} from "@seatfirst/config/logger";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel, SeatfirstMetrics } from "@seatfirst/config/otel";
import { installCrashHandlers } from "../crash-handlers.js";
import { providerStateSourceFromPool } from "../dispatch/handlers/provider-fetch-actor.js";
import { redisConnectionFromEnv } from "../queue/index.js";
import type { RedisConnectionConfig } from "../queue/index.js";
import { mintSessionId } from "../routes/session/bootstrap.js";
import { redisScriptExecutorFromIoredis } from "../session/limiter.js";

import { runAmcMoviesCrawler } from "./crawl.js";
import type { AmcMoviesCrawlLogger, AmcMoviesCrawlerHandle } from "./crawl.js";
import type { AmcMoviesCrawlDeps, AmcMoviesCrawlTick } from "./duties.js";

/**
 * ADR 0102 is AMC-specific: the crawl fetches the one provider's own `/movies`
 * catalogue. It is not configurable per-deployment because no second provider has an
 * authorized movies-catalogue corridor.
 */
export const AMC_MOVIES_CRAWL_PROVIDER_ID = "amc";

/**
 * Environment-sourced daemon configuration (mirrors S26.6/S26.13 per ADR 0102 decision
 * 8). Every tunable is required and has NO hardcoded default — an undecided number may
 * not be encoded anywhere (gate 14 / ADR 0006). The two ADR-0102-fixed numbers (the
 * daily 07:00-Eastern cadence and the ten-minute pacing tick) are NOT here: they are
 * hard-coded in `due.ts`/`crawl.ts` because the ADR fixes them and a configurable
 * cadence would let a deploy silently violate the decision.
 *
 * - `DATABASE_URL`                — Postgres connection string (catalogue rows + state).
 * - `PG_POOL_MAX`                 — pg pool size (durability's `createPool`).
 * - `PG_POOL_IDLE_TIMEOUT_MS`     — pg pool idle timeout.
 * - `PG_POOL_CONNECTION_TIMEOUT_MS` — pg pool connect timeout.
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — broker address (S7.2).
 * - `AMC_EGRESS_IDENTITY_LABEL`   — deployment-assigned audit label (ADR 0004).
 * - `AMC_USER_AGENT`              — deployment-assigned AMC identity (P1).
 * - `AMC_NAVIGATION_TIMEOUT_MS`   — per-navigation bound (P6.18).
 * - `AMC_SEMAPHORE_TTL_MS`        — semaphore lease TTL (S8), on the shared `sem:amc`.
 *
 * Deliberately absent: every `CHROME_*`/`AMC_CLEANUP_*`/`AMC_READINESS_*` supervisor
 * variable `catalogueCrawlConfigFromEnv` reads. This worker never owns a supervisor —
 * it only ever runs inside the fetch-worker process on the one shared supervisor
 * `startFetchWorker` owns (ADR 0102 decision 8).
 */
export interface AmcMoviesCrawlEnvConfig {
  readonly postgres: PoolOptions;
  readonly redis: RedisConnectionConfig;
  readonly egressIdentityLabel: string;
  readonly userAgent: string;
  readonly navigationTimeoutMs: number;
  readonly semaphoreTtlMs: number;
  readonly logLevel?: LogLevel;
}

export function amcMoviesCrawlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AmcMoviesCrawlEnvConfig {
  return {
    postgres: {
      connectionString: requiredString(env, "DATABASE_URL"),
      max: positiveInteger(env, "PG_POOL_MAX"),
      idleTimeoutMillis: positiveInteger(env, "PG_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: positiveInteger(env, "PG_POOL_CONNECTION_TIMEOUT_MS"),
    },
    redis: redisConnectionFromEnv(env),
    egressIdentityLabel: requiredString(env, "AMC_EGRESS_IDENTITY_LABEL"),
    userAgent: requiredString(env, "AMC_USER_AGENT"),
    navigationTimeoutMs: positiveInteger(env, "AMC_NAVIGATION_TIMEOUT_MS"),
    semaphoreTtlMs: positiveInteger(env, "AMC_SEMAPHORE_TTL_MS"),
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

export interface AmcMoviesCrawlService extends AmcMoviesCrawlerHandle {
  /** Stops the loop first, then closes every connection the service opened. */
  close(): Promise<void>;
}

export interface CreateAmcMoviesCrawlerOptions extends AmcMoviesCrawlEnvConfig {
  readonly logger?: AmcMoviesCrawlLogger;
  readonly onTickComplete?: (tick: AmcMoviesCrawlTick) => void;
  /**
   * ADR 0102 decision 8 — the caller-supplied shared supervisor. REQUIRED (unlike
   * `CreateCatalogueCrawlerOptions.supervisor`, which is optional): this worker never
   * starts its own Chrome, it only ever runs inside the fetch-worker process sharing
   * the one supervisor `startFetchWorker` owns. Ownership stays with the caller —
   * `close()` never shuts it down.
   */
  readonly supervisor: BrowserSupervisor;
  readonly env?: NodeJS.ProcessEnv;
  readonly metrics?: SeatfirstMetrics;
  /**
   * P6's offline synthetic test-harness seam (`ProviderFetchNavigationSeams.fetchHop`):
   * when supplied by the composed fetch-worker's dev-only fixture entrypoint, the
   * `/movies` document hop is served through it instead of the real network — the same
   * seam already guarding the RUN actor's navigations over the shared warm Chrome.
   * Production callers omit it; the transport then performs the hop through Chrome's
   * own network stack.
   */
  readonly fetchHop?: (route: Route) => Promise<HopResponse>;
}

/**
 * Assembles the full dependency set (pg pool, Redis script/hash client, shared
 * supervisor, control-state source) from a caller-supplied config and hands it to the
 * hard-coded-cadence tick loop. Everything is injected — no addresses, no tunables, no
 * defaults (gate 14).
 */
export function createAmcMoviesCrawler(
  options: CreateAmcMoviesCrawlerOptions,
): Promise<AmcMoviesCrawlService> {
  const envSource = options.env ?? process.env;
  const otel: ConfiguredOtel = buildOtelFromEnv(
    envSource,
    { serviceName: "seatfirst-amc-movies-crawl", component: "worker" },
    {},
  );
  const logger =
    options.logger ??
    createLogger({
      service: "seatfirst-amc-movies-crawl",
      component: "worker",
      level: requireLogLevel(options.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const pool = createPool(options.postgres);
  const redis = openRedisClient(options.redis);
  const supervisor = options.supervisor;

  const db = poolClient(pool);
  const scriptExecutor = redisScriptExecutorFromIoredis(redis);
  // ADR 0102 decision 2 — the SAME semaphore key as catalogue-crawl and provider-fetch
  // (`sem:amc`): the `/movies` fetch shares the one AMC corridor, never a new lane.
  const semaphoreKey = `sem:${AMC_MOVIES_CRAWL_PROVIDER_ID}`;
  const generationKey = `sem:${AMC_MOVIES_CRAWL_PROVIDER_ID}:gen`;
  const controlSource = providerStateSourceFromPool(pool);

  const deps: AmcMoviesCrawlDeps = {
    egressIdentityLabel: options.egressIdentityLabel,
    // The checkpoint table is a bare singleton: no provider id to thread through.
    readState: () => readAmcMovieCatalogueState(db),
    completeCrawl: () => completeAmcMovieCatalogueCrawl(db),
    upsertMovie: (input) => upsertAmcMovieCatalogue(db, input),
    // No separate lane — the crawl reads the provider-wide control state (routeClass
    // '') and obeys only the provider-wide halt/kill-switch.
    readControlState: () =>
      readProviderControlState(redis, controlSource, AMC_MOVIES_CRAWL_PROVIDER_ID, ""),
    acquireSemaphore: async (holderId) => {
      const result = await scriptExecutor.eval(
        SEMAPHORE_ACQUIRE,
        [semaphoreKey, generationKey],
        [holderId, options.semaphoreTtlMs],
      );
      return typeof result === "number" ? result : false;
    },
    releaseSemaphore: (holderId, generation) =>
      scriptExecutor.eval(SEMAPHORE_RELEASE, [semaphoreKey], [holderId, generation]),
    navigate: (targetUrl, scope) =>
      runCorridorNavigation(supervisor, {
        scope,
        targetUrl,
        userAgent: options.userAgent,
        limits: { navigationTimeoutMs: options.navigationTimeoutMs },
        ...(options.fetchHop !== undefined ? { fetchHop: options.fetchHop } : {}),
      }),
    parseMovies,
    buildMoviesUrl: () => buildMoviesUrl().toString(),
    mintId: mintSessionId,
    now: () => new Date(),
  };

  const handle = runAmcMoviesCrawler(deps, {
    logger,
    ...(options.onTickComplete !== undefined ? { onTickComplete: options.onTickComplete } : {}),
    ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
  });

  return Promise.resolve({
    pause: () => handle.pause(),
    resume: () => handle.resume(),
    stop: () => handle.stop(),
    async close() {
      handle.stop();
      await redis.quit().catch(() => undefined);
      await pool.end();
      // The supervisor is caller-owned (ADR 0102 decision 8): never shut down here.
      await otel.shutdown().catch(() => undefined);
    },
  });
}

/** ioredis construction from S7.2's two-form connection config (URL, or host/port/password). */
function openRedisClient(connection: RedisConnectionConfig): IORedis.Redis {
  if (connection.url !== undefined) {
    return new IORedis.Redis(connection.url);
  }
  const options: { host?: string; port?: number; password?: string } = {};
  if (connection.host !== undefined) options.host = connection.host;
  if (connection.port !== undefined) options.port = connection.port;
  if (connection.password !== undefined) options.password = connection.password;
  return new IORedis.Redis(options);
}
