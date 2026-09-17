import { describe, expect, it } from "vitest";

import { isTmdbPrewarmDue, nextFourAmEastern, todayFourAmEastern } from "../src/tmdb/due.js";

/**
 * S25.3 due-ness arithmetic (ADR 0019 amendment decision 1): 04:00 America/New_York,
 * daily. Instants are asserted in UTC: America/New_York is UTC-4 (EDT) in August and
 * UTC-5 (EST) in January, so 04:00 ET is 08:00 UTC in summer and 09:00 UTC in winter.
 */
describe("todayFourAmEastern (S25.3)", () => {
  it("computes 04:00 America/New_York as 08:00 UTC during EDT", () => {
    expect(todayFourAmEastern(new Date("2026-08-15T12:00:00Z"))).toEqual(
      new Date("2026-08-15T08:00:00Z"),
    );
  });

  it("computes 04:00 America/New_York as 09:00 UTC during EST", () => {
    expect(todayFourAmEastern(new Date("2026-01-15T12:00:00Z"))).toEqual(
      new Date("2026-01-15T09:00:00Z"),
    );
  });

  it("rolls the boundary to tomorrow once today's has passed", () => {
    expect(nextFourAmEastern(new Date("2026-08-15T06:00:00Z"))).toEqual(
      new Date("2026-08-15T08:00:00Z"),
    );
    expect(nextFourAmEastern(new Date("2026-08-15T12:00:00Z"))).toEqual(
      new Date("2026-08-16T08:00:00Z"),
    );
  });
});

describe("isTmdbPrewarmDue (S25.3)", () => {
  const afterBoundary = new Date("2026-08-15T12:00:00Z"); // past 08:00 UTC boundary
  const beforeBoundary = new Date("2026-08-15T06:00:00Z"); // before 08:00 UTC boundary

  it("is immediately due when no pass has ever completed", () => {
    expect(isTmdbPrewarmDue(null, afterBoundary)).toBe(true);
  });

  it("is due when the last completed pass predates today's boundary", () => {
    expect(isTmdbPrewarmDue(new Date("2026-08-15T07:59:59Z"), afterBoundary)).toBe(true);
  });

  it("is NOT due when the last completed pass is at or after today's boundary", () => {
    expect(isTmdbPrewarmDue(new Date("2026-08-15T08:00:00Z"), afterBoundary)).toBe(false);
    expect(isTmdbPrewarmDue(new Date("2026-08-15T09:00:00Z"), afterBoundary)).toBe(false);
  });

  it("is NOT due before the boundary, even with no prior pass", () => {
    expect(isTmdbPrewarmDue(null, beforeBoundary)).toBe(false);
  });
});
