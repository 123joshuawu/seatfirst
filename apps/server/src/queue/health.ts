import IORedis from "ioredis";
import type { QueueBase, RedisOptions } from "bullmq";

// ioredis is CJS; under the repo's NodeNext + no-esModuleInterop setup the
// default import is the module's exports object, so the class is reached as
// `IORedis.Redis` (constructor, instanceof, and the `Cluster` static).
const Redis = IORedis.Redis;

/** Result of a transport-reachability probe (S7.7). */
export interface RedisHealthResult {
  /** True when PING returned PONG on a ready connection. */
  readonly ok: boolean;
  /** PING round-trip in milliseconds; 0 when no reply was ever received. */
  readonly latencyMs: number;
}

/**
 * What {@link redisHealth} accepts: any BullMQ object that owns a connection
 * (`Queue`, `Worker`, `QueueEvents` — all `QueueBase`s) or a plain ioredis
 * connection.
 */
export type RedisHealthInput = QueueBase | InstanceType<typeof Redis>;
/**
 * Probes Redis through the input's connection and reports reachability plus
 * PING round-trip latency (S7.7). It examines transport reachability only —
 * not queue depth or stalled jobs — and it NEVER throws.
 *
 * BullMQ's own client promise (`queue.client`) only settles once the
 * connection is `ready`, so awaiting it while Redis is down (including down
 * at boot) would hang the probe. Instead this probes the CONFIGURED
 * connection directly: for a borrowed ioredis instance it is status-gated
 * (no command is issued while not `ready`, so nothing can hang), and for a
 * connection-options object it opens a short-lived no-retry probe connection
 * whose `connect()` rejects promptly when Redis is unreachable.
 *
 * ADR 0005 §A runs this shared Valkey/Redis service with persistence
 * disabled; that does not change anything here — reachability and latency
 * are runtime facts, never durability assumptions (S7.3).
 */
export async function redisHealth(input: RedisHealthInput): Promise<RedisHealthResult> {
  try {
    return await probe(input);
  } catch {
    return { ok: false, latencyMs: 0 };
  }
}

async function probe(input: RedisHealthInput): Promise<RedisHealthResult> {
  if (input instanceof Redis) {
    return pingWhenReady(input);
  }

  const connection = input.opts.connection;
  // `connection` is required by BullMQ's option type, but a bare
  // `new Queue(name)` leaves it undefined at runtime: nothing configured is
  // nothing probeable, and this module never invents an address (S7.2).
  if (connection === undefined) {
    return { ok: false, latencyMs: 0 };
  }
  if (connection instanceof Redis) {
    return pingWhenReady(connection);
  }
  if (connection instanceof Redis.Cluster) {
    // ADR 0004 runs one single-node Valkey/Redis service; a cluster topology
    // is outside this deployment shape, so this probe cannot assert it.
    return { ok: false, latencyMs: 0 };
  }
  if ("rootNodes" in connection || "startupNodes" in connection) {
    // ClusterOptions — same out-of-scope posture as the Cluster class above.
    return { ok: false, latencyMs: 0 };
  }
  if ("isCluster" in connection) {
    // BullMQ's internal client adapter. Single-node instances forward
    // `status`/`ping` to the wrapped ioredis client; clusters stay
    // out of scope.
    if (connection.isCluster) {
      return { ok: false, latencyMs: 0 };
    }
    return pingWhenReady(connection as unknown as RedisPingable);
  }
  return probeWithFreshClient(connection);
}

/** Minimal structural surface both ioredis clients and BullMQ's adapter share at runtime. */
interface RedisPingable {
  readonly status: string;
  ping(): Promise<string>;
}

async function pingWhenReady(client: RedisPingable): Promise<RedisHealthResult> {
  if (client.status !== "ready") {
    return { ok: false, latencyMs: 0 };
  }
  const startedAt = process.hrtime.bigint();
  try {
    const reply = await client.ping();
    return {
      ok: reply === "PONG",
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
  }
}

/**
 * Opens a dedicated probe connection over the queue's configured address and
 * closes it again. `lazyConnect` + `retryStrategy: null` +
 * `enableOfflineQueue: false` make `connect()` settle promptly either way —
 * ready on success, rejected on failure — so a down Redis resolves
 * `ok: false` instead of hanging.
 */
async function probeWithFreshClient(options: RedisOptions): Promise<RedisHealthResult> {
  const probeOptions: RedisOptions = {
    ...options,
    lazyConnect: true,
    retryStrategy: null,
    enableOfflineQueue: false,
  };
  const client =
    options.url !== undefined ? new Redis(options.url, probeOptions) : new Redis(probeOptions);
  client.on("error", () => {
    // Probe failures surface through connect()/ping() rejection; a listener
    // keeps ioredis from emitting unhandled-error noise.
  });
  try {
    if (client.status !== "ready") {
      await client.connect();
    }
    return await pingWhenReady(client);
  } catch {
    return { ok: false, latencyMs: 0 };
  } finally {
    client.disconnect();
  }
}
