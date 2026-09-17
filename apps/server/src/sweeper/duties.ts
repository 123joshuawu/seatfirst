/**
 * The ten sweeper duties (ADR 0001 §5; `docs/tasks/S10-sweeper-process/spec.md`
 * S10.1–S10.10).
 *
 * Every duty here is scheduling and orchestration only: it composes the durability
 * tier's existing boundary statements and composed transaction helpers
 * (`packages/durability/src/boundaries.ts`, `.../transactions.ts`) and never re-derives
 * their SQL, schemas, or transactional guarantees (S10.12). The sweeper is the periodic
 * reconciliation backstop — S9's relay daemon owns the primary publish path.
 */
import type { Queue } from "bullmq";
import type { Pool } from "pg";

import {
  B10_ADVANCE_EVENT_WATERMARK,
  B10_ADVANCE_SNAPSHOT_WATERMARK,
  B10_CLAIM_SNAPSHOT_PROJECTION,
  B10_READ_EVENT_WATERMARK,
  B10_UNPROJECTED_EVENTS,
  SWEEP_AGGREGATE_HINTS,
  SWEEP_OVERDUE_OUTBOX,
  SWEEP_REARM_JOBS,
  SWEEP_REARM_RUNS,
  SWEEP_RECLAIM_JOBS,
  SWEEP_RECLAIM_RUNS,
  SWEEP_STALE_SNAPSHOT_PROJECTIONS,
  markOutboxPublished,
  runStatement,
  sweepFailExhaustedJobs,
  sweepFailExhaustedRuns,
} from "@seatfirst/durability";
import type { SqlClient, TransactionClient } from "@seatfirst/durability";

import { publish, removeTerminalBrokerRecord } from "../queue/index.js";
import type { RelayPublisher } from "../relay/publisher.js";

/**
 * The AGGREGATE-hint channel (S10.8, S11.1). Published DIRECTLY — never through the
 * outbox table's `JOB`/`RUN` target kinds, because AGGREGATE is deliberately not a job
 * kind (`001_schema.sql:89`, `:136`). The queue name follows S9.2's per-target naming
 * convention (`job-queue`/`run-queue`); the job name is the literal handler key S11.3
 * registers (`'AGGREGATE'`).
 */
export const AGGREGATE_HINT_QUEUE = "aggregate-queue";
export const AGGREGATE_HINT_JOB_NAME = "AGGREGATE";

/** The lightweight hint body S11.1 consumes — `{ searchId }`, nothing else. */
export interface AggregateHintMessage {
  readonly searchId: string;
}

/**
 * S10.1 — republish overdue outbox rows. Reconciliation only: S9's relay daemon owns the
 * primary publish path; this duty re-publishes rows the relay missed. Each row is marked
 * `PUBLISHED` only after the broker acknowledges (`publish` resolving), exactly the
 * outbox lifecycle at `docs/seatfirst-architecture.md:181`.
 */
export async function republishOverdueOutbox(
  db: SqlClient,
  publisher: RelayPublisher,
  batch: number,
): Promise<number> {
  const rows = await runStatement<{
    outbox_id: string;
    target_kind: "JOB" | "RUN" | "TMDB_FETCH";
    job_id: string | null;
    run_id: string | null;
    tmdb_fetch_id: string | null;
    traceparent: string | null;
  }>(db, SWEEP_OVERDUE_OUTBOX, [batch]);
  let published = 0;
  for (const row of rows) {
    const targetId =
      row.target_kind === "JOB"
        ? row.job_id
        : row.target_kind === "RUN"
          ? row.run_id
          : row.tmdb_fetch_id;
    if (targetId === null) {
      // Unreachable under the outbox CHECK constraints ((target_kind = 'JOB') = (job_id
      // IS NOT NULL)); skipping is safer than inventing a target id.
      continue;
    }
    await publisher.publish({
      outboxId: row.outbox_id,
      targetKind: row.target_kind,
      targetId,
      // Null for re-armed/reclaimed rows (no HTTP origin) — never fabricated (ADR 0031).
      traceparent: row.traceparent,
    });
    // Zero rows means the row was published by a concurrent actor (the relay, or an
    // earlier tick's retry) — idempotent, not an error, same fence S9.3 relies on.
    await markOutboxPublished(db, row.outbox_id);
    published += 1;
  }
  return published;
}

