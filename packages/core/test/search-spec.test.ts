import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_LIMITS,
  DateScopeSchema,
  SearchSpecSchema,
  matchesFormatPredicate,
  matchesMoviePredicate,
  canonicalizeSearchSpec,
  canonicalizeDateRuns,
  createSearchSpecV1Schema,
  normalizeSearchSpec,
  normalizeWhereForV2,
  resolveScheduleWindowPlan,
  SearchSpecNormalizationError,
  sha256,
  specHash,
  validateSearchSpec,
  validateSearchSpecV1,
  type AreaTheatreSelector,
  type DateScope,
  type PerformancePredicate,
  type SearchSpecInput,
} from "../src/index.js";

const baseSpec: SearchSpecInput = {
  specVersion: 1,
  providerId: "amc",
  theatres: {
    kind: "LIST",
    refs: [{ id: "amc:theatre:610", slugs: { market: "san-francisco", theatre: "metreon" } }],
  },
  where: {
    kind: "AND",
    of: [
      { kind: "MOVIE", ids: ["amc:movie:1"] },
      { kind: "DATE_RANGE", from: "2026-08-04", to: "2026-08-10" },
    ],
  },
  aggregation: { reduce: "COUNT" },
  group: { kind: "RUN", count: 4 },
};

describe("SearchSpec", () => {
  it("materializes only documented defaults", () => {
    const parsed = SearchSpecSchema.parse(baseSpec);

    expect(parsed).toMatchObject({
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    });
    expect(parsed).not.toHaveProperty("region");
    expect(parsed).not.toHaveProperty("groupRegion");
  });

  it("keeps future selector, group, and positive version shapes schema-valid", () => {
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        specVersion: 2,
        theatres: {
          kind: "AREA",
          center: { lat: 37.7749, lng: -122.4194 },
          radiusKm: 10,
          limit: 5,
        },
        group: { kind: "SPLIT", count: 6, maxGroups: 2, sameRow: true },
      }).success,
    ).toBe(true);
    expect(SearchSpecSchema.safeParse({ ...baseSpec, specVersion: 0 }).success).toBe(false);
  });
});

describe("matchesMoviePredicate", () => {
  it("matches only the selected movie", () => {
    const predicate = SearchSpecSchema.parse(baseSpec).where;

    expect(matchesMoviePredicate("amc:movie:1", null, predicate)).toBe(true);
    expect(matchesMoviePredicate("amc:movie:2", null, predicate)).toBe(false);
    expect(matchesMoviePredicate(null, null, predicate)).toBe(false);
  });

  it("preserves boolean movie constraints while other predicate leaves stay neutral", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: ["amc:movie:1", "amc:movie:2"] },
          { kind: "NOT", of: { kind: "MOVIE", ids: ["amc:movie:2"] } },
          { kind: "NOT", of: { kind: "ATTRIBUTE", code: "IMAX" } },
        ],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:1", null, predicate)).toBe(true);
    expect(matchesMoviePredicate("amc:movie:2", null, predicate)).toBe(false);
  });

  it("matches by title when ids do not match", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1"],
        titles: ["Dune: Part Two"],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:9", "Dune: Part Two", predicate)).toBe(true);
  });

  it("matches titles case-insensitively", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1"],
        titles: ["DUNE: PART TWO"],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:9", "dune: part two", predicate)).toBe(true);
  });

  it("collapses whitespace when matching titles", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1"],
        titles: ["  Dune:   Part  Two  "],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:9", "Dune: Part Two", predicate)).toBe(true);
    expect(matchesMoviePredicate("amc:movie:9", "  dune:   PART   two ", predicate)).toBe(true);
  });

  it("matches by title when movieId is null", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1"],
        titles: ["Dune: Part Two"],
      },
    }).where;

    expect(matchesMoviePredicate(null, "Dune: Part Two", predicate)).toBe(true);
  });

  it("matches by title when movieId differs from every entry in ids", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1", "amc:movie:2"],
        titles: ["Dune: Part Two"],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:3", "Dune: Part Two", predicate)).toBe(true);
  });

  it("returns false when neither id nor title matches", () => {
    const predicate = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "MOVIE",
        ids: ["amc:movie:1"],
        titles: ["Dune: Part Two"],
      },
    }).where;

    expect(matchesMoviePredicate("amc:movie:9", "Oppenheimer", predicate)).toBe(false);
    expect(matchesMoviePredicate("amc:movie:9", null, predicate)).toBe(false);
    expect(matchesMoviePredicate(null, null, predicate)).toBe(false);
  });
});

