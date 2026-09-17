import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatAbsoluteDate } from "./dates";
import {
  resolveWhenPreset,
  resolveQuickDayIsos,
  resolveActiveDateScope,
  getDedupedPresets,
  getMergedTimeBounds,
  formatWhenReadout,
  validateCustomRange,
  expandIsos,
  matchesExistingPreset,
  toggleBandInSelection,
} from "./whenPresets";
import { buildSearchSpec, showtimeMatchesWindow } from "./buildSearchSpec";
import { create } from "zustand";
import { createSearchFormSlice } from "../store/searchFormSlice";
import type { SeatfirstStore } from "../store/seatfirstStore";
function createSearchFormTestStore() {
  return create<SeatfirstStore>()((...args) => createSearchFormSlice(...args) as SeatfirstStore);
}
describe("formatAbsoluteDate — absolute dates, never bare weekday", () => {
  it("formats Fri 28 correctly", () => {
    const d = new Date(2026, 7, 28); // Aug 28 2026 is Friday
    expect(formatAbsoluteDate(d)).toBe("Fri 28");
  });
  it("formats Sat 29 correctly", () => {
    const d = new Date(2026, 7, 29);
    expect(formatAbsoluteDate(d)).toBe("Sat 29");
  });
  it("never returns bare weekday", () => {
    const d = new Date(2026, 7, 28);
    const out = formatAbsoluteDate(d);
    expect(out).not.toBe("Friday");
    expect(out).toMatch(/^... \d+$/);
  });
});

describe("resolveWhenPreset — Tier1 presets", () => {
  it("Tonight resolves to today Evening", () => {
    const now = new Date(2026, 7, 28); // Friday
    const r = resolveWhenPreset("Tonight", now)!;
    expect(r.from).toBe("2026-08-28");
    expect(r.to).toBe("2026-08-28");
    expect(r.timeOfDay).toBe("Evening");
    expect(r.selectedBands).toEqual(["Evening"]);
    // UI24: no weekday-triple payload remains on the resolution.
    expect("days" in r).toBe(false);
  });

  it("Tomorrow evening resolves to tomorrow", () => {
    const now = new Date(2026, 7, 28);
    const r = resolveWhenPreset("Tomorrow evening", now)!;
    expect(r.from).toBe("2026-08-29");
    expect(r.to).toBe("2026-08-29");
  });

  it("This weekend on Saturday → Sat 29–Sun 30 (Saturday edge)", () => {
    const saturday = new Date(2026, 7, 29);
    const r = resolveWhenPreset("This weekend", saturday)!;
    expect(r.from).toBe("2026-08-29");
    expect(r.to).toBe("2026-08-30");
    expect("days" in r).toBe(false);
    // Readout should be Sat 29 – Sun 30 · 5 PM–9 PM
    const readout = formatWhenReadout({ from: r.from, to: r.to, selectedBands: r.selectedBands });
    expect(readout).toBe("Sat 29 – Sun 30 · 5 PM–9 PM");
  });

  it("This weekend on Friday → Fri 28–Sun 30", () => {
    const friday = new Date(2026, 7, 28);
    const r = resolveWhenPreset("This weekend", friday)!;
    expect(r.from).toBe("2026-08-28");
    expect(r.to).toBe("2026-08-30");
    expect("days" in r).toBe(false);
  });

  it("This weekend on Sunday collapses to exactly today, identical to Tonight", () => {
    // Regression: the store's initial state must not default to a literal
    // "This weekend" label on a day where its resolution is indistinguishable
    // from Tonight — getDedupedPresets drops it from the visible row (below),
    // so a whenPreset of "This weekend" here would match no rendered chip.
    const sunday = new Date(2026, 8, 6); // Sunday Sep 6 2026
    const weekend = resolveWhenPreset("This weekend", sunday)!;
    expect(weekend.from).toBe("2026-09-06");
    expect(weekend.to).toBe("2026-09-06");
    const tonight = resolveWhenPreset("Tonight", sunday)!;
    expect(weekend.from).toBe(tonight.from);
    expect(weekend.to).toBe(tonight.to);
    expect(weekend.selectedBands).toEqual(tonight.selectedBands);
    const dates = expandIsos(weekend.from, weekend.to);
    expect(matchesExistingPreset(dates, weekend.selectedBands, sunday)).toBe("Tonight");
  });
});

