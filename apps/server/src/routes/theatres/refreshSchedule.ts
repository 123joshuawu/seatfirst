import { z } from "zod";
import { TRPCError } from "@trpc/server";

import {
  IanaTimezoneSchema,
  parseNamespacedId,
  TheatreIdSchema,
  toTheatreLocal,
  UtcInstantSchema,
} from "@seatfirst/core";
import {
  poolClient,
  PROVIDER_RUN_READ_BY_ID,
  readScheduleRange,
  readTheatreById,
  runStatement,
  stageOnDemandScheduleRefresh,
  THEATRE_READ_BY_ID,
  withTransaction,
} from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";

import { t } from "./search.js";

export const RefreshScheduleInputSchema = z.object({ theatreId: TheatreIdSchema });
export type RefreshScheduleInput = z.infer<typeof RefreshScheduleInputSchema>;

export const RefreshScheduleResponseSchema = z.object({
  status: z.enum(["RESOLVED", "EMPTY", "FAILED"]),
  localDate: z.string(),
});
export type RefreshScheduleResponse = z.infer<typeof RefreshScheduleResponseSchema>;

/**
 * S63.5 (ADR 0100, "Explicit On-Demand Refresh") — bound on the whole
 * stage-and-poll request.
 *
 * (a) This is an internal implementation timeout, not a product/business policy
 *     number: on expiry the route returns an honest retryable `FAILED`, never a
 *     hung request.
 * (b) It is derived from the ~2–3 s single-navigation baseline ADR 0100 cites in
 *     rejected alternative 2 (30 sequential navigations ≈ 45–75 s under the
 *     capacity-1 `sem:amc` semaphore ⇒ ~2–3 s each): this refresh is bounded to
 *     exactly one date (D+0 — never the 30-day horizon that alternative rejects),
 *     so 20 s allows semaphore queueing plus fetch/accept overhead with headroom.
 * (c) It stays well under any client-side HTTP request timeout: no `requestTimeout`
 *     is configured on the Fastify server (`app.ts`/`app-config.ts` carry only pg
 *     pool/connect timeouts), so 20 s sits comfortably inside default client/proxy
 *     limits.
 */
export const REFRESH_SCHEDULE_DEADLINE_MS = 20_000;

/** The poll cadence while awaiting the worker's terminal run state. A mechanical choice, not policy (the `recheck.ts` `POLL_INTERVAL_MS` precedent). */
export const REFRESH_SCHEDULE_POLL_INTERVAL_MS = 100;

export interface RefreshScheduleTuning {
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
}

let testTuning: RefreshScheduleTuning | null = null;

/**
 * Test-only seam shortening the stage-and-poll bound (the timeout test must not wait
 * out the 20 s production bound). The `theatres` router's `TheatreSearchContext`
 * carries only `{ db }` — it has no dedicated context factory to extend with tuning
 * without touching shared context files — so the suite injects the short bound here
 * instead of via context. Production never calls this; tests must reset to `null`
 * (the suite's `afterEach` does).
 */
export function __setRefreshScheduleTuningForTests(tuning: RefreshScheduleTuning | null): void {
  testTuning = tuning;
}