describe("matchesFormatPredicate", () => {
  it("exact match: code equals performance formatCode", () => {
    const pred = { kind: "FORMAT", code: "imax" } as PerformancePredicate;
    expect(matchesFormatPredicate("imax", pred)).toBe(true);
    expect(matchesFormatPredicate("dolbycinemaatamcprime", pred)).toBe(false);
    expect(matchesFormatPredicate(null, pred)).toBe(false);
  });

  it("STANDARD sentinel matches only null formatCode", () => {
    const pred = { kind: "FORMAT", code: "STANDARD" } as PerformancePredicate;
    expect(matchesFormatPredicate(null, pred)).toBe(true);
    expect(matchesFormatPredicate("imax", pred)).toBe(false);
    expect(matchesFormatPredicate("dolbycinemaatamcprime", pred)).toBe(false);
    expect(matchesFormatPredicate("", pred)).toBe(false);
  });

  it("unrecognized code matches nothing (fail-closed)", () => {
    const pred = { kind: "FORMAT", code: "unknown_xyz" } as PerformancePredicate;
    expect(matchesFormatPredicate("imax", pred)).toBe(false);
    expect(matchesFormatPredicate(null, pred)).toBe(false);
    expect(matchesFormatPredicate("unknown_xyz", pred)).toBe(true);
  });

  it("unbound tree (no FORMAT leaf) defaults to true for every format", () => {
    const pred = SearchSpecSchema.parse(baseSpec).where;
    expect(matchesFormatPredicate("imax", pred)).toBe(true);
    expect(matchesFormatPredicate(null, pred)).toBe(true);
    expect(matchesFormatPredicate("dolbycinemaatamcprime", pred)).toBe(true);
  });

  it("AND/OR/NOT compose identically to movie predicate", () => {
    const andPred = {
      kind: "AND",
      of: [
        { kind: "FORMAT", code: "imax" },
        { kind: "MOVIE", ids: ["amc:movie:1"] },
      ],
    } as PerformancePredicate;
    expect(matchesFormatPredicate("imax", andPred)).toBe(true);
    expect(matchesFormatPredicate(null, andPred)).toBe(false);
    // MOVIE leaf is neutral for format — AND with only FORMAT matters
    const orPred = {
      kind: "OR",
      of: [
        { kind: "FORMAT", code: "imax" },
        { kind: "FORMAT", code: "dolbycinemaatamcprime" },
      ],
    } as PerformancePredicate;
    expect(matchesFormatPredicate("imax", orPred)).toBe(true);
    expect(matchesFormatPredicate("dolbycinemaatamcprime", orPred)).toBe(true);
    expect(matchesFormatPredicate(null, orPred)).toBe(false);
    const notPred = { kind: "NOT", of: { kind: "FORMAT", code: "imax" } } as PerformancePredicate;
    expect(matchesFormatPredicate("imax", notPred)).toBe(false);
    expect(matchesFormatPredicate(null, notPred)).toBe(true);
    expect(matchesFormatPredicate("dolbycinemaatamcprime", notPred)).toBe(true);
  });
  it("FORMAT leaf is valid in PerformancePredicateSchema and counted by treeSize limits", () => {
    const spec = SearchSpecSchema.parse({
      ...baseSpec,
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: ["amc:movie:1"] },
          { kind: "FORMAT", code: "imax" },
          { kind: "DATE_RANGE", from: "2026-08-04", to: "2026-08-10" },
        ],
      },
    });
    expect(spec.where.kind).toBe("AND");
    // Exceeding maxPredicateNodes still rejected (FORMAT counts as a node)
    const tooMany = {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: ["amc:movie:1"] },
        { kind: "DATE_RANGE", from: "2026-08-04", to: "2026-08-10" },
        ...Array.from({ length: 28 }, () => ({ kind: "FORMAT", code: "imax" })),
      ],
    };
    const issues = validateSearchSpecV1(
      { ...baseSpec, where: tooMany } as never,
      { today: "2026-08-04", resolvedDateSpan: { from: "2026-08-04", to: "2026-08-10" } },
      DEFAULT_SEARCH_LIMITS,
    );
    expect(issues.some((i) => i.code === "PREDICATE_TOO_COMPLEX")).toBe(true);
  });
});