describe("getDedupedPresets — the four presets", () => {
  it("always returns Tonight, Tomorrow evening, This weekend, Custom, in order", () => {
    const friday = new Date(2026, 7, 28);
    expect(getDedupedPresets(friday)).toEqual([
      "Tonight",
      "Tomorrow evening",
      "This weekend",
      "Custom",
    ]);
  });

  it("drops This weekend on a Sunday, where it collides with Tonight", () => {
    const sunday = new Date(2026, 8, 6); // Sunday Sep 6 2026
    expect(getDedupedPresets(sunday)).toEqual(["Tonight", "Tomorrow evening", "Custom"]);
  });
});

describe("time bands — contiguous-range control", () => {
  it("Morning+Late → full 00:00–23:59 single window", () => {
    const merged = getMergedTimeBounds(["Morning", "Late"])!;
    expect(merged.startLocal).toBe("00:00");
    expect(merged.endLocal).toBe("23:59");
  });

  it("Morning+Afternoon → 00:00–16:59", () => {
    const merged = getMergedTimeBounds(["Morning", "Afternoon"])!;
    expect(merged.startLocal).toBe("00:00");
    expect(merged.endLocal).toBe("16:59");
  });

  it("non-adjacent Morning+Late fills middle (same as full)", () => {
    const merged = getMergedTimeBounds(["Morning", "Late"])!;
    // Should span through Afternoon, Evening
    expect(merged).toEqual({ startLocal: "00:00", endLocal: "23:59" });
  });

  it("Afternoon+Late → 12:00–23:59", () => {
    const merged = getMergedTimeBounds(["Afternoon", "Late"])!;
    expect(merged.startLocal).toBe("12:00");
    expect(merged.endLocal).toBe("23:59");
  });

  it("Any time clears (empty array => null, no TIME_WINDOW)", () => {
    const merged = getMergedTimeBounds([]);
    expect(merged).toBeNull();
  });

  it("Any time with dates selected emits no TIME_WINDOW (UI24.4)", () => {
    const spec = buildSearchSpec({
      theatre: { id: "amc:theatre:1", providerId: "amc" },
      movieId: "movie:1",
      selectedDates: ["2026-08-28"],
      timeOfDay: "All times",
      selectedBands: [],
      seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
      partySize: 2,
      formatPref: "any",
    })!;
    expect(spec.specVersion).toBe(2);
    const tw = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "TIME_WINDOW",
    );
    expect(tw).toBeUndefined();
  });
  it("selectedBands Evening emits 17:00–20:59 over all seven weekdays", () => {
    const spec = buildSearchSpec({
      theatre: { id: "amc:theatre:1", providerId: "amc" },
      movieId: "movie:1",
      selectedDates: ["2026-08-28"],
      timeOfDay: "All times",
      selectedBands: ["Evening"],
      seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
      partySize: 2,
      formatPref: "any",
    })!;
    const tw = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "TIME_WINDOW",
    ) as { kind: "TIME_WINDOW"; startLocal: string; endLocal: string; days: string[] };
    expect(tw.startLocal).toBe("17:00");
    expect(tw.endLocal).toBe("20:59");
    expect(tw.days).toEqual([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ]);
  });

  it("emitted spec and showtimeMatchesWindow agree for non-adjacent pick (property sweep)", () => {
    const selectedDates = ["2026-08-28"];
    const selectedBands = ["Morning", "Late"]; // non-adjacent
    const spec = buildSearchSpec({
      theatre: { id: "amc:theatre:1", providerId: "amc" },
      movieId: "movie:1",
      selectedDates,
      timeOfDay: "All times",
      selectedBands,
      seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
      partySize: 2,
      formatPref: "any",
    })!;
    const tw = (spec.where as { kind: "AND"; of: unknown[] }).of.find(
      (p) => (p as { kind: string }).kind === "TIME_WINDOW",
    ) as { kind: "TIME_WINDOW"; startLocal: string; endLocal: string; days: string[] };
    expect(tw.startLocal).toBe("00:00");
    expect(tw.endLocal).toBe("23:59");
    expect(tw.days).toHaveLength(7);

    // Check matcher agrees for times across the day
    const tz = "America/Los_Angeles";
    // 10:00 should match (Morning), 15:00 Afternoon, 18:00 Evening, 22:00 Late → all should match because window is full day
    const samples: Array<{ utc: string; shouldMatch: boolean }> = [
      { utc: "2026-08-28T17:00:00Z", shouldMatch: true }, // Fri 10:00 PDT
      { utc: "2026-08-28T22:00:00Z", shouldMatch: true }, // Fri 15:00 PDT
      { utc: "2026-08-29T01:00:00Z", shouldMatch: true }, // Fri 18:00 PDT
      { utc: "2026-08-29T05:00:00Z", shouldMatch: true }, // Fri 22:00 PDT
    ];
    for (const { utc, shouldMatch } of samples) {
      const matches = showtimeMatchesWindow(utc, tz, selectedDates, selectedBands);
      expect(matches).toBe(shouldMatch);
    }
    // A Sunday show is outside the selected Friday set, so it never matches —
    // date membership, not a weekday flag, decides.
    const sundayUtc = "2026-08-30T18:00:00Z"; // Sun 11:00 PDT
    expect(showtimeMatchesWindow(sundayUtc, tz, selectedDates, selectedBands)).toBe(false);
  });
});

