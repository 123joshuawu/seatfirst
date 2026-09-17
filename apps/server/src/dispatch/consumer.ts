/**
 * The dispatch consumer harness (S11.1–S11.6, S11.10): three BullMQ workers — `job-queue`,
 * `run-queue`, and the AGGREGATE-hint channel (S9.2/S10.8) — routed to a typed handler
 * registry (`./types.ts`, `./handlers.ts`). Leasing/claiming (B2/B7) happens ONLY after a
 * concrete handler is confirmed registered (S11.3/S11.4): the durable row is never touched
 * for a not-yet-implemented kind. `B4_PREDISPATCH` is deliberately absent from this module
 * — it is the RUN handler's own responsibility (S11.5), run after provider-capacity
 * acquisition, not part of the generic harness.
 */
import { B2_LEASE_JOB, B2_LEASE_RUN, B7_CLAIM, runStatement } from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";

import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";

import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { SeatfirstMetrics } from "@seatfirst/config/otel";
import type { Queue } from "bullmq";

import { createWorker } from "../queue/index.js";
import type { CreateWorkerOptions } from "../queue/index.js";
import type { RelayMessage } from "../relay/publisher.js";
import { AGGREGATE_HINT_JOB_NAME } from "../sweeper/index.js";
import type { AggregateHintMessage } from "../sweeper/index.js";

import { findJobContext, findRunContext, findSearchById } from "./queries.js";
import { isTerminalJobOrRunState, isTerminalSearchStatus } from "./queries.js";
import type { DispatchRegistry } from "./types.js";

export interface DispatchDeps {
  readonly db: SqlClient;
  readonly registry: DispatchRegistry;
  /** Required since O6: the consumer never falls back to console logging. Production
   * wires the entrypoint's default logger; tests inject a capturing double. */
  readonly logger: SeatfirstLogger;
  /** O6.6 — handler duration/completion instruments; absent = nothing recorded. */
  readonly metrics?: SeatfirstMetrics;
}

/**
 * O6.6 — records one handler execution on the dispatch instruments: duration histogram
 * plus the completed counter tagged with the ok|error outcome dimension.
 */
function recordDispatchMetrics(
  metrics: SeatfirstMetrics | undefined,
  attrs: Record<string, string>,
  durationMs: number,
  outcome: "ok" | "error",
): void {
  if (metrics === undefined) {
    return;
  }
  metrics.dispatchHandlerDuration.record(durationMs, attrs);
  metrics.dispatchHandlerCompleted.add(1, { ...attrs, outcome });
}

export interface DispatchTunables {
  /** Postgres interval literal (e.g. `"30 seconds"`), injected — no default (gate 14). */
  readonly leaseTtl: string;
}

/**
 * O7.7 — the context a relay message's handler must run inside (ADR 0031). A message
 * carrying a W3C `traceparent` gets the originating request's remote span context
 * reconstructed via propagation.extract; a message without one (re-armed/reclaimed rows
 * have none by design) gets ROOT_CONTEXT explicitly — the handler then opens spans on a
 * fresh root trace and can never inherit a stale ambient caller span, so "null" truly
 * means fresh-root rather than "whatever happens to be active".
 */
function handlerContext(message: RelayMessage): Context {
  if (message.traceparent === null) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, { traceparent: message.traceparent });
}

