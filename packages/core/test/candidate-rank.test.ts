import { describe, expect, it } from "vitest";

import { candidateProximity, candidateTimeFit, rankCandidate } from "../src/candidate-rank.js";
import type { SearchSpec } from "../src/search-spec.js";

function makeSpec(where: SearchSpec["where"]): SearchSpec {
  return {
    specVersion: 1,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: "theatre_1" }] },
    where,
    region: { kind: "ALL" },
    aggregation: { kind: "COUNT" },
  } as unknown as SearchSpec;
}

function movieOnly(): SearchSpec["where"] {
  return { kind: "MOVIE", ids: ["m1"] };
}

function withFormat(code: string): SearchSpec["where"] {
  return {
    kind: "AND",
    of: [
      { kind: "MOVIE", ids: ["m1"] },
      { kind: "FORMAT", code } as unknown as SearchSpec["where"],
    ],
  };
}

function withTimeWindow(startLocal: string, endLocal: string): SearchSpec["where"] {
  return {
    kind: "AND",
    of: [
      { kind: "MOVIE", ids: ["m1"] },
      {
        kind: "TIME_WINDOW",
        days: ["MONDAY"],
        startLocal,
        endLocal,
      } as unknown as SearchSpec["where"],
      {
        kind: "DATE_RANGE",
        from: "2026-08-20",
        to: "2026-08-21",
      } as unknown as SearchSpec["where"],
    ],
  };
}

describe("candidateProximity", () => {
  it("returns 1 when distanceKm is null (single-theatre LIST)", () => {
    expect(candidateProximity(null)).toBe(1);
  });
  it("uses cap 15: 0 at 15km, 0.5 at 7.5km", () => {
    expect(candidateProximity(15)).toBe(0);
    expect(candidateProximity(7.5)).toBe(0.5);
    expect(candidateProximity(0)).toBe(1);
  });
  it("caps at 15 for larger distances", () => {
    expect(candidateProximity(30)).toBe(0);
    expect(candidateProximity(20)).toBe(0);
  });
});

describe("candidateTimeFit", () => {
  it("is 1 for every candidate when search has no TIME_WINDOW", () => {
    const spec = makeSpec(movieOnly());
    expect(candidateTimeFit(new Date("2026-08-20T10:00:00Z"), spec, "UTC")).toBe(1);
    expect(candidateTimeFit(new Date("2026-08-20T19:00:00Z"), spec, "UTC")).toBe(1);
  });
  it("tapers linearly: midpoint 1, edges 0, halfway 0.5, outside clamped 0 — using theatre-local time", () => {
    const spec = makeSpec(withTimeWindow("10:00", "14:00"));
    // window 10:00-14:00 UTC (midpoint 12:00) when timezone=UTC
    expect(candidateTimeFit(new Date("2026-08-20T12:00:00Z"), spec, "UTC")).toBeCloseTo(1);
    expect(candidateTimeFit(new Date("2026-08-20T10:00:00Z"), spec, "UTC")).toBeCloseTo(0);
    expect(candidateTimeFit(new Date("2026-08-20T14:00:00Z"), spec, "UTC")).toBeCloseTo(0);
    expect(candidateTimeFit(new Date("2026-08-20T11:00:00Z"), spec, "UTC")).toBeCloseTo(0.5);
    expect(candidateTimeFit(new Date("2026-08-20T13:00:00Z"), spec, "UTC")).toBeCloseTo(0.5);
    expect(candidateTimeFit(new Date("2026-08-20T09:00:00Z"), spec, "UTC")).toBeCloseTo(0);
    expect(candidateTimeFit(new Date("2026-08-20T15:00:00Z"), spec, "UTC")).toBeCloseTo(0);
  });
  it("uses theatre-local time, not UTC — same UTC instant maps differently in different timezones", () => {
    const spec = makeSpec(withTimeWindow("10:00", "14:00"));
    // 2026-08-20T12:00Z is 12:00 UTC but 08:00 America/New_York (EDT UTC-4) -> outside window -> 0
    // and 16:00Z is 12:00 America/New_York -> inside -> ~1
    expect(candidateTimeFit(new Date("2026-08-20T12:00:00Z"), spec, "UTC")).toBeCloseTo(1);
    expect(
      candidateTimeFit(new Date("2026-08-20T12:00:00Z"), spec, "America/New_York"),
    ).toBeCloseTo(0);
    expect(
      candidateTimeFit(new Date("2026-08-20T16:00:00Z"), spec, "America/New_York"),
    ).toBeCloseTo(1);
  });
});

