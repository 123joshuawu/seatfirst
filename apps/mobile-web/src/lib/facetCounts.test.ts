import { describe, it, expect } from "vitest";
import {
  getFacetDisplay,
  formatFacetCount,
  isWarmZero,
  shouldDimFacet,
  shouldDisableFacet,
  toFacetMap,
  getWarmScopeSummary,
} from "./facetCounts";

describe("facetCounts helpers — tri-state (UI18.6)", () => {
  const total = 3;

  it("warm number renders as number (cold 0)", () => {
    const entry = { count: 12, coldTheatreCount: 0 };
    const disp = getFacetDisplay(entry, total);
    expect(disp.text).toBe("12");
    expect(disp.isWarmZero).toBe(false);
    expect(disp.isNotCheckedYet).toBe(false);
    expect(disp.isPartial).toBe(false);
    expect(formatFacetCount(entry, total)).toBe("12");
  });

  it("warm zero dims+disables (count 0, cold 0)", () => {
    const entry = { count: 0, coldTheatreCount: 0 };
    const disp = getFacetDisplay(entry, total);
    expect(disp.text).toBe("0");
    expect(disp.isWarmZero).toBe(true);
    expect(isWarmZero(entry)).toBe(true);
    expect(shouldDimFacet(entry, total)).toBe(true);
    expect(shouldDisableFacet(entry, total)).toBe(true);
  });

  it("cold zero not dim (count 0, cold === total)", () => {
    const entry = { count: 0, coldTheatreCount: 3 };
    const disp = getFacetDisplay(entry, total);
    expect(disp.text).toBe("not checked yet");
    expect(disp.isWarmZero).toBe(false);
    expect(isWarmZero(entry)).toBe(false);
    // Only warm zero dims — cold zero stays enabled/opaque
    expect(shouldDimFacet(entry, total)).toBe(false);
    expect(shouldDisableFacet(entry, total)).toBe(false);
  });

  it("partial n+ not dim (0 < cold < total)", () => {
    const entry = { count: 0, coldTheatreCount: 1 };
    const disp = getFacetDisplay(entry, total);
    expect(disp.text).toBe("0+");
    expect(disp.isPartial).toBe(true);
    expect(shouldDimFacet(entry, total)).toBe(false);
    expect(shouldDisableFacet(entry, total)).toBe(false);

    const entry2 = { count: 5, coldTheatreCount: 2 };
    expect(getFacetDisplay(entry2, total).text).toBe("5+");
    expect(shouldDimFacet(entry2, total)).toBe(false);
  });

  it("not checked yet when none warm (cold === total)", () => {
    const entry = { count: 7, coldTheatreCount: 3 };
    // Even if count is 7, if all theatres cold we show not checked yet (count is stale)
    expect(getFacetDisplay(entry, 3).text).toBe("not checked yet");
    const entry2 = { count: 0, coldTheatreCount: 2 };
    expect(getFacetDisplay(entry2, 2).text).toBe("not checked yet");
  });

  it("zero rows never hidden — dimmed in place, not filtered", () => {
    // Simulate ChipRow rendering: zero entries are kept in map, not filtered.
    const counts = [
      { candidate: "a", count: 0, coldTheatreCount: 0 },
      { candidate: "b", count: 12, coldTheatreCount: 0 },
      { candidate: "c", count: 0, coldTheatreCount: 3 },
    ];
    const map = toFacetMap(counts);
    expect(map.size).toBe(3);
    // All three remain, none hidden, even zeros
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
    // Warm zero is dim, cold zero not dim — but both present
    expect(shouldDimFacet(map.get("a"), total)).toBe(true);
    expect(shouldDimFacet(map.get("c"), total)).toBe(false);
  });

  it("recompute rate via helper — no hardcoded 120/40 literals, uses total param", () => {
    // Ensure helper does not hardcode 40 or 120; total is passed in, not literal.
    // This is a meta-test: we just ensure display logic works for arbitrary totals.
    const totals = [1, 2, 3, 5, 10];
    for (const t of totals) {
      const warm = { count: 5, coldTheatreCount: 0 };
      expect(getFacetDisplay(warm, t).text).toBe("5");
      const partial = { count: 5, coldTheatreCount: 1 };
      if (t > 1) expect(getFacetDisplay(partial, t).text).toBe("5+");
      const notChecked = { count: 0, coldTheatreCount: t };
      expect(getFacetDisplay(notChecked, t).text).toBe("not checked yet");
    }
  });

  it("getWarmScopeSummary sums only warm (cold===0)", () => {
    const m = new Map<string, { count: number; coldTheatreCount: number }>([
      ["a", { count: 5, coldTheatreCount: 0 }],
      ["b", { count: 3, coldTheatreCount: 1 }],
      ["c", { count: 0, coldTheatreCount: 0 }],
    ]);
    const summary = getWarmScopeSummary(m);
    // Only a and c are warm (cold 0), sum is 5+0=5, theatres 2
    expect(summary.warmShowtimes).toBe(5);
    expect(summary.warmTheatres).toBe(2);
  });

  it("fail-to-pass guard — cold zero must NOT dim (regression if someone changes shouldDim to include cold)", () => {
    // This test will FAIL if shouldDimFacet is changed to dim cold zero (count 0, cold>0).
    // That is the intended fail→pass check: change cold zero to dim and watch test fail.
    const coldZero = { count: 0, coldTheatreCount: 3 };
    expect(shouldDimFacet(coldZero, 3)).toBe(false);
    expect(shouldDisableFacet(coldZero, 3)).toBe(false);
    const coldZeroPartial = { count: 0, coldTheatreCount: 1 };
    expect(shouldDimFacet(coldZeroPartial, 3)).toBe(false);
  });
});
