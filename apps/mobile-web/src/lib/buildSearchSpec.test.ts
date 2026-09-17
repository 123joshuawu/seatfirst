// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars */
import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_LIMITS, validateSearchSpecV1 } from "@seatfirst/core";
import type { TheatreRef } from "@seatfirst/core";
import { buildSearchSpec } from "./buildSearchSpec";
import { expandIsos, resolveWhenPreset } from "./whenPresets";
import type { FormatPref } from "@/types/placement";

const ALL_WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

const NOW = new Date("2026-03-04T12:00:00Z");
const MOVIE_ID = "amc:movie:1";
const THEATRE_REFS: TheatreRef[] = [
  { id: "amc:theatre:1" },
  { id: "amc:theatre:2" },
  { id: "amc:theatre:3" },
];
const SINGLE_REF: TheatreRef[] = [{ id: "amc:theatre:832" }];

function baseInput(overrides: Partial<ReturnType<typeof makeBase>> = {}) {
  return {
    movieId: MOVIE_ID,
    selectedDates: ["2026-03-04"],
    timeOfDay: "All times",
    seatPrefs: {} as Record<string, boolean>,
    partySize: 4,
    formatPref: "any" as FormatPref,
    ...overrides,
  };
}

function makeBase() {
  return baseInput();
}

// Helper to extract TIME_WINDOW from spec
function getTimeWindow(spec: ReturnType<typeof buildSearchSpec>) {
  if (!spec) return undefined;
  if (spec.where.kind !== "AND") return undefined;
  return spec.where.of.find(
    (p): p is Extract<typeof p, { kind: "TIME_WINDOW" }> => p.kind === "TIME_WINDOW",
  );
}

describe("buildSearchSpec AREA vs LIST (UI18.5)", () => {
  it("emits AREA for device location with no hand-edit", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: 10,
      },
    });
    expect(spec).not.toBeNull();
    expect(spec!.theatres.kind).toBe("AREA");
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.center).toEqual({ lat: 37.7749, lng: -122.4194 });
      expect(spec!.theatres.radiusKm).toBe(10);
      expect(spec!.theatres.limit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
      expect(spec!.providerId).toBe("amc");
    }
  });

  it("emits AREA via whereState alias and whereCenter alias", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      whereState: {
        whereCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 8,
      },
    });
    expect(spec?.theatres.kind).toBe("AREA");
    if (spec?.theatres.kind === "AREA") {
      expect(spec.theatres.center).toEqual({ lat: 37.7749, lng: -122.4194 });
    }
  });

  it("emits LIST for typed place (place present) even without hand-edit", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: null,
        place: { theatres: THEATRE_REFS, label: "Downtown SF" },
        wherePlace: { query: "downtown sf", label: "Downtown SF", radiusKm: 10 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: 10,
      },
    });
    expect(spec).not.toBeNull();
    expect(spec!.theatres.kind).toBe("LIST");
    if (spec!.theatres.kind === "LIST") {
      expect(spec!.theatres.refs).toEqual(THEATRE_REFS);
    }
  });

  it("emits LIST for typed place via wherePlace alone (ADR 0045)", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: null,
        wherePlace: { query: "berkeley", label: "Berkeley", radiusKm: 12 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: 12,
      },
    });
    expect(spec!.theatres.kind).toBe("LIST");
  });

  it("emits LIST when device center is hand-edited (isHandEdited true)", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: [{ id: "amc:theatre:1" }], // user unchecked 2 of 3
        radiusKm: 10,
        isHandEdited: true,
      },
    });
    expect(spec!.theatres.kind).toBe("LIST");
    if (spec!.theatres.kind === "LIST") {
      expect(spec!.theatres.refs).toEqual([{ id: "amc:theatre:1" }]);
    }
  });

  it("emits LIST when device center hand-edited via hasHandEdit alias", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 10,
        hasHandEdit: true,
      },
    });
    expect(spec!.theatres.kind).toBe("LIST");
  });

  it("returns null when whereState has no selectedTheatres (no-guess gate)", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: [],
        radiusKm: 10,
      },
    });
    expect(spec).toBeNull();
  });

  it("legacy theatre path still emits LIST single ref", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:832", providerId: "amc" },
    });
    expect(spec!.theatres).toEqual({ kind: "LIST", refs: [{ id: "amc:theatre:832" }] });
    expect(spec!.providerId).toBe("amc");
  });

  it("where takes precedence over legacy theatre", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:999", providerId: "amc" },
      where: {
        deviceCenter: { lat: 1, lng: 2 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 5,
      },
    });
    expect(spec!.theatres.kind).toBe("AREA");
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.center).toEqual({ lat: 1, lng: 2 });
    }
  });
});

