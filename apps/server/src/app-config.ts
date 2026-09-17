import IORedis from "ioredis";

import { createLogger, logLevelFromEnv } from "@seatfirst/config/logger";
import type { LogLevel } from "@seatfirst/config/logger";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel } from "@seatfirst/config/otel";
import { installCrashHandlers } from "./crash-handlers.js";
import {
  inboundRequestLogSerializer,
  InboundSpanAttributeFilter,
} from "@seatfirst/config/redaction";
import { ResultContractConfigSchema, SearchLimitsSchema } from "@seatfirst/core";
import type { ResultContractConfig, SearchLimits } from "@seatfirst/core";
import { createPool } from "@seatfirst/durability";
import type { PoolOptions } from "@seatfirst/durability";

import { buildApp } from "./app.js";
import { redisConnectionFromEnv } from "./queue/index.js";
import type { RedisConnectionConfig } from "./queue/index.js";
import { createRecoverySeam } from "./routes/showtimes/recovery-seam.js";
import { mintSessionId } from "./routes/session/bootstrap.js";
import type { SessionCookiePolicy } from "./session/cookie.js";
import { loadAsnLookup, noopAsnLookup } from "./session/extract.js";
import { createSessionRateLimiter, redisScriptExecutorFromIoredis } from "./session/limiter.js";
import type { RateLimitWindow, SessionRateLimitConfig } from "./session/limiter.js";

/**
 * The `api` role's environment reader and process assembly (S28.2). `buildApp` deliberately
 * does not read env or listen (`apps/server/src/app.ts:41-42`); this module is that deferred
 * "listen loop, entrypoint, signal handling, and env→config wiring".
 *
 * Every tunable is REQUIRED with no hardcoded default (gate 14 / ADR 0006), following
 * `relayConfigFromEnv`'s discipline (`apps/server/src/relay/entrypoint.ts:14-29`):
 *
 * - `DATABASE_URL`            — Postgres connection string.
 * - `APP_PG_POOL_MAX`         — pg pool size (durability's `createPool`).
 * - `APP_PG_POOL_IDLE_TIMEOUT_MS` — pg pool idle timeout.
 * - `APP_PG_CONNECT_TIMEOUT_MS`   — pg pool connect timeout.
 * - `API_PORT`                — Fastify listen port (S28.2).
 * - `REDIS_URL`, or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` — the shared broker, read by
 *   S7's `redisConnectionFromEnv`; the same connection serves both the session limiter and
 *   S12's streaming Redis (never a second address).
 * - `NONCE_SECRET`            — S22.9 recheck-nonce HMAC secret (ADR 0017).
 * - `RELAY_PEER_CIDR`         — S16.7 the relay's specific tailnet peer CIDR.
 * - `CORS_ALLOWED_ORIGINS`    — Browser CORS allowlist, comma-separated exact origins
 *   (e.g. `http://localhost:8081`). No default; exact-match, credentials required for
 *   cookie transport (`apps/mobile-web/src/lib/cookieJar.ts:173`). See also ADR search —
 *   no existing ADR settles CORS; production is same-origin via reverse proxy, so this is
 *   primarily a dev tunable whose production value must be the deployed web origin.
 * - `FRESHNESS_MS`            — ADR 0006 §A.1 freshness ceiling (S15.4).
 * - `LOG_LEVEL`               — O4.8/O5.10 one of trace|debug|info|warn|error|fatal.
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTel Collector endpoint; optional by contract (O4.5):
 *   when unset, `buildOtelFromEnv` returns a no-op setup and the API runs with no exporter.
 *   Read here so `startApp` builds OTel exactly once (O5.4).
 * **Structured-config convention (S28 finding): JSON-in-env.** `BuildAppOptions` carries four
 * object/record-valued options that do not map onto a single scalar env var. Each is read from
 * a dedicated JSON-string env var, parsed with `JSON.parse`, and shape-validated here — fail
 * loudly on malformed JSON (never silently skipped, never baked into the repo):
 *
 * - `SEARCH_LIMITS_JSON`           → `SearchLimitsSchema` (`@seatfirst/core`).
 * - `PROVIDER_HOST_ALLOWLISTS_JSON` → `ResultContractConfigSchema` (`@seatfirst/core`).
 * - `RATE_LIMIT_CONFIG_JSON`       → manual shape check (no Zod schema exists).
 * - `SESSION_COOKIE_POLICY_JSON`   → manual shape check (no Zod schema exists).
 *
 * JSON-in-env is chosen over a mounted config file because it keeps every variable inside ADR
 * 0046's audited `.env.example` / `.env.secrets.example` template pair and needs no new
 * mounted-file infrastructure.
 *
 * **Recovery wiring (S32.10/S32.11):** `recheckRecoveryRowWeight` is the level-1 `W`
 * (`docs/seatfirst-architecture.md:395`), injected with no default (gate 14); ADR 0024's
 * 2026-08-17 amendment pins the production value to 2. `startApp` builds the level-1
 * recovery seam (`createRecoverySeam`, `apps/server/src/routes/showtimes/recovery-seam.ts`)
 * from that value and `providerHostAllowlists`, and passes it to `buildApp` as
 * `recheckRecovery` — replacing S22.12's `UNLANDED_RECHECK_RECOVERY` loud-fail placeholder.
 */

