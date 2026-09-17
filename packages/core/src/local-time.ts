import {
  UtcInstantSchema,
  IanaTimezoneSchema,
  type UtcInstant,
  type IanaTimezone,
} from "./result-contracts.js";
import { WeekdaySchema, type Weekday, type PerformancePredicate } from "./search-spec.js";
import { canonicalizeDateRuns } from "./search-spec.js";

export type DayWindow = Extract<PerformancePredicate, { kind: "TIME_WINDOW" }>;

/**
 * S36.1 + S53.3 — deterministic theatre-local schedule window plan.
 *
 * `range` is the earliest-to-latest envelope from the (normalized) date scope,
 * needed for one `readScheduleRange`. `timeWindow` is the single reachable
 * TIME_WINDOW or null. `scheduleDates` is the ordered, duplicate-free list of
 * ALL selected theatre-local dates that survive the optional
 * `TIME_WINDOW.days` weekday rule (ADR 0050 §2-§3). Empty expansion is never
 * returned — the resolver rejects it with BAD_REQUEST per amendment
 * docs/adr/0028-recurring-window-search-admission.md:207-216 and ADR 0050 §2.
 */
export type ScheduleWindowPlan = {
  readonly range: { readonly from: string; readonly to: string };
  readonly timeWindow: DayWindow | null;
  readonly scheduleDates: readonly string[];
};

/**
 * BAD_REQUEST-compatible error for the schedule-window resolver.
 * Carries `code: "BAD_REQUEST"` so the server route can map it to the
 * existing tRPC `BAD_REQUEST` outcome before any idempotency/admission/write
 * per S36.1/S36.3 and docs/adr/0028-recurring-window-search-admission.md:207-216.
 */
export class ScheduleWindowError extends Error {
  public readonly code = "BAD_REQUEST" as const;
  public readonly httpStatus = 400 as const;
  public readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "ScheduleWindowError";
    this.reason = reason;
  }
}

const MS_PER_DAY = 86_400_000;

function weekdayForIsoDate(date: string): Weekday {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0 Sunday .. 6 Saturday
  const map: readonly Weekday[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ] as const;
  const wd = map[day]!;
  return WeekdaySchema.parse(wd);
}

/**
 * S36.1 + S53.3 — AND-only resolver with S53 normalized-scope support.
 *
 * Traverses only AND nodes for reachable DATE_RANGE/TIME_WINDOW. For
 * specVersion 2, a single date scope may be one DATE_RANGE leaf or one OR
 * whose direct children are DATE_RANGE leaves, reachable through AND nodes.
 * Rejects with BAD_REQUEST: date predicate below NOT, DATE_RANGE below a
 * nested OR, date-scope OR containing a non-DATE_RANGE child, more than one
 * reachable scope, no reachable scope, multiple TIME_WINDOWs, crossing
 * TIME_WINDOW, or empty weekday-filtered plan. The scheduleDates list is the
 * ordered, duplicate-free expansion of ALL canonical runs (not just the
 * envelope), filtered by TIME_WINDOW.days when present.
 */