describe("buildSearchSpec clamp and ceilings (UI18.5)", () => {
  it("clamps radiusKm 40.23 (25 mi) to maxAreaRadiusKm 40", () => {
    const wideRadiusKm = 40.23;
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: wideRadiusKm,
      },
    });
    expect(spec!.theatres.kind).toBe("AREA");
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.radiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
      expect(spec!.theatres.radiusKm).toBeLessThanOrEqual(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
      // ensure clamped value is exactly ceiling, not original wide value
      expect(spec!.theatres.radiusKm).not.toBe(wideRadiusKm);
    }
  });

  it("does not clamp radius below ceiling", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 10,
      },
    });
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.radiusKm).toBe(10);
    }
  });

  it("limit always equals DEFAULT_SEARCH_LIMITS.maxTheatres regardless of input limit", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 10,
        limit: 999,
      },
    });
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.limit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    }
  });

  it("ceilings come from DEFAULT_SEARCH_LIMITS — limit is not re-typed", () => {
    // This test asserts we use the constant, not a hardcoded literal.
    // If implementation hardcoded 25, changing DEFAULT would not affect output;
    // we verify by checking equality with DEFAULT.
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 10, lng: 20 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 5,
      },
    });
    expect(spec!.theatres.kind).toBe("AREA");
    if (spec!.theatres.kind === "AREA") {
      expect(spec!.theatres.limit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
      expect(spec!.theatres.limit).toBe(25); // sanity: known default, but primary is DEFAULT check
    }
  });

  it("wide chip (40.23 km) never produces a spec rejected by validator (SELECTOR_UNSUPPORTED)", () => {
    const wideRadiusKm = 40.23;
    const spec = buildSearchSpec({
      ...baseInput(),
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: wideRadiusKm,
      },
    })!;
    expect(spec.theatres.kind).toBe("AREA");

    const issues = validateSearchSpecV1(
      spec,
      {
        today: "2026-03-04",
        resolvedDateSpan: {
          from: spec.where.kind === "AND" ? "2026-03-04" : "2026-03-04",
          to: "2026-03-06",
        },
        // Use spec's own DATE_RANGE to avoid mismatch; derive from spec where
        resolvedShowtimeCount: 10,
      },
      DEFAULT_SEARCH_LIMITS,
    );
    // Extract DATE_RANGE from spec to build accurate context
    const dateRange =
      spec.where.kind === "AND"
        ? (spec.where.of.find((p) => p.kind === "DATE_RANGE") as
            { from: string; to: string } | undefined)
        : undefined;
    const issues2 = validateSearchSpecV1(
      spec,
      {
        today: dateRange!.from,
        resolvedDateSpan: { from: dateRange!.from, to: dateRange!.to },
        resolvedShowtimeCount: 10,
      },
      DEFAULT_SEARCH_LIMITS,
    );
    expect(issues2.map((i) => i.code)).not.toContain("SELECTOR_UNSUPPORTED");
  });

  it("unclamped radius would be rejected — proving clamp is required (fail→pass sentry)", () => {
    // Construct a raw AREA spec bypassing buildSearchSpec to show validator rejects 40.23
    const unclampedSpec = {
      specVersion: 1 as const,
      providerId: "amc" as const,
      theatres: {
        kind: "AREA" as const,
        center: { lat: 37.7749, lng: -122.4194 },
        radiusKm: 40.23,
        limit: DEFAULT_SEARCH_LIMITS.maxTheatres,
      },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:1"] },
          { kind: "DATE_RANGE" as const, from: "2026-03-04", to: "2026-03-06" },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      group: { kind: "RUN" as const, count: 4 },
      groupStrict: false as const,
      rank: "SCORE" as const,
    };
    const issues = validateSearchSpecV1(
      unclampedSpec,
      {
        today: "2026-03-04",
        resolvedDateSpan: { from: "2026-03-04", to: "2026-03-06" },
        resolvedShowtimeCount: 10,
      },
      DEFAULT_SEARCH_LIMITS,
    );
    expect(issues.map((i) => i.code)).toContain("SELECTOR_UNSUPPORTED");
  });
});

