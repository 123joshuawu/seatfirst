import { describe, expect, it } from "vitest";

import { deriveDevFixtureShowtimeId } from "../../src/dev-fixtures/showtime-id.js";

describe("deriveDevFixtureShowtimeId", () => {
  it("is deterministic: same inputs produce same output", () => {
    const a = deriveDevFixtureShowtimeId(145_927_006, "2026-08-13");
    const b = deriveDevFixtureShowtimeId(145_927_006, "2026-08-13");
    expect(a).toBe(b);
  });

  it("produces different outputs for same original across at least 3 different dates", () => {
    const original = 145_927_006;
    const dates = ["2026-08-13", "2026-08-14", "2026-09-01", "2026-09-02"];
    const derived = dates.map((d) => deriveDevFixtureShowtimeId(original, d));
    // All distinct
    expect(new Set(derived).size).toBe(derived.length);
    // Also pairwise different for first 3
    const [a, b, c] = derived;
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("outputs are safe non-negative integers with digit-only rendering and no leading zeros", () => {
    const cases: Array<[number, string]> = [
      [145_927_006, "2026-08-13"],
      [146_024_502, "2026-09-01"],
      [146_089_621, "2026-12-31"],
      [0, "1970-01-01"],
      [1, "2026-08-13"],
      [999_999_999, "2099-12-31"],
    ];
    for (const [original, date] of cases) {
      const out = deriveDevFixtureShowtimeId(original, date);
      expect(Number.isSafeInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(0);
      const rendered = String(out);
      expect(rendered).toMatch(/^\d+$/);
      // No leading zeros unless the value is exactly 0 (which never happens for real IDs)
      if (rendered.length > 1) {
        expect(rendered[0]).not.toBe("0");
      }
      // Round-trips through z.number()-like validation (safe integer) and digit URL matcher
      expect(/^\/showtimes\/(\d+)\/seats$/.test(`/showtimes/${rendered}/seats`)).toBe(true);
    }
  });

  it("derivation formula is auditable: original*1_000_000 + epochDay", () => {
    // Spot-check the exact arithmetic so the formula is locked and reviewable
    // Use known epoch days: 2026-08-13 and 2026-09-01
    const d1 = Math.floor(Date.UTC(2026, 7, 13) / 86_400_000);
    const d2 = Math.floor(Date.UTC(2026, 8, 1) / 86_400_000);
    expect(deriveDevFixtureShowtimeId(145_927_006, "2026-08-13")).toBe(
      145_927_006 * 1_000_000 + d1,
    );
    expect(deriveDevFixtureShowtimeId(145_927_006, "2026-09-01")).toBe(
      145_927_006 * 1_000_000 + d2,
    );
    expect(d1).not.toBe(d2);
  });

  it("rejects invalid inputs", () => {
    expect(() => deriveDevFixtureShowtimeId(145_927_006, "not-a-date")).toThrow();
    expect(() => deriveDevFixtureShowtimeId(145_927_006, "2026-02-31")).toThrow();
    expect(() => deriveDevFixtureShowtimeId(Number.NaN, "2026-08-13")).toThrow();
    expect(() => deriveDevFixtureShowtimeId(-1, "2026-08-13")).toThrow();
  });
});
