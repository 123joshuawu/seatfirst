/**
 * ADR 0001 Redis-side fencing protocols. These Lua programs are the Redis equivalent of
 * the named Postgres boundary statements: tests load and execute these exact strings
 * against Redis 7, so the ADR does not own a second, unaudited copy of the logic.
 *
 * The browser-navigation amendment (2026-08-11) removes the CrawlSession cookie protocol
 * entirely: one logical navigation owns one fresh nonpersistent BrowserContext, and no
 * cookie jar, browser profile, or session generation has a Redis write-back path. The
 * semaphore, snapshot-CAS, and empty-bucket-recreation protocols below are what remain.
 */
import * as B from "./boundaries.js";

export interface RedisScript {
  readonly name: string;
  readonly text: string;
}

export type RedisArgument = string | number;

export interface RedisScriptExecutor {
  eval(
    script: RedisScript,
    keys: readonly string[],
    args: readonly RedisArgument[],
  ): Promise<unknown>;
}

export interface RedisHashCache {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, values: Readonly<Record<string, RedisArgument>>): Promise<number>;
}

export interface ProviderStateSource {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: { state: "OPEN" | "PAUSED" | "HALTED" }[] }>;
}

const scripts: RedisScript[] = [];

function define(script: RedisScript): RedisScript {
  scripts.push(script);
  return script;
}

export const SEMAPHORE_ACQUIRE = define({
  name: "SEMAPHORE_ACQUIRE",
  text: `
    -- KEYS[1] holder hash, KEYS[2] generation counter
    -- ARGV[1] holder id, ARGV[2] lease ttl in milliseconds
    if redis.call('EXISTS', KEYS[1]) == 1 then return false end
    local generation = redis.call('INCR', KEYS[2])
    redis.call('HSET', KEYS[1], 'holder', ARGV[1], 'generation', generation)
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return generation`,
});

export const SEMAPHORE_HEARTBEAT = define({
  name: "SEMAPHORE_HEARTBEAT",
  text: `
    -- KEYS[1] holder hash; ARGV[1] holder, ARGV[2] generation, ARGV[3] ttl ms
    local holder = redis.call('HGET', KEYS[1], 'holder')
    local generation = redis.call('HGET', KEYS[1], 'generation')
    if holder ~= ARGV[1] or generation ~= ARGV[2] then return 0 end
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1`,
});

export const SEMAPHORE_RELEASE = define({
  name: "SEMAPHORE_RELEASE",
  text: `
    -- KEYS[1] holder hash; ARGV[1] holder, ARGV[2] generation
    local holder = redis.call('HGET', KEYS[1], 'holder')
    local generation = redis.call('HGET', KEYS[1], 'generation')
    if holder ~= ARGV[1] or generation ~= ARGV[2] then return 0 end
    redis.call('DEL', KEYS[1])
    return 1`,
});

export const SNAPSHOT_CAS = define({
  name: "SNAPSHOT_CAS",
  text: `
    -- KEYS[1] bitmap cache; ARGV[1] accepted revision, ARGV[2] payload
    local current = redis.call('HGET', KEYS[1], 'rev')
    if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
    redis.call('HSET', KEYS[1], 'rev', ARGV[1], 'bitmap', ARGV[2])
    return 1`,
});

export const TOKEN_BUCKET_INIT_EMPTY = define({
  name: "TOKEN_BUCKET_INIT_EMPTY",
  text: `
    -- KEYS[1] token bucket; ARGV[1] current timestamp supplied by the caller
    -- Redis loss recreates pacing state EMPTY, never with a free burst of capacity.
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    redis.call('HSET', KEYS[1], 'tokens', 0, 'updated_at', ARGV[1])
    return 1`,
});

/** Heartbeat loss is wired to the request's actual AbortController in one reusable path. */
export async function heartbeatSemaphoreOrAbort(
  redis: RedisScriptExecutor,
  semaphoreKey: string,
  holderId: string,
  generation: number,
  ttlMs: number,
  request: AbortController,
): Promise<boolean> {
  const heartbeat = await redis.eval(
    SEMAPHORE_HEARTBEAT,
    [semaphoreKey],
    [holderId, generation, ttlMs],
  );
  if (heartbeat === 1) return true;
  request.abort("semaphore fence lost");
  return false;
}

export function providerStateCacheKey(providerId: string, routeClass: string): string {
  return `provider:${providerId}:${routeClass}`;
}

/** Refill a missing fail-closed cache entry from durable Postgres state (the authority). */
export async function refreshProviderState(
  cache: RedisHashCache,
  source: ProviderStateSource,
  providerId: string,
  routeClass: string,
): Promise<"OPEN" | "PAUSED" | "HALTED"> {
  // The read is the named boundary statement `PROVIDER_EFFECTIVE_STATE`, not inline SQL:
  // tier 1 prepares it against the live schema and tier 2 asserts what it derives.
  const result = await source.query(B.PROVIDER_EFFECTIVE_STATE.text, [providerId, routeClass]);
  const state = result.rows[0]?.state;
  if (!state) throw new Error(`provider state read-through returned no row for ${providerId}`);
  await cache.hset(providerStateCacheKey(providerId, routeClass), { state });
  return state;
}

/** Empty or corrupt Redis is a cache miss, never evidence that a provider is open. */
export function providerStateOrHalted(cached: string | null): "OPEN" | "PAUSED" | "HALTED" {
  return cached === "OPEN" || cached === "PAUSED" || cached === "HALTED" ? cached : "HALTED";
}

/**
 * The fail-closed control read the browser actor makes before accepting work and again
 * before semaphore acquisition (ADR 0001 B4, amended): a recognized cached value is the
 * fast pre-check; a MISSING copy is refreshed from Postgres authority; an unrecognized
 * value or an unreadable authority is `HALTED`, never `OPEN`. A stale `OPEN` copy is
 * closed by B4 — the mandatory Postgres transition after capacity acquisition — which
 * every transition keeps ahead of by bumping the provider fence first.
 */
export async function readProviderControlState(
  cache: RedisHashCache,
  source: ProviderStateSource,
  providerId: string,
  routeClass: string,
): Promise<"OPEN" | "PAUSED" | "HALTED"> {
  const cached = await cache.hget(providerStateCacheKey(providerId, routeClass), "state");
  if (cached === "OPEN" || cached === "PAUSED" || cached === "HALTED") return cached;
  if (cached !== null) return "HALTED"; // unrecognized value: fail closed, never refreshed
  try {
    return await refreshProviderState(cache, source, providerId, routeClass);
  } catch {
    return "HALTED"; // unreadable authority: fail closed
  }
}

export const ALL_REDIS_SCRIPTS: readonly RedisScript[] = scripts;
