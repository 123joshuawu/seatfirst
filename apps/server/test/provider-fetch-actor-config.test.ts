import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { providerFetchActorDepsFromEnv } from "../src/fetch-worker/provider-fetch-actor-config.js";
import { startTestRedis, type TestService } from "./support/containers.js";

const RATE_LIMIT_CONFIG_JSON = JSON.stringify({
  searches: { limit: 20, windowMs: 60_000 },
  fetches: { limit: 600, windowMs: 60_000 },
  recheck: { limit: 10, windowMs: 60_000 },
  facetCounts: { limit: 120, windowMs: 60_000 },
  resolvePlace: { limit: 10_000, windowMs: 60_000 },
  suggestPlace: { limit: 30, windowMs: 60_000 },
  facetCountMaxCandidates: 40,
  concurrentSearches: 3,
  breachWindowMs: 60_000,
});

function env(redisUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/postgres",
    REDIS_URL: redisUrl,
    RUN_PG_MAX: "1",
    RUN_PG_IDLE_TIMEOUT_MS: "1",
    RUN_PG_CONNECTION_TIMEOUT_MS: "1",
    AMC_USER_AGENT: "SeatFirst test",
    AMC_NAVIGATION_TIMEOUT_MS: "1",
    AMC_SEMAPHORE_TTL_MS: "1",
    RUN_HEARTBEAT_INTERVAL_MS: "1",
    RUN_LEASE_TTL: "1 minute",
    RUN_MAX_ATTEMPTS: "1",
    RATE_LIMIT_CONFIG_JSON,
  };
}

describe("providerFetchActorDepsFromEnv (S31.7/S31.10)", () => {
  let redisService: TestService;
  let admin: IORedis.Redis;

  beforeAll(async () => {
    redisService = await startTestRedis();
    admin = new IORedis.Redis(redisService.url);
  });

  afterAll(async () => {
    await admin.quit();
    await redisService.stop();
  });

  it("rejects a missing RUN tunable instead of applying a default", () => {
    const missingRunPoolMax = env("redis://127.0.0.1:1");
    delete missingRunPoolMax.RUN_PG_MAX;
    expect(() => providerFetchActorDepsFromEnv(missingRunPoolMax)).toThrow(
      /RUN_PG_MAX is required and has no default/,
    );
  });

  it("charges exactly one fetch-window member for each subscriber", async () => {
    const deps = providerFetchActorDepsFromEnv(env(redisService.url));
    const sessionId = `s31-config-${randomUUID()}`;
    try {
      await deps.chargeSubscriberFetch(sessionId);
      expect(await admin.zcard(`rl:fetches:${sessionId}`)).toBe(1);
    } finally {
      await deps.redisClient.quit();
      await deps.pool.end();
    }
  });
});
