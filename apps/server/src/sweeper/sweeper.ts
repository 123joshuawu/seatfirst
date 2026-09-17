/**
 * The periodic-invocation sweeper (S10): orchestrates the ten duties on an injected tick
 * interval. Scheduling and orchestration only — every duty composes the durability tier's
 * existing statements and composed helpers (see `./duties.js`).
 *
 * ADR 0001 §5 sketches "~30 s where a resident process exists" — a sketch, not a decided
 * value (`docs/adr/0001-durability-search-lifecycle.md:1412`). The tick interval is
 * therefore an injected parameter with no hardcoded default (gate 14,
 * `docs/gates.md`), exactly like every other tunable below.
 */
import type { Queue } from "bullmq";
import type { Pool } from "pg";

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { poolClient } from "@seatfirst/durability";

import type { SeatfirstMetrics } from "@seatfirst/config/otel";
import type { RelayPublisher } from "../relay/publisher.js";

import {
  advanceStaleSnapshotProjections,
  failExhaustedJobs,
  failExhaustedRuns,
  projectSearchEvents,
  publishAggregateHints,
  rearmStrandedJobs,
  rearmStrandedRuns,
  reclaimExpiredJobs,
  reclaimExpiredRuns,
  republishOverdueOutbox,
} from "./duties.js";
import type { AggregateHintMessage, ProjectionRedis, SnapshotProjectionClaim } from "./duties.js";

export type SweeperLogger = SeatfirstLogger;

/** Everything the tick touches that a deployment wires. */
export interface SweepTickDeps {
  /** Postgres pool; the composed helpers run on one checked-out connection from it. */
  readonly pool: Pool;
  /** S9's relay publisher — the SAME publish contract for outbox rows (S9.2). */
  readonly publisher: RelayPublisher;
  /** The AGGREGATE-hint channel (S10.8). */
  readonly aggregateQueue: Queue<AggregateHintMessage>;
  /** Redis Stream writer for the event-projection duty (S10.9). */
  /** O6.6 metrics seam — production wires `otel.metrics`; tests inject fakes. */
  readonly metrics?: SeatfirstMetrics;
  readonly redis: ProjectionRedis;
  readonly logger: SweeperLogger;
}

/** Caller-supplied tunables — every one of them, no defaults (gate 14 / ADR 0006). */
export interface SweepTunables {
  /** `SWEEP_OVERDUE_OUTBOX` batch size. */
  readonly outboxBatch: number;
  /** Postgres interval literal for `SWEEP_REARM_JOBS`/`SWEEP_REARM_RUNS` (e.g. `'1 minute'`). */
  readonly rearmAge: string;
  /** Attempt budget for `SWEEP_RECLAIM_*` and the fail-exhausted composed helpers. */
  readonly maxAttempts: number;
  /** Postgres interval literal for `SWEEP_STALE_SNAPSHOT_PROJECTIONS`. */
  readonly snapshotAge: string;
  /** The snapshot-projection compute step (see `duties.ts`) — required, no default. */
  readonly computeSnapshotProjection: (claim: SnapshotProjectionClaim) => Promise<void>;
}

/** What one tick did — the observability surface and the tests' assertion surface. */
export interface SweepTickSummary {
  readonly outboxPublished: number;
  readonly jobsRearmed: number;
  readonly runsRearmed: number;
  readonly jobsReclaimed: number;
  readonly jobsFailedExhausted: number;
  readonly runsReclaimed: number;
  readonly runsFailedExhausted: number;
  readonly aggregateHintsPublished: number;
  readonly eventsProjected: number;
  readonly snapshotsAdvanced: number;
  /** Duty names that threw this tick; the loop survives and retries next tick. */
  readonly failedDuties: readonly string[];
}

type DutyStatKey = Exclude<keyof SweepTickSummary, "failedDuties">;

interface MutableSummary {
  readonly stats: Record<DutyStatKey, number>;
  readonly failedDuties: string[];
}

/**
 * One complete pass over all ten duties, in the ADR's duty order. The order within a tick
 * is not load-bearing — every statement and composed helper fences independently, so a
 * row can only be acted on when its predicate still holds. The event-projection duty
 * (9) runs over the searches this tick's duties 5/7/8 surfaced: those duties are the
 * only ones whose statements return search ids, so they are the tick's discovery of
 * searches that may have unprojected events (see the report for this decision).
 *
 * A failing duty does not abort the tick: reconciliation is the whole point, and the
 * next tick retries. The summary's `failedDuties` names what failed.
 */
