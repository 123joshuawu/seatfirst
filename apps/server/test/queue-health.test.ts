import type { QueueBase } from "bullmq";
import IORedis from "ioredis";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { redisHealth } from "../src/queue/health.js";

// Every branch below resolves without a live Redis: real ioredis objects are
// always built with `lazyConnect: true` (no socket until `.connect()` or a
// command, and the status gate returns before either), adapter shapes are
// plain fakes, and the one real connection attempt targets a port that was
// just proven closed, so it is refused rather than established.
const openClients: Array<{ disconnect(): void }> = [];

afterEach(() => {
  while (openClients.length > 0) {
    openClients.pop()?.disconnect();
  }
});

function lazyRedis(): IORedis.Redis {
  const client = new IORedis.Redis({ lazyConnect: true });
  client.on("error", () => {});
  openClients.push(client);
  return client;
}

function lazyCluster(): IORedis.Cluster {
  const cluster = new IORedis.Redis.Cluster([{ host: "127.0.0.1", port: 1 }], {
    lazyConnect: true,
  });
  cluster.on("error", () => {});
  openClients.push(cluster);
  return cluster;
}

function queueLike(connection: unknown): QueueBase {
  return { opts: { connection } } as unknown as QueueBase;
}

/** Binds and releases an ephemeral port, returning a number that is guaranteed closed. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
  });
}

describe("redisHealth without a live Redis", () => {
  it("reports down for a lazy direct client without connecting", async () => {
    const client = lazyRedis();
    expect(client.status).not.toBe("ready");
    const startedAt = Date.now();
    await expect(redisHealth(client)).resolves.toEqual({ ok: false, latencyMs: 0 });
    // A status-gated probe issues no command and opens no socket, so this is
    // synchronous-fast; a real connection attempt would take far longer.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("reports down when the queue has no configured connection", async () => {
    await expect(redisHealth(queueLike(undefined))).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });

  it("reports down when the queue wraps a lazy (not-ready) client", async () => {
    await expect(redisHealth(queueLike(lazyRedis()))).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });

  it("reports down for a cluster client without probing it", async () => {
    await expect(redisHealth(queueLike(lazyCluster()))).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });

  it("reports down for a ClusterOptions-shaped connection", async () => {
    await expect(redisHealth(queueLike({ rootNodes: [] }))).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });

  it("reports down for a clustered BullMQ adapter", async () => {
    await expect(redisHealth(queueLike({ isCluster: true }))).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });

  it("reports up when the single-node adapter pongs", async () => {
    const result = await redisHealth(
      queueLike({ isCluster: false, status: "ready", ping: () => Promise.resolve("PONG") }),
    );
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports down when the adapter ping resolves a non-PONG reply", async () => {
    const result = await redisHealth(
      queueLike({ isCluster: false, status: "ready", ping: () => Promise.resolve("OK") }),
    );
    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("reports down instead of rejecting when the adapter ping throws", async () => {
    const result = await redisHealth(
      queueLike({
        isCluster: false,
        status: "ready",
        ping: () => Promise.reject(new Error("boom")),
      }),
    );
    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("reports down for an unreachable options object via a refused probe connection", async () => {
    const port = await closedPort();
    const result = await redisHealth(queueLike({ host: "127.0.0.1", port, retryStrategy: null }));
    expect(result).toEqual({ ok: false, latencyMs: 0 });
  }, 15_000);

  it("never throws for a malformed input that makes probe throw", async () => {
    // `null` is not an instanceof Redis, so probe reads `.opts` of null and
    // throws a TypeError synchronously; redisHealth must convert it to down.
    await expect(redisHealth(null as unknown as QueueBase)).resolves.toEqual({
      ok: false,
      latencyMs: 0,
    });
  });
});
