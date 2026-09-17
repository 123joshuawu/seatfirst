import { describe, expect, it } from "vitest";
import type { Weekday } from "@seatfirst/core";
import { matchesScheduleWindow } from "@seatfirst/core";
import {
  buildSearchSpec,
  resolveEffectiveDateRange,
  summarizeMovieWindow,
  showtimeMatchesWindow,
} from "./buildSearchSpec";
import type { FormatPref } from "@/types/placement";

/**
 * Expectations are hand-derived from the theatre-local calendar (America/Los_Angeles,
 * UTC-8 in February), never by re-running the implementation:
 *
 *  s1 2026-02-06T20:00Z -> Fri Feb 6  12:00 PST  imax
 *  s2 2026-02-07T02:00Z -> Fri Feb 6  18:00 PST  dolbycinemaatamcprime
 *  s3 2026-02-07T09:30Z -> Sat Feb 7  01:30 PST  (standard — null)
 *  s4 2026-02-07T19:00Z -> Sat Feb 7  11:00 PST  (standard — null)
 *  s5 2026-02-08T02:00Z -> Sat Feb 7  18:00 PST  imax
 *  s6 2026-02-08T04:00Z -> Sat Feb 7  20:00 PST  null format
 *  s7 2026-02-09T01:00Z -> Sun Feb 8  17:00 PST  dolbycinemaatamcprime
 */
const TZ = "America/Los_Angeles";
const GROUP = {
  showtimes: [
    { showDateTimeUtc: "2026-02-06T20:00:00Z", formatCode: "imax" }, // Fri 12:00
    { showDateTimeUtc: "2026-02-07T02:00:00Z", formatCode: "dolbycinemaatamcprime" }, // Fri 18:00
    { showDateTimeUtc: "2026-02-07T09:30:00Z", formatCode: null }, // Sat 01:30 — standard
    { showDateTimeUtc: "2026-02-07T19:00:00Z", formatCode: null }, // Sat 11:00 — standard
    { showDateTimeUtc: "2026-02-08T02:00:00Z", formatCode: "imax" }, // Sat 18:00
    { showDateTimeUtc: "2026-02-08T04:00:00Z", formatCode: null }, // Sat 20:00
    { showDateTimeUtc: "2026-02-09T01:00:00Z", formatCode: "dolbycinemaatamcprime" }, // Sun 17:00
  ],
};

// UI24: date membership comes from explicit ISO sets, not weekday triples.
// Theatre-local dates of GROUP: s1/s2 = 2026-02-06, s3–s6 = 2026-02-07, s7 = 2026-02-08.
const FRI_0206 = ["2026-02-06"];
const SAT_0207 = ["2026-02-07"];
const SUN_0208 = ["2026-02-08"];
const ALL_FIXTURE_DATES = ["2026-02-06", "2026-02-07", "2026-02-08"];