export async function runSweepTick(
  deps: SweepTickDeps,
  tunables: SweepTunables,
): Promise<SweepTickSummary> {
  const db = poolClient(deps.pool);
  const summary: MutableSummary = {
    stats: {
      outboxPublished: 0,
      jobsRearmed: 0,
      runsRearmed: 0,
      jobsReclaimed: 0,
      jobsFailedExhausted: 0,
      runsReclaimed: 0,
      runsFailedExhausted: 0,
      aggregateHintsPublished: 0,
      eventsProjected: 0,
      snapshotsAdvanced: 0,
    },
    failedDuties: [],
  };
  const candidateSearches = new Set<string>();
  const duty = async <K extends DutyStatKey>(
    name: string,
    key: K,
    fn: () => Promise<number>,
  ): Promise<number> => {
    try {
      const result = await fn();
      summary.stats[key] = result;
      return result;
    } catch (error) {
      deps.logger.error({ duty: name, error }, "sweeper duty failed");
      summary.failedDuties.push(name);
      return 0;
    }
  };

  // Duty 1 — republish overdue outbox rows (reconciliation; S9 owns the primary path).
  await duty("republish-overdue-outbox", "outboxPublished", () =>
    republishOverdueOutbox(db, deps.publisher, tunables.outboxBatch),
  );
  // Duty 2/3 — re-arm stranded jobs and runs.
  await duty("rearm-stranded-jobs", "jobsRearmed", () => rearmStrandedJobs(db, tunables.rearmAge));
  await duty("rearm-stranded-runs", "runsRearmed", () => rearmStrandedRuns(db, tunables.rearmAge));
  // Duty 4/6 — reclaim expired leases still under their attempt budget.
  await duty("reclaim-expired-jobs", "jobsReclaimed", () =>
    reclaimExpiredJobs(db, tunables.maxAttempts),
  );
  await duty("reclaim-expired-runs", "runsReclaimed", () =>
    reclaimExpiredRuns(db, tunables.maxAttempts),
  );
  // Duty 5/7 — fail attempts-exhausted, expired-lease work via the composed helpers.
  await duty("fail-exhausted-jobs", "jobsFailedExhausted", async () => {
    const outcome = await failExhaustedJobs(deps.pool, tunables.maxAttempts);
    for (const searchId of outcome.affectedSearchIds) {
      candidateSearches.add(searchId);
    }
    return outcome.failed;
  });
  await duty("fail-exhausted-runs", "runsFailedExhausted", async () => {
    const outcome = await failExhaustedRuns(deps.pool, tunables.maxAttempts);
    for (const searchId of outcome.affectedSearchIds) {
      candidateSearches.add(searchId);
    }
    return outcome.failed;
  });
  // Duty 8 — AGGREGATE B7 hints, published directly (not through the outbox).
  await duty("publish-aggregate-hints", "aggregateHintsPublished", async () => {
    const outcome = await publishAggregateHints(db, deps.aggregateQueue);
    for (const searchId of outcome.searchIds) {
      candidateSearches.add(searchId);
    }
    return outcome.published;
  });
  // Duty 9 — relay unprojected events for the searches this tick surfaced.
  await duty("project-unprojected-events", "eventsProjected", async () => {
    let projected = 0;
    for (const searchId of candidateSearches) {
      projected += await projectSearchEvents(db, deps.redis, searchId);
    }
    return projected;
  });
  // Duty 10 — advance stale snapshot projections.
  await duty("advance-stale-snapshots", "snapshotsAdvanced", () =>
    advanceStaleSnapshotProjections(db, {
      age: tunables.snapshotAge,
      compute: tunables.computeSnapshotProjection,
    }),
  );

  return { ...summary.stats, failedDuties: summary.failedDuties };
}

export interface SweeperOptions extends SweepTunables {
  /** Tick interval — injected, no default (gate 14). */
  readonly tickIntervalMs: number;
  /** Observability/test hook: invoked after every completed tick. */
  readonly onTickComplete?: (summary: SweepTickSummary) => void;
}

export interface SweeperHandle {
  /** Stops the loop and waits for the in-flight tick (if any) to finish. */
  stop(): Promise<void>;
}

/**
 * Runs the tick immediately, then every `tickIntervalMs`. A tick that overruns the
 * interval delays the next one rather than overlapping it — the loop body is sequential,
 * so two ticks can never act on the same row concurrently from this process.
 */
export function runSweeper(deps: SweepTickDeps, options: SweeperOptions): SweeperHandle {
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      deps.logger.debug({ started_at: new Date().toISOString() }, "sweeper tick started");
      const started = Date.now();
      let summary: SweepTickSummary;
      try {
        summary = await runSweepTick(deps, options);
      } catch (error) {
        // runSweepTick isolates per-duty failures; this catches only orchestration-level
        // errors (e.g. poolClient itself), which must not kill the reconciliation loop.
        deps.logger.error({ error }, "sweeper tick aborted");
        summary = { ...emptySummary() };
      }
      const elapsed = Date.now() - started;
      deps.metrics?.sweeperTickDuration.record(elapsed);
      deps.metrics?.sweeperRowsReclaimed.add(summary.jobsReclaimed, { row_kind: "job" });
      deps.metrics?.sweeperRowsReclaimed.add(summary.runsReclaimed, { row_kind: "run" });
      deps.logger.debug(
        {
          duration_ms: elapsed,
          outbox_published: summary.outboxPublished,
          jobs_rearmed: summary.jobsRearmed,
          runs_rearmed: summary.runsRearmed,
          jobs_reclaimed: summary.jobsReclaimed,
          runs_reclaimed: summary.runsReclaimed,
          jobs_failed_exhausted: summary.jobsFailedExhausted,
          runs_failed_exhausted: summary.runsFailedExhausted,
          aggregate_hints_published: summary.aggregateHintsPublished,
          events_projected: summary.eventsProjected,
          snapshots_advanced: summary.snapshotsAdvanced,
          failed_duties: summary.failedDuties.length,
        },
        "sweeper tick completed",
      );
      options.onTickComplete?.(summary);
      await delay(Math.max(0, options.tickIntervalMs - elapsed), abort.signal);
    }
  })();

  return {
    async stop() {
      abort.abort();
      await loop;
    },
  };
}

function emptySummary(): SweepTickSummary {
  return {
    outboxPublished: 0,
    jobsRearmed: 0,
    runsRearmed: 0,
    jobsReclaimed: 0,
    jobsFailedExhausted: 0,
    runsReclaimed: 0,
    runsFailedExhausted: 0,
    aggregateHintsPublished: 0,
    eventsProjected: 0,
    snapshotsAdvanced: 0,
    failedDuties: [],
  };
}

/** Abortable sleep — `stop()` does not wait out a full interval. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
