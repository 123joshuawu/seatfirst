import { describe, expect, it } from "vitest";

import { amcMoviesCrawlBoundary, isAmcMoviesCrawlDue } from "../src/amc-movies-crawl/due.js";

/**
 * Due-ness arithmetic probe (ADR 0102 decisions 1–2): every assertion derives its
 * instants from `amcMoviesCrawlBoundary` itself, so the suite never hard-codes the
 * deterministic ±5-minute jitter — it proves the shape (before/inside/past the window,
 * checkpoint gating, same-day determinism) around whatever boundary the hash yields.
 */

const PROBE = new Date("2026-01-15T13:00:00Z");
const BOUNDARY = amcMoviesCrawlBoundary(PROBE);

describe("amcMoviesCrawlBoundary — ADR 0102 decision 1", () => {
  it("is deterministic within one Eastern day and distinct across days", () => {
    // due.ts truncates the probe instant to whole seconds, so the derived boundary
    // wobbles by the probe's own sub-second fraction — floor probes to whole seconds
    // for exact-equality assertions.
    const sameDay = new Date(Math.floor((BOUNDARY.getTime() + 60 * 60 * 1000) / 1000) * 1000);
    expect(amcMoviesCrawlBoundary(sameDay).getTime()).toBe(BOUNDARY.getTime());

    const nextDay = new Date(PROBE.getTime() + 24 * 60 * 60 * 1000);
    const nextBoundary = amcMoviesCrawlBoundary(nextDay);
    // Daily cadence: the next boundary is ~24h later, not the same instant.
    expect(nextBoundary.getTime()).toBeGreaterThan(BOUNDARY.getTime());
  });
});

describe("isAmcMoviesCrawlDue — ADR 0102 decisions 1–2", () => {
  it("is false before the boundary", () => {
    expect(isAmcMoviesCrawlDue(null, new Date(BOUNDARY.getTime() - 1000))).toBe(false);
  });

  it("is true just after the boundary when no pass has ever completed", () => {
    expect(isAmcMoviesCrawlDue(null, new Date(BOUNDARY.getTime() + 1000))).toBe(true);
  });

  it("is false once a pass has completed since the boundary", () => {
    expect(
      isAmcMoviesCrawlDue(
        new Date(BOUNDARY.getTime() + 1000),
        new Date(BOUNDARY.getTime() + 120_000),
      ),
    ).toBe(false);
  });

  it("is true again when the last completion predates the boundary", () => {
    expect(
      isAmcMoviesCrawlDue(
        new Date(BOUNDARY.getTime() - 1000),
        new Date(BOUNDARY.getTime() + 120_000),
      ),
    ).toBe(true);
  });
  it("gives up 4 hours past the boundary", () => {
    const giveUp = BOUNDARY.getTime() + 4 * 60 * 60 * 1000;
    // ±2s margins: the derived boundary wobbles by the probe's sub-second fraction,
    // so exact-edge assertions would be testing truncation noise, not the window.
    expect(isAmcMoviesCrawlDue(null, new Date(giveUp - 2000))).toBe(true);
    expect(isAmcMoviesCrawlDue(null, new Date(giveUp + 2000))).toBe(false);
    expect(isAmcMoviesCrawlDue(null, new Date(giveUp + 60_000))).toBe(false);
  });
});
