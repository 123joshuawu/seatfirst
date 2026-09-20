/**
 * `ProviderFetchActorDeps` environment reader (S31.7/S31.10). The fetch-worker composes the
 * real RUN handlers via `withProviderFetchActor`, which needs its own pg pool, one ioredis
 * client (backing both the actor's `redis` seam and the session limiter), a fail-closed
 * control-state source over that pool, and the injected policy values. Every value is
 * required and has no hardcoded default (gate 14 / ADR 0006).
 *
 * - `DATABASE_URL`                     — Postgres connection string (actor pool).
 * - `RUN_PG_MAX`                       — actor pool size.
 * - `RUN_PG_IDLE_TIMEOUT_MS`           — actor pool idle timeout.
 * - `RUN_PG_CONNECTION_TIMEOUT_MS`     — actor pool connect timeout.
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — broker address (S7.2).
 * - `AMC_USER_AGENT`                   — deployment-assigned AMC identity (P1).
 * - `AMC_NAVIGATION_TIMEOUT_MS`        — per-navigation bound (P6.18).
 * - `AMC_SEMAPHORE_TTL_MS`             — semaphore lease TTL; MUST equal the crawl's (both
 *   share the `sem:amc` keys — S31.7).
 * - `RUN_HEARTBEAT_INTERVAL_MS`        — B3 + semaphore heartbeat cadence.
 * - `RUN_LEASE_TTL`                    — Postgres interval literal for `B3_HEARTBEAT_RUN`.
 * - `RUN_MAX_ATTEMPTS`                 — attempt budget handed to `failRun`.
 * - `RATE_LIMIT_CONFIG_JSON`           — the same shape the API reads (ADR 0006 §A.6).
 * - `DIAGNOSTIC_CAPTURE_BUCKET_NAME`    — dedicated raw-capture S3 bucket.
 * - `DIAGNOSTIC_AWS_ACCESS_KEY_ID`      — least-privilege capture IAM key.
 * - `DIAGNOSTIC_AWS_SECRET_ACCESS_KEY`  — least-privilege capture IAM secret.
 * - `AWS_REGION`                        — capture bucket region.
 *
 * The pool is a third, actor-owned pool (`startDispatchWorker` opens the dispatch pool from
 * the `DISPATCH_PG_POOL_*` family, and the assembler owns its own from `AGGREGATE_PG_POOL_*`),
 * because `ProviderFetchActorDeps.pool` must be a dedicated pool for `withTransaction`
 * (single-connection brand, S8.18).
 */
import IORedis from "ioredis";
import type { Pool } from "pg";

import type { NavigationLimits } from "@seatfirst/browser-runtime";
import { createPool, diagnosticCaptureStorageConfig } from "@seatfirst/durability";
import type {
  ProviderStateSource,
  RedisHashCache,
  RedisScriptExecutor,
} from "@seatfirst/durability";

import { parseSessionRateLimitConfig } from "../app-config.js";
import { providerStateSourceFromPool } from "../dispatch/handlers/provider-fetch-actor.js";
import { redisConnectionFromEnv } from "../queue/index.js";
import type { RedisConnectionConfig } from "../queue/index.js";
import { createSessionRateLimiter, redisScriptExecutorFromIoredis } from "../session/limiter.js";

/** The non-code dependency set this reader produces; `buildTargetUrl`/`parseObservation`/
 * `supervisor` are composed in the entrypoint (S31.8). */
export interface ProviderFetchActorEnvDeps {
  readonly pool: Pool;
  readonly redis: RedisScriptExecutor & RedisHashCache;
  /** The underlying ioredis client, exposed so the entrypoint can `quit()` it in `close()`. */
  readonly redisClient: IORedis.Redis;
  readonly controlSource: ProviderStateSource;
  readonly userAgent: string;
  readonly navigationLimits: NavigationLimits;
  readonly semaphoreTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly runLeaseTtl: string;
  readonly maxAttempts: number;
  readonly chargeSubscriberFetch: (sessionId: string) => Promise<void>;
}

export function providerFetchActorDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderFetchActorEnvDeps {
  diagnosticCaptureStorageConfig(env);
  const postgres = {
    connectionString: requiredString(env, "DATABASE_URL"),
    max: positiveInteger(env, "RUN_PG_MAX"),
    idleTimeoutMillis: positiveInteger(env, "RUN_PG_IDLE_TIMEOUT_MS"),
    connectionTimeoutMillis: positiveInteger(env, "RUN_PG_CONNECTION_TIMEOUT_MS"),
  };
  const userAgent = requiredString(env, "AMC_USER_AGENT");
  const navigationLimits: NavigationLimits = {
    navigationTimeoutMs: positiveInteger(env, "AMC_NAVIGATION_TIMEOUT_MS"),
  };
  const semaphoreTtlMs = positiveInteger(env, "AMC_SEMAPHORE_TTL_MS");
  const heartbeatIntervalMs = positiveInteger(env, "RUN_HEARTBEAT_INTERVAL_MS");
  const runLeaseTtl = requiredString(env, "RUN_LEASE_TTL");
  const maxAttempts = positiveInteger(env, "RUN_MAX_ATTEMPTS");
  const rateLimitConfig = parseSessionRateLimitConfig(jsonObject(env, "RATE_LIMIT_CONFIG_JSON"));
  const connection = redisConnectionFromEnv(env);

  const pool = createPool(postgres);
  const client = openRedisClient(connection);
  const executor = redisScriptExecutorFromIoredis(client);
  const redis: RedisScriptExecutor & RedisHashCache = {
    eval: (script, keys, args) => executor.eval(script, keys, args),
    hget: (key, field) => client.hget(key, field),
    hset: (key, values) => client.hset(key, values),
  };
  const limiter = createSessionRateLimiter({ redis: executor, config: rateLimitConfig });

  return {
    pool,
    redis,
    redisClient: client,
    controlSource: providerStateSourceFromPool(pool),
    userAgent,
    navigationLimits,
    semaphoreTtlMs,
    heartbeatIntervalMs,
    runLeaseTtl,
    maxAttempts,
    chargeSubscriberFetch: (sessionId) => limiter.charge(sessionId, "fetches", 1),
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

function jsonObject(env: NodeJS.ProcessEnv, name: string): unknown {
  const raw = requiredString(env, name);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON, got ${JSON.stringify(raw)}`);
  }
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