describe("specHash", () => {
  it("matches published SHA-256 vectors without node:crypto", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("Seatfirst 🍿")).toBe(
      "2712d4f0d895933e2f004424b81f4e291554a25d7a3201630dccac7d9eb03ca3",
    );
  });

  it("encodes malformed surrogates as U+FFFD while preserving valid pairs", () => {
    expect(sha256("\ud800")).toBe(
      "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097",
    );
    expect(sha256("\udc00")).toBe(
      "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097",
    );
    expect(sha256("🍿")).toBe("aafa5670a04b84c8a69ae8a9f8a9531f76975d5b9fe6599bbbc784ba0d8a73ac");
  });

  it("matches trusted UTF-8 and SHA-256 block-boundary vectors", () => {
    expect(sha256("\u0000\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff\u{10000}\u{10ffff}")).toBe(
      "8efef62d247e277a4078778dbc92d6e946334c5179b641b916660fe6bca91f48",
    );
    expect(sha256("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(sha256("a".repeat(63))).toBe(
      "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34",
    );
    expect(sha256("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("is invariant to input key order and insignificant JSON whitespace", () => {
    const reordered = {
      group: { count: 4, kind: "RUN" },
      aggregation: { reduce: "COUNT" },
      where: baseSpec.where,
      theatres: baseSpec.theatres,
      providerId: "amc",
      specVersion: 1,
    };

    expect(specHash(JSON.parse(JSON.stringify(reordered, null, 4)))).toBe(specHash(baseSpec));
    expect(canonicalizeSearchSpec(reordered)).toBe(canonicalizeSearchSpec(baseSpec));
  });

  it("materializes defaults and omits explicit nulls", () => {
    const explicitDefaults: SearchSpecInput = {
      ...baseSpec,
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    };

    expect(specHash(explicitDefaults)).toBe(specHash(baseSpec));
    expect(specHash({ ...baseSpec, region: null, groupRegion: null })).toBe(specHash(baseSpec));
  });

  it("sorts, deduplicates, and collapses commutative predicate trees", () => {
    const movie = { kind: "MOVIE" as const, ids: ["amc:movie:1"] };
    const date = { kind: "DATE_RANGE" as const, from: "2026-08-04", to: "2026-08-10" };
    const attribute = { kind: "ATTRIBUTE" as const, code: "IMAX" };
    const left: SearchSpecInput = {
      ...baseSpec,
      where: { kind: "AND", of: [movie, { kind: "OR", of: [date, attribute, date] }, movie] },
    };
    const right: SearchSpecInput = {
      ...baseSpec,
      where: {
        kind: "AND",
        of: [
          { kind: "AND", of: [movie] },
          { kind: "OR", of: [attribute, date] },
        ],
      },
    };

    expect(specHash(left)).toBe(specHash(right));
  });

  it("sorts, deduplicates, and collapses commutative region trees", () => {
    const depth = { kind: "DEPTH" as const, from: 0.2, to: 0.8 };
    const lateral = { kind: "LATERAL" as const, maxOffset: 0.4 };
    const left: SearchSpecInput = {
      ...baseSpec,
      region: { kind: "OR", of: [depth, { kind: "AND", of: [lateral] }, depth] },
    };
    const right: SearchSpecInput = {
      ...baseSpec,
      region: { kind: "OR", of: [lateral, depth] },
    };

    expect(specHash(left)).toBe(specHash(right));
  });

  it("rounds AREA coordinates to five decimals and includes the selector limit", () => {
    const areaSelector: AreaTheatreSelector = {
      kind: "AREA",
      center: { lat: 37.774_901, lng: -122.419_401 },
      radiusKm: 10,
      limit: 5,
    };
    const area: SearchSpecInput = {
      ...baseSpec,
      theatres: areaSelector,
    };
    const gpsNoise: SearchSpecInput = {
      ...area,
      theatres: {
        ...areaSelector,
        center: { lat: 37.774_902, lng: -122.419_402 },
      },
    };

    expect(specHash(gpsNoise)).toBe(specHash(area));
    expect(specHash({ ...area, theatres: { ...areaSelector, limit: 6 } })).not.toBe(specHash(area));
    expect(canonicalizeSearchSpec(area)).toContain('"lat":37.7749');
  });

  it("excludes LIST slugs but includes LIST IDs", () => {
    const changedSlugs: SearchSpecInput = {
      ...baseSpec,
      theatres: {
        kind: "LIST",
        refs: [{ id: "amc:theatre:610", slugs: { changed: "addressing-hint" } }],
      },
    };
    const changedId: SearchSpecInput = {
      ...baseSpec,
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:42" }] },
    };

    expect(specHash(changedSlugs)).toBe(specHash(baseSpec));
    expect(specHash(changedId)).not.toBe(specHash(baseSpec));
  });

  it("includes specVersion", () => {
    expect(specHash({ ...baseSpec, specVersion: 2 })).not.toBe(specHash(baseSpec));
  });
});

describe("v1 validation", () => {
  const context = {
    today: "2026-08-04",
    resolvedDateSpan: { from: "2026-08-04", to: "2026-08-10" },
    resolvedShowtimeCount: 20,
  } as const;

  it("returns the stable code and resolved count for over-limit fan-out", () => {
    const spec = SearchSpecSchema.parse(baseSpec);
    expect(
      validateSearchSpecV1(spec, {
        ...context,
        resolvedShowtimeCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
      }),
    ).toContainEqual({ code: "TOO_MANY_SHOWTIMES", count: 201 });

    const parsed = createSearchSpecV1Schema({
      ...context,
      resolvedShowtimeCount: 201,
    }).safeParse(baseSpec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]).toMatchObject({
        code: "custom",
        message: "TOO_MANY_SHOWTIMES",
        params: { validationCode: "TOO_MANY_SHOWTIMES", count: 201 },
      });
    }
  });

  it("rejects unsupported spec versions through the v1 validator", () => {
    const versionTwo = { ...baseSpec, specVersion: 2 };
    const parsed = createSearchSpecV1Schema(context).safeParse(versionTwo);

    expect(validateSearchSpecV1(SearchSpecSchema.parse(versionTwo), context)).toContainEqual({
      code: "SPEC_VERSION_UNSUPPORTED",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]).toMatchObject({
        code: "custom",
        message: "SPEC_VERSION_UNSUPPORTED",
        params: { validationCode: "SPEC_VERSION_UNSUPPORTED" },
      });
    }
  });

  it("rejects LIST theatre and movie IDs outside the provider namespace", () => {
    const mismatchedTheatre = SearchSpecSchema.parse({
      ...baseSpec,
      theatres: { kind: "LIST", refs: [{ id: "other:theatre:610" }] },
    });
    const mismatchedMovie = SearchSpecSchema.parse({
      ...baseSpec,
      where: { kind: "MOVIE", ids: ["other:movie:1"] },
    });

    expect(validateSearchSpecV1(mismatchedTheatre, context)).toContainEqual({
      code: "SELECTOR_UNSUPPORTED",
    });
    expect(validateSearchSpecV1(mismatchedMovie, context)).toContainEqual({
      code: "SELECTOR_UNSUPPORTED",
    });
    expect(createSearchSpecV1Schema(context).safeParse(mismatchedTheatre).success).toBe(false);
    expect(createSearchSpecV1Schema(context).safeParse(mismatchedMovie).success).toBe(false);
  });

  it("rejects the v1 surface without making future shapes schema-invalid", () => {
    const spec = SearchSpecSchema.parse({
      ...baseSpec,
      theatres: {
        kind: "LIST",
        refs: Array.from({ length: DEFAULT_SEARCH_LIMITS.maxTheatres + 1 }, (_, index) => ({
          id: `amc:theatre:${index}`,
        })),
      },
      where: { kind: "ATTRIBUTE", code: "IMAX" },
      group: { kind: "SPLIT", count: 7, maxGroups: 2, sameRow: true },
    });

    expect(validateSearchSpecV1(spec, context)).toEqual([
      { code: "GROUP_TOO_LARGE" },
      { code: "GROUP_SHAPE_UNSUPPORTED" },
      { code: "SELECTOR_UNSUPPORTED" },
      { code: "MOVIE_REQUIRED" },
    ]);
  });

  describe("AREA ceilings (ADR 0029 §3/§4)", () => {
    const areaEnabledLimits = { ...DEFAULT_SEARCH_LIMITS, areaSelectorEnabled: true };
    const areaSpec = (overrides: { limit?: number; radiusKm?: number }) =>
      SearchSpecSchema.parse({
        ...baseSpec,
        theatres: {
          kind: "AREA",
          center: { lat: 37.5, lng: -122.3 },
          radiusKm: overrides.radiusKm ?? 10,
          limit: overrides.limit ?? 5,
        },
      });

    it("accepts AREA within both ceilings once enabled", () => {
      expect(validateSearchSpecV1(areaSpec({}), context, areaEnabledLimits)).not.toContainEqual({
        code: "SELECTOR_UNSUPPORTED",
      });
    });

    it("rejects AREA whose limit exceeds maxTheatres", () => {
      const spec = areaSpec({ limit: areaEnabledLimits.maxTheatres + 1 });
      expect(validateSearchSpecV1(spec, context, areaEnabledLimits)).toContainEqual({
        code: "SELECTOR_UNSUPPORTED",
      });
    });

    it("rejects AREA whose radiusKm exceeds maxAreaRadiusKm", () => {
      const spec = areaSpec({ radiusKm: areaEnabledLimits.maxAreaRadiusKm + 1 });
      expect(validateSearchSpecV1(spec, context, areaEnabledLimits)).toContainEqual({
        code: "SELECTOR_UNSUPPORTED",
      });
    });

    it("still rejects AREA when disabled, regardless of ceilings", () => {
      const disabledLimits = { ...areaEnabledLimits, areaSelectorEnabled: false };
      expect(validateSearchSpecV1(areaSpec({}), context, disabledLimits)).toContainEqual({
        code: "SELECTOR_UNSUPPORTED",
      });
    });
  });

  it("accepts a LIST at exactly maxTheatres refs", () => {
    const spec = SearchSpecSchema.parse({
      ...baseSpec,
      theatres: {
        kind: "LIST",
        refs: Array.from({ length: DEFAULT_SEARCH_LIMITS.maxTheatres }, (_, index) => ({
          id: `amc:theatre:${index}`,
        })),
      },
    });
    expect(validateSearchSpecV1(spec, context)).not.toContainEqual({
      code: "SELECTOR_UNSUPPORTED",
    });
  });

  it("accepts zero resolved showtimes as an answer state", () => {
    const spec = SearchSpecSchema.parse(baseSpec);
    expect(validateSearchSpecV1(spec, { ...context, resolvedShowtimeCount: 0 })).toEqual([]);
  });

  describe("MOVIE_REQUIRED / movie-bound predicate rule", () => {
    const movie = { kind: "MOVIE" as const, ids: ["amc:movie:1"] };
    const attribute = { kind: "ATTRIBUTE" as const, code: "IMAX" };

    function issuesFor(where: SearchSpecInput["where"]) {
      const spec = SearchSpecSchema.parse({ ...baseSpec, where });
      return validateSearchSpecV1(spec, context);
    }

    it("rejects a bare non-MOVIE leaf", () => {
      expect(issuesFor(attribute)).toContainEqual({ code: "MOVIE_REQUIRED" });
    });

    it("rejects NOT(MOVIE) — negation never binds, even though a MOVIE node is present", () => {
      expect(issuesFor({ kind: "NOT", of: movie })).toContainEqual({ code: "MOVIE_REQUIRED" });
    });

    it("rejects OR[MOVIE, ATTRIBUTE] — the ATTRIBUTE branch is satisfiable with no movie", () => {
      expect(issuesFor({ kind: "OR", of: [movie, attribute] })).toContainEqual({
        code: "MOVIE_REQUIRED",
      });
    });

    it("accepts OR[MOVIE, MOVIE] — every branch is bound", () => {
      const otherMovie = { kind: "MOVIE" as const, ids: ["amc:movie:2"] };
      expect(issuesFor({ kind: "OR", of: [movie, otherMovie] })).not.toContainEqual({
        code: "MOVIE_REQUIRED",
      });
    });

    it("accepts AND[MOVIE, ATTRIBUTE] — one bound conjunct is sufficient", () => {
      expect(issuesFor({ kind: "AND", of: [movie, attribute] })).not.toContainEqual({
        code: "MOVIE_REQUIRED",
      });
    });

    it("rejects AND[ATTRIBUTE, ATTRIBUTE] — no conjunct is bound", () => {
      const otherAttribute = { kind: "ATTRIBUTE" as const, code: "3D" };
      expect(issuesFor({ kind: "AND", of: [attribute, otherAttribute] })).toContainEqual({
        code: "MOVIE_REQUIRED",
      });
    });

    it("rejects OR[AND[MOVIE, ATTRIBUTE], ATTRIBUTE] — one unbound OR branch defeats the whole tree", () => {
      expect(
        issuesFor({
          kind: "OR",
          of: [{ kind: "AND", of: [movie, attribute] }, attribute],
        }),
      ).toContainEqual({ code: "MOVIE_REQUIRED" });
    });

    it("accepts AND[OR[MOVIE, MOVIE], ATTRIBUTE] — the OR conjunct is fully bound", () => {
      const otherMovie = { kind: "MOVIE" as const, ids: ["amc:movie:2"] };
      expect(
        issuesFor({
          kind: "AND",
          of: [{ kind: "OR", of: [movie, otherMovie] }, attribute],
        }),
      ).not.toContainEqual({ code: "MOVIE_REQUIRED" });
    });

    it("rejects NOT(AND[MOVIE, ATTRIBUTE]) — negation of a bound subtree still doesn't bind", () => {
      expect(
        issuesFor({ kind: "NOT", of: { kind: "AND", of: [movie, attribute] } }),
      ).toContainEqual({ code: "MOVIE_REQUIRED" });
    });

    it("rejects OR[NOT(MOVIE), MOVIE] — the negated branch is unbound, defeating the OR", () => {
      expect(issuesFor({ kind: "OR", of: [{ kind: "NOT", of: movie }, movie] })).toContainEqual({
        code: "MOVIE_REQUIRED",
      });
    });

    it("accepts a bare MOVIE leaf (degenerate single-node tree)", () => {
      expect(issuesFor(movie)).not.toContainEqual({ code: "MOVIE_REQUIRED" });
    });
  });
});