describe("Custom sheet — ≤30-day validation", () => {
  it("≤30 days valid", () => {
    expect(validateCustomRange("2026-08-28", "2026-09-26").valid).toBe(true); // 30 days inclusive
    expect(validateCustomRange("2026-08-28", "2026-08-28").valid).toBe(true); // 1 day
  });
  it("31 days invalid", () => {
    const r = validateCustomRange("2026-08-28", "2026-09-27"); // 31 days
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/30/);
  });
  it("end before start invalid", () => {
    const r = validateCustomRange("2026-08-30", "2026-08-28");
    expect(r.valid).toBe(false);
  });
});

describe("Chip interaction → Custom rename (store, UI24.5)", () => {
  it("initial selectedDates/whenPreset are never empty and the preset is one the chip row actually renders", () => {
    // searchFormInitialState is computed once at module load against the
    // real wall clock, so this can't fake `now` — instead it asserts the
    // invariant that actually matters: whatever preset the store starts
    // with must be a label getDedupedPresets(now) still renders. Regression
    // for the bug where the store defaulted to a hardcoded "This weekend"
    // even on days (e.g. Sunday) where This weekend collapses into Tonight
    // and gets deduped out of the chip row, leaving no chip highlighted.
    const useStore = createSearchFormTestStore();
    const s = useStore.getState();
    expect(s.selectedDates.length).toBeGreaterThan(0);
    expect([...s.selectedDates].sort()).toEqual(s.selectedDates);
    expect(getDedupedPresets(new Date())).toContain(s.whenPreset);
    expect(s.isCustom).toBe(false);
  });

  it("multi-date press removes the exact date and renames the selection to Custom", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      selectedDates: ["2026-08-28", "2026-08-29", "2026-08-30"],
      whenPreset: "This weekend",
      isCustom: false,
    });
    useStore.getState().removeSelectedDate("2026-08-29");
    expect(useStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-30"]);
    expect(useStore.getState().isCustom).toBe(true);
    expect(useStore.getState().whenPreset).toBe("Custom");
  });

  it("sole-date press is a no-op — membership and preset label unchanged", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      selectedDates: ["2026-09-02"],
      whenPreset: "Tonight",
      isCustom: false,
    });
    useStore.getState().removeSelectedDate("2026-09-02");
    expect(useStore.getState().selectedDates).toEqual(["2026-09-02"]);
    expect(useStore.getState().whenPreset).toBe("Tonight");
    expect(useStore.getState().isCustom).toBe(false);
  });

  it("removing an unselected date is a no-op", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      selectedDates: ["2026-08-28", "2026-08-29"],
      whenPreset: "Custom",
      isCustom: true,
    });
    useStore.getState().removeSelectedDate("2026-09-01");
    expect(useStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("selectWhenPreset writes the expanded ISO set plus bands", () => {
    const useStore = createSearchFormTestStore();
    useStore.getState().selectWhenPreset("Tomorrow evening");
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Tomorrow evening");
    expect(s.isCustom).toBe(false);
    expect(s.selectedBands).toEqual(["Evening"]);
    expect(s.selectedDates).toHaveLength(1);
  });

  it("setCustomDates canonicalizes; the empty-set rejection stays the store guard", () => {
    const useStore = createSearchFormTestStore();
    expect(useStore.getState().setCustomDates([])).toBe(false);
    expect(useStore.getState().setCustomDates(["2026-09-08", "2026-09-04"])).toBe(true);
    expect(useStore.getState().selectedDates).toEqual(["2026-09-04", "2026-09-08"]);
    expect(useStore.getState().whenPreset).toBe("Custom");
  });

  it("toggleBand sets isCustom true without touching selectedDates membership", () => {
    const useStore = createSearchFormTestStore();
    expect(useStore.getState().isCustom).toBe(false);
    const before = [...useStore.getState().selectedDates];
    // Initial is Evening; picking Morning extends through Afternoon (contiguous)
    useStore.getState().toggleBand("Morning");
    expect(useStore.getState().isCustom).toBe(true);
    expect(useStore.getState().whenPreset).toBe("Custom");
    expect(useStore.getState().selectedBands).toEqual(["Morning", "Afternoon", "Evening"]);
    expect(useStore.getState().selectedDates).toEqual(before);
  });

  it("Any time clears selectedBands", () => {
    const useStore = createSearchFormTestStore();
    // Start from Any time
    useStore.getState().setSelectedBands([]);
    expect(useStore.getState().selectedBands).toEqual([]);
    useStore.getState().toggleBand("Morning");
    expect(useStore.getState().selectedBands).toEqual(["Morning"]);
    useStore.getState().toggleBand("Any time");
    expect(useStore.getState().selectedBands).toEqual([]);
  });
});
describe("Tier2 read-out — absolute dates and real hours", () => {
  it("readout for single day Tonight", () => {
    const out = formatWhenReadout({
      from: "2026-08-28",
      to: "2026-08-28",
      selectedBands: ["Evening"],
    });
    expect(out).toBe("Fri 28 · 5 PM–9 PM");
  });
  it("readout for This weekend on Saturday", () => {
    const out = formatWhenReadout({
      from: "2026-08-29",
      to: "2026-08-30",
      selectedBands: ["Evening"],
    });
    expect(out).toBe("Sat 29 – Sun 30 · 5 PM–9 PM");
  });
  it("Any time readout", () => {
    const out = formatWhenReadout({ from: "2026-08-28", to: "2026-08-28", selectedBands: [] });
    expect(out).toBe("Fri 28 · Any time");
  });
});

