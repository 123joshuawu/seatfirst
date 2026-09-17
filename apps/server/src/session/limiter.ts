import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import type { RateLimitError } from "@seatfirst/core";
import type { RedisScript, RedisScriptExecutor } from "@seatfirst/durability";

/**
 * The session-keyed sliding-window rate limiter (S16.4/S16.5, ADR 0006 §A.6, ADR 0005
 * §A:148-155).
 *
 * Every bound is injected via `SessionRateLimitConfig` — there is deliberately NO
 * hardcoded number in this module (gate 14, `docs/gates.md`). The values ADR 0006 §A.6
 * fixes (20 searches/hour, 600 weighted fetches/hour, 3 concurrent searches, 10
 * recheck/min — all PROVISIONAL pending the §15 measurement campaign) are what a
 * deployment injects, never what this module assumes.
 *
 * Mechanics (per S16.4): one ZSET per `{dimension}/{sessionId}` pair, key
 * `rl:{dimension}:{sessionId}`, members `{timestampMs}:{random-suffix}:{i}` scored by
 * timestamp. A single atomic Lua script does prune + `ZCARD` for the check and
 * prune + weighted `ZADD` for the charge — one round trip, no check-then-act race
 * inside Redis. A weighted charge writes `weight` members, so `ZCARD` is the weighted
 * budget consumed. The concurrency gauge is deliberately NOT here: it is Postgres
 * (`countOpenSearches`, S16.3) — only the window dimensions live in Redis, which is the
 * reconstructible-on-loss coordination state ADR 0005 §A designates for them.
 *
 * Redis loss must not break the app (S16.16): a failed check/charge is a lost window,
 * and windows re-accumulate — callers (S16.13's route) treat limiter failure as
 * "allowed" so the persistence-disabled Redis outage never takes create down.
 */

export type RateLimitDimension =
  "searches" | "fetches" | "recheck" | "facetCounts" | "resolvePlace" | "suggestPlace";

/** One sliding window: the allowed count and the window it is measured over. */
export interface RateLimitWindow {
  readonly limit: number;
  readonly windowMs: number;
}

export interface SessionRateLimitConfig {
  /** ADR 0006 §A.6: 20/hour. */
  readonly searches: RateLimitWindow;
  /** ADR 0006 §A.6: 600/hour, weighted ("40 fetches for a 40-fetch search"). */
  readonly fetches: RateLimitWindow;
  /** ADR 0006 §A.6: 10/minute. */
  readonly recheck: RateLimitWindow;
  /** S43 (ADR 0036 decision 3): 120/minute for facetCounts — injected, no default. */
  readonly facetCounts: RateLimitWindow;
  /** S43: max candidates per facetCounts request (40) — injected, no default. */
  readonly facetCountMaxCandidates: number;
  /** S51-D5 (ADR 0045 §2a, ADR 0006 §A.6): 10/minute for resolvePlace — injected, no default. */
  readonly resolvePlace: RateLimitWindow;
  /** S51-D8 (ADR 0048, ADR 0006 §A.6): 30/minute for suggestPlace — injected, no default. */
  readonly suggestPlace: RateLimitWindow;
  /**
   * The concurrency ceiling — open (non-terminal) searches per session. Enforced in
   * Postgres by `countOpenSearches` (S16.3), carried here so bootstrap (S16.11) and
   * the route read one config. ADR 0006 §A.6: 3.
   */
  readonly concurrentSearches: number;
  /**
   * S16.9 — the breach-observation windows' duration. An injected parameter with NO
   * default: the window size is one of ADR 0014's deliberately-unset numbers
   * (docs/adr/0014-gate6-accounts-deferral-rate-limit-identity.md:116-123) and is a
   * reported finding, never a silently-chosen default.
   */
  readonly breachWindowMs: number;
}

/** The S16.6 wire discriminator for each window dimension. */
const DIMENSION_LIMIT: Record<RateLimitDimension, RateLimitError["limit"]> = {
  searches: "searches_per_hour",
  fetches: "fetches_per_hour",
  recheck: "recheck_calls_per_minute",
  facetCounts: "facet_counts_per_minute",
  resolvePlace: "resolve_place_per_minute",
  suggestPlace: "suggest_place_per_minute",
};

export interface RateLimitDenial {
  readonly allowed: false;
  readonly limit: RateLimitError["limit"];
  /**
   * Window dimensions derive this from window mechanics (S16.5): the time until the
   * oldest member falls out of the window, `windowMs - (now - oldestMemberTimestamp)`,
   * in whole seconds. `null` only for the Postgres concurrency gauge, whose value no
   * accepted document fixes (S16.5's finding).
   */
  readonly retryAfterSeconds: number | null;
}

export type RateLimitCheck = { readonly allowed: true } | RateLimitDenial;