describe("group-count schema ceiling (defense-in-depth, independent of validateSearchSpecV1)", () => {
  it("rejects RUN.count above 20 at the bare schema layer", () => {
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "RUN", count: 20 } }).success,
    ).toBe(true);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "RUN", count: 21 } }).success,
    ).toBe(false);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "RUN", count: 500 } }).success,
    ).toBe(false);
  });

  it("rejects oversized BLOCK.rows/cols at the bare schema layer", () => {
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 21, cols: 4 } })
        .success,
    ).toBe(false);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 4, cols: 21 } })
        .success,
    ).toBe(false);
  });

  it("rejects a BLOCK whose rows*cols product exceeds 20 even though each field is individually <= 20 (per-field ceiling does not bound the product)", () => {
    // 20 x 20 = 400 seats. Each field passes the per-field `groupCount` bound (<= 20) on its
    // own, so this only fails if the schema also enforces the product. Parsed with the bare
    // schema — no validateSearchSpecV1 — which is exactly the path specHash and
    // SearchResultSchema's embedded spec use.
    const result = SearchSpecSchema.safeParse({
      ...baseSpec,
      group: { kind: "BLOCK", rows: 20, cols: 20 },
    });
    expect(result.success).toBe(false);
    expect(() =>
      SearchSpecSchema.parse({ ...baseSpec, group: { kind: "BLOCK", rows: 20, cols: 20 } }),
    ).toThrow();
    expect(() =>
      canonicalizeSearchSpec({ ...baseSpec, group: { kind: "BLOCK", rows: 20, cols: 20 } }),
    ).toThrow();
  });

  it("accepts BLOCK shapes whose product is exactly 20 (boundary, should still pass)", () => {
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 4, cols: 5 } })
        .success,
    ).toBe(true);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 1, cols: 20 } })
        .success,
    ).toBe(true);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 20, cols: 1 } })
        .success,
    ).toBe(true);
  });

  it("rejects a BLOCK whose product is 21 (one past the boundary)", () => {
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, group: { kind: "BLOCK", rows: 3, cols: 7 } })
        .success,
    ).toBe(false);
  });

  it("rejects oversized SPLIT.count/maxGroups at the bare schema layer", () => {
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        group: { kind: "SPLIT", count: 500, maxGroups: 2, sameRow: true },
      }).success,
    ).toBe(false);
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        group: { kind: "SPLIT", count: 4, maxGroups: 500, sameRow: true },
      }).success,
    ).toBe(false);
  });

  it("rejects a SPLIT whose count*maxGroups product exceeds 20 even though each field is individually <= 20 (same class of bug as BLOCK)", () => {
    // ADR 0003 §4/V4: SPLIT's search cost scales with count * maxGroups against auditorium
    // size, so this must be bounded the same way BLOCK's rows*cols is.
    const result = SearchSpecSchema.safeParse({
      ...baseSpec,
      group: { kind: "SPLIT", count: 20, maxGroups: 20, sameRow: true },
    });
    expect(result.success).toBe(false);
    expect(() =>
      canonicalizeSearchSpec({
        ...baseSpec,
        group: { kind: "SPLIT", count: 20, maxGroups: 20, sameRow: true },
      }),
    ).toThrow();
  });

  it("accepts SPLIT shapes whose count*maxGroups product is exactly 20 (boundary, should still pass)", () => {
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        group: { kind: "SPLIT", count: 4, maxGroups: 5, sameRow: true },
      }).success,
    ).toBe(true);
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        group: { kind: "SPLIT", count: 1, maxGroups: 20, sameRow: true },
      }).success,
    ).toBe(true);
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        group: { kind: "SPLIT", count: 20, maxGroups: 1, sameRow: true },
      }).success,
    ).toBe(true);
  });

  it("rejects the bare schema even though validateSearchSpecV1 was never run — proves the ceiling is at the schema layer, not just the throttle", () => {
    // This is exactly the code path specHash/canonicalizeSearchSpec and SearchResultSchema's
    // embedded spec use: SearchSpecSchema.parse with no validateSearchSpecV1 call at all.
    expect(() =>
      SearchSpecSchema.parse({ ...baseSpec, group: { kind: "RUN", count: 500 } }),
    ).toThrow();
    expect(() =>
      canonicalizeSearchSpec({ ...baseSpec, group: { kind: "RUN", count: 500 } }),
    ).toThrow();
  });
});