export interface AppEnvConfig {
  readonly postgres: PoolOptions;
  readonly connection: RedisConnectionConfig;
  readonly port: number;
  readonly searchLimits: SearchLimits;
  readonly freshnessMs: number;
  readonly retryAfterSeconds: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly cookieSecret: string;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly relayPeerCidr: string;
  /** ADR 0095 — ASN database path, optional (MaxMind GeoLite2-ASN deferred for the initial production deployment); when unset, `startApp` uses `noopAsnLookup`. */
  readonly asnDatabasePath: string | undefined;
  readonly streamBlockTimeoutMs: number;
  readonly providerHostAllowlists: ResultContractConfig["providerHostAllowlists"];
  readonly nonceSecret: string;
  readonly recheckDeadlineMs: number;
  readonly recheckRecoveryRowWeight: number;
  /** Exact-match CORS allowlist from `CORS_ALLOWED_ORIGINS` (comma-separated). */
  readonly corsAllowedOrigins: readonly string[];
  /** O4.8/O5.10 — the process-wide log level, required (one of the six). */
  readonly logLevel: LogLevel;
  /** S51-D5 — Mapbox Geocoding access token, requiredString, no default (gate 14, ADR 0019 decision 4). */
  readonly mapboxAccessToken: string;
  /** O5.4 — the built OTel setup (tracer/meter/logger/metrics), built exactly once. */
  readonly otel: ConfiguredOtel;
}

export interface AppHandle {
  /** Closes the Fastify listener, the pg pool, and the session-limiter Redis client. */
  close(): Promise<void>;
}

