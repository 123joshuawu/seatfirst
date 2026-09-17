import { describe, expect, it } from "vitest";
import { formatWhenReadout, resolveWhenReadout } from "./whenPresets";

describe("resolveWhenReadout — committed selectedDates as resolved runs (UI24.5)", () => {
  it("renders the committed set with the selected bands", () => {
    const result = resolveWhenReadout({
      selectedDates: ["2026-09-26", "2026-09-27"],
      selectedBands: ["Evening"],
    });

    expect(result).toBe(
      formatWhenReadout({
        from: "2026-09-26",
        to: "2026-09-27",
        selectedBands: ["Evening"],
      }),
    );
  });

  it("lists every run of a sparse set in ascending absolute-date order", () => {
    expect(
      resolveWhenReadout({
        selectedDates: ["2026-09-08", "2026-09-04"],
        selectedBands: ["Evening"],
      }),
    ).toBe("Fri 4, Tue 8 · 5 PM–9 PM");
  });

  it("a single date reads as one absolute date", () => {
    expect(resolveWhenReadout({ selectedDates: ["2026-08-29"], selectedBands: ["Evening"] })).toBe(
      "Sat 29 · 5 PM–9 PM",
    );
  });

  it("an empty set renders the time part only (never a fabricated date)", () => {
    expect(resolveWhenReadout({ selectedDates: [], selectedBands: [] })).toBe("Any time");
  });
});
