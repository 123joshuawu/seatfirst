import IORedis from "ioredis";
import type { Route } from "playwright-core";

import { BrowserSupervisor, runCorridorNavigation } from "@seatfirst/browser-runtime";
import type { HopResponse } from "@seatfirst/browser-runtime";
import {
  SEMAPHORE_ACQUIRE,
  SEMAPHORE_RELEASE,
  advanceCatalogueCrawlCursor,
  beginCatalogueCrawlPass,
  completeCatalogueCrawlPass,
  createPool,
  poolClient,
  readCatalogueCrawlState,
  readProviderControlState,
  upsertTheatre,
} from "@seatfirst/durability";
import type { PoolOptions } from "@seatfirst/durability";
import {
  buildMarketTheatresUrl,
  buildTheatresDirectoryUrl,
  parseMarketSlugs,
  parseTheatres,
} from "@seatfirst/providers";

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

import { runCatalogueCrawler } from "./crawl.js";
import type { CatalogueCrawlLogger, CatalogueCrawlerHandle } from "./crawl.js";
import type { CatalogueCrawlDeps, CatalogueCrawlTick } from "./duties.js";

/**
 * ADR 0022 is AMC-specific: the crawl runs against the one provider whose directory the
 * ADR authorizes. It is not configurable per-deployment because no second provider has an
 * authorized directory corridor.
 */
const CATALOGUE_CRAWL_PROVIDER_ID = "amc";

/**
 * Environment-sourced daemon configuration (S26.6/S26.13). Every tunable is required and
 * has NO hardcoded default — an undecided number may not be encoded anywhere (gate 14 /
 * ADR 0006, `docs/gates.md:1-5`). The two ADR-0022-fixed numbers (the one-month cadence and
 * the ten-minute pacing tick) are NOT here: they are hard-coded in `due.ts`/`crawl.ts`
 * because the ADR fixes them and a configurable cadence would let a deploy silently violate
 * the decision (S26.7/S26.8).
 *
 * - `DATABASE_URL`                — Postgres connection string (the crawl state + theatre rows).
 * - `PG_POOL_MAX`                 — pg pool size (durability's `createPool`).
 * - `PG_POOL_IDLE_TIMEOUT_MS`     — pg pool idle timeout.
 * - `PG_POOL_CONNECTION_TIMEOUT_MS` — pg pool connect timeout.
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — broker address (S7.2).
 * - `AMC_EGRESS_IDENTITY_LABEL`   — deployment-assigned audit label (ADR 0004).
 * - `AMC_USER_AGENT`              — deployment-assigned AMC identity (P1).
 * - `AMC_NAVIGATION_TIMEOUT_MS`   — per-navigation bound (P6.18).
 * - `AMC_SEMAPHORE_TTL_MS`        — semaphore lease TTL (S8).
 * - `CHROME_EXECUTABLE_PATH`      — Chrome binary (I1 pins the build).
 * - `AMC_CLEANUP_GRACE_PERIOD_MS` — supervisor cleanup grace (P6.3).
 * - `AMC_READINESS_TIMEOUT_MS`    — supervisor readiness bound (P6.16).
 * - `AMC_READINESS_TARGET_URL`    — supervisor readiness probe target, never AMC (P6.16).
 */
export interface CatalogueCrawlEnvConfig {
  readonly postgres: PoolOptions;
  readonly redis: RedisConnectionConfig;
  readonly egressIdentityLabel: string;
  readonly userAgent: string;
  readonly navigationTimeoutMs: number;
  readonly semaphoreTtlMs: number;
  readonly chromeExecutablePath: string;
  readonly cleanupGracePeriodMs: number;
  readonly readinessTimeoutMs: number;
  readonly readinessTargetUrl: string;
  readonly logLevel?: LogLevel;
}

