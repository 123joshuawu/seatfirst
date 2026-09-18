import { TRPCError } from "@trpc/server";

import {
  CapacityPreviewInputSchema,
  CAPACITY_PREVIEW_UNAVAILABLE,
  TIME_OF_DAY_PRESET_BOUNDS,
  matchesFormatPredicate,
  matchesMoviePredicate,
  matchesScheduleWindow,
  normalizeWhereForV2,
  performancePolicy,
  RateLimitErrorSchema,
  resolveScheduleWindowPlan,
  resolveWeekendPreset,
  SearchSpecNormalizationError,
  ScheduleWindowError,
  ShowtimeStatusSchema,
} from "@seatfirst/core";
import type {
  CapacityPreviewInput,
  CapacityPreviewResponse,
  CapacityPreviewV1Input,
  CapacityPreviewV2Input,
  PerformancePredicate,
  ScheduleWindowPlan,
  Weekday,
} from "@seatfirst/core";
import {
  poolClient,
  previewScheduleRuns,
  readScheduleRange,
  readTheatreById,
  withTransaction,
} from "@seatfirst/durability";
import type { ScheduleRange } from "@seatfirst/durability";
import { StructuredHttpError, t, SEARCH_DEADLINE_MS } from "./create.js";

/**
 * `searches.capacityPreview` (S47; ADR 0039 decision 3 + Amendment) — the pre-submit
 * capacity gate. Read-mostly, schedule-tier-only: counts the performances the requested
 * search would admit using EXACTLY `searches.create`'s five-part eligibility test
 * (`create.ts`'s per-performance filter — sold-out policy, MOVIE, FORMAT,
 * schedule-window), resolving cold dates through the subscription-less preview-run
 * corridor (Amendment A1). The answer is exact-or-unavailable (Amendment A3):
 * `{ kind: "ok", matchedCount, ceilingExceeded }` or
 * `{ kind: "CAPACITY_PREVIEW_UNAVAILABLE" }` — never a partial number.
 *
 * Cost posture (ADR 0039 + Amendment A2): no `search` row, nothing against the
 * 20-searches/hour budget; the request itself consumes one unit of the accepted
 * `facetCounts` dimension, and each cold date this request actually resolves charges one
 * existing weighted-fetch unit to the initiating session.
 *
 * The procedure builds on the shared `SearchCreateContext` (`t` from create.ts) like
 * `facetCounts`, so it is served by the ordinary `fastifyTRPCPlugin` mounting without
 * bespoke registration; every policy figure comes from injected context — no defaults.
 */

/** Engineering poll tick for the resolution wait loop — a cadence, not a policy number. */
const POLL_INTERVAL_MS = 200;

/** All seven weekdays: the "Any day" set ADR 0039 decision 1 pins for Any day + Evening. */
const ALL_WEEKDAYS: Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

function cachedStatus(status: string | null) {
  return ShowtimeStatusSchema.parse(status ?? "UNKNOWN");
}

/**
 * Resolve the request's window to the same `ScheduleWindowPlan` shape admission uses.
 * Mirrors `buildSearchSpec`'s emission semantics (ADR 0039 decision 1): selected
 * weekdays with bounds from the time-of-day preset; Any day + Evening = all seven
 * weekdays with evening bounds; no weekday restriction when nothing constrains days.
 * The date span is the horizon preset when given, else today through
 * `maxDateSpanDays - 1` — the accepted v1 search-date bound via ctx.limits, the same
 * fallback facetCounts uses (`facetCounts.ts`'s no-plan branch). FORMAT rides in the
 * where-tree so `matchesFormatPredicate(perf.formatCode, where)` sees it exactly as
 * create's does.
 */
