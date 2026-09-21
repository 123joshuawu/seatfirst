import { TRPCError } from "@trpc/server";

import {
  FacetCountsInputSchema,
  matchesFormatPredicate,
  matchesScheduleWindow,
  performancePolicy,
  resolveScheduleWindowPlan,
  ShowtimeStatusSchema,
} from "@seatfirst/core";
import type {
  DateScope,
  FacetAxisKind,
  FacetCountsInput,
  FacetCountsResponse,
  PerformancePredicate,
  ScheduleWindowPlan,
  Weekday,
} from "@seatfirst/core";
import { poolClient, readScheduleRange, readTheatreById } from "@seatfirst/durability";
import type { ScheduleRange } from "@seatfirst/durability";
import {
  RateLimitErrorSchema,
  resolveWeekendPreset,
  TIME_OF_DAY_PRESET_BOUNDS,
} from "@seatfirst/core";
import { StructuredHttpError, t } from "./create.js";

/**
 * `searches.facetCounts` (S43; ADR 0036) — a read-only, schedule-tier-only query
 * answering "how many showtimes match if I also pick candidate X on axis A", for a
 * bounded set of (axis, candidate) pairs, over each theatre's already-cached schedule
 * rows. Zero durable writes (no `search`/`admission_reservation`/`run_key`/
 * `provider_run`/`outbox` row of any kind), zero upstream traffic, exempt from
 * `searches.create`'s ceilings and bounded instead by the injected `facetCounts`
 * rate-limit dimension and `facetCountMaxCandidates` cap (ADR 0036 decision 3).
 *
 * The procedure builds on the shared `SearchCreateContext` (`t` from create.ts), so
 * it is served by the ordinary `fastifyTRPCPlugin` mounting without bespoke
 * registration; every policy figure comes from that injected context — no defaults.
 */

function cachedStatus(status: string | null) {
  return ShowtimeStatusSchema.parse(status ?? "UNKNOWN");
}

type FacetBase = FacetCountsInput["base"];

interface FacetCandidate {
  readonly kind: FacetAxisKind;
  readonly responseCandidate: string;
  readonly dateScopeOverride: DateScope | null;
}

const ALL_WEEKDAYS: readonly Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

function flattenFacetCandidates(axes: FacetCountsInput["axes"]): readonly FacetCandidate[] {
  return axes.flatMap((axis): readonly FacetCandidate[] => {
    if (axis.kind === "DATE_SCOPE") {
      return axis.candidates.map((candidate) => ({
        kind: axis.kind,
        responseCandidate: candidate.key,
        dateScopeOverride: candidate.dateScope,
      }));
    }
    if (axis.kind === "DATE") {
      return axis.candidates.map((candidate) => ({
        kind: axis.kind,
        responseCandidate: candidate,
        dateScopeOverride: { kind: "DATE_RANGE", from: candidate, to: candidate },
      }));
    }
    return axis.candidates.map((candidate) => ({
      kind: axis.kind,
      responseCandidate: candidate,
      dateScopeOverride: null,
    }));
  });
}

function formatPredicate(code: string): Extract<PerformancePredicate, { kind: "FORMAT" }> {
  return { kind: "FORMAT", code };
}

/**
 * Resolve one candidate's theatre-local plan. Date-scope paths deliberately
 * propagate planner failures so the procedure can reject before it reads the
 * cache; the legacy horizon-only path retains its no-plan fallback.
 */