describe("expandIsos helper", () => {
  it("expands inclusive", () => {
    expect(expandIsos("2026-08-28", "2026-08-30")).toEqual([
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);
  });
});

describe("resolveQuickDayIsos — one chip per date in the resolved window", () => {
  it("uses the committed selectedDates set verbatim, not the enclosing span", () => {
    const now = new Date(2026, 8, 1, 10, 0);
    expect(
      resolveQuickDayIsos({
        selectedDates: ["2026-09-08", "2026-09-04"],
        whenPreset: "Custom",
        now,
      }),
    ).toEqual(["2026-09-04", "2026-09-08"]);
  });
});

describe("resolveActiveDateScope — exact active scope (UI24.6)", () => {
  it("collapses a contiguous set to one DATE_RANGE", () => {
    const now = new Date(2026, 8, 1, 10, 0);
    expect(
      resolveActiveDateScope({
        selectedDates: ["2026-09-06", "2026-09-04", "2026-09-05"],
        whenPreset: "Custom",
        now,
      }),
    ).toEqual({ kind: "DATE_RANGE", from: "2026-09-04", to: "2026-09-06" });
  });

  it("expands a sparse set to an OR of DATE_RANGEs", () => {
    const now = new Date(2026, 8, 1, 10, 0);
    expect(
      resolveActiveDateScope({
        selectedDates: ["2026-09-08", "2026-09-04"],
        whenPreset: "Custom",
        now,
      }),
    ).toEqual({
      kind: "OR",
      of: [
        { kind: "DATE_RANGE", from: "2026-09-04", to: "2026-09-04" },
        { kind: "DATE_RANGE", from: "2026-09-08", to: "2026-09-08" },
      ],
    });
  });

  it("resolves a non-Custom preset to a DATE_RANGE from resolveWhenPreset", () => {
    const now = new Date(2026, 7, 29, 23, 30);
    const resolved = resolveWhenPreset("This weekend", now)!;
    expect(resolveActiveDateScope({ whenPreset: "This weekend", now })).toEqual({
      kind: "DATE_RANGE",
      from: resolved.from,
      to: resolved.to,
    });
  });
});
describe("reverse-canonicalization → auto-select preset (ADR 0044 amendment 2026-09-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday Sep 2 2026: Tonight is [2026-09-02] + Evening, Tomorrow
    // evening is [2026-09-03] + Evening, This weekend is [2026-09-04 .. 06].
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matchesExistingPreset resolves each named preset on an exact match", () => {
    const now = new Date();
    expect(matchesExistingPreset(["2026-09-02"], ["Evening"], now)).toBe("Tonight");
    expect(matchesExistingPreset(["2026-09-03"], ["Evening"], now)).toBe("Tomorrow evening");
    expect(
      matchesExistingPreset(["2026-09-04", "2026-09-05", "2026-09-06"], ["Evening"], now),
    ).toBe("This weekend");
  });

  it("matchesExistingPreset returns null for genuinely custom selections", () => {
    const now = new Date();
    // Right dates, wrong bands.
    expect(matchesExistingPreset(["2026-09-02"], ["Morning"], now)).toBeNull();
    // Right bands, extra date.
    expect(matchesExistingPreset(["2026-09-02", "2026-09-03"], ["Evening"], now)).toBeNull();
    // Non-contiguous custom set.
    expect(matchesExistingPreset(["2026-09-04", "2026-09-08"], ["Evening"], now)).toBeNull();
    // Any-time bands never equal a preset's Evening window.
    expect(matchesExistingPreset(["2026-09-02"], [], now)).toBeNull();
  });

  it("setCustomDates committing exactly today snaps to Tonight", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({ whenPreset: "Custom", isCustom: true, selectedBands: ["Evening"] });
    expect(useStore.getState().setCustomDates(["2026-09-02"])).toBe(true);
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Tonight");
    expect(s.isCustom).toBe(false);
    expect(s.selectedDates).toEqual(["2026-09-02"]);
    expect(s.selectedBands).toEqual(["Evening"]);
  });

  it("setCustomRange committing exactly tomorrow snaps to Tomorrow evening", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({ whenPreset: "Custom", isCustom: true, selectedBands: ["Evening"] });
    expect(useStore.getState().setCustomRange("2026-09-03", "2026-09-03")).toBe(true);
    expect(useStore.getState().whenPreset).toBe("Tomorrow evening");
    expect(useStore.getState().isCustom).toBe(false);
  });

  it("toggleBand narrowing to the preset band set snaps to Tonight", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-02"],
      selectedBands: ["Morning", "Afternoon", "Evening"],
    });
    useStore.getState().toggleBand("Evening");
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Tonight");
    expect(s.isCustom).toBe(false);
    expect(s.selectedBands).toEqual(["Evening"]);
  });

  it("setSelectedBands to a non-preset range stays Custom", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-02"],
      selectedBands: ["Evening"],
    });
    useStore.getState().setSelectedBands(["Morning"]);
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Custom");
    expect(s.isCustom).toBe(true);
    expect(s.selectedBands).toEqual(["Morning"]);
  });

  it("removeSelectedDate leaving exactly the weekend set snaps to This weekend", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"],
      selectedBands: ["Evening"],
    });
    useStore.getState().removeSelectedDate("2026-09-07");
    const s = useStore.getState();
    expect(s.whenPreset).toBe("This weekend");
    expect(s.isCustom).toBe(false);
    expect(s.selectedDates).toEqual(["2026-09-04", "2026-09-05", "2026-09-06"]);
  });
});

