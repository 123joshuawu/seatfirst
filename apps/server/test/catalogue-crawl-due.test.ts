import { describe, expect, it } from "vitest";

import { addCalendarMonths, isCatalogueCrawlDue } from "../src/catalogue-crawl/due.js";

describe("addCalendarMonths (S26.7 calendar-month arithmetic)", () => {
  it("adds one month in the ordinary non-clamping case", () => {
    expect(addCalendarMonths(new Date("2026-01-15T00:00:00Z"), 1)).toEqual(
      new Date("2026-02-15T00:00:00Z"),
    );
  });

  it("clamps a 31st across February to the last day of the month", () => {
    expect(addCalendarMonths(new Date("2026-01-31T00:00:00Z"), 1)).toEqual(
      new Date("2026-02-28T00:00:00Z"),
    );
  });

  it("clamps a 31st across a leap February to Feb 29", () => {
    expect(addCalendarMonths(new Date("2024-01-31T00:00:00Z"), 1)).toEqual(
      new Date("2024-02-29T00:00:00Z"),
    );
  });

  it("clamps a 31st onto a 30-day month", () => {
    expect(addCalendarMonths(new Date("2026-03-31T00:00:00Z"), 1)).toEqual(
      new Date("2026-04-30T00:00:00Z"),
    );
  });

  it("carries across year boundaries", () => {
    expect(addCalendarMonths(new Date("2026-12-10T00:00:00Z"), 1)).toEqual(
      new Date("2027-01-10T00:00:00Z"),
    );
  });

  it("clamps across a year boundary onto February", () => {
    expect(addCalendarMonths(new Date("2026-01-31T00:00:00Z"), 13)).toEqual(
      new Date("2027-02-28T00:00:00Z"),
    );
  });
});

describe("isCatalogueCrawlDue (S26.7)", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  it("is immediately due when no pass has ever run (both timestamps null)", () => {
    expect(isCatalogueCrawlDue(null, null, now)).toBe(true);
  });

  it("is due when the last completed pass is more than one calendar month ago", () => {
    expect(isCatalogueCrawlDue(null, new Date("2026-07-14T00:00:00Z"), now)).toBe(true);
  });

  it("is NOT due when the last completed pass is within one calendar month", () => {
    expect(isCatalogueCrawlDue(null, new Date("2026-07-16T00:00:00Z"), now)).toBe(false);
  });

  it("is due exactly at the one-month boundary (>=, never >)", () => {
    expect(isCatalogueCrawlDue(null, new Date("2026-07-15T00:00:00Z"), now)).toBe(true);
  });

  it("falls back to last_pass_started_at when a pass never completed", () => {
    expect(isCatalogueCrawlDue(new Date("2026-07-15T00:00:00Z"), null, now)).toBe(true);
    expect(isCatalogueCrawlDue(new Date("2026-08-10T00:00:00Z"), null, now)).toBe(false);
  });

  it("prefers last_pass_completed_at over last_pass_started_at when both are set", () => {
    expect(
      isCatalogueCrawlDue(new Date("2026-01-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"), now),
    ).toBe(false);
  });
});
