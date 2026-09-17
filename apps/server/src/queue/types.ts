import type { Job, JobsOptions, RedisOptions, Worker, WorkerOptions } from "bullmq";
import type { ZodType } from "zod";

/**
 * Connection configuration handed to BullMQ's `Queue`/`Worker`/`QueueEvents`
 * constructors. This is BullMQ's own `RedisOptions` — ioredis options plus the
 * optional `url` key BullMQ understands — so callers pass it straight through:
 *
 * ```ts
 * new Queue("fetch", { connection: redisConnectionFromEnv() });
 * ```
 *
 * The address is always caller/env-supplied (S7.2): this module never writes a
 * default host or port.
 */
export type RedisConnectionConfig = RedisOptions;

/**
 * Handler wired by {@link createWorker}: receives the typed payload and the
 * BullMQ `Job` that carried it. Throwing hands the job to BullMQ's
 * retry/backoff machinery (S7.5).
 */
export type WorkerHandler<T> = (data: T, job: Job<T>) => void | Promise<void>;

/**
 * Disposable returned by {@link createWorker}. `worker` is exposed so callers
 * can attach lifecycle listeners (`error`, `ready`, …) and await readiness;
 * `close()` tears the worker and its connections down.
 */
export interface WorkerHandle {
  readonly worker: Worker;
  close(): Promise<void>;
}

/**
 * Options accepted by {@link createWorker} — BullMQ's `WorkerOptions`
 * verbatim. `concurrency`, `limiter`, and every other tunable are
 * caller-set; this module defaults none of them (S7.8 / gate 14).
 */
export type CreateWorkerOptions = WorkerOptions;

/**
 * Options accepted by {@link publish}: BullMQ's `JobsOptions` with `jobId`
 * removed — the required `jobId` parameter owns the dedup key, so a second
 * jobId inside `opts` is a type error — plus the optional runtime-validation
 * `schema`.
 *
 * `delay`, `priority`, `attempts`, `backoff`, `removeOnComplete`, and
 * `removeOnFail` are all caller-set, never defaulted here (S7.4 / S7.8).
 */
export interface PublishOptions<T> extends Omit<JobsOptions, "jobId"> {
  /**
   * When supplied, `publish` runs `schema.parse(data)` before enqueueing and
   * throws {@link InvalidPayloadError} on failure — the malformed job never
   * reaches Redis. Without a schema, the type parameter is a compile-time
   * guarantee only; TypeScript erasure cannot provide a runtime one (S7,
   * verification item 6).
   */
  schema?: ZodType<T>;
}