describe("showtimeMatchesWindow / summarizeMovieWindow (shared buildSearchSpec predicate)", () => {
  it("all fixture dates + All times: ALL showtimes count with no restriction", () => {
    const s = summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "All times");
    expect(s!.matchingCount).toBe(7);
    expect(s!.formatCounts).toEqual({ imax: 2, dolby: 2, standard: 3 });
  });

  it("all fixture dates + each explicit band constrains (S50, ADR 0043 §1)", () => {
    // Hand-derived with inclusive bounds:
    // Morning 00:00-11:59 => s3 Sat01:30, s4 Sat11:00 => 2
    // Afternoon 12:00-16:59 => s1 Fri12:00 => 1
    // Evening 17:00-20:59 => s2 Fri18, s5 Sat18, s6 Sat20, s7 Sun17 => 4
    // Late 21:00-23:59 => none => 0
    expect(summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Morning")!.matchingCount).toBe(2);
    expect(summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Afternoon")!.matchingCount).toBe(1);
    expect(summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening")!.matchingCount).toBe(4);
    expect(summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Late")!.matchingCount).toBe(0);
  });

  it("all fixture dates + Evening constrains to local evening across all weekdays (S50 20:59)", () => {
    // Hand-derived evening instants in PST: s2 Fri 18:00 dolby, s5 Sat 18:00 imax,
    // s6 Sat 20:00 standard(null), s7 Sun 17:00 dolby. Noon/01:30/11:00 are out.
    const s = summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening");
    expect(s!.matchingCount).toBe(4);
    expect(s!.formatCounts).toEqual({ imax: 1, dolby: 2, standard: 1 });
    expect(showtimeMatchesWindow("2026-02-07T09:30:00Z", TZ, ALL_FIXTURE_DATES, "Evening")).toBe(
      false,
    ); // Sat 01:30
    expect(showtimeMatchesWindow("2026-02-06T20:00:00Z", TZ, ALL_FIXTURE_DATES, "Evening")).toBe(
      false,
    ); // Fri 12:00
    expect(showtimeMatchesWindow("2026-02-08T04:00:00Z", TZ, ALL_FIXTURE_DATES, "Evening")).toBe(
      true,
    ); // Sat 20:00
  });

  it("Friday 2026-02-06 selected, All times: 2 showtimes", () => {
    const s = summarizeMovieWindow(GROUP, TZ, FRI_0206, "All times");
    expect(s!.matchingCount).toBe(2); // s1 Fri 12:00, s2 Fri 18:00
    expect(s!.formatCounts).toEqual({ imax: 1, dolby: 1, standard: 0 });
  });

  it("Friday 2026-02-06 + Evening (17:00–20:59): 1 showtime", () => {
    const s = summarizeMovieWindow(GROUP, TZ, FRI_0206, "Evening");
    expect(s!.matchingCount).toBe(1); // s2 Fri 18:00; s1 at noon is excluded
    expect(s!.formatCounts.dolby).toBe(1);
  });

  it("null/unknown formatCode reads as Standard (hueForFormat convention)", () => {
    const s = summarizeMovieWindow(
      { showtimes: [{ showDateTimeUtc: "2026-02-08T04:00:00Z", formatCode: null }] },
      TZ,
      SAT_0207,
      "All times",
    );
    expect(s!.formatCounts.standard).toBe(1);
    expect(s!.formatCounts.imax).toBe(0);
  });

  it("format narrowing: matchingCount respects the selected format; formatCounts stay full", () => {
    // Hand-derived from GROUP: Friday evening matches s2 (dolby) only.
    expect(
      summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening", "any")!.matchingCount,
    ).toBe(4);
    expect(
      summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening", "imax")!.matchingCount,
    ).toBe(1); // s5
    expect(
      summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening", "dolby")!.matchingCount,
    ).toBe(2);
    expect(
      summarizeMovieWindow(GROUP, TZ, ALL_FIXTURE_DATES, "Evening", "standard")!.matchingCount,
    ).toBe(1); // s6
    expect(summarizeMovieWindow(GROUP, TZ, FRI_0206, "Evening", "dolby")!.matchingCount).toBe(1); // s2
    // Per-format chip counts remain all-formats regardless of the selection:
    const narrowed = summarizeMovieWindow(GROUP, TZ, FRI_0206, "Evening", "standard")!;
    expect(narrowed.formatCounts).toEqual({ imax: 0, dolby: 1, standard: 0 });
  });

  it("group null -> null summary (never a fabricated zero)", () => {
    expect(summarizeMovieWindow(null, TZ, FRI_0206, "Evening")).toBeNull();
  });
});

describe("showtimeMatchesWindow / summarizeMovieWindow — selectedDates (UI24: the single date scope)", () => {
  // GROUP local dates (America/Los_Angeles): s1/s2 = Fri 2026-02-06, s3-s6 = Sat 2026-02-07,
  // s7 = Sun 2026-02-08.
  it("excludes a showtime whose theatre-local date is not in the selected set", () => {
    // s6 is Sat 2026-02-07 20:00 PST — matches Evening but Feb 7 is not selected.
    expect(showtimeMatchesWindow("2026-02-08T04:00:00Z", TZ, SUN_0208, "Evening")).toBe(false);
  });

  it("includes a showtime whose theatre-local date is in the selected set", () => {
    expect(showtimeMatchesWindow("2026-02-08T04:00:00Z", TZ, SAT_0207, "Evening")).toBe(true);
  });

  it("null selectedDates keeps the unbounded-date behavior for pure time checks", () => {
    expect(showtimeMatchesWindow("2026-02-08T04:00:00Z", TZ, null, "Evening")).toBe(true);
  });

  it("an empty selectedDates matches nothing (fail closed)", () => {
    expect(showtimeMatchesWindow("2026-02-08T04:00:00Z", TZ, [], "Evening")).toBe(false);
  });

  it("summarizeMovieWindow narrows matchingCount to only the showtimes on selected dates", () => {
    // Only Fri Feb 6 showtimes (s1 imax, s2 dolby) are selected; Sat/Sun are excluded
    // even though they'd otherwise match All times.
    const s = summarizeMovieWindow(GROUP, TZ, FRI_0206, "All times");
    expect(s!.matchingCount).toBe(2);
    expect(s!.formatCounts).toEqual({ imax: 1, dolby: 1, standard: 0 });
  });

  it("a selected set with no overlap in the group yields zero matches", () => {
    const s = summarizeMovieWindow(GROUP, TZ, ["2026-03-01"], "Evening");
    expect(s!.matchingCount).toBe(0);
  });

  it("a two-run sparse set excludes every gap date in the local count (UI24.7)", () => {
    // Fri 2026-02-06 + Sun 2026-02-08 selected, Sat 2026-02-07 gap: s1, s2, s7
    // count; all four Saturday showtimes are excluded.
    const sparse = ["2026-02-06", "2026-02-08"];
    const s = summarizeMovieWindow(GROUP, TZ, sparse, "All times");
    expect(s!.matchingCount).toBe(3);
    expect(s!.formatCounts).toEqual({ imax: 1, dolby: 2, standard: 0 });
  });
});

describe("resolveEffectiveDateRange (inclusive-span fallback definition)", () => {
  // Local-time constructor (not a UTC ISO string) so localDateString(now) is deterministic
  // regardless of the test runner's TZ.
  const now = new Date(2026, 1, 6, 12, 0, 0);

  it("both from/to present: passes them through", () => {
    expect(resolveEffectiveDateRange("2026-02-10", "2026-02-15", now)).toEqual({
      from: "2026-02-10",
      to: "2026-02-15",
    });
  });

  it("only from present: single-day range at from", () => {
    expect(resolveEffectiveDateRange("2026-02-10", undefined, now)).toEqual({
      from: "2026-02-10",
      to: "2026-02-10",
    });
  });

  it("neither bound present: falls back to the default 30-day browse window from now", () => {
    const result = resolveEffectiveDateRange(undefined, undefined, now);
    expect(result).toEqual({ from: "2026-02-06", to: "2026-03-07" });
  });

  it("inverted range (from > to) fails closed to null", () => {
    expect(resolveEffectiveDateRange("2026-02-15", "2026-02-10", now)).toBeNull();
  });
});

describe("formatCodeToPref (S42.7 — real ADR 0008 vocabulary)", () => {
  it("maps real lower-case codes to concrete prefs", async () => {
    const { formatCodeToPref } = await import("./buildSearchSpec");
    expect(formatCodeToPref("imax")).toBe("imax");
    expect(formatCodeToPref("imax70mm")).toBe("imax");
    expect(formatCodeToPref("imaxlaseratamc")).toBe("imax");
    expect(formatCodeToPref("dolbycinemaatamcprime")).toBe("dolby");
    expect(formatCodeToPref(null)).toBe("standard");
    expect(formatCodeToPref("unknown_xyz")).toBe("standard");
    expect(formatCodeToPref("")).toBe("standard");
    // Old upper-case literals are dead — they now map to standard, not premium
    expect(formatCodeToPref("IMAX")).toBe("standard");
    expect(formatCodeToPref("DOLBY")).toBe("standard");
  });
});

describe("buildSearchSpec FORMAT predicate (S42.6)", () => {
  it("emits correct FORMAT code per formatPref, 'any' emits none", async () => {
    const { buildSearchSpec } = await import("./buildSearchSpec");
    const base = {
      theatre: { id: "amc:theatre:1", providerId: "amc" },
      movieId: "amc:movie:1",
      selectedDates: ["2026-08-04"],
      timeOfDay: "All times",
      seatPrefs: {} as Record<string, boolean>,
      partySize: 2,
    };
    const anySpec = buildSearchSpec({ ...base, formatPref: "any" })!;
    expect(JSON.stringify(anySpec.where)).not.toContain('"FORMAT"');

    const imaxSpec = buildSearchSpec({ ...base, formatPref: "imax" })!;
    expect(JSON.stringify(imaxSpec.where)).toContain('"code":"imax"');

    const dolbySpec = buildSearchSpec({ ...base, formatPref: "dolby" })!;
    expect(JSON.stringify(dolbySpec.where)).toContain('"code":"dolbycinemaatamcprime"');

    const stdSpec = buildSearchSpec({ ...base, formatPref: "standard" })!;
    expect(JSON.stringify(stdSpec.where)).toContain('"code":"STANDARD"');
  });
});

describe("buildSearchSpec — selected dates + Evening emits a real TIME_WINDOW (ADR 0052 §3) — S50 widens to all bands", () => {
  const base = {
    theatre: { id: "amc:theatre:832", providerId: "amc" },
    movieId: "amc:movie:1",
    // The DST-crossing week Mar 5–12 2026, so the emitted DATE_RANGE covers the probed instants
    // (the first evening probe is Mar 5 18:30 local == 2026-03-06T02:30:00Z).
    selectedDates: [
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ],
    timeOfDay: "Evening",
    seatPrefs: {} as Record<string, boolean>,
    partySize: 2,
    formatPref: "any" as FormatPref,
  };

  function timeWindow(
    spec: ReturnType<typeof buildSearchSpec>,
  ): { kind: "TIME_WINDOW"; days: Weekday[]; startLocal: string; endLocal: string } | undefined {
    expect(spec).not.toBeNull();
    if (spec!.where.kind !== "AND") return undefined;
    return spec!.where.of.find(
      (p): p is Extract<typeof p, { kind: "TIME_WINDOW" }> => p.kind === "TIME_WINDOW",
    );
  }

  it("selected dates + Evening emits all seven weekdays with 17:00–20:59 bounds (ADR 0043 §1)", () => {
    const tw = timeWindow(buildSearchSpec(base));
    expect(tw?.days).toEqual([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ]);
    expect(tw?.startLocal).toBe("17:00");
    expect(tw?.endLocal).toBe("20:59");
  });

  it("selected dates + each band emits its ADR 0043 bounds (S50.5/S50.6)", () => {
    const cases: [string, string, string][] = [
      ["Morning", "00:00", "11:59"],
      ["Afternoon", "12:00", "16:59"],
      ["Evening", "17:00", "20:59"],
      ["Late", "21:00", "23:59"],
    ];
    for (const [tod, start, end] of cases) {
      const tw = timeWindow(buildSearchSpec({ ...base, timeOfDay: tod }));
      expect(tw?.startLocal).toBe(start);
      expect(tw?.endLocal).toBe(end);
      expect(tw?.days).toEqual([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ]);
    }
  });

  it("selected dates + All times emits no TIME_WINDOW", () => {
    const tw = timeWindow(buildSearchSpec({ ...base, timeOfDay: "All times" }));
    expect(tw).toBeUndefined();
  });

  it("golden parity: the emitted plan expands to evening-only instants across a DST-crossing week", async () => {
    const { resolveScheduleWindowPlan } = await import("@seatfirst/core");
    const spec = buildSearchSpec(base)!;
    const plan = resolveScheduleWindowPlan(spec.where);
    // US DST 2026: PST (UTC-8) before 2026-03-08 02:00 local, PDT (UTC-7) after.
    // Hand-derived instants for America/Los_Angeles across the crossing:
    //   18:30 local each day -> in-window every day; 15:00 local -> out every day.
    const eveningInstants = [
      "2026-03-06T02:30:00Z", // Fri Mar 6, PST: 18:30-8
      "2026-03-07T02:30:00Z", // Sat Mar 7, PST
      "2026-03-08T01:30:00Z", // Sun Mar 8, still PST at that UTC instant (17:30 pre-jump)
      "2026-03-09T01:30:00Z", // Mon Mar 9, PDT: 18:30-7
      "2026-03-10T01:30:00Z", // Tue PDT
      "2026-03-11T01:30:00Z", // Wed PDT
      "2026-03-12T01:30:00Z", // Thu PDT
    ];
    const afternoonInstants = [
      "2026-03-06T23:00:00Z", // Fri 15:00 PST
      "2026-03-07T23:00:00Z", // Sat 15:00 PST
      "2026-03-09T22:00:00Z", // Mon 15:00 PDT
    ];
    for (const iso of eveningInstants) {
      expect(showtimeMatchesWindow(iso, "America/Los_Angeles", base.selectedDates, "Evening")).toBe(
        true,
      );
      expect(matchesPlan(iso, plan)).toBe(true);
    }
    for (const iso of afternoonInstants) {
      expect(showtimeMatchesWindow(iso, "America/Los_Angeles", base.selectedDates, "Evening")).toBe(
        false,
      );
      expect(matchesPlan(iso, plan)).toBe(false);
    }

    function matchesPlan(iso: string, plan: ReturnType<typeof resolveScheduleWindowPlan>): boolean {
      try {
        return matchesScheduleWindow(iso, "America/Los_Angeles", plan);
      } catch {
        return false;
      }
    }
  });

  it("golden parity: each band's time-only TIME_WINDOW expands via resolveScheduleWindowPlan (DST-aware)", async () => {
    const { resolveScheduleWindowPlan } = await import("@seatfirst/core");
    // Hand-derived probes for each band, covering PST and PDT plus inclusive edges.
    // All times are America/Los_Angeles local, converted to UTC. Expected true = inside band.
    const cases: Array<{
      tod: string;
      expectedStart: string;
      expectedEnd: string;
      probes: Array<{ utc: string; expectIn: boolean }>;
    }> = [
      {
        tod: "Morning",
        expectedStart: "00:00",
        expectedEnd: "11:59",
        probes: [
          { utc: "2026-03-06T14:00:00Z", expectIn: true }, // Fri 06:00 PST
          { utc: "2026-03-06T19:59:00Z", expectIn: true }, // Fri 11:59 PST inclusive edge
          { utc: "2026-03-06T20:00:00Z", expectIn: false }, // Fri 12:00 PST -> Afternoon
          { utc: "2026-03-06T21:30:00Z", expectIn: false }, // Fri 13:30 PST
          { utc: "2026-03-09T13:00:00Z", expectIn: true }, // Mon 06:00 PDT
          { utc: "2026-03-09T18:59:00Z", expectIn: true }, // Mon 11:59 PDT
          { utc: "2026-03-09T19:00:00Z", expectIn: false }, // Mon 12:00 PDT
          { utc: "2026-03-10T01:30:00Z", expectIn: false }, // Mon 18:30 PDT
        ],
      },
      {
        tod: "Afternoon",
        expectedStart: "12:00",
        expectedEnd: "16:59",
        probes: [
          { utc: "2026-03-06T20:00:00Z", expectIn: true }, // Fri 12:00 PST inclusive start
          { utc: "2026-03-06T21:30:00Z", expectIn: true }, // Fri 13:30 PST
          { utc: "2026-03-07T00:59:00Z", expectIn: true }, // Fri 16:59 PST inclusive end
          { utc: "2026-03-07T01:00:00Z", expectIn: false }, // Fri 17:00 PST -> Evening
          { utc: "2026-03-06T14:00:00Z", expectIn: false }, // Fri 06:00 PST
          { utc: "2026-03-09T19:00:00Z", expectIn: true }, // Mon 12:00 PDT
          { utc: "2026-03-09T23:59:00Z", expectIn: true }, // Mon 16:59 PDT
          { utc: "2026-03-10T00:00:00Z", expectIn: false }, // Mon 17:00 PDT
        ],
      },
      {
        tod: "Evening",
        expectedStart: "17:00",
        expectedEnd: "20:59",
        probes: [
          { utc: "2026-03-06T02:30:00Z", expectIn: true }, // Fri 18:30 PST (next-day UTC) - uses durable week via now Mar 4
          { utc: "2026-03-07T01:00:00Z", expectIn: true }, // Fri 17:00 PST
          { utc: "2026-03-07T04:59:00Z", expectIn: true }, // Fri 20:59 PST
          { utc: "2026-03-07T05:00:00Z", expectIn: false }, // Fri 21:00 PST -> Late
          { utc: "2026-03-06T21:30:00Z", expectIn: false }, // Fri 13:30 PST
          { utc: "2026-03-10T01:30:00Z", expectIn: true }, // Mon 18:30 PDT
          { utc: "2026-03-10T04:00:00Z", expectIn: false }, // Mon 21:00 PDT
        ],
      },
      {
        tod: "Late",
        expectedStart: "21:00",
        expectedEnd: "23:59",
        probes: [
          { utc: "2026-03-07T05:00:00Z", expectIn: true }, // Fri 21:00 PST inclusive start
          { utc: "2026-03-07T06:30:00Z", expectIn: true }, // Fri 22:30 PST
          { utc: "2026-03-07T07:59:00Z", expectIn: true }, // Fri 23:59 PST inclusive end
          { utc: "2026-03-07T04:59:00Z", expectIn: false }, // Fri 20:59 PST -> Evening
          { utc: "2026-03-06T14:00:00Z", expectIn: false }, // Fri 06:00 PST
          { utc: "2026-03-10T04:00:00Z", expectIn: true }, // Mon 21:00 PDT
          { utc: "2026-03-10T05:30:00Z", expectIn: true }, // Mon 22:30 PDT
          { utc: "2026-03-10T03:59:00Z", expectIn: false }, // Mon 20:59 PDT
        ],
      },
    ];

    for (const c of cases) {
      const spec = buildSearchSpec({ ...base, timeOfDay: c.tod })!;
      const tw = timeWindow(spec)!;
      expect(tw.startLocal).toBe(c.expectedStart);
      expect(tw.endLocal).toBe(c.expectedEnd);
      expect(tw.days).toEqual([
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ]);
      const plan = resolveScheduleWindowPlan(spec.where);
      for (const p of c.probes) {
        const matcher = showtimeMatchesWindow(
          p.utc,
          "America/Los_Angeles",
          base.selectedDates,
          c.tod,
        );
        let planVerdict: boolean;
        try {
          planVerdict = matchesScheduleWindow(p.utc, "America/Los_Angeles", plan);
        } catch {
          planVerdict = false;
        }
        expect(matcher).toBe(p.expectIn);
        expect(planVerdict).toBe(p.expectIn);
        expect(matcher).toBe(planVerdict);
      }
    }
  });
});
describe("predicate sweep — emitted spec and matcher agree over explicit date sets (UI24) — S50 inclusive bands", () => {
  const dateSets: string[][] = [
    ALL_FIXTURE_DATES,
    FRI_0206,
    SAT_0207,
    SUN_0208,
    ["2026-02-06", "2026-02-07"],
    ["2026-02-07", "2026-02-08"],
    ["2026-02-06", "2026-02-08"],
  ];
  const tods = ["All times", "Morning", "Afternoon", "Evening", "Late"];
  // Hand-derived per-instant verdicts against GROUP (PST locals):
  //   s1 Fri12 s2 Fri18 s3 Sat01:30 s4 Sat11 s5 Sat18 s6 Sat20 s7 Sun17
  // Bounds per ADR 0043 §1 (inclusive):
  //   Morning 00:00-11:59 => s3,s4
  //   Afternoon 12:00-16:59 => s1
  //   Evening 17:00-20:59 => s2,s5,s6,s7
  //   Late 21:00-23:59 => none in this fixture
  const expectedMatchCount: Record<string, number[]> = {
    // rows = tod, cols = dateSets order above
    "All times": [7, 2, 4, 1, 6, 5, 3],
    Morning: [2, 0, 2, 0, 2, 2, 0],
    Afternoon: [1, 1, 0, 0, 1, 0, 1],
    Evening: [4, 1, 2, 1, 3, 3, 2],
    Late: [0, 0, 0, 0, 0, 0, 0],
  };

  for (const tod of tods) {
    dateSets.forEach((dateSet, ci) => {
      const label = `${tod} × [${dateSet.join(",")}]`;
      it(`${label} → ${expectedMatchCount[tod]![ci]!} showtimes`, () => {
        const s = summarizeMovieWindow(GROUP, TZ, dateSet, tod);
        expect(s!.matchingCount).toBe(expectedMatchCount[tod]![ci]!);
        // Emitted-spec parity: TIME_WINDOW present iff any explicit band, always
        // spanning all seven weekdays — date membership never affects the window.
        const spec = buildSearchSpec({
          theatre: { id: "amc:theatre:832", providerId: "amc" },
          movieId: "amc:movie:1",
          selectedDates: dateSet,
          timeOfDay: tod,
          seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
          partySize: 1,
          formatPref: "any",
        })!;
        expect(spec.specVersion).toBe(2);
        const andParts =
          spec.where.kind === "AND" ? spec.where.of.filter((p) => p.kind === "TIME_WINDOW") : [];
        const tw = andParts[0] as { days: string[] } | undefined;
        if (tod !== "All times") {
          expect(tw).toBeDefined();
          expect(tw === undefined ? [] : tw.days).toEqual([
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
            "SUNDAY",
          ]);
        } else {
          expect(tw).toBeUndefined();
        }
      });
    });
  }
});

describe("FORMAT regression — leaf survives time-only emission (UI24)", () => {
  const dateSets: string[][] = [
    ALL_FIXTURE_DATES,
    FRI_0206,
    [...SAT_0207, ...SUN_0208],
    ["2026-02-06", "2026-02-08"],
  ];
  const cases: [string, string][] = [
    ["imax", '"code":"imax"'],
    ["dolby", '"code":"dolbycinemaatamcprime"'],
    ["standard", '"code":"STANDARD"'],
  ];
  for (const [formatPref, needle] of cases) {
    for (const dateSet of dateSets) {
      it(`format=${formatPref} × dates=[${dateSet.join(",")}] emits FORMAT`, () => {
        const spec = buildSearchSpec({
          theatre: { id: "amc:theatre:832", providerId: "amc" },
          movieId: "amc:movie:1",
          selectedDates: dateSet,
          timeOfDay: "Evening",
          seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
          partySize: 1,
          formatPref: formatPref as FormatPref,
        })!;
        expect(JSON.stringify(spec.where)).toContain(needle);
      });
    }
  }
  it("FORMAT leaf survives selected-dates + each band (UI24 cross-band)", () => {
    const bands = ["Morning", "Afternoon", "Evening", "Late", "All times"];
    for (const tod of bands) {
      for (const [formatPref, needle] of cases) {
        const spec = buildSearchSpec({
          theatre: { id: "amc:theatre:832", providerId: "amc" },
          movieId: "amc:movie:1",
          selectedDates: ALL_FIXTURE_DATES,
          timeOfDay: tod,
          seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
          partySize: 1,
          formatPref: formatPref as FormatPref,
        })!;
        // TIME_WINDOW presence already covered elsewhere; here we just assert FORMAT leaf never dropped.
        const whereStr = JSON.stringify(spec.where);
        expect(whereStr).toContain(needle);
        if (tod === "All times") {
          expect(whereStr).not.toContain('"TIME_WINDOW"');
        } else {
          expect(whereStr).toContain('"TIME_WINDOW"');
        }
      }
    }
  });
});

describe("Tuesday showtimes are admitted end-to-end (UI24.3 Context-defect regression)", () => {
  // Friday 2026-08-28 plus the following Tuesday 2026-09-01, Evening band.
  // Tuesday 19:00 PDT = 2026-09-02T02:00:00Z; Monday 2026-08-31 19:00 PDT is the gap.
  const FRIDAY_PLUS_TUESDAY = ["2026-08-28", "2026-09-01"];
  it("the emitted v2 scope contains Tuesday and the matcher admits Tuesday evening", () => {
    const spec = buildSearchSpec({
      theatre: { id: "amc:theatre:832", providerId: "amc" },
      movieId: "amc:movie:1",
      selectedDates: FRIDAY_PLUS_TUESDAY,
      timeOfDay: "Evening",
      seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
      partySize: 1,
      formatPref: "any",
    })!;
    expect(spec.specVersion).toBe(2);
    expect(JSON.stringify(spec.where)).toContain('"from":"2026-09-01"');
    expect(
      showtimeMatchesWindow(
        "2026-09-02T02:00:00Z",
        "America/Los_Angeles",
        FRIDAY_PLUS_TUESDAY,
        "Evening",
      ),
    ).toBe(true);
  });
  it("the gap Monday between the runs is excluded everywhere", () => {
    expect(
      showtimeMatchesWindow(
        "2026-09-01T02:00:00Z",
        "America/Los_Angeles",
        FRIDAY_PLUS_TUESDAY,
        "Evening",
      ),
    ).toBe(false);
    const group = {
      showtimes: [
        { showDateTimeUtc: "2026-09-02T02:00:00Z", formatCode: null }, // Tue 19:00 PDT
        { showDateTimeUtc: "2026-09-01T02:00:00Z", formatCode: null }, // Mon 19:00 PDT (gap)
      ],
    };
    expect(
      summarizeMovieWindow(group, "America/Los_Angeles", FRIDAY_PLUS_TUESDAY, "Evening")!
        .matchingCount,
    ).toBe(1);
  });
});