describe("toggleBandInSelection — pure contiguous-range toggle (ADR 0044 amendment 2026-09-05)", () => {
  it("clearing via Any time or All times empties the selection", () => {
    expect(toggleBandInSelection(["Morning", "Afternoon"], "Any time")).toEqual({
      bands: [],
      timeOfDay: "All times",
    });
    expect(toggleBandInSelection(["Evening"], "All times")).toEqual({
      bands: [],
      timeOfDay: "All times",
    });
  });

  it("tapping the sole active band clears the selection", () => {
    expect(toggleBandInSelection(["Evening"], "Evening")).toEqual({
      bands: [],
      timeOfDay: "All times",
    });
  });

  it("tapping a band inside the active span narrows to just that band", () => {
    expect(toggleBandInSelection(["Morning", "Afternoon", "Evening"], "Afternoon")).toEqual({
      bands: ["Afternoon"],
      timeOfDay: "Afternoon",
    });
  });

  it("tapping a band above the span extends upward through the middle", () => {
    expect(toggleBandInSelection(["Evening"], "Morning")).toEqual({
      bands: ["Morning", "Afternoon", "Evening"],
      timeOfDay: "Morning",
    });
  });

  it("tapping a band below the span extends downward through the middle", () => {
    expect(toggleBandInSelection(["Morning"], "Late")).toEqual({
      bands: ["Morning", "Afternoon", "Evening", "Late"],
      timeOfDay: "Morning",
    });
  });

  it("tapping from an empty selection starts a single-band span", () => {
    expect(toggleBandInSelection([], "Late")).toEqual({ bands: ["Late"], timeOfDay: "Late" });
  });

  it("an unknown band leaves the selection unchanged", () => {
    expect(toggleBandInSelection(["Evening"], "Dawn")).toEqual({
      bands: ["Evening"],
      timeOfDay: "Evening",
    });
  });
});