function buildWindow(
  input: CapacityPreviewV1Input,
  todayLocal: string,
  maxDateSpanDays: number,
): { plan: ScheduleWindowPlan; where: PerformancePredicate } {
  const preset =
    input.horizon !== undefined ? resolveWeekendPreset(input.horizon, todayLocal) : null;
  const range =
    preset !== null
      ? preset.range
      : {
          from: todayLocal,
          to: new Date(Date.now() + (maxDateSpanDays - 1) * 86_400_000).toISOString().slice(0, 10),
        };
  const weekdays: readonly Weekday[] | undefined =
    input.weekdays !== undefined && input.weekdays.length > 0
      ? input.weekdays
      : preset !== null
        ? preset.days
        : input.timeOfDay !== undefined && input.timeOfDay !== "allTimes"
          ? ALL_WEEKDAYS
          : undefined;
  const bounds =
    input.timeOfDay !== undefined
      ? TIME_OF_DAY_PRESET_BOUNDS[input.timeOfDay]
      : TIME_OF_DAY_PRESET_BOUNDS.allTimes;

  const parts: PerformancePredicate[] = [
    { kind: "MOVIE", ids: [input.movieId] },
    { kind: "DATE_RANGE", from: range.from, to: range.to },
  ];
  if (weekdays !== undefined) {
    parts.push({
      kind: "TIME_WINDOW",
      days: [...weekdays],
      startLocal: bounds.startLocal,
      endLocal: bounds.endLocal,
    });
  }
  if (input.formatCode !== undefined && input.formatCode !== null) {
    parts.push({ kind: "FORMAT", code: input.formatCode });
  }
  return {
    plan: resolveScheduleWindowPlan({ kind: "AND", of: parts }),
    where: { kind: "AND", of: parts },
  };
}

function isCapacityPreviewV2Input(input: CapacityPreviewInput): input is CapacityPreviewV2Input {
  return (input as { specVersion?: number }).specVersion === 2;
}

/**
 * One theatre's eligibility count over the plan's dates, verbatim from create.ts's
 * loop: a date is warm iff present AND captured within freshnessMs; a performance is
 * eligible iff not sold-out by policy, matching MOVIE, matching FORMAT, and inside the
 * resolved schedule window (window projection errors count as non-matching).
 */