/** Dispatches one `job-queue` message (S11.1, verification items 1, 2, 4, 5, 7). */
export async function dispatchJobMessage(
  deps: DispatchDeps,
  tunables: DispatchTunables,
  message: RelayMessage,
): Promise<void> {
  const { logger } = deps;
  const found = await findJobContext(deps.db, message.targetId);
  if (found === null) {
    logger.warn({ target_id: message.targetId }, "dispatch: JOB not found — ack without dispatch");
    return;
  }
  if (isTerminalJobOrRunState(found.job.state)) {
    logger.warn(
      { target_id: message.targetId, state: found.job.state },
      "dispatch: JOB already terminal — ack without dispatch",
    );
    return;
  }
  const entry = deps.registry.job[found.job.kind];
  if (!entry.implemented) {
    logger.error(
      { target_id: message.targetId, kind: found.job.kind },
      `dispatch: JOB handler not implemented — ${entry.reason}`,
    );
    return; // B2_LEASE_JOB never called: the row is never mutated (S11.3).
  }
  // O6.3/O6.4 — child context merged into every line from the receipt onward. The lease
  // below only bumps generation/state, so the identity fields read here are stable
  // across the post-lease re-read (`fresh`).
  const log = logger.child({
    job_id: found.job.jobId,
    search_id: found.search.searchId,
    run_key_id: found.runKey.runKeyId,
    kind: found.job.kind,
  });
  log.info(
    {
      target_id: message.targetId,
      kind: found.job.kind,
      state: found.job.state,
      attempt: found.job.attempt,
    },
    "JOB message received",
  );
  const leased = await runStatement(deps.db, B2_LEASE_JOB, [found.job.jobId, tunables.leaseTtl]);
  if (leased.length === 0) {
    log.warn(
      { target_id: message.targetId },
      "dispatch: JOB lease lost (duplicate delivery or cancelled) — ack without dispatch",
    );
    return;
  }
  const fresh = await findJobContext(deps.db, message.targetId);
  if (fresh === null) {
    // The row cannot vanish between a winning lease and this read (no delete statement
    // exists in the durability schema) — defensive only, never expected to trigger.
    throw new Error(`dispatch: JOB ${message.targetId} vanished immediately after leasing`);
  }
  const attrs = { target_kind: "JOB" };
  const started = Date.now();
  const runHandler = () =>
    entry.handler({
      job: fresh.job,
      search: fresh.search,
      runKey: fresh.runKey,
      sqlClient: deps.db,
      logger: log,
    });
  try {
    // O7.7 — always inside an explicit context: the extracted request trace when the
    // message carries one, else ROOT_CONTEXT so spans open on a fresh root trace.
    await context.with(handlerContext(message), runHandler);
  } catch (error) {
    recordDispatchMetrics(deps.metrics, attrs, Date.now() - started, "error");
    log.error({ error, target_id: message.targetId, ...attrs }, "handler failed");
    throw error;
  }
  const durationMs = Date.now() - started;
  recordDispatchMetrics(deps.metrics, attrs, durationMs, "ok");
  log.info({ duration_ms: durationMs }, "handler completed");
}

/** Dispatches one `run-queue` message (S11.1, verification item 3). */
export async function dispatchRunMessage(
  deps: DispatchDeps,
  tunables: DispatchTunables,
  message: RelayMessage,
): Promise<void> {
  const { logger } = deps;
  const found = await findRunContext(deps.db, message.targetId);
  if (found === null) {
    logger.warn({ target_id: message.targetId }, "dispatch: RUN not found — ack without dispatch");
    return;
  }
  if (isTerminalJobOrRunState(found.run.state)) {
    logger.warn(
      { target_id: message.targetId, state: found.run.state },
      "dispatch: RUN already terminal — ack without dispatch",
    );
    return;
  }
  const entry = deps.registry.run[found.runKey.kind];
  if (!entry.implemented) {
    logger.error(
      { target_id: message.targetId, kind: found.runKey.kind },
      `dispatch: RUN handler not implemented — ${entry.reason}`,
    );
    return; // B2_LEASE_RUN never called: the row is never mutated (S11.3).
  }
  // O6.3/O6.4 — child context merged into every line from the receipt onward; identity
  // fields are stable across the post-lease re-read (`fresh`), `search_id` only when the
  // best-effort join found a LIVE subscriber.
  const log = logger.child({
    run_id: found.run.runId,
    ...(found.search !== null ? { search_id: found.search.searchId } : {}),
    run_key_id: found.runKey.runKeyId,
    kind: found.runKey.kind,
  });
  log.info(
    {
      target_id: message.targetId,
      kind: found.runKey.kind,
      state: found.run.state,
      attempt: found.run.attempt,
    },
    "RUN message received",
  );
  const leased = await runStatement(deps.db, B2_LEASE_RUN, [found.run.runId, tunables.leaseTtl]);
  if (leased.length === 0) {
    log.warn(
      { target_id: message.targetId },
      "dispatch: RUN lease lost (duplicate delivery or cancelled) — ack without dispatch",
    );
    return;
  }
  const fresh = await findRunContext(deps.db, message.targetId);
  if (fresh === null) {
    throw new Error(`dispatch: RUN ${message.targetId} vanished immediately after leasing`);
  }
  const attrs = {
    target_kind: "RUN",
    provider_id: fresh.runKey.providerId,
    route_class: fresh.runKey.routeClass,
  };
  const started = Date.now();
  try {
    const runHandler = () =>
      entry.handler({
        run: fresh.run,
        search: fresh.search,
        runKey: fresh.runKey,
        sqlClient: deps.db,
        logger: log,
      });
    // O7.7 — always inside an explicit context: the extracted request trace when the
    // message carries one (so e.g. `amc.browser_navigation` parents onto it), else
    // ROOT_CONTEXT so spans open on a fresh root trace.
    await context.with(handlerContext(message), runHandler);
  } catch (error) {
    recordDispatchMetrics(deps.metrics, attrs, Date.now() - started, "error");
    log.error({ error, target_id: message.targetId, ...attrs }, "handler failed");
    throw error;
  }
  const durationMs = Date.now() - started;
  recordDispatchMetrics(deps.metrics, attrs, durationMs, "ok");
  log.info({ duration_ms: durationMs }, "handler completed");
}