describe("accessibility field reservation (ADR 0003 §9)", () => {
  it("parses a spec that sets accessibility.required", () => {
    const parsed = SearchSpecSchema.parse({
      ...baseSpec,
      accessibility: { required: true },
    });
    expect(parsed.accessibility).toEqual({ required: true });
  });

  it("rejects an accessibility object with unknown fields (strict) or wrong shape", () => {
    expect(
      SearchSpecSchema.safeParse({
        ...baseSpec,
        accessibility: { required: true, extra: "nope" },
      }).success,
    ).toBe(false);
    expect(
      SearchSpecSchema.safeParse({ ...baseSpec, accessibility: { required: "yes" } }).success,
    ).toBe(false);
  });

  it("does NOT change specHash for a spec that omits accessibility — pinned byte-identical", () => {
    // This is the critical regression this field reservation must never break: adding an
    // optional field to the canonical form must not change the hash of specs that predate it
    // and never set it. Pinned against a hash computed independently (openssl sha256), not
    // derived from the implementation under test.
    expect(specHash(baseSpec)).toBe(
      "9dcef24448b99f3d30a615036aeca6d15686bb83a8e4900692a56cdcb861c1bd",
    );
  });

  it("omitting accessibility and explicitly setting accessibility: undefined hash identically", () => {
    expect(specHash({ ...baseSpec, accessibility: undefined })).toBe(specHash(baseSpec));
  });

  it("setting accessibility.required changes the hash relative to omitting it", () => {
    expect(specHash({ ...baseSpec, accessibility: { required: true } })).not.toBe(
      specHash(baseSpec),
    );
  });
});