export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppEnvConfig {
  return {
    postgres: {
      connectionString: requiredString(env, "DATABASE_URL"),
      max: positiveInteger(env, "APP_PG_POOL_MAX"),
      idleTimeoutMillis: positiveInteger(env, "APP_PG_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: positiveInteger(env, "APP_PG_CONNECT_TIMEOUT_MS"),
    },
    connection: redisConnectionFromEnv(env),
    port: port(env, "API_PORT"),
    searchLimits: SearchLimitsSchema.parse(jsonObject(env, "SEARCH_LIMITS_JSON")),
    freshnessMs: positiveInteger(env, "FRESHNESS_MS"),
    retryAfterSeconds: positiveInteger(env, "RETRY_AFTER_SECONDS"),
    rateLimitConfig: parseSessionRateLimitConfig(jsonObject(env, "RATE_LIMIT_CONFIG_JSON")),
    cookieSecret: requiredString(env, "COOKIE_SECRET"),
    cookiePolicy: parseSessionCookiePolicy(jsonObject(env, "SESSION_COOKIE_POLICY_JSON")),
    relayPeerCidr: requiredString(env, "RELAY_PEER_CIDR"),
    asnDatabasePath: optionalString(env, "ASN_DATABASE_PATH"),
    streamBlockTimeoutMs: positiveInteger(env, "STREAM_BLOCK_TIMEOUT_MS"),
    providerHostAllowlists: ResultContractConfigSchema.parse({
      providerHostAllowlists: jsonObject(env, "PROVIDER_HOST_ALLOWLISTS_JSON"),
    }).providerHostAllowlists,
    nonceSecret: requiredString(env, "NONCE_SECRET"),
    recheckDeadlineMs: positiveInteger(env, "RECHECK_DEADLINE_MS"),
    recheckRecoveryRowWeight: positiveInteger(env, "RECHECK_RECOVERY_ROW_WEIGHT"),
    corsAllowedOrigins: parseCorsAllowedOrigins(env),
    logLevel: logLevelFromEnv(env),
    mapboxAccessToken: requiredString(env, "MAPBOX_ACCESS_TOKEN"),
    otel: buildOtelFromEnv(
      env,
      { serviceName: "seatfirst-api", component: "app" },
      // O5.4 / ADR 0005 §A:189-192 — the inbound-attribute filter goes FIRST so it
      // strips client.address/network.peer.*/x-forwarded-for before the batch export
      // processor `buildOtelFromEnv` appends after it.
      { spanProcessors: [new InboundSpanAttributeFilter()] },
    ),
  };
}

/**
 * Assembles and starts the API process: loads the ASN lookup, builds the session limiter over
 * the shared Redis instance, calls `buildApp`, and binds the listener. `close()` releases every
 * resource this module opened. Signal handling is the dispatcher's (S28.4) — this returns the
 * handle it normalizes.
 */
export async function startApp(config: AppEnvConfig): Promise<AppHandle> {
  const db = createPool(config.postgres);
  const recheckRecovery = createRecoverySeam({
    db,
    rowWeight: config.recheckRecoveryRowWeight,
    providerHostAllowlists: config.providerHostAllowlists,
  });
  const redis = openRedisClient(config.connection);
  const asnLookup =
    config.asnDatabasePath === undefined
      ? noopAsnLookup
      : await loadAsnLookup(config.asnDatabasePath);
  const limiter = createSessionRateLimiter({
    redis: redisScriptExecutorFromIoredis(redis),
    config: config.rateLimitConfig,
  });
  // O5.1/O5.4 — ONE logger, built via O4's `createLogger`: a real pino logger (so it is
  // Fastify-compatible) carrying the inbound req/res allowlist serializers (ADR 0005
  // §A:168-195) and the OTel log bridge. There is no second raw-pino construction path —
  // request logs AND process lifecycle lines (the listen line below) flow through this
  // same instance, and every line it emits (including Fastify's internal request logs and
  // `request.log.child(...)` descendants) is mirrored into OTel logs.
  const logger = createLogger({
    service: "seatfirst-api",
    component: "app",
    level: config.logLevel,
    otelLogger: config.otel.logger,
    serializers: { req: inboundRequestLogSerializer, res: inboundRequestLogSerializer },
  });
  installCrashHandlers({ logger, otel: config.otel, exit: (code) => process.exit(code) });
  const fastify = buildApp({
    db,
    searchLimits: config.searchLimits,
    freshnessMs: config.freshnessMs,
    retryAfterSeconds: config.retryAfterSeconds,
    rateLimitConfig: config.rateLimitConfig,
    limiter,
    cookieSecret: config.cookieSecret,
    cookiePolicy: config.cookiePolicy,
    relayPeerCidr: config.relayPeerCidr,
    asnLookup,
    streamRedisUrl: redisUrlFromConnection(config.connection),
    streamBlockTimeoutMs: config.streamBlockTimeoutMs,
    providerHostAllowlists: config.providerHostAllowlists,
    nonceSecret: config.nonceSecret,
    recheckDeadlineMs: config.recheckDeadlineMs,
    recheckRecovery,
    mapboxAccessToken: config.mapboxAccessToken,
    corsAllowedOrigins: config.corsAllowedOrigins,
    logger,
    mintId: mintSessionId,
    metrics: config.otel.metrics,
    tracer: config.otel.tracer,
    readinessCheck: async () => (await redis.ping()) === "PONG",
  });

  try {
    // 0.0.0.0 (all container interfaces), not 127.0.0.1: the API is the front door reached
    // from the bridge network; binding loopback would make it unreachable from the relay.
    await fastify.listen({ host: "0.0.0.0", port: config.port });
    // O5.4 — the same createLogger instance carries the lifecycle line; request logs
    // flow through its Fastify-owned children (O5.1/O5.3).
    logger.info({ port: config.port, origin: fastify.listeningOrigin }, "api listening");
  } catch (error) {
    await fastify.close();
    await db.end();
    redis.disconnect();
    throw error;
  }

  return {
    async close() {
      await fastify.close();
      await db.end();
      // disconnect() (not quit()) — an in-flight command would make quit() wait forever.
      redis.disconnect();
    },
  };
}

/** Derives the streaming URL from the same config the limiter uses (S7's two connection forms). */
function redisUrlFromConnection(connection: RedisConnectionConfig): string {
  if (connection.url !== undefined) {
    return connection.url;
  }
  if (connection.host === undefined) {
    throw new Error(
      "Redis stream URL cannot be derived without REDIS_URL or REDIS_HOST; " +
        "set REDIS_URL (redis://… or rediss://…) for the shared instance.",
    );
  }
  const credentials =
    connection.password === undefined ? "" : `:${encodeURIComponent(connection.password)}@`;
  // Omitted port → ioredis applies its own standard-port default, matching
  // `redisConnectionFromEnv`'s host-with-no-port passthrough.
  const port = connection.port === undefined ? "" : `:${connection.port}`;
  return `redis://${credentials}${connection.host}${port}`;
}

/** Opens the limiter's ioredis client from S7's connection config (mirrors the sweeper). */
function openRedisClient(connection: RedisConnectionConfig): IORedis.Redis {
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

export function parseSessionRateLimitConfig(value: unknown): SessionRateLimitConfig {
  const obj = asRecord(value, "RATE_LIMIT_CONFIG_JSON");
  return {
    searches: parseWindow(obj["searches"], "RATE_LIMIT_CONFIG_JSON.searches"),
    fetches: parseWindow(obj["fetches"], "RATE_LIMIT_CONFIG_JSON.fetches"),
    recheck: parseWindow(obj["recheck"], "RATE_LIMIT_CONFIG_JSON.recheck"),
    facetCounts: parseWindow(obj["facetCounts"], "RATE_LIMIT_CONFIG_JSON.facetCounts"),
    facetCountMaxCandidates: positiveField(
      obj,
      "facetCountMaxCandidates",
      "RATE_LIMIT_CONFIG_JSON",
    ),
    resolvePlace: parseWindow(obj["resolvePlace"], "RATE_LIMIT_CONFIG_JSON.resolvePlace"),
    suggestPlace: parseWindow(obj["suggestPlace"], "RATE_LIMIT_CONFIG_JSON.suggestPlace"),
    concurrentSearches: positiveField(obj, "concurrentSearches", "RATE_LIMIT_CONFIG_JSON"),
    breachWindowMs: positiveField(obj, "breachWindowMs", "RATE_LIMIT_CONFIG_JSON"),
  };
}

function parseWindow(value: unknown, path: string): RateLimitWindow {
  const obj = asRecord(value, path);
  return {
    limit: positiveField(obj, "limit", path),
    windowMs: positiveField(obj, "windowMs", path),
  };
}

function parseSessionCookiePolicy(value: unknown): SessionCookiePolicy {
  const obj = asRecord(value, "SESSION_COOKIE_POLICY_JSON");
  const sameSite = obj["sameSite"];
  if (sameSite !== "Lax" && sameSite !== "Strict") {
    throw new Error(
      `SESSION_COOKIE_POLICY_JSON.sameSite must be "Lax" or "Strict", got ${JSON.stringify(sameSite)}`,
    );
  }
  return {
    sameSite,
    maxAgeSeconds: positiveField(obj, "maxAgeSeconds", "SESSION_COOKIE_POLICY_JSON"),
  };
}

function jsonObject(env: NodeJS.ProcessEnv, name: string): unknown {
  const raw = requiredString(env, name);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON, got ${JSON.stringify(raw)}`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function positiveField(obj: Record<string, unknown>, field: string, path: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path}.${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default (gate 14)`);
  }
  return value;
}

function optionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
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

function parseCorsAllowedOrigins(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = requiredString(env, "CORS_ALLOWED_ORIGINS");
  // Comma-separated list (simple scalar, not JSON) — chosen over JSON to avoid quoting
  // pain in .env files. Matches the simple-scalar convention for CORS_ALLOWED_ORIGINS
  // vs the four *_JSON structured-config vars which need JSON because they carry objects.
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (origins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must contain at least one origin, got empty list");
  }
  for (const origin of origins) {
    // Exact-match allowlist: must be a valid origin (scheme + host + optional port), no path/query/fragment, no wildcard.
    if (origin.includes("*") || origin.endsWith("/")) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS entry must be an exact origin without trailing slash or wildcard, got ${JSON.stringify(origin)}`,
      );
    }
    try {
      const url = new URL(origin);
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error("path/query/fragment not allowed");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("must be http: or https:");
      }
    } catch (cause) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS entry must be a valid origin (e.g. http://localhost:8081), got ${JSON.stringify(origin)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  return origins;
}
