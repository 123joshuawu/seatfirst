import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_LIMITS } from "../src/search-spec.js";
import {
  CAPACITY_CEILING_EXCEEDED,
  CapacityCeilingExceededSchema,
  CapacityPreviewInputSchema,
  CapacityPreviewResponseSchema,
  CAPACITY_PREVIEW_UNAVAILABLE,
} from "../src/capacity-contracts.js";

/**
 * S47.1 — contract-level validation matrix for `searches.capacityPreview`'s wire
 * shapes. Expectations derived by hand from ADR 0039 decision 3 + Amendment
 * (docs/adr/0039-filter-transmission-and-pre-submit-capacity-gate.md), never from the
 * implementation.
 */

const VALID_INPUT = {
  providerId: "amc",
  theatreIds: ["amc:theatre:a"],
  movieId: "amc:movie:m1",
  weekdays: ["FRIDAY"],
  timeOfDay: "evening",
  horizon: "thisWeekend",
  formatCode: "imax",
} as const;

describe("CapacityPreviewInputSchema", () => {
  it("accepts the fully-resolved form combination", () => {
    expect(CapacityPreviewInputSchema.parse(VALID_INPUT)).toBeDefined();
  });

  it("every filter field is optional except provider/theatres/movie", () => {
    expect(
      CapacityPreviewInputSchema.parse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        movieId: "amc:movie:m1",
      }),
    ).toEqual({
      providerId: "amc",
      theatreIds: ["amc:theatre:a"],
      movieId: "amc:movie:m1",
    });
  });

  it("movieId is required (ADR 0003 §4 V3 MOVIE_REQUIRED posture)", () => {
    const withoutMovie: Record<string, unknown> = { ...VALID_INPUT };
    delete withoutMovie.movieId;
    expect(CapacityPreviewInputSchema.safeParse(withoutMovie).success).toBe(false);
  });

  it("rejects an empty theatre list", () => {
    expect(CapacityPreviewInputSchema.safeParse({ ...VALID_INPUT, theatreIds: [] }).success).toBe(
      false,
    );
  });

  it("bounds theatreIds by DEFAULT_SEARCH_LIMITS.maxTheatres — the same constant admission uses", () => {
    const tooMany = Array.from(
      { length: DEFAULT_SEARCH_LIMITS.maxTheatres + 1 },
      (_, i) => `amc:theatre:x${i}`,
    );
    expect(
      CapacityPreviewInputSchema.safeParse({ ...VALID_INPUT, theatreIds: tooMany }).success,
    ).toBe(false);
    expect(DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes).toBe(200);
  });

  it("rejects unknown strictObject keys", () => {
    expect(CapacityPreviewInputSchema.safeParse({ ...VALID_INPUT, extra: true }).success).toBe(
      false,
    );
  });

  it("accepts all five ADR 0043 band values (S50.2)", () => {
    for (const v of ["allTimes", "morning", "afternoon", "evening", "late"] as const) {
      expect(CapacityPreviewInputSchema.safeParse({ ...VALID_INPUT, timeOfDay: v }).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown timeOfDay strings (S50.2)", () => {
    expect(
      CapacityPreviewInputSchema.safeParse({ ...VALID_INPUT, timeOfDay: "midnight" }).success,
    ).toBe(false);
  });
});