describe("buildSearchSpec golden specs with When bands (UI18.5)", () => {
  const bands: Array<{ timeOfDay: string; startLocal: string; endLocal: string }> = [
    { timeOfDay: "Morning", startLocal: "00:00", endLocal: "11:59" },
    { timeOfDay: "Afternoon", startLocal: "12:00", endLocal: "16:59" },
    { timeOfDay: "Evening", startLocal: "17:00", endLocal: "20:59" },
    { timeOfDay: "Late", startLocal: "21:00", endLocal: "23:59" },
    { timeOfDay: "All times", startLocal: "00:00", endLocal: "23:59" },
  ];

  for (const band of bands) {
    it(`AREA device + band "${band.timeOfDay}" emits correct TIME_WINDOW or none`, () => {
      const spec = buildSearchSpec({
        ...baseInput(),
        selectedDates: ["2026-03-06"],
        timeOfDay: band.timeOfDay,
        where: {
          deviceCenter: { lat: 37.7749, lng: -122.4194 },
          selectedTheatres: SINGLE_REF,
          radiusKm: 15,
        },
      })!;
      expect(spec.theatres.kind).toBe("AREA");
      expect(spec.specVersion).toBe(2);
      const tw = getTimeWindow(spec);
      if (band.timeOfDay === "All times") {
        // UI24: Any time emits no TIME_WINDOW regardless of the selected dates.
        expect(tw).toBeUndefined();
        expect(spec.where.kind).toBe("AND");
        if (spec.where.kind === "AND") {
          expect(spec.where.of.length).toBe(2);
        }
      } else {
        expect(tw?.startLocal).toBe(band.startLocal);
        expect(tw?.endLocal).toBe(band.endLocal);
        // UI24: band filtering never drops a date — the window always spans all seven weekdays.
        expect(tw?.days).toEqual(ALL_WEEKDAYS);
        // Ensure AREA vs LIST does not alter where predicate count
        // MOVIE + DATE_RANGE + TIME_WINDOW = 3 nodes in AND
        expect(spec.where.kind).toBe("AND");
        if (spec.where.kind === "AND") {
          expect(spec.where.of.length).toBe(3);
        }
      }
    });

    it(`LIST typed-place + band "${band.timeOfDay}" emits same where as AREA`, () => {
      const selectedDates = ["2026-03-07"];
      const specArea = buildSearchSpec({
        ...baseInput(),
        selectedDates,
        timeOfDay: band.timeOfDay,
        where: {
          deviceCenter: { lat: 37.7749, lng: -122.4194 },
          selectedTheatres: SINGLE_REF,
          radiusKm: 15,
        },
      })!;
      const specList = buildSearchSpec({
        ...baseInput(),
        selectedDates,
        timeOfDay: band.timeOfDay,
        where: {
          deviceCenter: null,
          wherePlace: { query: "oakland", label: "Oakland", radiusKm: 15 },
          selectedTheatres: SINGLE_REF,
          radiusKm: 15,
        },
      })!;
      // Where predicate should be identical regardless of AREA vs LIST
      expect(specArea.where).toEqual(specList.where);
      expect(specList.theatres.kind).toBe("LIST");
      expect(specArea.theatres.kind).toBe("AREA");
    });

    it(`LIST hand-edited device + band "${band.timeOfDay}" emits LIST with same where`, () => {
      const selectedDates = ["2026-03-08"];
      const specArea = buildSearchSpec({
        ...baseInput(),
        selectedDates,
        timeOfDay: band.timeOfDay,
        where: {
          deviceCenter: { lat: 37, lng: -122 },
          selectedTheatres: THEATRE_REFS,
          radiusKm: 12,
        },
      })!;
      const specHand = buildSearchSpec({
        ...baseInput(),
        selectedDates,
        timeOfDay: band.timeOfDay,
        where: {
          deviceCenter: { lat: 37, lng: -122 },
          selectedTheatres: [THEATRE_REFS[0]],
          radiusKm: 12,
          isHandEdited: true,
        },
      })!;
      expect(specHand.theatres.kind).toBe("LIST");
      expect(specArea.where).toEqual(specHand.where);
    });
  }

  it("Any day + All times with AREA emits no TIME_WINDOW", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      timeOfDay: "All times",
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 10,
      },
    })!;
    const tw = getTimeWindow(spec);
    expect(tw).toBeUndefined();
    expect(spec.where.kind).toBe("AND");
    if (spec.where.kind === "AND") {
      expect(spec.where.of.some((p) => p.kind === "TIME_WINDOW")).toBe(false);
    }
  });

  it("Any day + Evening with LIST emits TIME_WINDOW over all weekdays", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      timeOfDay: "Evening",
      where: {
        wherePlace: { query: "sf", label: "SF", radiusKm: 10 },
        selectedTheatres: SINGLE_REF,
        radiusKm: 10,
      },
    })!;
    const tw = getTimeWindow(spec);
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
  });
});