interface ProviderRunPollRow {
  readonly run_id: string;
  readonly state: string;
  readonly fail_cause: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * S63.5 — poll the staged run's `provider_run` state to a terminal outcome, bounded
 * by the tuning. Returns `DONE | FAILED | CANCELLED` (the exact state machine B2
 * leases and B5/B5F terminalize), or `null` when the bound elapses first with the run
 * still `PENDING`/`LEASED` (a caller can retry later; the worker-side run is reclaimed
 * by the sweeper). Mirrors `recheck.ts`'s `awaitOutcome` shape.
 */
async function awaitRunTerminal(
  db: SqlClient,
  runId: string,
  tuning: RefreshScheduleTuning,
): Promise<"DONE" | "FAILED" | "CANCELLED" | null> {
  const deadline = Date.now() + tuning.deadlineMs;
  for (;;) {
    const rows = await runStatement<ProviderRunPollRow>(db, PROVIDER_RUN_READ_BY_ID, [runId]);
    const state = rows[0]?.state;
    if (state === "DONE" || state === "FAILED" || state === "CANCELLED") {
      return state;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(tuning.pollIntervalMs);
  }
}

/**
 * `theatres.refreshSchedule` (S63.5; ADR 0100 "Explicit On-Demand Refresh") — a
 * bounded, single-date (D+0, today in the theatre's own timezone)
 * `SCHEDULE_RESOLUTION` run on demand. Stages the run-only work (no search, no job,
 * no subscription — `stageOnDemandScheduleRefresh`, the preview path's discipline),
 * then polls for its terminal outcome within this request:
 * `RESOLVED` (the day now holds ≥1 performance), `EMPTY` (it resolved with none), or
 * `FAILED` (worker failure, cancellation, unstaged run, or the poll bound elapsed).
 *
 * The api role never runs Chrome/Playwright (`index.ts` header) — the actual scrape
 * executes asynchronously in the fetch-worker process; this route only stages and
 * awaits it.
 */
export const refreshSchedule = t.procedure
  .input(RefreshScheduleInputSchema)
  .mutation(async ({ input, ctx }): Promise<RefreshScheduleResponse> => {
    const { db } = ctx;
    const sql = poolClient(db);

    // Theatre existence first (the `movies.ts` S21.2 pattern): zero rows is NOT_FOUND
    // with the boundary's own zeroRowsMeans text.
    const theatreRows = await readTheatreById(sql, input.theatreId);
    const theatre = theatreRows[0];
    if (theatre === undefined) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: THEATRE_READ_BY_ID.zeroRowsMeans,
      });
    }

    // Provider is DERIVED from the namespaced id prefix, never a request field (the
    // `movies.ts` S21.3 pattern). `TheatreIdSchema` already rejected unnamespaced or
    // foreign-kind ids, so this parse is guaranteed to succeed; handle the impossible
    // case loudly anyway.
    const parsed = parseNamespacedId(input.theatreId);
    if (!parsed.ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "theatre id did not parse as a namespaced id",
      });
    }
    const providerId = parsed.value.providerId;

    // D+0 in the theatre's own timezone — never the server's. `toTheatreLocal` is the
    // single definition of what the schedule fetch key's local date means (E6.4).
    const localDate = toTheatreLocal(
      UtcInstantSchema.parse(new Date().toISOString()),
      IanaTimezoneSchema.parse(theatre.timezone),
    ).localDate;

    // Stage the run-only SCHEDULE_RESOLUTION in one transaction (never raw
    // multi-statement logic in the handler — the `transactions.ts` discipline).
    const staged = await withTransaction(db, (tx) =>
      stageOnDemandScheduleRefresh(tx, {
        providerId,
        theatreId: input.theatreId,
        localDate,
      }),
    );
    if (staged.runId === null) {
      // Nothing staged and nothing live to poll (missing provider fence): an honest
      // retryable FAILED, not a hang.
      return RefreshScheduleResponseSchema.parse({ status: "FAILED", localDate });
    }

    const tuning = testTuning ?? {
      deadlineMs: REFRESH_SCHEDULE_DEADLINE_MS,
      pollIntervalMs: REFRESH_SCHEDULE_POLL_INTERVAL_MS,
    };
    const terminal = await awaitRunTerminal(sql, staged.runId, tuning);
    if (terminal === null || terminal === "FAILED" || terminal === "CANCELLED") {
      return RefreshScheduleResponseSchema.parse({ status: "FAILED", localDate });
    }

    // DONE: distinguish RESOLVED from EMPTY by reading back the day's schedule the
    // same way `theatres.movies` does (`readScheduleRange` — no new read helper).
    // The key exists (this request created or converged on it), so an absent day is
    // impossible; treat it as zero performances defensively.
    const range = await readScheduleRange(sql, {
      providerId,
      theatreId: input.theatreId,
      dateFrom: localDate,
      dateTo: localDate,
    });
    const performanceCount =
      range.days.find((day) => day.localDate === localDate)?.performances.length ?? 0;
    return RefreshScheduleResponseSchema.parse({
      status: performanceCount > 0 ? "RESOLVED" : "EMPTY",
      localDate,
    });
  });