describe("rankCandidate", () => {
  it("hand-computed scores: 0.5*formatMatch +0.3*proximity+0.2*timeFit", () => {
    const specNoFormat = makeSpec(movieOnly());
    const perf = (formatCode: string | null, distanceKm: number | null, startsAt: Date) => ({
      performance: { showtimeId: "st_1", formatCode, startsAt },
      theatreId: "theatre_1",
      distanceKm,
    });

    // No format preference -> formatMatch 0, proximity 1 (null distance), timeFit 1 => 0.5
    expect(
      rankCandidate(perf(null, null, new Date("2026-08-20T19:00:00Z")), specNoFormat),
    ).toBeCloseTo(0.5);

    // distance 7.5 => proximity 0.5 => 0.3*0.5=0.15 +0.2=0.35
    expect(
      rankCandidate(perf(null, 7.5, new Date("2026-08-20T19:00:00Z")), specNoFormat),
    ).toBeCloseTo(0.35);

    // distance 15 => proximity 0 => 0.2
    expect(
      rankCandidate(perf(null, 15, new Date("2026-08-20T19:00:00Z")), specNoFormat),
    ).toBeCloseTo(0.2);

    // With FORMAT imax, matching => formatMatch 1 => +0.5 vs non-matching 0
    const specImax = makeSpec(withFormat("imax"));
    expect(
      rankCandidate(perf("imax", null, new Date("2026-08-20T19:00:00Z")), specImax),
    ).toBeCloseTo(1.0);
    expect(
      rankCandidate(
        perf("dolbycinemaatamcprime", null, new Date("2026-08-20T19:00:00Z")),
        specImax,
      ),
    ).toBeCloseTo(0.5);
    // STANDARD sentinel: null matches STANDARD
    const specStandard = makeSpec(withFormat("STANDARD"));
    expect(
      rankCandidate(perf(null, null, new Date("2026-08-20T19:00:00Z")), specStandard),
    ).toBeCloseTo(1.0);
    expect(
      rankCandidate(perf("imax", null, new Date("2026-08-20T19:00:00Z")), specStandard),
    ).toBeCloseTo(0.5);
  });

  it("formatMatch neutral when no FORMAT predicate: every candidate same term", () => {
    const spec = makeSpec(movieOnly());
    const a = rankCandidate(
      {
        performance: {
          showtimeId: "a",
          formatCode: "imax",
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: null,
      },
      spec,
    );
    const b = rankCandidate(
      {
        performance: {
          showtimeId: "b",
          formatCode: null,
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: null,
      },
      spec,
    );
    // same distance/time, different formatCode but spec has no FORMAT -> same score
    expect(a).toBe(b);
  });

  it("ordinal assignment: contiguous 0..N-1 matching descending score, stable tie-break", () => {
    const spec = makeSpec(movieOnly());
    const candidates = [
      {
        performance: {
          showtimeId: "st_far",
          formatCode: null,
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: 15,
      }, // 0.2
      {
        performance: {
          showtimeId: "st_mid",
          formatCode: null,
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: 7.5,
      }, // 0.35
      {
        performance: {
          showtimeId: "st_near",
          formatCode: null,
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: null,
      }, // 0.5
      {
        performance: {
          showtimeId: "st_near2",
          formatCode: null,
          startsAt: new Date("2026-08-20T19:00:00Z"),
        },
        theatreId: "t1",
        distanceKm: null,
      }, // 0.5 tie with st_near, original order tie-break
    ];
    const ranked = candidates
      .map((c, idx) => ({ c, idx, score: rankCandidate(c, spec) }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((entry, ordinal) => ({
        showtimeId: entry.c.performance.showtimeId,
        dispatchRank: ordinal,
        score: entry.score,
      }));

    expect(ranked.map((r) => r.dispatchRank)).toEqual([0, 1, 2, 3]);
    // Best (lowest rank) should be near items first, stable on original order for tie
    expect(ranked[0]!.showtimeId).toBe("st_near");
    expect(ranked[1]!.showtimeId).toBe("st_near2");
    expect(ranked[2]!.showtimeId).toBe("st_mid");
    expect(ranked[3]!.showtimeId).toBe("st_far");
    // contiguous permutation
    const ranks = ranked.map((r) => r.dispatchRank).sort((a, b) => a - b);
    expect(ranks).toEqual([0, 1, 2, 3]);
  });

  it("never throws when FORMAT predicate absent (S44.2)", () => {
    const spec = makeSpec(movieOnly());
    expect(() =>
      rankCandidate(
        {
          performance: { showtimeId: "st", formatCode: "imax", startsAt: new Date() },
          theatreId: "t",
          distanceKm: null,
        },
        spec,
      ),
    ).not.toThrow();
  });
});