describe("buildSearchSpec preserves other predicates across AREA/LIST flip", () => {
  it("FORMAT, DATE_RANGE, groupRegion identical for AREA vs LIST", () => {
    const common = {
      ...baseInput(),
      timeOfDay: "Evening",
      formatPref: "imax" as FormatPref,
      seatPrefs: { Centered: true, Aisle: true, "Avoid front": false } as Record<string, boolean>,
    };
    const specArea = buildSearchSpec({
      ...common,
      where: {
        deviceCenter: { lat: 37.7749, lng: -122.4194 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: 10,
      },
    })!;
    const specList = buildSearchSpec({
      ...common,
      where: {
        wherePlace: { query: "sf", label: "SF", radiusKm: 10 },
        selectedTheatres: THEATRE_REFS,
        radiusKm: 10,
      },
    })!;
    expect(specArea.where).toEqual(specList.where);
    expect(specArea.groupRegion).toEqual(specList.groupRegion);
    expect(specArea.providerId).toBe(specList.providerId);
    expect(specArea.theatres.kind).toBe("AREA");
    expect(specList.theatres.kind).toBe("LIST");
  });
});

describe("buildSearchSpec emits the committed selection as normalized v2 (UI24)", () => {
  it("preset-selected dates emit the resolved weekend range at specVersion 2", () => {
    const expected = resolveWhenPreset("This weekend", NOW)!;
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:832", providerId: "amc" },
      selectedDates: expandIsos(expected.from, expected.to),
      timeOfDay: "Evening",
    })!;
    expect(spec.specVersion).toBe(2);
    const dateRange = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "DATE_RANGE",
    ) as { from: string; to: string };
    expect(dateRange.from).toBe(expected.from);
    expect(dateRange.to).toBe(expected.to);
    // Guards the old widening regression: the scope must be exactly the
    // resolved weekend, never the 30-day browse-window fallback (now + 29 days).
    expect(dateRange.to).not.toBe("2026-04-02");
  });

  it("Tonight, Tomorrow evening, and This weekend each resolve to their exact dates at v2", () => {
    for (const preset of ["Tonight", "Tomorrow evening", "This weekend"] as const) {
      const resolved = resolveWhenPreset(preset, NOW)!;
      const spec = buildSearchSpec({
        ...baseInput(),
        theatre: { id: "amc:theatre:832", providerId: "amc" },
        selectedDates: expandIsos(resolved.from, resolved.to),
        timeOfDay: "Evening",
      })!;
      expect(spec.specVersion).toBe(2);
      const dateRange = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
        (p) => (p as { kind: string }).kind === "DATE_RANGE",
      ) as { from: string; to: string };
      expect(dateRange).toEqual({
        kind: "DATE_RANGE",
        from: resolved.from,
        to: resolved.to,
      });
    }
  });

  it("a sparse Custom set emits a direct-child OR of DATE_RANGE leaves at v2", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:832", providerId: "amc" },
      selectedDates: ["2026-03-12", "2026-03-10"],
      timeOfDay: "All times",
    })!;
    expect(spec.specVersion).toBe(2);
    const orNode = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "OR",
    ) as { kind: "OR"; of: Array<{ kind: string; from: string; to: string }> };
    expect(orNode.of).toEqual([
      { kind: "DATE_RANGE", from: "2026-03-10", to: "2026-03-10" },
      { kind: "DATE_RANGE", from: "2026-03-12", to: "2026-03-12" },
    ]);
  });

  it("empty selectedDates fails closed to null", () => {
    expect(
      buildSearchSpec({
        ...baseInput(),
        theatre: { id: "amc:theatre:832", providerId: "amc" },
        selectedDates: [],
      }),
    ).toBeNull();
  });

  it("a span over 30 days fails closed to null", () => {
    expect(
      buildSearchSpec({
        ...baseInput(),
        theatre: { id: "amc:theatre:832", providerId: "amc" },
        selectedDates: ["2026-03-01", "2026-04-05"],
      }),
    ).toBeNull();
  });
});