export function catalogueCrawlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CatalogueCrawlEnvConfig {
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
    chromeExecutablePath: requiredString(env, "CHROME_EXECUTABLE_PATH"),
    cleanupGracePeriodMs: positiveInteger(env, "AMC_CLEANUP_GRACE_PERIOD_MS"),
    readinessTimeoutMs: positiveInteger(env, "AMC_READINESS_TIMEOUT_MS"),
    readinessTargetUrl: requiredString(env, "AMC_READINESS_TARGET_URL"),
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

export interface CatalogueCrawlService extends CatalogueCrawlerHandle {
  /** Stops the loop first, then closes every connection the service opened. */
  close(): Promise<void>;
}

export interface CreateCatalogueCrawlerOptions extends CatalogueCrawlEnvConfig {
  readonly logger?: CatalogueCrawlLogger;
  readonly onTickComplete?: (tick: CatalogueCrawlTick) => void;
  /**
   * D3 (S31.6) — an externally-constructed supervisor the crawler shares with the RUN actor.
   * When supplied, the crawler uses it, skips its own `BrowserSupervisor.start(...)`, and does
   * NOT shut it down in `close()` — ownership stays with the caller. When absent, behavior is
   * unchanged (the crawler constructs and owns the one warm Chrome).
   */
  readonly supervisor?: BrowserSupervisor;
  readonly env?: NodeJS.ProcessEnv;
  readonly metrics?: SeatfirstMetrics;
  /**
   * P6's offline synthetic test-harness seam (`ProviderFetchNavigationSeams.fetchHop`,
   * ADR 0022 §6 "no separate lane"): when supplied by the composed fetch-worker's dev-only
   * fixture entrypoint, every crawler document hop is served through it instead of the real
   * network — the same seam already guarding the RUN actor's navigations over the shared
   * warm Chrome. Production callers omit it; the transport then performs each hop through
   * Chrome's own network stack.
   */
  readonly fetchHop?: (route: Route) => Promise<HopResponse>;
}

/**
 * Assembles the full dependency set (pg pool, Redis script/hash client, warm-process
 * browser supervisor, control-state source) from a caller-supplied config and hands it to
 * the hard-coded-cadence tick loop. Everything is injected — no addresses, no tunables, no
 * defaults (gate 14). S26.13: importable and independently startable without being wired
 * into the composed fetch-worker process.
 */
export async function createCatalogueCrawler(
  options: CreateCatalogueCrawlerOptions,
): Promise<CatalogueCrawlService> {
  const envSource = options.env ?? process.env;
  const otel: ConfiguredOtel = buildOtelFromEnv(
    envSource,
    { serviceName: "seatfirst-catalogue-crawl", component: "worker" },
    {},
  );
  const logger =
    options.logger ??
    createLogger({
      service: "seatfirst-catalogue-crawl",
      component: "worker",
      level: requireLogLevel(options.logLevel),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });
  const pool = createPool(options.postgres);
  const redis = openRedisClient(options.redis);
  const ownsSupervisor = options.supervisor === undefined;
  const supervisor =
    options.supervisor ??
    (await BrowserSupervisor.start({
      executablePath: options.chromeExecutablePath,
      egressIdentityLabel: options.egressIdentityLabel,
      providerId: CATALOGUE_CRAWL_PROVIDER_ID,
      cleanupGracePeriodMs: options.cleanupGracePeriodMs,
      readinessTimeoutMs: options.readinessTimeoutMs,
      readinessTargetUrl: options.readinessTargetUrl,
    }));

  const db = poolClient(pool);
  const scriptExecutor = redisScriptExecutorFromIoredis(redis);
  const semaphoreKey = `sem:${CATALOGUE_CRAWL_PROVIDER_ID}`;
  const generationKey = `sem:${CATALOGUE_CRAWL_PROVIDER_ID}:gen`;
  const controlSource = providerStateSourceFromPool(pool);

  const deps: CatalogueCrawlDeps = {
    providerId: CATALOGUE_CRAWL_PROVIDER_ID,
    egressIdentityLabel: options.egressIdentityLabel,
    readState: (providerId) => readCatalogueCrawlState(db, providerId),
    beginPass: (providerId) => beginCatalogueCrawlPass(db, providerId),
    advanceCursor: (providerId, cursor) => advanceCatalogueCrawlCursor(db, providerId, cursor),
    completePass: (providerId) => completeCatalogueCrawlPass(db, providerId),
    upsertTheatre: (input) => upsertTheatre(db, input),
    // ADR 0022 §6: no separate lane — the crawl reads the provider-wide control state
    // (routeClass '') and obeys only the provider-wide halt/kill-switch.
    readControlState: () =>
      readProviderControlState(redis, controlSource, CATALOGUE_CRAWL_PROVIDER_ID, ""),
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
    parseMarketSlugs,
    parseTheatres,
    buildDirectoryUrl: () => buildTheatresDirectoryUrl().toString(),
    buildMarketUrl: (marketSlug) => buildMarketTheatresUrl(marketSlug).toString(),
    mintId: mintSessionId,
    now: () => new Date(),
  };

  const handle = runCatalogueCrawler(deps, {
    logger,
    ...(options.onTickComplete !== undefined ? { onTickComplete: options.onTickComplete } : {}),
    metrics: options.metrics ?? otel.metrics,
  });

  return {
    pause: () => handle.pause(),
    resume: () => handle.resume(),
    stop: () => handle.stop(),
    async close() {
      handle.stop();
      await redis.quit().catch(() => undefined);
      await pool.end();
      if (ownsSupervisor) {
        await supervisor.shutdown().catch(() => undefined);
      }
      await otel.shutdown().catch(() => undefined);
    },
  };
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
