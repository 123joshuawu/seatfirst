import type { Meter } from "@opentelemetry/api";
import {
  OUTBOX_MARK_RETRY,
  SWEEP_OVERDUE_OUTBOX,
  markOutboxPublished,
  runStatement,
} from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { registerRelayMetrics } from "./metrics.js";
import type { RelayPublisher } from "./publisher.js";
import { createRelayState, type RelayState } from "./state.js";

/**
 * Outbox relay poll loop (S9.1–S9.4).
 *
 * Every cycle sweeps due `PENDING` outbox rows through the EXISTING
 * `SWEEP_OVERDUE_OUTBOX` statement, publishes each via BullMQ with the target id as the
 * dedup key, and marks the row `PUBLISHED` — in Postgres — only after the broker
 * acknowledges. Publish failures go through `OUTBOX_MARK_RETRY` with the caller-supplied
 * backoff. Both statements are fenced; zero rows from a mark means a concurrent actor
 * won and is logged, never treated as an error.
 *
 * This loop only touches the outbox state machine through those three durability
 * statements — it re-derives none of their logic (S9.7) and invents no durable state in
 * Redis or BullMQ (S9.8). Sweeper duties are S10's, not this daemon's.
 */

/** A row as returned by `SWEEP_OVERDUE_OUTBOX` (widened with `traceparent` by O7.3). */
interface OverdueOutboxRow {
  readonly outbox_id: string;
  readonly target_kind: string;
  readonly job_id: string | null;
  readonly run_id: string | null;
  readonly tmdb_fetch_id: string | null;
  readonly traceparent: string | null;
}

interface RetriedRow {
  readonly outbox_id: string;
  readonly attempt: number;
  readonly next_attempt_at: Date;
}

export interface PollOnceResult {
  /** Rows returned by the sweep. */
  swept: number;
  /** Rows published and marked PUBLISHED in this cycle. */
  published: number;
  /** Rows whose publish threw; each went through the retry path. */
  publishFailed: number;
  /** Rows where OUTBOX_MARK_RETRY took effect (attempt incremented, deferral advanced). */
  retried: number;
  /** Rows where OUTBOX_MARK_RETRY returned zero rows (reclaimed/published concurrently). */
  retryFenced: number;
  /** Rows where OUTBOX_MARK_PUBLISHED returned zero rows (already published or gone). */
  markFenced: number;
  /** Rows where a mark/retry statement itself threw (DB error); the row stays PENDING. */
  markFailed: number;
}

export interface PollOnceOptions {
  readonly batchSize: number;
  readonly retryBackoff: string;
  readonly logger: SeatfirstLogger;
}

/**
 * One sweep-and-dispatch cycle. Exported for tests (the spec's verification items run
 * single cycles); the daemon drives it continuously in {@link runRelayLoop}.
 */
export async function pollOnce(
  db: SqlClient,
  publisher: RelayPublisher,
  options: PollOnceOptions,
): Promise<PollOnceResult> {
  const swept = await runStatement<OverdueOutboxRow>(db, SWEEP_OVERDUE_OUTBOX, [options.batchSize]);
  const result: PollOnceResult = {
    swept: swept.length,
    published: 0,
    publishFailed: 0,
    retried: 0,
    retryFenced: 0,
    markFenced: 0,
    markFailed: 0,
  };
  for (const row of swept) {
    const outcome = await processRow(db, publisher, row, options);
    switch (outcome) {
      case "published":
        result.published += 1;
        break;
      case "retried":
        result.publishFailed += 1;
        result.retried += 1;
        break;
      case "retry-fenced":
        result.publishFailed += 1;
        result.retryFenced += 1;
        break;
      case "retry-mark-failed":
        result.publishFailed += 1;
        result.markFailed += 1;
        break;
      case "mark-fenced":
        result.markFenced += 1;
        break;
      case "mark-failed":
        result.markFailed += 1;
        break;
    }
  }
  return result;
}

type RowOutcome =
  "published" | "retried" | "retry-fenced" | "retry-mark-failed" | "mark-fenced" | "mark-failed";

async function processRow(
  db: SqlClient,
  publisher: RelayPublisher,
  row: OverdueOutboxRow,
  options: PollOnceOptions,
): Promise<RowOutcome> {
  const { logger } = options;
  try {
    if (
      row.target_kind !== "JOB" &&
      row.target_kind !== "RUN" &&
      row.target_kind !== "TMDB_FETCH"
    ) {
      // Impossible under the outbox CHECK (001_schema.sql:136, widened by 012), but an
      // unrecognized persisted kind fails closed rather than guessing a queue.
      throw new Error(
        `outbox ${row.outbox_id} carries target_kind ${JSON.stringify(row.target_kind)} — ` +
          "impossible under the outbox CHECK constraint",
      );
    }
    const targetId =
      row.target_kind === "JOB"
        ? row.job_id
        : row.target_kind === "RUN"
          ? row.run_id
          : row.tmdb_fetch_id;
    if (targetId === null) {
      throw new Error(`outbox ${row.outbox_id} carries no id for target_kind ${row.target_kind}`);
    }
    logger.info(
      { outbox_id: row.outbox_id, target_kind: row.target_kind, target_id: targetId },
      "outbox row claimed",
    );
    await publisher.publish({
      outboxId: row.outbox_id,
      targetKind: row.target_kind,
      targetId,
      // Null for re-armed/reclaimed rows (no HTTP origin) — never fabricated (ADR 0031).
      traceparent: row.traceparent,
    });
  } catch (error) {
    logger.error({ outbox_id: row.outbox_id, error }, "publish failed; marking it for retry");
    return markRetry(db, row.outbox_id, options, logger);
  }

  try {
    const marked = await markOutboxPublished(db, row.outbox_id);
    if (marked.length === 0) {
      logger.warn(
        { outbox_id: row.outbox_id },
        "OUTBOX_MARK_PUBLISHED returned no row: already published or gone — continuing",
      );
      return "mark-fenced";
    }
    return "published";
  } catch (error) {
    // The broker has the message (dedup key = target id), so leaving the row PENDING
    // here means the next cycle re-publishes to a no-op dedup hit and re-marks.
    logger.error({ outbox_id: row.outbox_id, error }, "OUTBOX_MARK_PUBLISHED failed");
    return "mark-failed";
  }
}