/** Dispatches one AGGREGATE-hint message (S11.1, verification item 6). */
export async function dispatchAggregateMessage(
  deps: DispatchDeps,
  tunables: DispatchTunables,
  message: AggregateHintMessage,
): Promise<void> {
  const { logger } = deps;
  const search = await findSearchById(deps.db, message.searchId);
  if (search === null) {
    logger.warn(
      { search_id: message.searchId },
      "dispatch: AGGREGATE not found — ack without dispatch",
    );
    return;
  }
  if (isTerminalSearchStatus(search.status)) {
    logger.warn(
      { search_id: message.searchId, status: search.status },
      "dispatch: AGGREGATE already terminal — ack without dispatch",
    );
    return;
  }
  const entry = deps.registry.aggregate;
  if (!entry.implemented) {
    logger.error(
      { search_id: message.searchId },
      `dispatch: AGGREGATE handler not implemented — ${entry.reason}`,
    );
    return; // B7_CLAIM never called: the row is never mutated (S11.3).
  }
  // O6.4 — receipt precedes the claim: the claimed generation is only known after
  // B7_CLAIM returns, so it rides the child context below rather than this line.
  logger.info({ search_id: message.searchId }, "AGGREGATE hint received");
  const claimed = await runStatement<{ agg_generation: number; agg_requested_rev: string }>(
    deps.db,
    B7_CLAIM,
    [message.searchId, tunables.leaseTtl],
  );
  const claim = claimed[0];
  if (claim === undefined) {
    logger.warn(
      { search_id: message.searchId },
      "dispatch: AGGREGATE claim lost (no work or another claimant) — ack without dispatch",
    );
    return;
  }
  const aggGeneration = Number(claim.agg_generation);
  const log = logger.child({ search_id: message.searchId, agg_generation: aggGeneration });
  const attrs = { target_kind: "AGGREGATE" };
  const started = Date.now();
  try {
    await entry.handler({
      search,
      aggGeneration,
      aggRequestedRev: String(claim.agg_requested_rev),
      sqlClient: deps.db,
      logger: log,
    });
  } catch (error) {
    recordDispatchMetrics(deps.metrics, attrs, Date.now() - started, "error");
    log.error({ error, search_id: message.searchId, ...attrs }, "handler failed");
    throw error;
  }
  const durationMs = Date.now() - started;
  recordDispatchMetrics(deps.metrics, attrs, durationMs, "ok");
  log.info({ duration_ms: durationMs }, "handler completed");
}

export interface DispatchQueues {
  readonly job: Queue<RelayMessage>;
  readonly run: Queue<RelayMessage>;
  readonly aggregate: Queue<AggregateHintMessage>;
}

export interface DispatchWorkerOptions {
  readonly job?: CreateWorkerOptions;
  readonly run?: CreateWorkerOptions;
  readonly aggregate?: CreateWorkerOptions;
}

export interface DispatchHandle {
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Wires the three BullMQ workers via S7's `createWorker` (S11.1). Job names are the
 * publisher-side convention: `RELAY_QUEUE_FOR_TARGET`'s keys for job-queue/run-queue
 * (`../relay/publisher.ts`), `AGGREGATE_HINT_JOB_NAME` for the hint channel
 * (`../sweeper/duties.ts`).
 */
export function createDispatchWorkers(
  deps: DispatchDeps,
  queues: DispatchQueues,
  tunables: DispatchTunables,
  workerOptions: DispatchWorkerOptions = {},
): DispatchHandle {
  const jobWorker = createWorker<RelayMessage>(
    queues.job,
    "JOB",
    (data) => dispatchJobMessage(deps, tunables, data),
    workerOptions.job,
  );
  const runWorker = createWorker<RelayMessage>(
    queues.run,
    "RUN",
    (data) => dispatchRunMessage(deps, tunables, data),
    workerOptions.run,
  );
  const aggregateWorker = createWorker<AggregateHintMessage>(
    queues.aggregate,
    AGGREGATE_HINT_JOB_NAME,
    (data) => dispatchAggregateMessage(deps, tunables, data),
    workerOptions.aggregate,
  );
  return {
    pause: async () => {
      await Promise.all([
        jobWorker.worker.pause(true),
        runWorker.worker.pause(true),
        aggregateWorker.worker.pause(true),
      ]);
    },
    resume: () => {
      jobWorker.worker.resume();
      runWorker.worker.resume();
      aggregateWorker.worker.resume();
      return Promise.resolve();
    },
    close: async () => {
      await Promise.all([jobWorker.close(), runWorker.close(), aggregateWorker.close()]);
    },
  };
}
