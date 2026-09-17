import { afterEach, describe, expect, it } from "vitest";

import {
  IanaTimezoneSchema,
  type IanaTimezone,
  UtcInstantSchema,
  type UtcInstant,
  matchesDayWindows,
  toTheatreLocal,
  type DayWindow,
  resolveScheduleWindowPlan,
  matchesScheduleWindow,
  ScheduleWindowError,
  type Weekday,
  type PerformancePredicate,
} from "../src/index.js";

declare const process: { readonly env: Record<string, string | undefined> };

const originalTimezone = process.env.TZ;

afterEach(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

function local(utc: string, timezone: string) {
  return toTheatreLocal(UtcInstantSchema.parse(utc), IanaTimezoneSchema.parse(timezone));
}

describe("toTheatreLocal", () => {
  it("skips the nonexistent America/Chicago spring-forward hour", () => {
    // IANA 2026 rule: clocks jump from 01:59:59 CST to 03:00:00 CDT on March 8.
    expect(local("2026-03-08T07:59:59Z", "America/Chicago")).toEqual({
      localDateTime: "2026-03-08T01:59:59",
      localDate: "2026-03-08",
      utcOffset: "-06:00",
      weekday: "SUNDAY",
    });
    expect(local("2026-03-08T08:00:00Z", "America/Chicago")).toEqual({
      localDateTime: "2026-03-08T03:00:00",
      localDate: "2026-03-08",
      utcOffset: "-05:00",
      weekday: "SUNDAY",
    });
  });

  it("distinguishes both fall-back instants by their audited offsets", () => {
    // IANA 2026 rule: 01:30 occurs first in CDT and then in CST on November 1.
    expect(local("2026-11-01T06:30:00Z", "America/Chicago")).toMatchObject({
      localDateTime: "2026-11-01T01:30:00",
      utcOffset: "-05:00",
    });
    expect(local("2026-11-01T07:30:00Z", "America/Chicago")).toMatchObject({
      localDateTime: "2026-11-01T01:30:00",
      utcOffset: "-06:00",
    });
  });

  it("derives the previous local date used by schedule single-flight", () => {
    expect(local("2026-08-04T23:30:00Z", "America/Los_Angeles")).toMatchObject({
      localDateTime: "2026-08-04T16:30:00",
      localDate: "2026-08-04",
      weekday: "TUESDAY",
    });
    expect(local("2026-08-04T06:30:00Z", "America/Los_Angeles")).toMatchObject({
      localDateTime: "2026-08-03T23:30:00",
      localDate: "2026-08-03",
      weekday: "MONDAY",
    });
  });

  it("handles non-hour and non-DST offsets", () => {
    expect(local("2026-01-15T00:00:00Z", "Asia/Kolkata")).toMatchObject({
      localDateTime: "2026-01-15T05:30:00",
      utcOffset: "+05:30",
    });
    expect(local("2026-07-15T12:00:00Z", "America/Phoenix")).toMatchObject({
      localDateTime: "2026-07-15T05:00:00",
      utcOffset: "-07:00",
    });
  });

  it("uses zone rules rather than reusing a winter offset in summer", () => {
    expect(local("2026-01-15T12:00:00Z", "America/Chicago")).toMatchObject({
      localDateTime: "2026-01-15T06:00:00",
      utcOffset: "-06:00",
    });
    expect(local("2026-07-15T12:00:00Z", "America/Chicago")).toMatchObject({
      localDateTime: "2026-07-15T07:00:00",
      utcOffset: "-05:00",
    });
  });

  it("is independent of the process timezone", () => {
    process.env.TZ = "Pacific/Honolulu";
    const underHonolulu = local("2026-03-08T08:00:00Z", "America/Chicago");
    process.env.TZ = "Asia/Tokyo";
    expect(local("2026-03-08T08:00:00Z", "America/Chicago")).toEqual(underHonolulu);
  });
});

describe("matchesDayWindows", () => {
  const fridayEvening: DayWindow = {
    kind: "TIME_WINDOW",
    days: ["FRIDAY"],
    startLocal: "18:00",
    endLocal: "22:00",
  };

  it("ORs windows over derived theatre-local weekday and time", () => {
    const derived = local("2026-08-08T02:30:00Z", "America/Chicago");
    expect(matchesDayWindows(derived, [fridayEvening])).toBe(true);
    expect(
      matchesDayWindows(derived, [{ ...fridayEvening, days: ["THURSDAY"] }, fridayEvening]),
    ).toBe(true);
    expect(matchesDayWindows(derived, [{ ...fridayEvening, days: ["THURSDAY"] }])).toBe(false);
  });

  it("supports a schema-valid window that crosses midnight", () => {
    const derived = local("2026-08-08T06:30:00Z", "America/Chicago");
    expect(
      matchesDayWindows(derived, [
        { kind: "TIME_WINDOW", days: ["SATURDAY"], startLocal: "22:00", endLocal: "02:00" },
      ]),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ S36.1 / S36.2 helpers
function dateRange(from: string, to: string): PerformancePredicate {
  return { kind: "DATE_RANGE", from, to };
}
function timeWindow(
  days: readonly Weekday[] | readonly string[],
  startLocal: string,
  endLocal: string,
): PerformancePredicate {
  return { kind: "TIME_WINDOW", days: [...days] as Weekday[], startLocal, endLocal };
}
function and(...of: PerformancePredicate[]): PerformancePredicate {
  return { kind: "AND", of };
}
function or(...of: PerformancePredicate[]): PerformancePredicate {
  return { kind: "OR", of };
}
function not(of: PerformancePredicate): PerformancePredicate {
  return { kind: "NOT", of };
}
function movie(ids: string[]): PerformancePredicate {
  return { kind: "MOVIE", ids };
}

function expectBadRequest(fn: () => unknown, reason?: string) {
  try {
    fn();
    throw new Error("expected ScheduleWindowError");
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleWindowError);
    const e = error as ScheduleWindowError;
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.httpStatus).toBe(400);
    if (reason) expect(e.reason).toBe(reason);
  }
}

describe("resolveScheduleWindowPlan", () => {
  it("resolves next-three-weekends to nine ordered Friday/Saturday/Sunday dates over 17-day span", () => {
    // ADR 0028 §2: Next three weekends = first Friday after current block through third Sunday,
    // TIME_WINDOW Fri,Sat,Sun 00:00-23:59. With theatre 2026-08-04 = Tuesday, next weekend Fri is 2026-08-14.
    const where = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-30"),
      timeWindow(["FRIDAY", "SATURDAY", "SUNDAY"], "00:00", "23:59"),
    );
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.range).toEqual({ from: "2026-08-14", to: "2026-08-30" });
    expect(plan.timeWindow).toEqual({
      kind: "TIME_WINDOW",
      days: ["FRIDAY", "SATURDAY", "SUNDAY"],
      startLocal: "00:00",
      endLocal: "23:59",
    });
    expect(plan.scheduleDates).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);
    // ordered, duplicate-free, inclusive
    expect([...plan.scheduleDates].sort()).toEqual(plan.scheduleDates);
    expect(new Set(plan.scheduleDates).size).toBe(plan.scheduleDates.length);
  });

  it("resolves next-three-Friday-evenings to three Fridays", () => {
    const where = and(
      movie(["m1"]),
      dateRange("2026-08-07", "2026-08-21"),
      timeWindow(["FRIDAY"], "17:00", "23:59"),
    );
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual(["2026-08-07", "2026-08-14", "2026-08-21"]);
  });

  it("with no TIME_WINDOW selects every date in the inclusive span", () => {
    const where = and(movie(["m1"]), dateRange("2026-08-14", "2026-08-16"));
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.timeWindow).toBeNull();
    expect(plan.scheduleDates).toEqual(["2026-08-14", "2026-08-15", "2026-08-16"]);
  });

  it("handles single-day range and is inclusive on boundaries", () => {
    const where = and(movie(["m1"]), dateRange("2026-08-15", "2026-08-15"));
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual(["2026-08-15"]);
  });

  it("pins Friday/Sunday boundaries inclusive", () => {
    // Friday 2026-08-14 to Sunday 2026-08-16, Fri/Sat/Sun window 00:00-23:59 should include both Friday and Sunday endpoints
    const weekend = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-16"),
      timeWindow(["FRIDAY", "SATURDAY", "SUNDAY"], "00:00", "23:59"),
    );
    expect(resolveScheduleWindowPlan(weekend).scheduleDates).toEqual([
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
    // Same span but FRIDAY only should include only Friday
    const fridayOnly = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-16"),
      timeWindow(["FRIDAY"], "00:00", "23:59"),
    );
    expect(resolveScheduleWindowPlan(fridayOnly).scheduleDates).toEqual(["2026-08-14"]);
    // SUNDAY only should include Sunday endpoint
    const sundayOnly = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-16"),
      timeWindow(["SUNDAY"], "00:00", "23:59"),
    );
    expect(resolveScheduleWindowPlan(sundayOnly).scheduleDates).toEqual(["2026-08-16"]);
  });

  it("request made on Friday selects the following Friday (next-Friday rule)", () => {
    // 2026-08-07 is Friday. Next Friday is 2026-08-14. A spec for next-three-Fridays from 2026-08-14
    const where = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-28"),
      timeWindow(["FRIDAY"], "17:00", "23:59"),
    );
    const plan = resolveScheduleWindowPlan(where);
    // Must NOT include 2026-08-07, only 14,21,28
    expect(plan.scheduleDates).toEqual(["2026-08-14", "2026-08-21", "2026-08-28"]);
    expect(plan.scheduleDates).not.toContain("2026-08-07");
  });

  it("traverses only AND nodes; single DATE_RANGE at top-level is reachable", () => {
    const plan = resolveScheduleWindowPlan(dateRange("2026-08-14", "2026-08-14"));
    expect(plan.scheduleDates).toEqual(["2026-08-14"]);
  });

  it("accepts AND nesting with mixed predicates (MOVIE + DATE_RANGE + TIME_WINDOW)", () => {
    const where = and(
      and(movie(["m1"]), dateRange("2026-08-14", "2026-08-16")),
      timeWindow(["SATURDAY"], "10:00", "12:00"),
    );
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual(["2026-08-15"]);
  });

  it("is deterministic: same input yields same ordered plan", () => {
    const where = and(
      movie(["m1"]),
      dateRange("2026-08-14", "2026-08-30"),
      timeWindow(["FRIDAY"], "17:00", "23:59"),
    );
    const a = resolveScheduleWindowPlan(where);
    const b = resolveScheduleWindowPlan(where);
    expect(a).toEqual(b);
  });

  // ----------------------- rejections: ambiguous OR/NOT, duplicates, missing
  it("rejects DATE_RANGE under OR as ambiguous (mixed OR)", () => {
    const where = or(dateRange("2026-08-14", "2026-08-14"), movie(["m1"]));
    expectBadRequest(() => resolveScheduleWindowPlan(where), "date_or_mixed");
  });

  it("rejects DATE_RANGE under NOT as ambiguous", () => {
    const where = not(dateRange("2026-08-14", "2026-08-14"));
    expectBadRequest(() => resolveScheduleWindowPlan(where), "ambiguous_predicate");
  });

  it("rejects TIME_WINDOW under OR as ambiguous", () => {
    const where = and(
      dateRange("2026-08-14", "2026-08-16"),
      or(timeWindow(["FRIDAY"], "10:00", "12:00"), movie(["m1"])),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "ambiguous_predicate");
  });

  it("rejects TIME_WINDOW under NOT as ambiguous", () => {
    const where = and(
      dateRange("2026-08-14", "2026-08-16"),
      not(timeWindow(["FRIDAY"], "10:00", "12:00")),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "ambiguous_predicate");
  });

  it("rejects DATE_RANGE nested under OR via AND nesting as ambiguous", () => {
    const where = and(movie(["m1"]), or(and(dateRange("2026-08-14", "2026-08-14")), movie(["m2"])));
    expectBadRequest(() => resolveScheduleWindowPlan(where), "ambiguous_predicate");
  });
  it("rejects multiple reachable DATE_RANGE predicates", () => {
    const where = and(dateRange("2026-08-14", "2026-08-14"), dateRange("2026-08-15", "2026-08-15"));
    expectBadRequest(() => resolveScheduleWindowPlan(where), "multiple_date_ranges");
  });

  it("rejects multiple reachable TIME_WINDOW predicates", () => {
    const where = and(
      dateRange("2026-08-14", "2026-08-16"),
      timeWindow(["FRIDAY"], "10:00", "12:00"),
      timeWindow(["SATURDAY"], "10:00", "12:00"),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "multiple_time_windows");
  });

  it("rejects missing DATE_RANGE", () => {
    const where = and(movie(["m1"]), timeWindow(["FRIDAY"], "10:00", "12:00"));
    expectBadRequest(() => resolveScheduleWindowPlan(where), "missing_date_range");
  });

  it("rejects TIME_WINDOW alone (missing DATE_RANGE)", () => {
    const where = timeWindow(["FRIDAY"], "10:00", "12:00");
    expectBadRequest(() => resolveScheduleWindowPlan(where), "missing_date_range");
  });

  it("rejects predicate with no DATE_RANGE (MOVIE only)", () => {
    const where = movie(["m1"]);
    expectBadRequest(() => resolveScheduleWindowPlan(where), "missing_date_range");
  });

  it("rejects crossing TIME_WINDOW startLocal > endLocal as BAD_REQUEST (B1)", () => {
    const where = and(
      dateRange("2026-08-14", "2026-08-16"),
      timeWindow(["FRIDAY"], "22:00", "02:00"),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "crossing_time_window");
  });

  it("rejects empty weekday-expanded plan as BAD_REQUEST (B2)", () => {
    // 2026-08-11 Tue .. 2026-08-13 Thu contains no Friday
    const where = and(
      movie(["m1"]),
      dateRange("2026-08-11", "2026-08-13"),
      timeWindow(["FRIDAY"], "17:00", "23:59"),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "empty_plan");
  });

  it("rejects another empty plan: Monday-Thu range with Fri-Sun window", () => {
    const where = and(
      dateRange("2026-08-17", "2026-08-20"),
      timeWindow(["FRIDAY", "SATURDAY", "SUNDAY"], "00:00", "23:59"),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(where), "empty_plan");
  });

  it("does not treat OR without date/time as ambiguous (date-irrelevant OR)", () => {
    const where = and(dateRange("2026-08-14", "2026-08-15"), or(movie(["m1"]), movie(["m2"])));
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual(["2026-08-14", "2026-08-15"]);
  });
});

