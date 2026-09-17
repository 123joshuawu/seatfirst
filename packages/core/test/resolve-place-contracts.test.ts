import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_LIMITS,
  ResolvePlaceInputSchema,
  ResolvePlaceOkSchema,
  ResolvePlaceResponseSchema,
  placeQuerySchema,
} from "../src/index.js";

// S51.1 bounds per spec.md:44-53 — providerId nonemptyString, query min1 max256 reject ; and >20 tokens,
// radiusKm max 40 from DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm, limit max 25 from maxTheatres.
// S51.4 partial — response never carries lat/lng (strictObject rejection).

const validInput = {
  providerId: "amc",
  query: "Sunnyvale",
  radiusKm: 10,
  limit: 5,
} as const;

describe("ResolvePlaceInputSchema bounds (S51.1) — shared query envelope", () => {
  it("accepts valid input", () => {
    expect(ResolvePlaceInputSchema.parse(validInput)).toEqual(validInput);
  });

  it("pins radius and limit ceilings to DEFAULT_SEARCH_LIMITS (no invented numbers)", () => {
    expect(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm).toBe(40);
    expect(DEFAULT_SEARCH_LIMITS.maxTheatres).toBe(25);
  });

  it("rejects empty providerId (nonemptyString)", () => {
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, providerId: "" }).success).toBe(
      false,
    );
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, providerId: "x" }).success).toBe(
      true,
    );
  });

  it("rejects query shorter than 1 and longer than 256", () => {
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: "" }).success).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: "a" }).success).toBe(true);
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: "a".repeat(256) }).success,
    ).toBe(true);
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: "a".repeat(257) }).success,
    ).toBe(false);
  });

  it("rejects query containing semicolon", () => {
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: "Sunnyvale; DROP" }).success,
    ).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: ";Sunnyvale" }).success).toBe(
      false,
    );
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: "Sunnyvale;" }).success).toBe(
      false,
    );
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: "Sunny;vale" }).success).toBe(
      false,
    );
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: "Sunnyvale CA" }).success,
    ).toBe(true);
  });

  it("rejects query with >20 whitespace tokens and accepts 20", () => {
    const twenty = Array.from({ length: 20 }, () => "word").join(" ");
    const twentyOne = Array.from({ length: 21 }, () => "word").join(" ");
    const withExtraWhitespace = `  ${Array.from({ length: 20 }, () => "word").join("   \t  ")}  `;
    const twentyOneWithNewlines = Array.from({ length: 21 }, () => "tok").join("\n");

    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: twenty }).success).toBe(true);
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: withExtraWhitespace }).success,
    ).toBe(true);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, query: twentyOne }).success).toBe(
      false,
    );
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: twentyOneWithNewlines }).success,
    ).toBe(false);
    // single token with trailing/leading space is collapsed but still 1 token
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, query: "  Sunnyvale  " }).success,
    ).toBe(true);
  });

  it("bounds radiusKm at 40 (DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm), positive and finite", () => {
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: 40 }).success).toBe(true);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: 40.0001 }).success).toBe(
      false,
    );
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: 0 }).success).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: -1 }).success).toBe(false);
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: Number.POSITIVE_INFINITY })
        .success,
    ).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: Number.NaN }).success).toBe(
      false,
    );
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: 0.1 }).success).toBe(true);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, radiusKm: 25 }).success).toBe(true);
  });

  it("bounds limit at 25 (DEFAULT_SEARCH_LIMITS.maxTheatres), int and positive", () => {
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: 1 }).success).toBe(true);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: 25 }).success).toBe(true);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: 26 }).success).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: 0 }).success).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: -1 }).success).toBe(false);
    expect(ResolvePlaceInputSchema.safeParse({ ...validInput, limit: 1.5 }).success).toBe(false);
    expect(
      ResolvePlaceInputSchema.safeParse({ ...validInput, limit: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  it("exposes shared placeQuerySchema used as the query validator", () => {
    const shared = placeQuerySchema;
    expect(shared.safeParse("a").success).toBe(true);
    expect(shared.safeParse("a".repeat(256)).success).toBe(true);
    expect(shared.safeParse("a; b").success).toBe(false);
    const twentyOne = Array.from({ length: 21 }, () => "word").join(" ");
    expect(shared.safeParse(twentyOne).success).toBe(false);
    expect(ResolvePlaceInputSchema.shape.query).toBe(shared);
  });
});

describe("ResolvePlaceResponse never carries lat/lng (S51.4 partial + S52.8)", () => {
  const okBase = {
    kind: "ok" as const,
    theatres: [
      {
        theatreId: "amc:theatre:610",
        distanceKm: 1.2,
        name: "AMC Metreon 16",
        city: "San Francisco",
      },
    ],
    excluded: { outsideArea: 2, byLimit: 0 },
    label: "10 km around Sunnyvale",
    resolvedPlaceName: "Sunnyvale, CA, United States",
  };

  it("accepts valid ok response without coordinates", () => {
    expect(ResolvePlaceOkSchema.parse(okBase)).toEqual(okBase);
    expect(ResolvePlaceResponseSchema.parse(okBase)).toEqual(okBase);
  });

  it("rejects ok response that carries lat/lng at top level (strictObject)", () => {
    const withLat = { ...okBase, lat: 37.37, lng: -122.04 };
    const withCenter = { ...okBase, center: { lat: 37.37, lng: -122.04 } };
    expect(ResolvePlaceOkSchema.safeParse(withLat).success).toBe(false);
    expect(ResolvePlaceResponseSchema.safeParse(withLat).success).toBe(false);
    expect(ResolvePlaceOkSchema.safeParse(withCenter).success).toBe(false);
  });

  it("rejects theatre entry that carries lat/lng", () => {
    const withCoordTheatre = {
      ...okBase,
      theatres: [
        {
          theatreId: "amc:theatre:610",
          distanceKm: 1.2,
          name: "AMC Metreon 16",
          city: "San Francisco",
          lat: 37.37,
          lng: -122,
        },
      ],
    };
    expect(ResolvePlaceOkSchema.safeParse(withCoordTheatre).success).toBe(false);
  });

  it("rejects response that carries coordinate-named fields anywhere", () => {
    const withLatLng = {
      ...okBase,
      lat: 37.37,
      lng: -122.04,
      latitude: 37.37,
      longitude: -122.04,
    };
    // latitude/longitude are extra strict keys too
    expect(ResolvePlaceOkSchema.safeParse(withLatLng).success).toBe(false);
  });

  it("round-trips PLACE_NOT_FOUND and PLACE_RESOLUTION_UNAVAILABLE without coordinates", () => {
    expect(ResolvePlaceResponseSchema.parse({ kind: "PLACE_NOT_FOUND" })).toEqual({
      kind: "PLACE_NOT_FOUND",
    });
    expect(ResolvePlaceResponseSchema.parse({ kind: "PLACE_RESOLUTION_UNAVAILABLE" })).toEqual({
      kind: "PLACE_RESOLUTION_UNAVAILABLE",
    });
    expect(
      ResolvePlaceResponseSchema.safeParse({ kind: "PLACE_NOT_FOUND", lat: 1, lng: 1 }).success,
    ).toBe(false);
    expect(
      ResolvePlaceResponseSchema.safeParse({
        kind: "PLACE_RESOLUTION_UNAVAILABLE",
        lat: 1,
        lng: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ResolvePlaceOkSchema S51-D9 resolvedPlaceName (S52.7)", () => {
  const okBase = {
    kind: "ok" as const,
    theatres: [
      {
        theatreId: "amc:theatre:610",
        distanceKm: 0.5,
        name: "AMC Metreon 16",
        city: "San Francisco",
      },
    ],
    excluded: { outsideArea: 1, byLimit: 0 },
    label: "10 km around Sunnyvale",
    resolvedPlaceName: "Sunnyvale, CA, United States",
  };

  it("requires resolvedPlaceName (fails if removed — S52.7 revert check)", () => {
    const { resolvedPlaceName: _removed, ...without } = okBase;
    void _removed;
    expect(ResolvePlaceOkSchema.safeParse(without).success).toBe(false);
    expect(ResolvePlaceResponseSchema.safeParse(without).success).toBe(false);
  });

  it("rejects empty resolvedPlaceName (min 1)", () => {
    expect(ResolvePlaceOkSchema.safeParse({ ...okBase, resolvedPlaceName: "" }).success).toBe(
      false,
    );
  });

  it("preserves every existing field alongside resolvedPlaceName (legacy behavior)", () => {
    const parsed = ResolvePlaceOkSchema.parse(okBase);
    expect(parsed.theatres).toEqual(okBase.theatres);
    expect(parsed.excluded).toEqual(okBase.excluded);
    expect(parsed.label).toEqual(okBase.label);
    expect(parsed.resolvedPlaceName).toEqual(okBase.resolvedPlaceName);
    // Missing theatres/excluded/label still rejected — legacy fields remain required.
    expect(
      ResolvePlaceOkSchema.safeParse({
        kind: "ok",
        excluded: okBase.excluded,
        label: okBase.label,
        resolvedPlaceName: okBase.resolvedPlaceName,
      }).success,
    ).toBe(false);
    expect(
      ResolvePlaceOkSchema.safeParse({
        kind: "ok",
        theatres: okBase.theatres,
        label: okBase.label,
        resolvedPlaceName: okBase.resolvedPlaceName,
      }).success,
    ).toBe(false);
    expect(
      ResolvePlaceOkSchema.safeParse({
        kind: "ok",
        theatres: okBase.theatres,
        excluded: okBase.excluded,
        resolvedPlaceName: okBase.resolvedPlaceName,
      }).success,
    ).toBe(false);
  });

  it("resolvedPlaceName is distinct from label and allows Mapbox display text", () => {
    const withDifferent = {
      ...okBase,
      label: "40 km around san fran",
      resolvedPlaceName: "San Francisco, CA, United States",
    };
    expect(ResolvePlaceOkSchema.parse(withDifferent).label).toBe("40 km around san fran");
    expect(ResolvePlaceOkSchema.parse(withDifferent).resolvedPlaceName).toBe(
      "San Francisco, CA, United States",
    );
  });

  it("rejects ok that carries coordinates alongside resolvedPlaceName (no-coordinate invariant)", () => {
    const withCoord = { ...okBase, lat: 37.77, lng: -122.41 };
    expect(ResolvePlaceOkSchema.safeParse(withCoord).success).toBe(false);
  });

  it("round-trips through ResolvePlaceResponse discriminated union with resolvedPlaceName", () => {
    const parsed = ResolvePlaceResponseSchema.parse(okBase);
    expect(parsed).toEqual(okBase);
    if (parsed.kind === "ok") {
      expect(parsed.resolvedPlaceName).toBe(okBase.resolvedPlaceName);
    }
  });

  it("serializes without lat/lng/center, only resolvedPlaceName as place text", () => {
    const json = JSON.stringify(ResolvePlaceOkSchema.parse(okBase));
    expect(json).not.toMatch(/"lat"/);
    expect(json).not.toMatch(/"lng"/);
    expect(json).not.toMatch(/"center"/);
    expect(json).toMatch(/"resolvedPlaceName"/);
    expect(json).toMatch(/"label"/);
  });
});

describe("ResolvePlaceOkSchema theatre display fields (place-mode row names)", () => {
  const okBase = {
    kind: "ok" as const,
    theatres: [
      {
        theatreId: "amc:theatre:610",
        distanceKm: 0.5,
        name: "AMC Metreon 16",
        city: "San Francisco",
      },
    ],
    excluded: { outsideArea: 1, byLimit: 0 },
    label: "10 km around Sunnyvale",
    resolvedPlaceName: "Sunnyvale, CA, United States",
  };

  it("requires a non-empty name per theatre (no raw-id fallback downstream)", () => {
    const { name: _removed, ...nameless } = okBase.theatres[0]!;
    void _removed;
    expect(ResolvePlaceOkSchema.safeParse({ ...okBase, theatres: [nameless] }).success).toBe(false);
    expect(
      ResolvePlaceOkSchema.safeParse({
        ...okBase,
        theatres: [{ ...okBase.theatres[0], name: "" }],
      }).success,
    ).toBe(false);
  });

  it("requires city (nullable) per theatre — catalogue always carries the column", () => {
    const { city: _removed, ...cityless } = okBase.theatres[0]!;
    void _removed;
    expect(ResolvePlaceOkSchema.safeParse({ ...okBase, theatres: [cityless] }).success).toBe(false);
    expect(
      ResolvePlaceOkSchema.safeParse({
        ...okBase,
        theatres: [{ ...okBase.theatres[0], city: null }],
      }).success,
    ).toBe(true);
  });
});