function countEligible(
  range: ScheduleRange,
  theatreTimezone: string,
  plan: ScheduleWindowPlan,
  where: PerformancePredicate,
  dates: readonly string[],
  nowForFreshness: number,
  freshnessMs: number,
): { freshCount: number; coldDates: readonly string[] } {
  const dayByDate = new Map(range.days.map((day) => [day.localDate, day]));
  let freshCount = 0;
  const coldDates: string[] = [];
  for (const localDate of dates) {
    const day = dayByDate.get(localDate);
    if (
      day === undefined ||
      day.capturedAt === null ||
      nowForFreshness - day.capturedAt.getTime() > freshnessMs
    ) {
      coldDates.push(localDate);
      continue;
    }
    for (const perf of day.performances) {
      if (performancePolicy(cachedStatus(perf.status)) === "SKIP_SOLD_OUT") continue;
      if (!matchesMoviePredicate(perf.movieId, perf.title ?? null, where)) continue;
      if (!matchesFormatPredicate(perf.formatCode, where)) continue;
      let matches: boolean;
      try {
        matches = matchesScheduleWindow(perf.startsAt.toISOString(), theatreTimezone, plan);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      freshCount += 1;
    }
  }
  return { freshCount, coldDates };
}

export const capacityPreview = t.procedure
  .input(CapacityPreviewInputSchema)
  .query(async ({ input, ctx }): Promise<CapacityPreviewResponse> => {
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to preview capacity (session.bootstrap first)",
      });
    }

    // S16.13 step 2's order mirrored: rate check BEFORE any DB read. Redis loss fails
    // OPEN (S16.16) but never silently (O11.8) — same log-and-continue posture as
    // create.ts/facetCounts.ts.
    let windowCheck;
    try {
      windowCheck = await ctx.limiter.check(sessionId, "facetCounts", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.capacityPreview: rate-limit window check failed (failing open)",
      );
      windowCheck = { allowed: true };
    }
    if (!windowCheck.allowed) {
      throw new StructuredHttpError({
        code: "TOO_MANY_REQUESTS",
        message: `session rate limit exceeded: ${windowCheck.limit}`,
        body: RateLimitErrorSchema.parse({
          code: "RATE_LIMITED",
          limit: windowCheck.limit,
          retryAfterSeconds: windowCheck.retryAfterSeconds,
        }),
      });
    }

    const nowForFreshness = Date.now();
    let plan: ScheduleWindowPlan;
    let where: PerformancePredicate;
    if (isCapacityPreviewV2Input(input)) {
      try {
        const normalizedWhere = normalizeWhereForV2(input.where);
        where = normalizedWhere;
        plan = resolveScheduleWindowPlan(normalizedWhere);
      } catch (error) {
        if (error instanceof SearchSpecNormalizationError || error instanceof ScheduleWindowError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (error as Error).message,
          });
        }
        throw error;
      }
    } else {
      const todayLocal = new Date(nowForFreshness).toISOString().slice(0, 10);
      const built = buildWindow(input, todayLocal, ctx.limits.maxDateSpanDays);
      plan = built.plan;
      where = built.where;
    }
    async function readAll(): Promise<
      { theatreId: string; range: ScheduleRange; timezone: string }[]
    > {
      return Promise.all(
        input.theatreIds.map(async (theatreId) => {
          const [range, theatreRows] = await Promise.all([
            readScheduleRange(poolClient(ctx.db), {
              providerId: input.providerId,
              theatreId,
              dateFrom: plan.range.from,
              dateTo: plan.range.to,
            }),
            readTheatreById(poolClient(ctx.db), theatreId),
          ]);
          const theatre = theatreRows[0];
          if (theatre === undefined) {
            throw new TRPCError({ code: "NOT_FOUND", message: `unknown theatre ${theatreId}` });
          }
          return { theatreId, range, timezone: theatre.timezone };
        }),
      );
    }

    let reads = await readAll();
    let counted = reads.map((read) => ({
      theatreId: read.theatreId,
      ...countEligible(
        read.range,
        read.timezone,
        plan,
        where,
        plan.scheduleDates,
        nowForFreshness,
        ctx.freshnessMs,
      ),
    }));
    let cold = counted.flatMap((entry) =>
      entry.coldDates.map((localDate) => ({ theatreId: entry.theatreId, localDate })),
    );

    let dispatchedColdCount = 0;
    if (cold.length > 0) {
      // Amendment A1: dispatch subscription-less preview runs for exactly the cold
      // dates. Coalescing is by construction (deterministic run_key); completion and
      // outbox-loss re-arm are invariant-guarded durability behavior.
      dispatchedColdCount = cold.length;
      await withTransaction(ctx.db, (tx) =>
        previewScheduleRuns(tx, { providerId: input.providerId, keys: cold }),
      );

      // Amendment A3: wait until every cold date is present-and-fresh or the accepted
      // budget expires — exact or unavailable, never partial.
      const deadlineMs = ctx.capacityPreviewDeadlineMs ?? SEARCH_DEADLINE_MS;
      const pollIntervalMs = ctx.capacityPreviewPollIntervalMs ?? POLL_INTERVAL_MS;
      const deadlineAt = Date.now() + deadlineMs;
      while (cold.length > 0) {
        if (Date.now() >= deadlineAt) {
          return { kind: CAPACITY_PREVIEW_UNAVAILABLE };
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const now = Date.now();
        reads = await readAll();
        counted = reads.map((read) => ({
          theatreId: read.theatreId,
          ...countEligible(
            read.range,
            read.timezone,
            plan,
            where,
            plan.scheduleDates,
            now,
            ctx.freshnessMs,
          ),
        }));
        cold = counted.flatMap((entry) =>
          entry.coldDates.map((localDate) => ({ theatreId: entry.theatreId, localDate })),
        );
      }
    }

    const matchedCount = counted.reduce((sum, entry) => sum + entry.freshCount, 0);

    // Amendment A2: one existing weighted-fetch unit per cold date this request
    // actually resolved, charged to the initiating session. Charge-after-success
    // (S16.5 posture, deliberate warn-and-continue like every charge below): an
    // UNAVAILABLE answer has resolved nothing and charges nothing.
    if (dispatchedColdCount > 0) {
      try {
        for (let i = 0; i < dispatchedColdCount; i++) {
          await ctx.limiter.charge(sessionId, "fetches", 1);
        }
      } catch (error) {
        ctx.logger.warn(
          { session_id: sessionId, error },
          "searches.capacityPreview: fetches charge failed after successful resolution (failing open)",
        );
      }
    }

    try {
      await ctx.limiter.charge(sessionId, "facetCounts", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.capacityPreview: rate-limit charge failed after successful read (failing open)",
      );
    }

    return {
      kind: "ok",
      matchedCount,
      ceilingExceeded: matchedCount > ctx.limits.maxResolvedShowtimes,
    };
  });