// ---------------------------------------------------------------- S53 v2 non-contiguous plan
describe("resolveScheduleWindowPlan v2 (S53.3/S53.4)", () => {
  it("expands separated DATE_RANGE runs into ordered unique scheduleDates with no gap", () => {
    const where = and(
      movie(["m1"]),
      or(dateRange("2026-09-10", "2026-09-12"), dateRange("2026-09-01", "2026-09-02")),
    );
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
    expect(plan.range).toEqual({ from: "2026-09-01", to: "2026-09-12" });
    expect(plan.scheduleDates).not.toContain("2026-09-03");
    expect(plan.scheduleDates).not.toContain("2026-09-09");
  });

  it("is ordered & unique even when input is reordered/duplicated/overlapping/adjacent", () => {
    const where = and(
      movie(["m1"]),
      or(
        dateRange("2026-09-04", "2026-09-06"),
        dateRange("2026-09-01", "2026-09-03"),
        dateRange("2026-09-01", "2026-09-03"),
        dateRange("2026-09-02", "2026-09-05"),
      ),
    );
    const plan = resolveScheduleWindowPlan(where);
    expect(plan.scheduleDates).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
  });

  it("applies TIME_WINDOW weekday filtering to selected dates only, not envelope gaps", () => {
    const where = and(
      movie(["m1"]),
      or(dateRange("2026-08-10", "2026-08-14"), dateRange("2026-08-17", "2026-08-17")),
      timeWindow(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"], "00:00", "23:59"),
    );
    const plan = resolveScheduleWindowPlan(where);
    // 2026-08-15 is Saturday (gap between 14 and 17) — not in selected, so not in plan even though envelope includes it
    expect(plan.scheduleDates).not.toContain("2026-08-15");
    expect(plan.scheduleDates).not.toContain("2026-08-16");
    // 2026-08-17 is Monday, included; 2026-08-10 is Monday as well
    expect(plan.scheduleDates).toContain("2026-08-10");
    expect(plan.scheduleDates).toContain("2026-08-14");
    expect(plan.scheduleDates).toContain("2026-08-17");
  });

  it("rejects empty weekday intersection on selected dates (not envelope)", () => {
    const emptyWhere = and(
      movie(["m1"]),
      or(dateRange("2026-08-11", "2026-08-13")),
      timeWindow(["FRIDAY"], "17:00", "23:59"),
    );
    expectBadRequest(() => resolveScheduleWindowPlan(emptyWhere), "empty_plan");
  });

  it("never matches performance in envelope gap", () => {
    const where = and(
      movie(["m1"]),
      or(dateRange("2026-09-01", "2026-09-01"), dateRange("2026-09-10", "2026-09-10")),
    );
    const plan = resolveScheduleWindowPlan(where);
    const chicago = IanaTimezoneSchema.parse("America/Chicago");
    // Gap date 2026-09-05 inside envelope but not selected => must not match even at noon
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-09-05T17:00:00Z"), chicago, plan),
    ).toBe(false);
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-09-01T17:00:00Z"), chicago, plan),
    ).toBe(true);
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-09-10T17:00:00Z"), chicago, plan),
    ).toBe(true);
  });

  it("accepts single OR leaf as DATE_RANGE and single range directly", () => {
    const singleOr = and(movie(["m1"]), or(dateRange("2026-09-01", "2026-09-03")));
    const single = and(movie(["m1"]), dateRange("2026-09-01", "2026-09-03"));
    expect(resolveScheduleWindowPlan(singleOr).scheduleDates).toEqual(
      resolveScheduleWindowPlan(single).scheduleDates,
    );
    expect(resolveScheduleWindowPlan(singleOr).range).toEqual(
      resolveScheduleWindowPlan(single).range,
    );
  });

  it("spring-forward and fall-back dates are correct via theatre-local", () => {
    const chicago = IanaTimezoneSchema.parse("America/Chicago");
    const whereSpring = and(
      movie(["m1"]),
      or(dateRange("2026-03-08", "2026-03-08"), dateRange("2026-03-09", "2026-03-09")),
    );
    const planSpring = resolveScheduleWindowPlan(whereSpring);
    expect(planSpring.scheduleDates).toEqual(["2026-03-08", "2026-03-09"]);
    // 03-08 just after jump should still be 03-08
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-03-08T08:00:00Z"), chicago, planSpring),
    ).toBe(true);
    // 03-08 before jump also 03-08
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-03-08T07:59:59Z"), chicago, planSpring),
    ).toBe(true);
    const whereFall = and(
      movie(["m1"]),
      or(dateRange("2026-11-01", "2026-11-01"), dateRange("2026-11-02", "2026-11-02")),
    );
    const planFall = resolveScheduleWindowPlan(whereFall);
    expect(planFall.scheduleDates).toEqual(["2026-11-01", "2026-11-02"]);
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-11-01T06:30:00Z"), chicago, planFall),
    ).toBe(true);
    expect(
      matchesScheduleWindow(UtcInstantSchema.parse("2026-11-01T07:30:00Z"), chicago, planFall),
    ).toBe(true);
  });
});