/**
 * S10.2 — re-arm stranded jobs: a fresh `JOB` outbox row for every aged, nonterminal,
 * unleased `search_job`, regardless of the existing outbox row's state. The job table is
 * what gets reconciled, not the outbox (`docs/seatfirst-architecture.md:194`).
 */
export async function rearmStrandedJobs(db: SqlClient, age: string): Promise<number> {
  return (await runStatement(db, SWEEP_REARM_JOBS, [age])).length;
}

/** S10.3 — the `provider_run` equivalent of duty 2 (ADR 0001 §5 duty 6). */
export async function rearmStrandedRuns(db: SqlClient, age: string): Promise<number> {
  return (await runStatement(db, SWEEP_REARM_RUNS, [age])).length;
}

/** S10.4 — expired-lease jobs back to `PENDING` with a fresh outbox row (T37). */
export async function reclaimExpiredJobs(db: SqlClient, maxAttempts: number): Promise<number> {
  return (await runStatement(db, SWEEP_RECLAIM_JOBS, [maxAttempts])).length;
}

/** S10.6 — the run-side reclaim. */
export async function reclaimExpiredRuns(db: SqlClient, maxAttempts: number): Promise<number> {
  return (await runStatement(db, SWEEP_RECLAIM_RUNS, [maxAttempts])).length;
}

/** The composed-helper outcome this module's callers consume. */
export interface FailedExhaustedOutcome {
  readonly failed: number;
  readonly affectedSearchIds: readonly string[];
}

/**
 * S10.5 — attempts-exhausted, expired-lease jobs via the EXISTING composed transaction
 * `sweepFailExhaustedJobs` (`packages/durability/src/transactions.ts:384-425`): it
 * discovers, fences, and applies effects atomically per candidate. The three raw
 * statements (`SWEEP_DISCOVER_EXHAUSTED_JOBS`/`SWEEP_FAIL_EXHAUSTED_JOB`/
 * `SWEEP_JOB_FAIL_EFFECTS`) are deliberately NOT invoked from here.
 */
export async function failExhaustedJobs(
  pool: Pool,
  maxAttempts: number,
): Promise<FailedExhaustedOutcome> {
  const results = await withSingleConnection(pool, (tx) => sweepFailExhaustedJobs(tx, maxAttempts));
  return {
    failed: results.length,
    affectedSearchIds: results.flatMap((result) => result.affected.map((a) => a.search_id)),
  };
}

/**
 * S10.7 — attempts-exhausted, expired-lease runs via the EXISTING composed transaction
 * `sweepFailExhaustedRuns` (`packages/durability/src/transactions.ts:345-366`): discovery,
 * then the full B5F effects per candidate. The raw discovery and B5F statements are NOT
 * invoked from here.
 */
export async function failExhaustedRuns(
  pool: Pool,
  maxAttempts: number,
): Promise<FailedExhaustedOutcome> {
  const results = await withSingleConnection(pool, (tx) => sweepFailExhaustedRuns(tx, maxAttempts));
  return {
    failed: results.length,
    affectedSearchIds: results.flatMap((result) => result.affected.map((a) => a.search_id)),
  };
}

/**
 * S10.8 — publish AGGREGATE B7 hints DIRECTLY via S7's BullMQ client, not through the
 * outbox table. `jobId` is the search id, so live hints collapse to one message per
 * search. A terminal record is removed before a later hint is added because durable
 * `agg_requested_rev` can advance after an earlier hint completed (ADR 0001 B7).
 */
