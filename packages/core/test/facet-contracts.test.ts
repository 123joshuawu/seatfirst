import { describe, expect, it } from "vitest";

import { FacetCountsInputSchema } from "../src/facet-contracts.js";
import { CapacityPreviewInputSchema } from "../src/capacity-contracts.js";

/**
 * S50.2 — both wire contracts accept the five ADR 0043 band values and reject
 * any other string. Hand-typed expectations, not re-derived from the enum.
 * SuperRefine (base.timeOfDay must be omitted when TIME_OF_DAY axis requested)
 * remains unchanged — verified by the retained rejection.
 */

describe("FacetCountsInputSchema.base.timeOfDay (S50.2)", () => {
  for (const v of ["allTimes", "morning", "afternoon", "evening", "late"] as const) {
    it(`accepts "${v}"`, () => {
      expect(
        FacetCountsInputSchema.safeParse({
          providerId: "amc",
          theatreIds: ["amc:theatre:a"],
          base: { timeOfDay: v },
          axes: [{ kind: "MOVIE", candidates: ["m1"] }],
        }).success,
      ).toBe(true);
    });
  }

  it('rejects "midnight" and other unknown strings', () => {
    expect(
      FacetCountsInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        base: { timeOfDay: "midnight" },
        axes: [{ kind: "MOVIE", candidates: ["m1"] }],
      }).success,
    ).toBe(false);
    expect(
      FacetCountsInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        base: { timeOfDay: "EVENING" },
        axes: [{ kind: "MOVIE", candidates: ["m1"] }],
      }).success,
    ).toBe(false);
  });

  it("superRefine still rejects base.timeOfDay when TIME_OF_DAY axis is requested", () => {
    expect(
      FacetCountsInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        base: { timeOfDay: "evening" },
        axes: [{ kind: "TIME_OF_DAY", candidates: ["morning"] }],
      }).success,
    ).toBe(false);
  });

  it("accepts omitting timeOfDay entirely", () => {
    expect(
      FacetCountsInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        base: {},
        axes: [{ kind: "TIME_OF_DAY", candidates: ["evening"] }],
      }).success,
    ).toBe(true);
  });
});

describe("CapacityPreviewInputSchema.timeOfDay (S50.2)", () => {
  for (const v of ["allTimes", "morning", "afternoon", "evening", "late"] as const) {
    it(`accepts "${v}"`, () => {
      expect(
        CapacityPreviewInputSchema.safeParse({
          providerId: "amc",
          theatreIds: ["amc:theatre:a"],
          movieId: "amc:movie:m1",
          timeOfDay: v,
        }).success,
      ).toBe(true);
    });
  }

  it('rejects "midnight"', () => {
    expect(
      CapacityPreviewInputSchema.safeParse({
        providerId: "amc",
        theatreIds: ["amc:theatre:a"],
        movieId: "amc:movie:m1",
        timeOfDay: "midnight",
      }).success,
    ).toBe(false);
  });
});

describe("FacetCountsInputSchema date scopes (S54.2)", () => {
  const scope = { kind: "DATE_RANGE", from: "2026-09-01", to: "2026-09-03" };
  const request = (base: unknown, axes: unknown) => ({
    providerId: "amc",
    theatreIds: ["amc:theatre:a"],
    base,
    axes,
  });

  it("accepts DATE and keyed DATE_SCOPE candidates", () => {
    expect(
      FacetCountsInputSchema.safeParse(
        request({}, [
          { kind: "DATE", candidates: ["2026-09-01"] },
          { kind: "DATE_SCOPE", candidates: [{ key: "custom", dateScope: scope }] },
        ]),
      ).success,
    ).toBe(true);
  });

  it("rejects every date-scope/base-axis mutual exclusion", () => {
    const cases = [
      request({ dateScope: scope, horizon: "thisWeekend" }, [
        { kind: "MOVIE", candidates: ["m1"] },
      ]),
      request({ dateScope: scope }, [{ kind: "HORIZON", candidates: ["thisWeekend"] }]),
      request({ dateScope: scope }, [{ kind: "DATE", candidates: ["2026-09-01"] }]),
      request({ dateScope: scope }, [
        { kind: "DATE_SCOPE", candidates: [{ key: "custom", dateScope: scope }] },
      ]),
    ];
    for (const input of cases) expect(FacetCountsInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects invalid DATE and DATE_SCOPE candidate shapes", () => {
    const cases = [
      request({}, [{ kind: "DATE", candidates: ["2026-02-30"] }]),
      request({}, [{ kind: "DATE_SCOPE", candidates: [{ dateScope: scope }] }]),
      request({}, [{ kind: "DATE_SCOPE", candidates: [{ key: "custom" }] }]),
      request({}, [
        {
          kind: "DATE_SCOPE",
          candidates: [
            {
              key: "mixed",
              dateScope: {
                kind: "OR",
                of: [scope, { kind: "MOVIE", ids: ["amc:movie:m1"] }],
              },
            },
          ],
        },
      ]),
      request({}, [
        {
          kind: "DATE_SCOPE",
          candidates: [{ key: "single", dateScope: { kind: "OR", of: [scope] } }],
        },
      ]),
    ];
    for (const input of cases) expect(FacetCountsInputSchema.safeParse(input).success).toBe(false);
  });
});