function planForCandidate(
  base: FacetBase,
  candidate: FacetCandidate,
  todayLocal: string,
): ScheduleWindowPlan | null {
  let weekdays = base.weekdays;
  let timeOfDay = base.timeOfDay;
  let horizon = base.horizon;
  if (candidate.kind === "WEEKDAY") weekdays = [candidate.responseCandidate as Weekday];
  else if (candidate.kind === "TIME_OF_DAY") {
    timeOfDay = candidate.responseCandidate as
      "allTimes" | "morning" | "afternoon" | "evening" | "late";
  } else if (candidate.kind === "HORIZON") {
    horizon = candidate.responseCandidate as "thisWeekend" | "nextThreeWeekends";
  }

  const dateScope = candidate.dateScopeOverride ?? base.dateScope;
  const usesDateScope = dateScope !== undefined;
  let scope: DateScope;
  let defaultDays: readonly Weekday[];
  if (usesDateScope) {
    scope = dateScope;
    defaultDays = ALL_WEEKDAYS;
  } else {
    if (horizon === undefined) return null;
    const preset = resolveWeekendPreset(horizon, todayLocal);
    scope = { kind: "DATE_RANGE", from: preset.range.from, to: preset.range.to };
    defaultDays = preset.days;
  }

  const bounds =
    timeOfDay !== undefined
      ? TIME_OF_DAY_PRESET_BOUNDS[timeOfDay]
      : TIME_OF_DAY_PRESET_BOUNDS.allTimes;
  const where: PerformancePredicate = {
    kind: "AND",
    of: [
      scope,
      {
        kind: "TIME_WINDOW",
        days: [...(weekdays ?? defaultDays)],
        startLocal: bounds.startLocal,
        endLocal: bounds.endLocal,
      },
    ],
  };
  try {
    return resolveScheduleWindowPlan(where);
  } catch (error) {
    if (usesDateScope) throw error;
    return null;
  }
}

function epochDay(localDate: string): number {
  const [yearText, monthText, dayText] = localDate.split("-");
  return Math.floor(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)) / (24 * 60 * 60 * 1_000),
  );
}