export interface SessionRateLimiter {
  /**
   * S16.5 — prune-only read against the window. Never mutates budget: a denied check
   * costs nothing and an allowed check does not reserve.
   */
  check(sessionId: string, dimension: RateLimitDimension, weight: number): Promise<RateLimitCheck>;
  /**
   * S16.5 — atomic weighted charge. Callers charge only AFTER the guarded action has
   * durably committed, never before (failed/rolled-back work never burns budget) and
   * never on a replay.
   */
  charge(sessionId: string, dimension: RateLimitDimension, weight: number): Promise<void>;
  /**
   * S16.9 — breach observation: records one breach into the Redis windows keyed
   * `rl:breach:session:{id}`, `rl:breach:ip:{ip}` (when extractable) and
   * `rl:breach:asn:{asn}` (when derivable). Escalation itself is NOT built (S16.9's
   * non-goal); these windows only exist for S18/ADR 0014's later promotion decision.
   */
  recordBreach(keys: {
    sessionId: string;
    clientIp?: string | undefined;
    asn?: string | undefined;
  }): Promise<void>;
}

const WINDOW_PRUNE_COUNT: RedisScript = {
  name: "window_prune_count",
  text: `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
local oldest = 0
if count > 0 then
  local members = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  oldest = tonumber(members[2])
end
return {count, oldest}
`,
};

const WINDOW_CHARGE: RedisScript = {
  name: "window_charge",
  text: `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local seed = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
for i = 1, weight do
  redis.call('ZADD', key, now, now .. ':' .. seed .. ':' .. i)
end
redis.call('PEXPIRE', key, windowMs * 2)
return redis.call('ZCARD', key)
`,
};

/**
 * Adapts an ioredis client to durability's `RedisScriptExecutor` seam (the same shape
 * the shared BullMQ/streaming Redis instance satisfies structurally). The deployment's
 * future entrypoint (not built in S16) wires this; tests wire recording/scripted
 * adapters of their own.
 */
export function redisScriptExecutorFromIoredis(redis: Redis): RedisScriptExecutor {
  return {
    eval: (script, keys, args) => redis.eval(script.text, keys.length, ...keys, ...args),
  };
}

export interface CreateSessionRateLimiterOptions {
  readonly redis: RedisScriptExecutor;
  readonly config: SessionRateLimitConfig;
  /** Injected for tests; defaults to the wall clock (a mechanical, not policy, choice). */
  readonly now?: () => number;
  /** Unique member suffix source; defaults to `randomUUID` (mechanical, not policy). */
  readonly random?: () => string;
}

export function createSessionRateLimiter(
  opts: CreateSessionRateLimiterOptions,
): SessionRateLimiter {
  const { redis, config } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? randomUUID;

  const windowOf = (dimension: RateLimitDimension): RateLimitWindow => {
    switch (dimension) {
      case "searches":
        return config.searches;
      case "fetches":
        return config.fetches;
      case "recheck":
        return config.recheck;
      case "facetCounts":
        return config.facetCounts;
      case "resolvePlace":
        return config.resolvePlace;
      case "suggestPlace":
        return config.suggestPlace;
    }
  };

  const keyOf = (dimension: RateLimitDimension, sessionId: string): string =>
    `rl:${dimension}:${sessionId}`;

  return {
    async check(sessionId, dimension, weight) {
      const window = windowOf(dimension);
      const at = now();
      const result = (await redis.eval(
        WINDOW_PRUNE_COUNT,
        [keyOf(dimension, sessionId)],
        [at, window.windowMs],
      )) as [number, number];
      const count = result[0];
      const oldest = result[1];
      if (count + weight > window.limit) {
        const remainingMs = window.windowMs - (at - oldest);
        return {
          allowed: false,
          limit: DIMENSION_LIMIT[dimension],
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        };
      }
      return { allowed: true };
    },

    async charge(sessionId, dimension, weight) {
      const window = windowOf(dimension);
      await redis.eval(
        WINDOW_CHARGE,
        [keyOf(dimension, sessionId)],
        [now(), window.windowMs, weight, random()],
      );
    },

    async recordBreach(keys) {
      const breaches: Promise<unknown>[] = [
        redis.eval(
          WINDOW_CHARGE,
          [`rl:breach:session:${keys.sessionId}`],
          [now(), config.breachWindowMs, 1, random()],
        ),
      ];
      if (keys.clientIp !== undefined) {
        breaches.push(
          redis.eval(
            WINDOW_CHARGE,
            [`rl:breach:ip:${keys.clientIp}`],
            [now(), config.breachWindowMs, 1, random()],
          ),
        );
      }
      if (keys.asn !== undefined) {
        breaches.push(
          redis.eval(
            WINDOW_CHARGE,
            [`rl:breach:asn:${keys.asn}`],
            [now(), config.breachWindowMs, 1, random()],
          ),
        );
      }
      await Promise.all(breaches);
    },
  };
}