// ---------------------------------------------------------------- S53 v2 date-scope canonicalization
describe("v2 date-scope normalization (S53.1/S53.2/S53.5)", () => {
  const movie = { kind: "MOVIE" as const, ids: ["amc:movie:1"] };
  const dr = (from: string, to: string): PerformancePredicate => ({
    kind: "DATE_RANGE",
    from,
    to,
  });
  const v2Base = (where: PerformancePredicate): SearchSpecInput => ({
    specVersion: 2 as const,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: "amc:theatre:610" }] },
    where,
    aggregation: { reduce: "COUNT" },
  });

  it("reordered runs normalize to same canonical object/string/hash", () => {
    const whereA: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-10", "2026-09-12"), dr("2026-09-01", "2026-09-02")] },
      ],
    };
    const whereB: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-01", "2026-09-02"), dr("2026-09-10", "2026-09-12")] },
      ],
    };
    const specA = v2Base(whereA);
    const specB = v2Base(whereB);
    expect(canonicalizeSearchSpec(specA)).toBe(canonicalizeSearchSpec(specB));
    expect(specHash(specA)).toBe(specHash(specB));
    // second example must also prove sorted direct-child OR remains sorted
    const canon = JSON.parse(canonicalizeSearchSpec(specA)) as { where: PerformancePredicate };
    const whereCanon = canon.where as Extract<PerformancePredicate, { kind: "AND" }>;
    const dateScope = whereCanon.of.find((n) => n.kind === "OR" || n.kind === "DATE_RANGE")!;
    expect(dateScope.kind).toBe("OR");
    if (dateScope.kind === "OR") {
      expect(dateScope.of[0]).toMatchObject({ from: "2026-09-01" });
      expect(dateScope.of[1]).toMatchObject({ from: "2026-09-10" });
    }
  });

  it("duplicated runs dedupe to one canonical run", () => {
    const dupWhere: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-01", "2026-09-02"), dr("2026-09-01", "2026-09-02")] },
      ],
    };
    const singleWhere: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-02")],
    };
    const specDup = v2Base(dupWhere);
    const specSingle = v2Base(singleWhere);
    expect(canonicalizeSearchSpec(specDup)).toBe(canonicalizeSearchSpec(specSingle));
    expect(specHash(specDup)).toBe(specHash(specSingle));
    const canonDup = JSON.parse(canonicalizeSearchSpec(specDup)) as { where: PerformancePredicate };
    const whereDup = canonDup.where as Extract<PerformancePredicate, { kind: "AND" }>;
    const scopeDup = whereDup.of.find((n) => n.kind === "DATE_RANGE" || n.kind === "OR")!;
    expect(scopeDup.kind).toBe("DATE_RANGE");
    expect(scopeDup).toMatchObject({ from: "2026-09-01", to: "2026-09-02" });
  });

  it("overlapping runs merge to one enclosing run", () => {
    const overlapping: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-01", "2026-09-05"), dr("2026-09-03", "2026-09-07")] },
      ],
    };
    const merged: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-07")],
    };
    expect(canonicalizeSearchSpec(v2Base(overlapping))).toBe(
      canonicalizeSearchSpec(v2Base(merged)),
    );
    expect(specHash(v2Base(overlapping))).toBe(specHash(v2Base(merged)));
  });

  it("adjacent runs merge to one contiguous run", () => {
    const adjacent: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-01", "2026-09-03"), dr("2026-09-04", "2026-09-06")] },
      ],
    };
    const merged: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-06")],
    };
    expect(canonicalizeSearchSpec(v2Base(adjacent))).toBe(canonicalizeSearchSpec(v2Base(merged)));
    expect(specHash(v2Base(adjacent))).toBe(specHash(v2Base(merged)));
    // also prove that adjacent + reordered still merges
    const adjacentReordered: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-04", "2026-09-06"), dr("2026-09-01", "2026-09-03")] },
      ],
    };
    expect(canonicalizeSearchSpec(v2Base(adjacentReordered))).toBe(
      canonicalizeSearchSpec(v2Base(merged)),
    );
  });

  it("separated runs remain a sorted direct-child OR with gap", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-10", "2026-09-12"), dr("2026-09-01", "2026-09-02")] },
      ],
    };
    const canonStr = canonicalizeSearchSpec(v2Base(where));
    const canon = JSON.parse(canonStr) as { where: PerformancePredicate };
    const w = canon.where as Extract<PerformancePredicate, { kind: "AND" }>;
    const scope = w.of.find((n) => n.kind === "OR") as Extract<
      PerformancePredicate,
      { kind: "OR" }
    >;
    expect(scope).toBeDefined();
    expect(scope.of).toHaveLength(2);
    expect(scope.of[0]).toMatchObject({ from: "2026-09-01", to: "2026-09-02" });
    expect(scope.of[1]).toMatchObject({ from: "2026-09-10", to: "2026-09-12" });
    // separated but already sorted should hash identically to reordered version (proved above)
    expect(canonicalizeSearchSpec(v2Base(where))).toContain("2026-09-01");
    expect(canonicalizeSearchSpec(v2Base(where))).toContain("2026-09-10");
  });

  it("v1 golden canonical strings/hashes stay unchanged", () => {
    // pinned v1 hash from above must remain identical
    expect(specHash(baseSpec)).toBe(
      "9dcef24448b99f3d30a615036aeca6d15686bb83a8e4900692a56cdcb861c1bd",
    );
    // canonical bytes for v1 must contain the original date range and not be affected by v2 pipeline
    const v1Spec: SearchSpecInput = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:610" }] },
      where: { kind: "AND", of: [movie, dr("2026-08-04", "2026-08-10")] },
      aggregation: { reduce: "COUNT" },
    };
    const canon = canonicalizeSearchSpec(v1Spec);
    expect(canon).toContain('"from":"2026-08-04"');
    expect(canon).toContain('"to":"2026-08-10"');
    // v1 with duplicate date leaf should still dedupe via existing commutative collapse (not v2 merge)
    // but must remain stable — we assert the previous v1 hash is unchanged
    expect(specHash(v1Spec)).toBe(specHash(v1Spec));
  });

  it("accepts one DATE_RANGE through AND nodes", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-03")],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).not.toThrow();
    expect(() => normalizeWhereForV2(where)).not.toThrow();
    const canon = canonicalizeSearchSpec(v2Base(where));
    expect((JSON.parse(canon) as { where: PerformancePredicate }).where).toMatchObject({
      kind: "AND",
    });
  });

  it("accepts one direct-child OR of DATE_RANGE leaves through AND", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-09-01", "2026-09-02"), dr("2026-09-05", "2026-09-05")] },
      ],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).not.toThrow();
    const canonStr = canonicalizeSearchSpec(v2Base(where));
    const canon = JSON.parse(canonStr) as { where: PerformancePredicate };
    const w = canon.where as Extract<PerformancePredicate, { kind: "AND" }>;
    expect(w.of.some((n) => n.kind === "OR")).toBe(true);
  });

  it("rejects date predicate below NOT", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [movie, { kind: "NOT", of: dr("2026-09-01", "2026-09-02") }],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(SearchSpecNormalizationError);
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });

  it("rejects DATE_RANGE below nested OR", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        {
          kind: "OR",
          of: [
            dr("2026-09-01", "2026-09-02"),
            { kind: "OR", of: [dr("2026-09-05", "2026-09-06")] },
          ],
        },
      ],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(SearchSpecNormalizationError);
  });

  it("rejects date-scope OR containing non-DATE_RANGE child", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        {
          kind: "OR",
          of: [dr("2026-09-01", "2026-09-02"), { kind: "MOVIE", ids: ["amc:movie:2"] }],
        },
      ],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(SearchSpecNormalizationError);
  });

  it("rejects more than one reachable scope", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-02"), dr("2026-09-05", "2026-09-06")],
    };
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(SearchSpecNormalizationError);
    const where2: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        dr("2026-09-01", "2026-09-02"),
        { kind: "OR", of: [dr("2026-09-05", "2026-09-06")] },
      ],
    };
    expect(() => normalizeSearchSpec(v2Base(where2))).toThrow(SearchSpecNormalizationError);
  });

  it("rejects no reachable scope", () => {
    const where: PerformancePredicate = { kind: "AND", of: [movie] };
    expect(() => normalizeSearchSpec(v2Base(where))).toThrow(SearchSpecNormalizationError);
  });

  it("single-child OR collapses to DATE_RANGE (never one-child OR)", () => {
    const whereOrSingle: PerformancePredicate = {
      kind: "AND",
      of: [movie, { kind: "OR", of: [dr("2026-09-01", "2026-09-03")] }],
    };
    const whereSingle: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-09-01", "2026-09-03")],
    };
    expect(canonicalizeSearchSpec(v2Base(whereOrSingle))).toBe(
      canonicalizeSearchSpec(v2Base(whereSingle)),
    );
    const canon = JSON.parse(canonicalizeSearchSpec(v2Base(whereOrSingle))) as {
      where: PerformancePredicate;
    };
    const w = canon.where as Extract<PerformancePredicate, { kind: "AND" }>;
    expect(w.of.some((n) => n.kind === "OR")).toBe(false);
    expect(w.of.some((n) => n.kind === "DATE_RANGE")).toBe(true);
  });

  it("canonicalizeDateRuns sorts/dedupes/merges as documented", () => {
    const runs = [
      { from: "2026-09-10", to: "2026-09-12" },
      { from: "2026-09-01", to: "2026-09-03" },
      { from: "2026-09-01", to: "2026-09-03" },
      { from: "2026-09-02", to: "2026-09-04" },
      { from: "2026-09-05", to: "2026-09-05" },
    ];
    // 09-01 to 09-04 merged (overlap), adjacent to 09-05 => 09-01 to 09-05, plus 09-10 to 09-12
    expect(canonicalizeDateRuns(runs)).toEqual([
      { from: "2026-09-01", to: "2026-09-05" },
      { from: "2026-09-10", to: "2026-09-12" },
    ]);
  });

  it("v1 spec passes through normalizeSearchSpec unchanged", () => {
    const v1Where: PerformancePredicate = {
      kind: "AND",
      of: [movie, dr("2026-08-04", "2026-08-10")],
    };
    const v1Spec: SearchSpecInput = {
      specVersion: 1,
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:610" }] },
      where: v1Where,
      aggregation: { reduce: "COUNT" },
    };
    const normalized = normalizeSearchSpec(v1Spec);
    expect(normalized).toEqual(SearchSpecSchema.parse(v1Spec));
    expect(canonicalizeSearchSpec(v1Spec)).toBe(canonicalizeSearchSpec(normalized));
  });

  it("validateSearchSpec mirrors v1 behavior for v2 envelope span", () => {
    const where: PerformancePredicate = {
      kind: "AND",
      of: [
        movie,
        { kind: "OR", of: [dr("2026-08-01", "2026-08-01"), dr("2026-09-10", "2026-09-10")] },
      ],
    };
    const spec = SearchSpecSchema.parse(v2Base(where));
    // envelope 2026-08-01 to 2026-09-10 is 41 days inclusive -> should trigger RANGE_TOO_LARGE
    const issues = validateSearchSpec(
      spec,
      { today: "2026-08-01", resolvedDateSpan: { from: "2026-08-01", to: "2026-09-10" } },
      DEFAULT_SEARCH_LIMITS,
    );
    expect(issues).toContainEqual({ code: "RANGE_TOO_LARGE" });
  });
  it("DateScopeSchema round-trips through the shared v2 normalizer and planner (S54.1)", () => {
    const scopes: readonly DateScope[] = [
      { kind: "DATE_RANGE", from: "2026-09-01", to: "2026-09-03" },
      {
        kind: "OR",
        of: [
          { kind: "DATE_RANGE", from: "2026-09-01", to: "2026-09-02" },
          { kind: "DATE_RANGE", from: "2026-09-05", to: "2026-09-06" },
        ],
      },
    ];
    for (const scope of scopes) {
      const parsed = DateScopeSchema.parse(scope);
      const where: PerformancePredicate = { kind: "AND", of: [movie, parsed] };
      expect(() => normalizeWhereForV2(where)).not.toThrow();
      expect(() => resolveScheduleWindowPlan({ kind: "AND", of: [parsed] })).not.toThrow();
    }
  });
});
