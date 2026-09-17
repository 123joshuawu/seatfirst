import { describe, expect, it } from "vitest";
import { resolveWeekendPreset, TIME_OF_DAY_PRESET_BOUNDS } from "../src/facet-presets.js";

describe("resolveWeekendPreset", () => {
  it("thisWeekend resolves to current Fri-Sun block", () => {
    expect(resolveWeekendPreset("thisWeekend", "2026-08-26")).toEqual({
      range: { from: "2026-08-28", to: "2026-08-30" },
      days: ["FRIDAY", "SATURDAY", "SUNDAY"],
    });
  });
  it("nextThreeWeekends from Wed skips current block", () => {
    expect(resolveWeekendPreset("nextThreeWeekends", "2026-08-26")).toEqual({
      range: { from: "2026-09-04", to: "2026-09-20" },
      days: ["FRIDAY", "SATURDAY", "SUNDAY"],
    });
  });
  it("request made on Friday selects following Friday for nextThreeWeekends (ADR 0028 edge)", () => {
    expect(resolveWeekendPreset("nextThreeWeekends", "2026-08-28")).toEqual({
      range: { from: "2026-09-04", to: "2026-09-20" },
      days: ["FRIDAY", "SATURDAY", "SUNDAY"],
    });
  });
  it("handles Saturday in current block", () => {
    expect(resolveWeekendPreset("thisWeekend", "2026-08-29")).toEqual({
      range: { from: "2026-08-28", to: "2026-08-30" },
      days: ["FRIDAY", "SATURDAY", "SUNDAY"],
    });
  });
});

describe("TIME_OF_DAY_PRESET_BOUNDS", () => {
  it("has exactly the five ADR 0043 §1 inclusive bounds (hand-typed, not re-derived)", () => {
    expect(TIME_OF_DAY_PRESET_BOUNDS.allTimes).toEqual({ startLocal: "00:00", endLocal: "23:59" });
    expect(TIME_OF_DAY_PRESET_BOUNDS.morning).toEqual({ startLocal: "00:00", endLocal: "11:59" });
    expect(TIME_OF_DAY_PRESET_BOUNDS.afternoon).toEqual({ startLocal: "12:00", endLocal: "16:59" });
    expect(TIME_OF_DAY_PRESET_BOUNDS.evening).toEqual({ startLocal: "17:00", endLocal: "20:59" });
    expect(TIME_OF_DAY_PRESET_BOUNDS.late).toEqual({ startLocal: "21:00", endLocal: "23:59" });
  });

  it("has exactly five keys", () => {
    expect(Object.keys(TIME_OF_DAY_PRESET_BOUNDS).sort()).toEqual([
      "afternoon",
      "allTimes",
      "evening",
      "late",
      "morning",
    ]);
  });

  it("bands are contiguous and non-overlapping; cut points 12:00/17:00/21:00 belong to one band only (ADR 0043 §1 amendment)", () => {
    const b = TIME_OF_DAY_PRESET_BOUNDS;
    // Inclusive string comparison is the same as matchesDayWindows uses
    const inBand = (hhmm: string, band: keyof typeof b) =>
      hhmm >= b[band].startLocal && hhmm <= b[band].endLocal;

    // Cut points belong to exactly one band
    expect(inBand("12:00", "morning")).toBe(false);
    expect(inBand("12:00", "afternoon")).toBe(true);
    expect(inBand("12:00", "evening")).toBe(false);
    expect(inBand("12:00", "late")).toBe(false);

    expect(inBand("17:00", "afternoon")).toBe(false);
    expect(inBand("17:00", "evening")).toBe(true);

    expect(inBand("21:00", "evening")).toBe(false);
    expect(inBand("21:00", "late")).toBe(true);

    // Contiguous: every minute belongs to exactly one of morning/afternoon/evening/late
    // Spot-check boundaries and mids
    for (const hhmm of [
      "00:00",
      "05:30",
      "11:59",
      "12:00",
      "14:00",
      "16:59",
      "17:00",
      "19:30",
      "20:59",
      "21:00",
      "22:15",
      "23:59",
    ]) {
      const hits = (["morning", "afternoon", "evening", "late"] as const).filter((k) =>
        inBand(hhmm, k),
      );
      expect(hits.length, `expected exactly one band for ${hhmm} got ${hits.join(",")}`).toBe(1);
    }
  });
});