describe("CapacityPreviewInputSchema v2 (S53.7)", () => {
  const v2Where = {
    kind: "AND" as const,
    of: [
      { kind: "MOVIE" as const, ids: ["amc:movie:m1"] },
      { kind: "DATE_RANGE" as const, from: "2026-09-01", to: "2026-09-02" },
    ],
  };
  const v2WhereSeparated = {
    kind: "AND" as const,
    of: [
      { kind: "MOVIE" as const, ids: ["amc:movie:m1"] },
      {
        kind: "OR" as const,
        of: [
          { kind: "DATE_RANGE" as const, from: "2026-09-01", to: "2026-09-02" },
          { kind: "DATE_RANGE" as const, from: "2026-09-10", to: "2026-09-12" },
        ],
      },
    ],
  };
  const baseV2 = {
    specVersion: 2 as const,
    providerId: "amc",
    theatreIds: ["amc:theatre:a"],
    where: v2Where,
  };

  it("accepts a v2 input carrying specVersion 2 + where verbatim", () => {
    expect(CapacityPreviewInputSchema.parse(baseV2)).toEqual(baseV2);
  });

  it("accepts v2 with separated direct-OR date scope", () => {
    expect(CapacityPreviewInputSchema.parse({ ...baseV2, where: v2WhereSeparated })).toBeDefined();
  });

  it("v2 retains providerId + theatreIds as resolved set", () => {
    const parsed = CapacityPreviewInputSchema.parse(baseV2) as {
      providerId: string;
      theatreIds: string[];
    };
    expect(parsed.providerId).toBe("amc");
    expect(parsed.theatreIds).toEqual(["amc:theatre:a"]);
  });

  it("rejects v2 without specVersion or with wrong version", () => {
    expect(
      CapacityPreviewInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        where: v2Where,
      }).success,
    ).toBe(false);
    expect(
      CapacityPreviewInputSchema.safeParse({ ...baseV2, specVersion: 1 as const }).success,
    ).toBe(false);
  });

  it("rejects v2 with mixed OR (non-DATE_RANGE child) at schema level if predicate invalid", () => {
    const mixedWhere = {
      kind: "AND" as const,
      of: [
        { kind: "MOVIE" as const, ids: ["amc:movie:m1"] },
        {
          kind: "OR" as const,
          of: [
            { kind: "DATE_RANGE" as const, from: "2026-09-01", to: "2026-09-02" },
            { kind: "MOVIE" as const, ids: ["amc:movie:2"] },
          ],
        },
      ],
    };
    // schema still parses — structural rejection is deferred to normalizer/planner (capacityPreview route)
    // but the where itself is schema-valid, so input parses; the route will BAD_REQUEST
    expect(CapacityPreviewInputSchema.safeParse({ ...baseV2, where: mixedWhere }).success).toBe(
      true,
    );
  });

  it("v1 short-form still parses and is distinct from v2", () => {
    const v1 = { providerId: "amc", theatreIds: ["amc:theatre:a"], movieId: "amc:movie:m1" };
    const parsedV1 = CapacityPreviewInputSchema.parse(v1) as { movieId: string };
    expect(parsedV1.movieId).toBe("amc:movie:m1");
    expect((parsedV1 as unknown as { specVersion?: number }).specVersion).toBeUndefined();
  });

  it("rejects unknown strictObject keys on v2", () => {
    expect(CapacityPreviewInputSchema.safeParse({ ...baseV2, extra: "nope" }).success).toBe(false);
  });

  it("bounds theatreIds for v2 by same maxTheatres constant", () => {
    const many = Array.from(
      { length: DEFAULT_SEARCH_LIMITS.maxTheatres + 1 },
      (_, i) => `amc:theatre:${i}`,
    );
    expect(CapacityPreviewInputSchema.safeParse({ ...baseV2, theatreIds: many }).success).toBe(
      false,
    );
  });
});

describe("CapacityPreviewResponseSchema", () => {
  it("parses the ok arm with a nonnegative integer count", () => {
    expect(
      CapacityPreviewResponseSchema.parse({ kind: "ok", matchedCount: 0, ceilingExceeded: false }),
    ).toEqual({ kind: "ok", matchedCount: 0, ceilingExceeded: false });
    expect(
      CapacityPreviewResponseSchema.safeParse({
        kind: "ok",
        matchedCount: -1,
        ceilingExceeded: false,
      }).success,
    ).toBe(false);
    expect(
      CapacityPreviewResponseSchema.safeParse({
        kind: "ok",
        matchedCount: 201,
        ceilingExceeded: true,
      }).success,
    ).toBe(true);
  });

  it("parses the unavailable arm and it can never carry a count", () => {
    expect(CapacityPreviewResponseSchema.parse({ kind: CAPACITY_PREVIEW_UNAVAILABLE })).toEqual({
      kind: CAPACITY_PREVIEW_UNAVAILABLE,
    });
    // Any numeric field on the unavailable arm is a schema violation — the whole point
    // of Amendment A3 is that unavailability never leaks even a partial number.
    expect(
      CapacityPreviewResponseSchema.safeParse({
        kind: CAPACITY_PREVIEW_UNAVAILABLE,
        matchedCount: 12,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(CapacityPreviewResponseSchema.safeParse({ kind: "maybe" }).success).toBe(false);
  });
});

describe("CapacityCeilingExceededSchema (S56 / ADR 0054 decision 1)", () => {
  it("accepts a valid object at the ceiling boundary", () => {
    expect(
      CapacityCeilingExceededSchema.parse({
        code: CAPACITY_CEILING_EXCEEDED,
        matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      }),
    ).toEqual({
      code: "CAPACITY_CEILING_EXCEEDED",
      matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
      limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
    });
  });

  it("rejects extra keys (strictObject)", () => {
    expect(
      CapacityCeilingExceededSchema.safeParse({
        code: CAPACITY_CEILING_EXCEEDED,
        matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
        retryAfterSeconds: 30,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative matchedCount", () => {
    expect(
      CapacityCeilingExceededSchema.safeParse({
        code: CAPACITY_CEILING_EXCEEDED,
        matchedCount: -1,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive limit", () => {
    expect(
      CapacityCeilingExceededSchema.safeParse({
        code: CAPACITY_CEILING_EXCEEDED,
        matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
        limit: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong code literal", () => {
    expect(
      CapacityCeilingExceededSchema.safeParse({
        code: "ADMISSION_REJECTED",
        matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 1,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      }).success,
    ).toBe(false);
  });
});