describe("buildSearchSpec Tuesday-after-This-weekend stale-state regression (UI24.3)", () => {
  it("a Custom Friday-plus-Tuesday set emits a v2 scope containing Tuesday", () => {
    // Friday 2026-08-28 plus the following Tuesday 2026-09-01: the Context
    // defect admitted only weekend performances on the wire while the calendar
    // showed Tuesday. The scope must contain Tuesday verbatim.
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:832", providerId: "amc" },
      selectedDates: ["2026-08-28", "2026-09-01"],
      timeOfDay: "Evening",
    })!;
    expect(spec.specVersion).toBe(2);
    const orNode = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "OR",
    ) as { kind: "OR"; of: Array<{ kind: string; from: string; to: string }> };
    expect(orNode.of).toEqual([
      { kind: "DATE_RANGE", from: "2026-08-28", to: "2026-08-28" },
      { kind: "DATE_RANGE", from: "2026-09-01", to: "2026-09-01" },
    ]);
    // The TIME_WINDOW constrains wall-clock time only — it must not re-admit
    // a weekday filter that would drop Tuesday.
    const tw = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "TIME_WINDOW",
    ) as { days: string[]; startLocal: string; endLocal: string };
    expect(tw.days).toEqual(ALL_WEEKDAYS);
    expect(tw.startLocal).toBe("17:00");
    expect(tw.endLocal).toBe("20:59");
  });
});

describe("buildSearchSpec time-only TIME_WINDOW (UI24.4)", () => {
  it("Any time emits no TIME_WINDOW", () => {
    const spec = buildSearchSpec({
      ...baseInput(),
      theatre: { id: "amc:theatre:832", providerId: "amc" },
      selectedDates: ["2026-08-28", "2026-08-29"],
      timeOfDay: "All times",
    })!;
    expect(spec.specVersion).toBe(2);
    expect(JSON.stringify(spec.where)).not.toContain("TIME_WINDOW");
  });

  it("each band emits one TIME_WINDOW with all seven weekdays and its ADR 0043 bounds", () => {
    const cases: Array<[string[], string, string]> = [
      [["Morning"], "00:00", "11:59"],
      [["Morning", "Afternoon"], "00:00", "16:59"],
      [["Evening"], "17:00", "20:59"],
      [["Late"], "21:00", "23:59"],
    ];
    for (const [bands, start, end] of cases) {
      const spec = buildSearchSpec({
        ...baseInput(),
        theatre: { id: "amc:theatre:832", providerId: "amc" },
        selectedDates: ["2026-08-28"],
        timeOfDay: "All times",
        selectedBands: bands,
      })!;
      const tw = getTimeWindow(spec)!;
      expect(tw.days).toEqual(ALL_WEEKDAYS);
      expect(tw.startLocal).toBe(start);
      expect(tw.endLocal).toBe(end);
    }
  });
});