describe("matchesScheduleWindow", () => {
  const CHICAGO: IanaTimezone = IanaTimezoneSchema.parse("America/Chicago");
  const KOLKATA: IanaTimezone = IanaTimezoneSchema.parse("Asia/Kolkata");

  function utc(s: string): UtcInstant {
    return UtcInstantSchema.parse(s);
  }

  it("requires localDate inside range", () => {
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-08-14", "2026-08-16"), timeWindow(["FRIDAY"], "00:00", "23:59")),
    );
    // 2026-08-14 is Friday in Chicago
    // 2026-08-14T12:00:00Z -> 07:00 Chicago Friday => inside range + matches window
    expect(matchesScheduleWindow(utc("2026-08-14T12:00:00Z"), CHICAGO, plan)).toBe(true);
    // Day before range
    expect(matchesScheduleWindow(utc("2026-08-13T12:00:00Z"), CHICAGO, plan)).toBe(false);
    // Day after range
    expect(matchesScheduleWindow(utc("2026-08-17T12:00:00Z"), CHICAGO, plan)).toBe(false);
  });

  it("applies TIME_WINDOW via theatre-local time (uses toTheatreLocal, not UTC calendar day)", () => {
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-08-14", "2026-08-14"), timeWindow(["FRIDAY"], "17:00", "23:59")),
    );
    // 2026-08-14 is Friday. Chicago is CDT UTC-5.
    // UTC 21:59 => 16:59 local Friday => before window => false
    expect(matchesScheduleWindow(utc("2026-08-14T21:59:00Z"), CHICAGO, plan)).toBe(false);
    // UTC 22:00 => 17:00 local => inside => true
    expect(matchesScheduleWindow(utc("2026-08-14T22:00:00Z"), CHICAGO, plan)).toBe(true);
    // UTC 2026-08-15T04:59:00Z => 23:59 Friday => true (inclusive end)
    expect(matchesScheduleWindow(utc("2026-08-15T04:59:00Z"), CHICAGO, plan)).toBe(true);
    // UTC 2026-08-15T05:00:00Z => 00:00 Saturday => outside window days => false
    expect(matchesScheduleWindow(utc("2026-08-15T05:00:00Z"), CHICAGO, plan)).toBe(false);
    // Verify UTC calendar day is irrelevant: performance at UTC Saturday 00:00 but local Friday 19:00 should match
    // Using Kolkata +05:30: 2026-08-14T13:30:00Z => 19:00 Kolkata Friday => true, even though UTC date is Friday already (same) - choose a timezone shift that flips date
    // Better: America/Los_Angeles UTC-7: 2026-08-15T00:30:00Z => 2026-08-14T17:30 local Friday => true
    const la = IanaTimezoneSchema.parse("America/Los_Angeles");
    expect(matchesScheduleWindow(utc("2026-08-15T00:30:00Z"), la, plan)).toBe(true);
  });

  it("with null timeWindow matches any time inside range", () => {
    const plan = resolveScheduleWindowPlan(dateRange("2026-08-14", "2026-08-16"));
    expect(matchesScheduleWindow(utc("2026-08-14T05:00:00Z"), CHICAGO, plan)).toBe(true);
    expect(matchesScheduleWindow(utc("2026-08-14T23:59:59Z"), CHICAGO, plan)).toBe(true);
    expect(matchesScheduleWindow(utc("2026-08-15T12:00:00Z"), CHICAGO, plan)).toBe(true);
    expect(matchesScheduleWindow(utc("2026-08-16T23:59:59Z"), CHICAGO, plan)).toBe(true);
  });

  it("Sunday boundary: distinguishes Sunday 23:59 vs Monday 00:00", () => {
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-08-16", "2026-08-17"), timeWindow(["SUNDAY"], "00:00", "23:59")),
    );
    // 2026-08-16 is Sunday, 2026-08-17 is Monday.
    // Chicago: 2026-08-17T04:59:00Z => Sunday 23:59 => true
    expect(matchesScheduleWindow(utc("2026-08-17T04:59:00Z"), CHICAGO, plan)).toBe(true);
    // 2026-08-17T05:00:00Z => Monday 00:00 => false (weekday mismatch, also time window would reject)
    expect(matchesScheduleWindow(utc("2026-08-17T05:00:00Z"), CHICAGO, plan)).toBe(false);
    // Also range check: Monday outside window but also 17 is Monday inside range but Sunday window => false
    expect(matchesScheduleWindow(utc("2026-08-17T12:00:00Z"), CHICAGO, plan)).toBe(false);
  });

  it("handles spring-forward UTC instants mapping to correct theatre-local date/weekday/time", () => {
    // Plan for 2026-03-08 Sunday with full-day window, Chicago DST jump at 07:00? Actually 2026-03-08 clocks jump 01:59 CST -> 03:00 CDT
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-03-08", "2026-03-08"), timeWindow(["SUNDAY"], "00:00", "23:59")),
    );
    // Just before jump: 07:59:59Z => 01:59:59 CST Sunday => inside
    expect(matchesScheduleWindow(utc("2026-03-08T07:59:59Z"), CHICAGO, plan)).toBe(true);
    // Just after jump: 08:00:00Z => 03:00 CDT Sunday => inside (gap hour doesn't exist, but mapping skips 02:xx)
    expect(matchesScheduleWindow(utc("2026-03-08T08:00:00Z"), CHICAGO, plan)).toBe(true);
    // Verify that a narrow window 01:00-01:59 still matches first instant but not second (03:00 outside)
    const narrow = resolveScheduleWindowPlan(
      and(dateRange("2026-03-08", "2026-03-08"), timeWindow(["SUNDAY"], "01:00", "01:59")),
    );
    expect(matchesScheduleWindow(utc("2026-03-08T07:59:59Z"), CHICAGO, narrow)).toBe(true);
    expect(matchesScheduleWindow(utc("2026-03-08T08:00:00Z"), CHICAGO, narrow)).toBe(false);
  });

  it("handles fall-back UTC instants mapping to correct theatre-local date/weekday/time both offsets", () => {
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-11-01", "2026-11-01"), timeWindow(["SUNDAY"], "00:00", "23:59")),
    );
    // First 01:30 CDT
    expect(matchesScheduleWindow(utc("2026-11-01T06:30:00Z"), CHICAGO, plan)).toBe(true);
    // Second 01:30 CST
    expect(matchesScheduleWindow(utc("2026-11-01T07:30:00Z"), CHICAGO, plan)).toBe(true);
    // Narrow window 01:00-01:30 should match both instants (both 01:30)
    const narrow = resolveScheduleWindowPlan(
      and(dateRange("2026-11-01", "2026-11-01"), timeWindow(["SUNDAY"], "01:00", "01:30")),
    );
    expect(matchesScheduleWindow(utc("2026-11-01T06:30:00Z"), CHICAGO, narrow)).toBe(true);
    expect(matchesScheduleWindow(utc("2026-11-01T07:30:00Z"), CHICAGO, narrow)).toBe(true);
    // 02:30 after fall-back should be outside narrow but inside full-day plan
    expect(matchesScheduleWindow(utc("2026-11-01T08:30:00Z"), CHICAGO, narrow)).toBe(false);
    expect(matchesScheduleWindow(utc("2026-11-01T08:30:00Z"), CHICAGO, plan)).toBe(true);
  });

  it("produces same verdict for shared evaluator paths (warm/cold/aggregate drift guard)", () => {
    // Simulate three callers using the same plan and same performance instant.
    // Warm path: filter fresh cache performances via matchesScheduleWindow
    // Cold fan-out: filter ScheduleShowtimes via same function
    // Aggregate: filter deduped performances before snapshots
    const fridayEveningPlan = resolveScheduleWindowPlan(
      and(dateRange("2026-08-14", "2026-08-14"), timeWindow(["FRIDAY"], "17:00", "23:59")),
    );
    const warmVerdict = matchesScheduleWindow(
      utc("2026-08-14T22:30:00Z"),
      CHICAGO,
      fridayEveningPlan,
    ); // 17:30 Friday
    const coldVerdict = matchesScheduleWindow(
      utc("2026-08-14T22:30:00Z"),
      CHICAGO,
      fridayEveningPlan,
    );
    const aggregateVerdict = matchesScheduleWindow(
      utc("2026-08-14T22:30:00Z"),
      CHICAGO,
      fridayEveningPlan,
    );
    expect(warmVerdict).toBe(true);
    expect(coldVerdict).toBe(true);
    expect(aggregateVerdict).toBe(true);
    expect(warmVerdict).toBe(coldVerdict);
    expect(coldVerdict).toBe(aggregateVerdict);

    // Negative control: nearby nonmatching time (16:59) should be false in all three
    const warmNeg = matchesScheduleWindow(utc("2026-08-14T21:59:00Z"), CHICAGO, fridayEveningPlan);
    const coldNeg = matchesScheduleWindow(utc("2026-08-14T21:59:00Z"), CHICAGO, fridayEveningPlan);
    expect(warmNeg).toBe(false);
    expect(coldNeg).toBe(false);
    expect(warmNeg).toBe(coldNeg);

    // Weekday mismatch: same time on Saturday should be false
    const saturday = matchesScheduleWindow(utc("2026-08-15T22:30:00Z"), CHICAGO, fridayEveningPlan); // Saturday 17:30
    expect(saturday).toBe(false);
  });

  it("performance just before/inside/after 17:00–23:59 has correct verdicts on DST date", () => {
    // Use a plan that is Friday evening 17:00-23:59 but on a DST boundary Sunday to prove evaluator is timezone-aware, not UTC
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-03-08", "2026-03-08"), timeWindow(["SUNDAY"], "17:00", "23:59")),
    );
    // 2026-03-08 is Sunday with DST jump. 22:00Z => 17:00 CDT => inside
    expect(matchesScheduleWindow(utc("2026-03-08T22:00:00Z"), CHICAGO, plan)).toBe(true);
    // 21:59Z => 16:59 => before => false
    expect(matchesScheduleWindow(utc("2026-03-08T21:59:00Z"), CHICAGO, plan)).toBe(false);
    // 2026-03-09T04:59Z => 23:59 Sunday => true
    expect(matchesScheduleWindow(utc("2026-03-09T04:59:00Z"), CHICAGO, plan)).toBe(true);
    // 2026-03-09T05:00Z => Monday 00:00 => outside range => false
    expect(matchesScheduleWindow(utc("2026-03-09T05:00:00Z"), CHICAGO, plan)).toBe(false);
  });

  it("never inspects performance.local_date or UTC calendar day, only theatre-local", () => {
    // Plan 2026-08-14 Friday evening. A performance stored with local_date = "2026-08-14" but actually at UTC 2026-08-15T00:30Z (17:30 PDT Friday) should still match via theatre-local
    const plan = resolveScheduleWindowPlan(
      and(dateRange("2026-08-14", "2026-08-14"), timeWindow(["FRIDAY"], "17:00", "23:59")),
    );
    const la = IanaTimezoneSchema.parse("America/Los_Angeles");
    // UTC Saturday 00:30 is still Friday 17:30 in LA => true, even though UTC date is next day
    expect(matchesScheduleWindow(utc("2026-08-15T00:30:00Z"), la, plan)).toBe(true);
    // Conversely UTC Friday 12:00 in Kolkata (17:30) should match according to Kolkata, not UTC
    expect(matchesScheduleWindow(utc("2026-08-14T12:00:00Z"), KOLKATA, plan)).toBe(true);
  });
});