export const facetCounts = t.procedure
  .input(FacetCountsInputSchema)
  .query(async ({ input, ctx }): Promise<FacetCountsResponse> => {
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to count facets (session.bootstrap first)",
      });
    }

    const maxCandidates = ctx.rateLimitConfig.facetCountMaxCandidates;
    const totalCandidates = input.axes.reduce((sum, axis) => sum + axis.candidates.length, 0);
    if (totalCandidates > maxCandidates) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `too many candidates: ${totalCandidates} exceeds ${maxCandidates}`,
      });
    }

    // S16.13 step 2's order mirrored: rate check BEFORE any DB read. Redis loss fails
    // OPEN (S16.16) but never silently (O11.8) — same log-and-continue posture as
    // `enforceRateLimits` in create.ts.
    let windowCheck;
    try {
      windowCheck = await ctx.limiter.check(sessionId, "facetCounts", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.facetCounts: rate-limit window check failed (failing open)",
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

    const nowForFreshness = new Date();
    const todayLocal = nowForFreshness.toISOString().slice(0, 10);
    const candidates = flattenFacetCandidates(input.axes);

    // Validate each distinct supplied date scope before any schedule/theatre read.
    // This deliberately uses the shared planner, rather than treating a malformed
    // scope as the no-horizon fallback used by the legacy axes.
    const dateScopes = new Map<string, DateScope>();
    if (input.base.dateScope !== undefined) {
      dateScopes.set(JSON.stringify(input.base.dateScope), input.base.dateScope);
    }
    for (const candidate of candidates) {
      if (candidate.dateScopeOverride !== null) {
        dateScopes.set(JSON.stringify(candidate.dateScopeOverride), candidate.dateScopeOverride);
      }
    }
    for (const scope of dateScopes.values()) {
      try {
        const scopePlan = resolveScheduleWindowPlan({ kind: "AND", of: [scope] });
        const spanDays = epochDay(scopePlan.range.to) - epochDay(scopePlan.range.from) + 1;
        if (spanDays > ctx.limits.maxDateSpanDays) {
          throw new Error(`date scope span ${spanDays} exceeds ${ctx.limits.maxDateSpanDays} days`);
        }
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "invalid date scope",
        });
      }
    }

    // Planning every candidate here both gives the one-read union below and rejects
    // a date scope whose weekday/time-window intersection is empty before any DB read.
    const candidatePlans = candidates.map((candidate) => {
      try {
        return { candidate, plan: planForCandidate(input.base, candidate, todayLocal) };
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "invalid date scope",
        });
      }
    });

    // One inclusive date span covers every candidate's resolved range, so one
    // readScheduleRange call per theatre serves every candidate.
    let unionFrom: string | null = null;
    let unionTo: string | null = null;
    for (const { plan } of candidatePlans) {
      if (plan !== null) {
        if (unionFrom === null || plan.range.from < unionFrom) unionFrom = plan.range.from;
        if (unionTo === null || plan.range.to > unionTo) unionTo = plan.range.to;
      }
    }
    if (unionFrom === null || unionTo === null) {
      const maxSpanDays = ctx.limits.maxDateSpanDays;
      unionFrom = todayLocal;
      unionTo = new Date(nowForFreshness.getTime() + (maxSpanDays - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }

    const dateFrom: string = unionFrom;
    const dateTo: string = unionTo;
    const reads = await Promise.all(
      input.theatreIds.map(async (theatreId) => {
        const [range, theatreRows] = await Promise.all([
          readScheduleRange(poolClient(ctx.db), {
            providerId: input.providerId,
            theatreId,
            dateFrom,
            dateTo,
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

    const counts: FacetCountsResponse["counts"] = [];
    for (const { candidate, plan } of candidatePlans) {
      // ADR 0036 amendment (2026-09-21): reserved ANY FORMAT candidate — skips
      // the format predicate entirely (every performance matches regardless of
      // format). A `{kind:"FORMAT", code:"ANY"}` predicate would match nothing
      // since "ANY" is not a real provider format code, so null (same as a
      // non-FORMAT axis) is the only correct filter here.
      const formatFilter =
        candidate.kind === "FORMAT" && candidate.responseCandidate !== "ANY"
          ? formatPredicate(candidate.responseCandidate)
          : null;
      let count = 0;
      let coldTheatreCount = 0;
      for (const { range, timezone } of reads) {
        const dayByDate = new Map(range.days.map((day) => [day.localDate, day]));
        // Dates this candidate can possibly match: its resolved plan when one
        // exists, otherwise every day the read returned (no-horizon scope).
        const relevantDates =
          plan !== null ? plan.scheduleDates : range.days.map((day) => day.localDate);
        let hasColdDate = false;
        let theatreCount = 0;
        for (const date of relevantDates) {
          const day = dayByDate.get(date);
          if (day === undefined) {
            hasColdDate = true;
            continue;
          }
          const capturedAt = day.capturedAt;
          const isStale =
            capturedAt === null ||
            nowForFreshness.getTime() - capturedAt.getTime() > ctx.freshnessMs;
          if (isStale) {
            hasColdDate = true;
            continue;
          }
          for (const perf of day.performances) {
            if (performancePolicy(cachedStatus(perf.status)) === "SKIP_SOLD_OUT") continue;
            if (candidate.kind === "MOVIE") {
              if (perf.movieId !== candidate.responseCandidate) continue;
            } else if (input.base.movieId !== undefined && input.base.movieId !== null) {
              if (perf.movieId !== input.base.movieId) continue;
            }
            if (formatFilter !== null && !matchesFormatPredicate(perf.formatCode, formatFilter)) {
              continue;
            }
            if (plan !== null) {
              let matches: boolean;
              try {
                matches = matchesScheduleWindow(perf.startsAt.toISOString(), timezone, plan);
              } catch {
                matches = false;
              }
              if (!matches) continue;
            }
            theatreCount += 1;
          }
        }
        count += theatreCount;
        if (hasColdDate) coldTheatreCount += 1;
      }
      counts.push({
        kind: candidate.kind,
        candidate: candidate.responseCandidate,
        count,
        coldTheatreCount,
      });
    }

    // S16.5's charge-after posture: the guarded action here is the cache read, so the
    // charge follows successful reads. A charge failure must not discard the computed
    // answer, but it is never silent either — same warn-and-continue degradation log
    // as the check above (O11.8). Deliberate choice, not an empty catch.
    try {
      await ctx.limiter.charge(sessionId, "facetCounts", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.facetCounts: rate-limit charge failed after successful read (failing open)",
      );
    }

    return { counts };
  });

/** Exported for the behavioral test suite's direct-procedure assertions. */
export type FacetCountsRead = { theatreId: string; range: ScheduleRange };
