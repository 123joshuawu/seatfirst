/**
 * S30.1/S30.2/S30.5 (+ S61/ADR 0065) — the JOB-branch admission/dedup layer: the
 * registry composer `withJobAdmissionDedup` and the shared admission handler behind
 * both JOB slots.
 *
 * `job.SCHEDULE_RESOLUTION` runs find-or-create only: it finds-or-creates the live
 * `provider_run` for the job's `run_key`, coalescing concurrent in-flight work onto one
 * upstream navigation (single-flight, §4.4). It never serves a completed observation —
 * ADR 0006 §A.1 pins schedule resolution to "never cached (always live per query)"
 * (`docs/adr/0006-capacity-cost-model-numeric-acceptance-criteria.md:189`), and
 * `RUN_CREATE`'s fence (`state IN ('PENDING','LEASED')`, `boundaries.ts:650`) means a
 * `DONE` run never blocks a fresh one.
 *
 * `job.SHOWTIME_FETCH` first attempts S61 snapshot adoption (ADR 0065,
 * `docs/adr/0065-tiered-hybrid-seat-caching-and-freshness-disclosure.md`, amending
 * ADR 0002 §2.3 and ADR 0006 §A.1 with owner data-use risk acceptance): when a recent
 * (<30s, `SNAPSHOT_ADOPTION_TTL_MS`) authoritative `availability_snapshot` exists for
 * the job's `run_key`, `stageAdoptOrCreateShowtimeWork` applies that historical run to
 * this search synchronously — writing `run_application` and emitting `FETCH_ACCEPTED`
 * with the exact `B5_FANIN` mirror transitions — and no browser run is dispatched.
 * On a cache miss it falls back to the same find-or-create path (which creates the
 * outbox entry itself when it wins the race), and when the provider is halted/paused
 * (`FENCE_REJECTED`) the pass is dropped without creating any run, mirroring why a
 * zero-row `B2_ADMISSION_FENCE` already means "drop the pass".
 *
 * The handler does exactly one admission decision and returns: a created run stays
 * `PENDING`, and its outbox drives the relay to publish a `RUN` message that the RUN
 * branch (S8) actually dispatches and navigates. It never re-leases (the consumer
 * already won `B2_LEASE_JOB`, `consumer.ts:60-79`) and never reads a `DONE`
 * observation outside the S61 adoption path.
 */
import type { Pool } from "pg";

import {
  B2_ADMISSION_FENCE,
  runStatement,
  stageAdoptOrCreateShowtimeWork,
  stageFindOrCreateRun,
  withTransaction,
} from "@seatfirst/durability";

import { implementedHandler } from "../handlers.js";
import type { DispatchRegistry, JobHandlerFn } from "../types.js";

/** S30.1 — the composer's injected dependency set. `pool` is the single required, non-code
 * dependency (the S8 precedent, `ProviderFetchActorDeps.pool`); `withTransaction` provides the
 * single-connection guarantee `stageFindOrCreateRun` needs. No numeric policy value lives here —
 * there is no gate-14 surface. */
export interface JobAdmissionDedupDeps {
  /** Caller-owned pg pool; `withTransaction` provides the single-connection guarantee. */
  readonly pool: Pool;
}

/**
 * S30.1 — wires both `job.*` slots to the shared find-or-create handler, mirroring
 * `withProviderFetchActor` (`handlers.ts:79-92`) and `withAnswerAssembler`
 * (`aggregate-answer-assembler.ts:121`): spread the registry, override ONLY `job.*`, leave
 * `run.*`/`aggregate` untouched, and never alter `createPlaceholderRegistry`.
 */
export function withJobAdmissionDedup(
  registry: DispatchRegistry,
  deps: JobAdmissionDedupDeps,
): DispatchRegistry {
  const handler = createJobAdmissionHandler(deps);
  return {
    ...registry,
    job: {
      SHOWTIME_FETCH: implementedHandler(handler),
      SCHEDULE_RESOLUTION: implementedHandler(handler),
      MOVIE_SCHEDULE_RESOLUTION: implementedHandler(handler),
    },
  };
}

/** S30.2 (+ S61.7) — the shared handler body. `SCHEDULE_RESOLUTION` is find-or-create
 * only (`kind` is already encoded in the `run_key` row — `RUN_CREATE` derives `priority`
 * from it — so that branch needs no per-kind logic); `SHOWTIME_FETCH` first attempts
 * S61 snapshot adoption via `stageAdoptOrCreateShowtimeWork` before falling back to
 * find-or-create. The RUN branch (S8) interprets `kind` at acceptance. */
export function createJobAdmissionHandler(deps: JobAdmissionDedupDeps): JobHandlerFn {
  return async (context) => {
    // NOT `context.sqlClient` — that is a bare, autocommitted `SqlClient` (`poolClient`,
    // `pool.ts:59-66`) with no `TransactionClient` brand, and passing it here would be a compile
    // error. `withTransaction` checks out one connection and brands it for the composed body.
    await withTransaction(deps.pool, async (tx) => {
      // S60.7 (ADR 0066 §4) — admission fence: lock the job and its parent search before
      // admitting any provider work. Zero rows means the search was cancelled/terminalized
      // or the job lease lapsed, so drop the pass without creating a run or outbox entry.
      const fenced = await runStatement(tx, B2_ADMISSION_FENCE, [
        context.job.jobId,
        context.job.generation,
      ]);
      if (fenced.length === 0) {
        return;
      }
      // S61.7 (ADR 0065) — SHOWTIME_FETCH jobs adopt a recent cached snapshot instead of
      // spawning a browser run; every other kind stays on plain find-or-create.
      if (context.job.kind === "SHOWTIME_FETCH") {
        const result = await stageAdoptOrCreateShowtimeWork(tx, {
          jobId: context.job.jobId,
          jobGeneration: context.job.generation,
          searchId: context.job.searchId,
          runKeyId: context.job.runKeyId,
          providerId: context.runKey.providerId,
        });
        if (result.outcome === "ADOPTED") {
          context.logger.info(
            {
              runKeyId: context.job.runKeyId,
              runId: result.runId,
              freeCount: result.freeCount,
              capturedAt: result.capturedAt,
            },
            "S61 showtime run adopted from cache",
          );
          return;
        }
        if (result.outcome === "FENCE_REJECTED") {
          context.logger.info(
            { runKeyId: context.job.runKeyId },
            "S61 provider fence rejected showtime adoption",
          );
          return;
        }
        // RUN_CREATED — `stageAdoptOrCreateShowtimeWork` already composed
        // `stageFindOrCreateRun` internally, which creates the outbox entry itself when
        // it wins the race (`transactions.ts:1938-1946`). No second outbox entry.
        return;
      }
      await stageFindOrCreateRun(tx, { runKeyId: context.job.runKeyId });
    });
  };
}
