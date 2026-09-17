import { describe, expect, it } from "vitest";

import { redisConnectionFromEnv } from "../src/queue/index.js";

describe("redisConnectionFromEnv", () => {
  it("maps REDIS_URL to BullMQ's url connection config", () => {
    expect(redisConnectionFromEnv({ REDIS_URL: "redis://valkey.home:6379" })).toEqual({
      url: "redis://valkey.home:6379",
    });
  });

  it("passes a rediss:// URL (TLS, userinfo, db) through verbatim", () => {
    expect(
      redisConnectionFromEnv({
        REDIS_URL: "rediss://queue-user:queue-pass@valkey.home:6380/2",
      }),
    ).toEqual({ url: "rediss://queue-user:queue-pass@valkey.home:6380/2" });
  });

  it("maps REDIS_HOST/REDIS_PORT/REDIS_PASSWORD to host/port/password", () => {
    expect(
      redisConnectionFromEnv({
        REDIS_HOST: "valkey.home",
        REDIS_PORT: "6380",
        REDIS_PASSWORD: "s3cret",
      }),
    ).toEqual({ host: "valkey.home", port: 6380, password: "s3cret" });
  });

  it("maps a host-only config without inventing a port", () => {
    // ioredis applies its own standard-port default; this module authors none.
    expect(redisConnectionFromEnv({ REDIS_HOST: "valkey.home" })).toEqual({
      host: "valkey.home",
    });
  });

  it("rejects a non-redis URL scheme", () => {
    expect(() => redisConnectionFromEnv({ REDIS_URL: "http://valkey.home:6379" })).toThrow(
      /redis:\/\/ or rediss:\/\//,
    );
  });

  it("rejects a malformed REDIS_URL", () => {
    expect(() => redisConnectionFromEnv({ REDIS_URL: "not a url at all" })).toThrow(
      /not a valid URL/,
    );
  });

  it("rejects a non-numeric or out-of-range REDIS_PORT", () => {
    expect(() => redisConnectionFromEnv({ REDIS_HOST: "x", REDIS_PORT: "six" })).toThrow(
      /REDIS_PORT/,
    );
    expect(() => redisConnectionFromEnv({ REDIS_HOST: "x", REDIS_PORT: "0" })).toThrow(
      /REDIS_PORT/,
    );
    expect(() => redisConnectionFromEnv({ REDIS_HOST: "x", REDIS_PORT: "70000" })).toThrow(
      /REDIS_PORT/,
    );
  });

  it("throws instead of defaulting when nothing is configured", () => {
    // S7.2: never default to localhost:6379 in production code.
    expect(() => redisConnectionFromEnv({})).toThrow(/not configured/);
    expect(() => redisConnectionFromEnv({ NODE_ENV: "production" })).toThrow(/not configured/);
  });
});
