import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createServer } from "node:net";

/**
 * Redis 7 — the Valkey/Redis target ADR 0004 places in Docker Compose.
 * Persistence is explicitly disabled (`--save ""`, `--appendonly no`),
 * mirroring ADR 0005 §A: BullMQ's job data evaporates on restart and the
 * Postgres outbox is the sole durable truth. The S7 tests assert exactly
 * that behavior, so the fixture must run without RDB/AOF.
 */
const REDIS_IMAGE = "redis:7-alpine";

export interface QueueRedisFixture {
  readonly container: StartedTestContainer;
  /** Mapped redis:// URL for the container. */
  readonly url: string;
}

/**
 * Starts the shared Redis fixture, or returns `null` (and a loud warning)
 * when Docker is unavailable. `QUEUE_REDIS_REQUIRED=1` turns absence into a
 * failure instead of a skip — the same posture as the durability harness's
 * `DURABILITY_REDIS_REQUIRED`.
 */
export async function startQueueRedis(): Promise<QueueRedisFixture | null> {
  try {
    // Docker re-allocates ephemeral host ports on every stop/start, which would
    // change the address under the clients and break the reconnect proof.
    // Production (Docker Compose) fixes the port, so the fixture pins one too.
    const hostPort = await freePort();
    const container = await new GenericContainer(REDIS_IMAGE)
      .withCommand(["redis-server", "--save", "", "--appendonly", "no"])
      .withExposedPorts({ container: 6379, host: hostPort })
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      // The restart test stops and starts the same container; testcontainers
      // removes stopped containers by default, which would break restart().
      .withAutoRemove(false)
      .start();
    return {
      container,
      url: `redis://${container.getHost()}:${hostPort}`,
    };
  } catch (error) {
    if (process.env["QUEUE_REDIS_REQUIRED"] === "1") {
      throw error;
    }
    console.warn(
      "Queue client Redis tests skipped: could not start a Redis container " +
        "(no Docker daemon?). Set QUEUE_REDIS_REQUIRED=1 to fail instead. " +
        `Underlying error: ${String(error)}`,
    );
    return null;
  }
}

/** Binds and releases an ephemeral port, returning a number that is free to use. */
function freePort(): Promise<number> {
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

/**
 * Polls `check` until it returns true or `timeoutMs` elapses. Used for
 * wall-clock conditions that cannot be faked — a real Redis reconnect after
 * a container restart — bounded by a deadline so failures are fast and
 * deterministic rather than flaky sleeps.
 */
export async function until(
  check: () => Promise<boolean>,
  opts: { readonly label: string; readonly timeoutMs?: number; readonly intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${opts.label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
