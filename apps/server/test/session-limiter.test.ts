import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";
import type { SessionRateLimitConfig, SessionRateLimiter } from "../src/session/limiter.js";

import { startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";

/**
 * S16 verification item 4 — the sliding-window arithmetic, against REAL Redis 7
 * (testcontainers, or `SERVER_REDIS_URL`): the Lua scripts execute for real; only the
 * clock and member seed are injected, so the `retryAfterSeconds` derivation is
 * deterministic (the spec allows "within clock tolerance"; an injected clock is exact).
 *
 * The windows below ARE ADR 0006 §A.6's figures (20/hr searches, 600/hr weighted
 * fetches, 10/min recheck) — these are unit tests of the engine, so the real numbers
 * are directly exercised. `breachWindowMs` is an injected finding (S16.9): a harness
 * value here, not a policy claim.
 */

const CONFIG: SessionRateLimitConfig = {
  searches: { limit: 20, windowMs: 3_600_000 },
  fetches: { limit: 600, windowMs: 3_600_000 },
  recheck: { limit: 10, windowMs: 60_000 },
  facetCounts: { limit: 10_000, windowMs: 60_000 },
  resolvePlace: { limit: 10, windowMs: 60_000 },
  suggestPlace: { limit: 30, windowMs: 60_000 },
  facetCountMaxCandidates: 40,
  concurrentSearches: 3,
  breachWindowMs: 60_000,
};

const T0 = 1_000_000_000;

describe("session rate limiter (S16.4/S16.5/S16.9)", () => {
  let service: TestService;
  let redis: Redis;

  beforeAll(async () => {
    service = await startTestRedis();
    redis = new Redis(service.url);
  });

  afterAll(async () => {
    await redis.quit();
    await service.stop();
  });

  function makeLimiter(): {
    limiter: SessionRateLimiter;
    clock: () => number;
    advance: (ms: number) => number;
  } {
    let at = T0;
    // Unique per charge — production uses randomUUID; a constant here would make every
    // same-timestamp ZADD overwrite the same members and collapse the window.
    let seed = 0;
    const limiter = createSessionRateLimiter({
      redis: redisScriptExecutorFromIoredis(redis),
      config: CONFIG,
      now: () => at,
      random: () => `seed${seed++}`,
    });
    return {
      limiter,
      clock: () => at,
      advance: (ms) => {
        at += ms;
        return at;
      },
    };
  }

  it("searches: the 20th charge is allowed, the 21st check is denied with the oldest member's remaining window", async () => {
    const { limiter, advance, clock } = makeLimiter();

    for (let i = 0; i < 20; i++) {
      await limiter.charge("sess_window_1", "searches", 1);
    }
    // The 20th charge filled the window exactly; one more weight-1 check overflows.
    advance(60_000);
    const denied = await limiter.check("sess_window_1", "searches", 1);

    expect(denied).toEqual({
      allowed: false,
      limit: "searches_per_hour",
      // Oldest member is the first charge at T0; windowMs − (now − oldest):
      // 3_600_000 − 60_000 = 3_540_000 ms → 3540 whole seconds.
      retryAfterSeconds: 3540,
    });
    expect(clock()).toBe(T0 + 60_000);
  });

  it("searches: after the window elapses the charge is allowed again", async () => {
    const { limiter, advance } = makeLimiter();

    for (let i = 0; i < 20; i++) {
      await limiter.charge("sess_window_2", "searches", 1);
    }
    // Cross the full window boundary: every member is pruned by the charge's script.
    advance(3_600_001);
    await limiter.charge("sess_window_2", "searches", 1);

    expect(await redis.zcard("rl:searches:sess_window_2")).toBe(1);
    await expect(limiter.check("sess_window_2", "searches", 1)).resolves.toEqual({
      allowed: true,
    });
  });

  it("fetches: a weight-40 charge consumes 40 members of the window", async () => {
    const { limiter } = makeLimiter();

    await limiter.charge("sess_window_3", "fetches", 40);

    expect(await redis.zcard("rl:fetches:sess_window_3")).toBe(40);
  });

  it("charge refreshes the window key TTL to two windows (I15.4)", async () => {
    const { limiter } = makeLimiter();

    await limiter.charge("sess_ttl_1", "searches", 1);

    // WINDOW_CHARGE PEXPIREs the key to 2 * windowMs on every charge, so idle
    // windows evaporate. Without it pttl reads back -1; a wrong multiplier
    // would read back above two windows.
    const pttl = await redis.pttl("rl:searches:sess_ttl_1");
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(2 * 3_600_000);
  });

  it("fetches: weight accumulates against the 600 budget and denies beyond it", async () => {
    const { limiter } = makeLimiter();

    for (let i = 0; i < 15; i++) {
      await limiter.charge("sess_window_4", "fetches", 40);
    }
    expect(await redis.zcard("rl:fetches:sess_window_4")).toBe(600);

    // A check is advisory — any weight that would overflow the 600 budget denies.
    await expect(limiter.check("sess_window_4", "fetches", 1)).resolves.toMatchObject({
      allowed: false,
      limit: "fetches_per_hour",
    });
    await expect(limiter.check("sess_window_4", "fetches", 40)).resolves.toMatchObject({
      allowed: false,
      limit: "fetches_per_hour",
    });
  });

  it("recheck: allows 10 per minute and rejects the 11th with the derived retry", async () => {
    const { limiter, advance } = makeLimiter();

    for (let i = 0; i < 10; i++) {
      await limiter.charge("sess_window_5", "recheck", 1);
    }
    advance(30_000);
    const denied = await limiter.check("sess_window_5", "recheck", 1);

    expect(denied).toEqual({
      allowed: false,
      limit: "recheck_calls_per_minute",
      retryAfterSeconds: 30, // 60_000 − 30_000 = 30_000 ms → 30 s
    });

    // A minute later every member has expired: allowed again.
    advance(30_001);
    await expect(limiter.check("sess_window_5", "recheck", 1)).resolves.toEqual({
      allowed: true,
    });
  });

  it("an empty window check is allowed and never mutates the key", async () => {
    const { limiter } = makeLimiter();

    await expect(limiter.check("sess_window_6", "searches", 1)).resolves.toEqual({
      allowed: true,
    });
    expect(await redis.exists("rl:searches:sess_window_6")).toBe(0);
  });

  it("recordBreach writes the session, ip, and asn observation windows (and only the keys it has)", async () => {
    const { limiter } = makeLimiter();

    await limiter.recordBreach({
      sessionId: "sess_breach_1",
      clientIp: "203.0.113.7",
      asn: "64500",
    });
    expect(await redis.zcard("rl:breach:session:sess_breach_1")).toBe(1);
    expect(await redis.zcard("rl:breach:ip:203.0.113.7")).toBe(1);
    expect(await redis.zcard("rl:breach:asn:64500")).toBe(1);

    // Without an extractable IP or ASN only the session window is touched.
    const bare = makeLimiter();
    await bare.limiter.recordBreach({ sessionId: "sess_breach_2" });
    expect(await redis.zcard("rl:breach:session:sess_breach_2")).toBe(1);
    expect(await redis.exists("rl:breach:ip:sess_breach_2")).toBe(0);
  });
});