export function resolveScheduleWindowPlan(where: PerformancePredicate): ScheduleWindowPlan {
  const collectedRuns: { from: string; to: string }[] = [];
  const windows: DayWindow[] = [];
  let violated = false;
  let violatedReason = "ambiguous_predicate";
  let scopesFound = 0;

  function walk(node: PerformancePredicate, allowed: boolean): void {
    switch (node.kind) {
      case "AND": {
        for (const child of node.of) walk(child, allowed);
        break;
      }
      case "OR": {
        if (allowed) {
          const allDate = node.of.every((c) => c.kind === "DATE_RANGE");
          const anyDate = node.of.some((c) => c.kind === "DATE_RANGE");
          if (allDate && anyDate) {
            scopesFound += 1;
            for (const c of node.of) {
              const dr = c as Extract<PerformancePredicate, { kind: "DATE_RANGE" }>;
              collectedRuns.push({ from: dr.from, to: dr.to });
            }
          } else if (anyDate) {
            violated = true;
            violatedReason = "date_or_mixed";
          } else {
            for (const child of node.of) walk(child, false);
          }
        } else {
          for (const child of node.of) walk(child, false);
        }
        break;
      }
      case "NOT": {
        walk(node.of, false);
        break;
      }
      case "DATE_RANGE": {
        if (allowed) {
          scopesFound += 1;
          collectedRuns.push({ from: node.from, to: node.to });
        } else {
          violated = true;
          violatedReason = "ambiguous_predicate";
        }
        break;
      }
      case "TIME_WINDOW": {
        if (allowed) windows.push(node);
        else {
          violated = true;
          violatedReason = "ambiguous_predicate";
        }
        break;
      }
      case "MOVIE":
      case "ATTRIBUTE":
      case "AUDITORIUM":
      case "PRICE":
      case "RUNTIME":
      case "FORMAT":
        break;
    }
  }

  walk(where, true);

  if (violated) {
    throw new ScheduleWindowError(
      `schedule window predicate is ambiguous: DATE_RANGE or TIME_WINDOW under OR/NOT or mixed date OR (${violatedReason})`,
      violatedReason,
    );
  }
  if (scopesFound === 0) {
    throw new ScheduleWindowError(
      "schedule window requires exactly one reachable date scope",
      "missing_date_range",
    );
  }
  if (scopesFound > 1) {
    throw new ScheduleWindowError(
      "schedule window requires exactly one reachable date scope (found multiple)",
      "multiple_date_ranges",
    );
  }
  if (windows.length > 1) {
    throw new ScheduleWindowError(
      "schedule window requires at most one reachable TIME_WINDOW",
      "multiple_time_windows",
    );
  }

  const timeWindow: DayWindow | null = windows[0] ?? null;

  if (timeWindow !== null && timeWindow.startLocal > timeWindow.endLocal) {
    throw new ScheduleWindowError(
      `TIME_WINDOW startLocal (${timeWindow.startLocal}) must not exceed endLocal (${timeWindow.endLocal})`,
      "crossing_time_window",
    );
  }

  const canonicalRuns = canonicalizeDateRuns(collectedRuns);
  if (canonicalRuns.length === 0) {
    throw new ScheduleWindowError("invalid DATE_RANGE", "invalid_date_range");
  }
  const range = {
    from: canonicalRuns[0]!.from,
    to: canonicalRuns[canonicalRuns.length - 1]!.to,
  };

  const fromToValid = (s: string) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (!fromToValid(range.from) || !fromToValid(range.to)) {
    throw new ScheduleWindowError("invalid DATE_RANGE", "invalid_date_range");
  }

  const allDates: string[] = [];
  for (const run of canonicalRuns) {
    const fromMs = Date.parse(`${run.from}T00:00:00Z`);
    const toMs = Date.parse(`${run.to}T00:00:00Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new ScheduleWindowError("invalid DATE_RANGE", "invalid_date_range");
    }
    for (let ms = fromMs; ms <= toMs; ms += MS_PER_DAY) {
      const dateStr = new Date(ms).toISOString().slice(0, 10);
      allDates.push(dateStr);
    }
  }

  let scheduleDates: string[];
  if (timeWindow === null) {
    scheduleDates = allDates;
  } else {
    scheduleDates = [];
    for (const dateStr of allDates) {
      const wd = weekdayForIsoDate(dateStr);
      if (timeWindow.days.includes(wd)) scheduleDates.push(dateStr);
    }
  }

  if (scheduleDates.length === 0) {
    throw new ScheduleWindowError("schedule window resolves to zero dates", "empty_plan");
  }

  return {
    range,
    timeWindow,
    scheduleDates,
  };
}

/**
 * S36.2 + S53.3 — theatre-local evaluator shared by warm-cache selection, cold fan-out,
 * and aggregate assembly.
 *
 * Derives local date/weekday/time from the performance UTC instant and IANA
 * timezone via `toTheatreLocal` (E6), requires membership in the planned
 * selected-date list (`plan.scheduleDates`) as well as applying the optional
 * time window, not merely falling inside the enclosing envelope. An omitted
 * date in a sparse selection never matches, even if inside `plan.range`.
 * Never inspects browser locale, client clock, `performance.local_date`, or a
 * parsed UTC calendar day.
 */
export function matchesScheduleWindow(
  utcInstant: UtcInstant,
  timezone: IanaTimezone,
  plan: ScheduleWindowPlan,
): boolean {
  UtcInstantSchema.parse(utcInstant);
  IanaTimezoneSchema.parse(timezone);
  const derived = toTheatreLocal(utcInstant, timezone);
  if (!plan.scheduleDates.includes(derived.localDate)) {
    return false;
  }
  if (plan.timeWindow === null) return true;
  return matchesDayWindows(derived, [plan.timeWindow]);
}

export function toTheatreLocal(
  utc: UtcInstant,
  tz: IanaTimezone,
): {
  localDateTime: string;
  localDate: string;
  utcOffset: string;
  weekday: Weekday;
} {
  UtcInstantSchema.parse(utc);
  IanaTimezoneSchema.parse(tz);

  const d = new Date(utc);

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    timeZoneName: "longOffset",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  // E6.4: localDate is what performance.local_date and the schedule fetch key
  // (providerId, theatreId, localDate) mean. The two must agree, or single-flighting
  // fetches the wrong day.
  const localDate = `${year}-${month}-${day}`;
  const localDateTime = `${localDate}T${hour}:${minute}:${second}`;

  const offsetString = get("timeZoneName");
  const utcOffset = offsetString.replace("GMT", "");

  const weekdayString = WeekdaySchema.parse(get("weekday").toUpperCase());

  return { localDateTime, localDate, utcOffset, weekday: weekdayString };
}

export function matchesDayWindows(
  derived: { localDate: string; localDateTime: string; weekday: Weekday },
  windows: readonly DayWindow[],
): boolean {
  const time = derived.localDateTime.slice(11, 16);

  return windows.some((w) => {
    if (!w.days.includes(derived.weekday)) return false;
    if (w.startLocal <= w.endLocal) {
      return time >= w.startLocal && time <= w.endLocal;
    } else {
      // crosses midnight
      return time >= w.startLocal || time <= w.endLocal;
    }
  });
}