export async function publishAggregateHints(
  db: SqlClient,
  queue: Queue<AggregateHintMessage>,
): Promise<{ published: number; searchIds: readonly string[] }> {
  const rows = await runStatement<{ search_id: string }>(db, SWEEP_AGGREGATE_HINTS, []);
  for (const row of rows) {
    await removeTerminalBrokerRecord(queue, row.search_id);
    await publish(queue, AGGREGATE_HINT_JOB_NAME, row.search_id, { searchId: row.search_id });
  }
  return { published: rows.length, searchIds: rows.map((row) => row.search_id) };
}

/**
 * The narrow Redis surface the projection duty needs. ioredis satisfies it structurally;
 * tests may substitute anything else that does. XADD uses flat field/value pairs (the
 * shape `packages/durability/test/support/projector.ts` writes into the stream).
 */
export interface ProjectionRedis {
  xadd(key: string, id: string, ...fields: string[]): Promise<unknown>;
  xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** A `B10_UNPROJECTED_EVENTS` row — `seq` is a bigint, surfaced as a string by pg. */
interface UnprojectedEvent {
  readonly seq: string;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * S10.9 — relay one search's unprojected `search_event` rows into its Redis Stream,
 * following the crash-safe projector contract
 * (`packages/durability/test/support/projector.ts:13-45`): XADD with entry ID
 * `${seq}-0`; on rejection, XRANGE that exact entry and reconcile rather than skip (an
 * ABSENT entry is an interior gap and throws — never a silent skip); advance the
 * contiguous watermark only after the entry is known present.
 */
export async function projectSearchEvents(
  db: SqlClient,
  redis: ProjectionRedis,
  searchId: string,
): Promise<number> {
  const events = await runStatement<UnprojectedEvent>(db, B10_UNPROJECTED_EVENTS, [searchId]);
  for (const event of events) {
    await projectEvent(db, redis, searchId, event);
  }
  return events.length;
}

async function projectEvent(
  db: SqlClient,
  redis: ProjectionRedis,
  searchId: string,
  event: UnprojectedEvent,
): Promise<void> {
  const seq = Number(event.seq);
  const entryId = `${seq}-0`;
  const key = `search:${searchId}`;
  try {
    await redis.xadd(key, entryId, "type", event.type, "payload", JSON.stringify(event.payload));
    const ttl = event.type === "SEARCH_TERMINAL" ? 3600 : 86400;
    await redis.expire(key, ttl);
  } catch (error) {
    // XADD rejects non-increasing entry IDs. Two cases, distinguished by XRANGE:
    // the entry exists → this exact event was already projected (crash between XADD and
    // the watermark advance) → reconcile by advancing; the entry is absent → the stream
    // is past this event, a genuine interior gap → stop, never skip.
    const existing = await redis.xrange(key, entryId, entryId);
    if (existing.length === 0) {
      throw new Error(
        `event ${entryId} is an interior stream gap; stop and rebuild rather than skipping it`,
        { cause: error },
      );
    }
  }

  const advanced = await runStatement(db, B10_ADVANCE_EVENT_WATERMARK, [searchId, seq]);
  if (advanced.length === 0) {
    const current = await runStatement<{ projected_through: string }>(
      db,
      B10_READ_EVENT_WATERMARK,
      [searchId],
    );
    const projectedThrough = current[0] === undefined ? -1 : Number(current[0].projected_through);
    if (projectedThrough < seq) {
      throw new Error(
        `event ${entryId} exists but the contiguous watermark is only ${projectedThrough}`,
      );
    }
  }
}

/** A `B10_CLAIM_SNAPSHOT_PROJECTION` row, shaped for the injected compute step. */
export interface SnapshotProjectionClaim {
  readonly runKeyId: string;
  readonly acceptedRevision: string;
  readonly latestObservationId: string | null;
}

export interface StaleSnapshotProjectionOptions {
  /** Postgres interval literal (e.g. `'1 minute'`), caller-supplied — no default (gate 14). */
  readonly age: string;
  /**
   * The compute step between claim and advance. No boundary statement reads the snapshot
   * to project (S10.10: "There is no 'S3 snapshot projector'"), so the projection itself
   * is caller-injected and REQUIRED: advancing the watermark without the cache write is
   * exactly the certified-stale failure the ADR's revision-fenced Redis CAS exists to
   * prevent (`docs/adr/0001-durability-search-lifecycle.md:1283-1299`).
   */
  readonly compute: (claim: SnapshotProjectionClaim) => Promise<void>;
}

/**
 * S10.10 — advance stale snapshot projections: discover aged `run_key` rows with
 * `projected_revision < accepted_revision`, claim each through the existing B10 snapshot
 * flow, run the injected compute, then advance the watermark. Zero advance rows means a
 * newer projector won — correct, not an error.
 *
 * Each claimed row is isolated: a failure on one row (e.g. a transient Redis blip) is
 * recorded and rethrown only after every sibling row has been attempted, so one poisoned
 * row can never block the rest of the batch.
 */
export async function advanceStaleSnapshotProjections(
  db: SqlClient,
  options: StaleSnapshotProjectionOptions,
): Promise<number> {
  const stale = await runStatement<{ run_key_id: string }>(db, SWEEP_STALE_SNAPSHOT_PROJECTIONS, [
    options.age,
  ]);
  if (stale.length === 0) {
    return 0;
  }
  const claims = await runStatement<{
    run_key_id: string;
    accepted_revision: string;
    latest_observation_id: string | null;
  }>(db, B10_CLAIM_SNAPSHOT_PROJECTION, []);
  const claimFor = new Map(claims.map((claim) => [claim.run_key_id, claim]));

  let advanced = 0;
  const failures: unknown[] = [];
  for (const row of stale) {
    const claim = claimFor.get(row.run_key_id);
    if (claim === undefined) {
      continue; // caught up since discovery — the claim's zeroRowsMeans
    }
    try {
      await options.compute({
        runKeyId: claim.run_key_id,
        acceptedRevision: claim.accepted_revision,
        latestObservationId: claim.latest_observation_id,
      });
      const done = await runStatement(db, B10_ADVANCE_SNAPSHOT_WATERMARK, [
        claim.run_key_id,
        claim.accepted_revision,
      ]);
      if (done.length > 0) {
        advanced += 1;
      }
    } catch (error) {
      // Poison-pill isolation: a failing row must not advance its watermark, but it also
      // must never block sibling rows in the same batch. Record it and keep going; the
      // first failure is rethrown below so the tick-level duty() wrapper still logs it.
      failures.push(error);
      continue;
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return advanced;
}

/**
 * Runs a composed transaction helper on one checked-out connection, WITHOUT an outer
 * BEGIN/COMMIT. The five BEGIN-emitting helpers in
 * `packages/durability/src/transactions.ts` open their own transaction per candidate
 * (`sweepFailExhaustedJobs` opens one per job), so wrapping them in
 * `withTransaction`'s outer BEGIN would nest transactions and then fail at its own
 * COMMIT. This adapter is a verbatim mirror of the durability tier's own unexported
 * `sqlClient` (`packages/durability/src/pool.ts:32-39`) — whose doc comment places the
 * brand-asserting cast exactly at the single-connection boundary; the package's public
 * surface offers no external equivalent yet, so the cast is re-asserted here with the
 * same single-connection guarantee (one checked-out `PoolClient`, never the pool).
 */
async function withSingleConnection<T>(
  pool: Pool,
  fn: (transaction: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const transaction = {
      async query(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values === undefined ? undefined : [...values]);
        return { rows: result.rows as unknown[] };
      },
    } as TransactionClient;
    return await fn(transaction);
  } finally {
    client.release();
  }
}