describe("applyCustomSelection — atomic Custom dialog commit (ADR 0044 amendment 2026-09-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday Sep 2 2026: Tonight is [2026-09-02] + Evening.
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits a non-preset date+band combination as Custom with both axes together", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Tonight",
      isCustom: false,
      selectedDates: ["2026-09-02"],
      selectedBands: ["Evening"],
    });
    expect(
      useStore.getState().applyCustomSelection(["2026-09-04", "2026-09-08"], ["Morning"]),
    ).toBe(true);
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Custom");
    expect(s.isCustom).toBe(true);
    expect(s.selectedDates).toEqual(["2026-09-04", "2026-09-08"]);
    expect(s.selectedBands).toEqual(["Morning"]);
    expect(s.timeOfDay).toBe("Morning");
  });

  it("snaps a preset-matching combination to that preset, like setCustomDates", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-04", "2026-09-08"],
      selectedBands: ["Morning"],
    });
    expect(useStore.getState().applyCustomSelection(["2026-09-02"], ["Evening"])).toBe(true);
    const s = useStore.getState();
    expect(s.whenPreset).toBe("Tonight");
    expect(s.isCustom).toBe(false);
    expect(s.selectedDates).toEqual(["2026-09-02"]);
    expect(s.selectedBands).toEqual(["Evening"]);
  });

  it("invalid dates return false and leave dates and bands unchanged", () => {
    const useStore = createSearchFormTestStore();
    useStore.setState({
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-04", "2026-09-08"],
      selectedBands: ["Morning"],
    });
    expect(useStore.getState().applyCustomSelection([], ["Evening"])).toBe(false);
    expect(useStore.getState().selectedDates).toEqual(["2026-09-04", "2026-09-08"]);
    expect(useStore.getState().selectedBands).toEqual(["Morning"]);
    // A 45-day span fails validateCustomRange — still no partial commit.
    expect(
      useStore.getState().applyCustomSelection(["2026-09-01", "2026-10-15"], ["Evening"]),
    ).toBe(false);
    expect(useStore.getState().selectedDates).toEqual(["2026-09-04", "2026-09-08"]);
    expect(useStore.getState().selectedBands).toEqual(["Morning"]);
  });
});