async function markRetry(
  db: SqlClient,
  outboxId: string,
  options: PollOnceOptions,
  logger: SeatfirstLogger,
): Promise<RowOutcome> {
  try {
    const retried = await runStatement<RetriedRow>(db, OUTBOX_MARK_RETRY, [
      outboxId,
      options.retryBackoff,
    ]);
    if (retried.length === 0) {
      logger.warn(
        { outbox_id: outboxId },
        "OUTBOX_MARK_RETRY fenced out: reclaimed or already published by a concurrent actor — nothing to retry",
      );
      return "retry-fenced";
    }
    return "retried";
  } catch (error) {
    logger.error({ outbox_id: outboxId, error }, "OUTBOX_MARK_RETRY failed; row stays due");
    return "retry-mark-failed";
  }
}

export interface RelayLoopDeps {
  readonly db: SqlClient;
  readonly publisher: RelayPublisher;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly retryBackoff: string;
  readonly alarmThresholdMs: number;
  readonly meter: Meter;
  readonly logger: SeatfirstLogger;
  readonly signal?: AbortSignal;
}

export interface RelayLoopHandle {
  readonly state: RelayState;
  /** Resolves when the loop has stopped (via `stop()` or the injected signal). */
  readonly done: Promise<void>;
  stop(): void;
}

/**
 * The continuously-polling relay daemon loop (S9.1). Polls immediately, then every
 * `pollIntervalMs` until aborted. After each completed cycle it refreshes the shared
 * {@link RelayState} — backlog depth, oldest-PENDING age, alarm flag against the
 * caller-supplied threshold, and the last-successful-poll timestamp — which `/healthz`
 * and the OTel gauges read. A cycle that throws (e.g. the DB is down) is logged and
 * retried after the interval; it does not stop the daemon and does not refresh the
 * liveness timestamp.
 */
export function runRelayLoop(deps: RelayLoopDeps, existingState?: RelayState): RelayLoopHandle {
  const state = existingState ?? createRelayState();
  registerRelayMetrics(deps.meter, state);
  const logger = deps.logger;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onAbort, { once: true });

  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          await pollOnce(deps.db, deps.publisher, {
            batchSize: deps.batchSize,
            retryBackoff: deps.retryBackoff,
            logger,
          });
          const telemetry = await readPendingTelemetry(deps.db);
          state.pendingBacklogDepth = telemetry.pending;
          state.oldestPendingAgeMs = telemetry.oldestAgeMs;
          state.alarmActive = telemetry.oldestAgeMs > deps.alarmThresholdMs;
          state.lastSuccessfulPollAt = new Date();
        } catch (error) {
          logger.error({ error }, "relay poll cycle failed; retrying after the poll interval");
        }
        if (controller.signal.aborted) {
          break;
        }
        await delay(deps.pollIntervalMs, controller.signal);
      }
    } finally {
      deps.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return { state, done, stop: () => controller.abort() };
}

interface PendingTelemetry {
  readonly pending: number;
  readonly oldestAgeMs: number;
}

/**
 * Read-only telemetry probe for S9.5/S9.6 (`min(created_at)` staleness and PENDING
 * depth). This is a SELECT, not a state transition, so the "no raw SQL at a call site"
 * rule (which guards moves of state) does not apply — and adding a statement for it
 * would exceed this task's one in-scope statement, `OUTBOX_MARK_RETRY` (S9.4).
 */
async function readPendingTelemetry(db: SqlClient): Promise<PendingTelemetry> {
  const result = await db.query(
    `SELECT count(*)::integer AS pending,
            COALESCE(floor(extract(epoch FROM (now() - min(created_at))) * 1000)::bigint, 0)
              AS oldest_age_ms
     FROM outbox
     WHERE state = 'PENDING'`,
  );
  // pg delivers int8 as a string; convert at the boundary so the gauges observe a
  // number (the OTel SDK drops non-numeric observations) and comparisons stay numeric.
  const row = result.rows[0] as { pending: number; oldest_age_ms: string } | undefined;
  if (row === undefined) {
    throw new Error("outbox telemetry probe returned no row");
  }
  return { pending: row.pending, oldestAgeMs: Number(row.oldest_age_ms) };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
