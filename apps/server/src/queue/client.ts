import { UnrecoverableError, Worker, type Job, type Queue } from "bullmq";
import { z } from "zod";

import type {
  CreateWorkerOptions,
  PublishOptions,
  RedisConnectionConfig,
  WorkerHandle,
  WorkerHandler,
} from "./types.js";

/**
 * Thrown by {@link publish} when a caller-supplied `schema` rejects the
 * payload. Carries the Zod issues so callers (S9's relay) can log the exact
 * mismatch. The job is never enqueued when this is thrown.
 */
export class InvalidPayloadError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[], message: string) {
    super(message);
    this.name = "InvalidPayloadError";
    this.issues = issues;
  }
}

/**
 * Builds the Redis connection config from the environment (S7.2).
 *
 * `REDIS_URL` (a `redis://` or `rediss://` URL) wins when present; otherwise
 * `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` are read. A host with no
 * port is passed through without one — ioredis applies its own standard-port
 * default, not this module. When nothing is configured this throws: there is
 * deliberately no `localhost:6379` fallback here, because ADR 0004's Docker
 * Compose service is the only sanctioned address and it is operator-supplied.
 *
 * The returned object is handed to BullMQ's own constructors
 * (`Queue(queueName, { connection })`, `Worker(queueName, handler,
 * { connection })`) — the connection shape is BullMQ's contract, not ours.
 */
export function redisConnectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RedisConnectionConfig {
  const url = env["REDIS_URL"];
  if (url !== undefined) {
    assertRedisUrl(url);
    return { url };
  }

  const host = env["REDIS_HOST"];
  const port = env["REDIS_PORT"];
  const password = env["REDIS_PASSWORD"];
  if (host === undefined && port === undefined && password === undefined) {
    throw new Error(
      "Redis connection is not configured: set REDIS_URL (redis://… or rediss://…) " +
        "or REDIS_HOST/REDIS_PORT/REDIS_PASSWORD. No default address exists — " +
        "ADR 0004's Docker Compose supplies the Valkey/Redis endpoint.",
    );
  }

  const config: RedisConnectionConfig = {};
  if (host !== undefined) {
    config.host = host;
  }
  if (port !== undefined) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`REDIS_PORT must be an integer in 1..65535, got "${port}"`);
    }
    config.port = parsedPort;
  }
  if (password !== undefined) {
    config.password = password;
  }
  return config;
}

function assertRedisUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(
      `REDIS_URL must use the redis:// or rediss:// scheme, got "${parsed.protocol}"`,
    );
  }
}

/**
 * Publishes a typed job (S7.4).
 *
 * `jobId` is required: BullMQ keys idempotency/dedup on it
 * (`docs/seatfirst-architecture.md:181` — the outbox publishes with `jobId`
 * as the message dedup key), so a second publish with the same id is a no-op,
 * not a duplicate. `opts` are BullMQ `JobsOptions` minus `jobId`; `attempts`,
 * `backoff`, `delay`, `priority`, and `removeOnComplete`/`removeOnFail` are
 * caller-set, never defaulted (S7.8 / gate 14).
 *
 * When `opts.schema` is supplied the payload is validated with
 * `schema.parse` BEFORE enqueueing; a failing payload throws
 * {@link InvalidPayloadError} and never reaches Redis.
 */
export async function publish<T>(
  queue: Queue<T>,
  name: string,
  jobId: string,
  data: T,
  opts?: PublishOptions<T>,
): Promise<Job<T>> {
  const { schema, ...jobOptions } = opts ?? {};
  if (schema !== undefined) {
    try {
      schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new InvalidPayloadError(
          error.issues,
          `Payload for job "${jobId}" (${queue.name}:${name}) failed schema validation: ${z.prettifyError(error)}`,
        );
      }
      throw error;
    }
  }
  // BullMQ 5.8x derives `Queue<T>`'s payload type through conditional types
  // (`ExtractDataType<T, T>`) that cannot reduce inside a generic function;
  // at every concrete call site they resolve to `T`, so these casts are
  // exact — caller-side checking is unaffected.
  const job = await queue.add(name as never, data as never, {
    ...jobOptions,
    jobId,
  });
  return job as unknown as Job<T>;
}

/**
 * Removes a terminal (`completed`/`failed`) BullMQ record for a durable target id so a
 * later hint for newer durable state is not swallowed by custom-`jobId` dedup. Live
 * states stay in place because first-delivery dedup is correct while work is pending.
 */
export async function removeTerminalBrokerRecord<T>(queue: Queue<T>, jobId: string): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (existing === undefined) {
    return;
  }
  const state = await existing.getState();
  if (state !== "completed" && state !== "failed") {
    return;
  }
  await existing.remove();
}

/**
 * Constructs a BullMQ `Worker` scoped to one job `name` and returns a
 * disposable (S7.5).
 *
 * The harness is thin: it wires one handler and does not route by job type
 * (S11's registry does that composition). `opts` — `concurrency`, `limiter`,
 * `connection`, … — are caller-set, never defaulted. The handler receives the
 * typed payload and the BullMQ `Job`; throwing hands the job to BullMQ's
 * retry/backoff. A job whose name does not match this worker's scope is
 * failed without retry via BullMQ's `UnrecoverableError`: it was routed to
 * the wrong consumer, and retrying cannot fix that.
 */
export function createWorker<T>(
  queue: Queue<T>,
  name: string,
  handler: WorkerHandler<T>,
  opts?: CreateWorkerOptions,
): WorkerHandle {
  const worker = new Worker<T, void>(
    queue.name,
    async (job) => {
      if (job.name !== name) {
        throw new UnrecoverableError(
          `Worker for "${name}" on queue "${queue.name}" cannot process job "${job.name}" (${job.id})`,
        );
      }
      await handler(job.data, job);
    },
    { connection: queue.opts.connection, ...opts },
  );
  return {
    worker,
    close: () => worker.close(),
  };
}

/**
 * Moves one failed job back to the wait list via BullMQ's own `Job.retry()`
 * (S7.6). Returns the job, or `undefined` when no job with that id exists;
 * a job that is not failed is left alone. Callers decide when to invoke
 * redrive (manual or scheduled) — this module wires no cron, UI, or alarm.
 */
export async function redriveFailed<T>(
  queue: Queue<T>,
  jobId: string,
): Promise<Job<T> | undefined> {
  const job = await queue.getJob(jobId);
  if (job === undefined) {
    return undefined;
  }
  const state = await job.getState();
  if (state === "failed") {
    await job.retry();
  }
  // Same conditional-generic reduction as `publish`: exact at concrete call sites.
  return job;
}

/**
 * Retries every job currently in the failed set via `Job.retry()`, optionally
 * filtered to one job `name` (S7.6). Returns how many jobs were redriven so
 * callers can assert a non-zero effect.
 */
export async function redriveAllFailed<T>(queue: Queue<T>, name?: string): Promise<number> {
  const failed = await queue.getFailed();
  const jobs = name === undefined ? failed : failed.filter((job) => job.name === name);
  await Promise.all(jobs.map((job) => job.retry()));
  return jobs.length;
}
