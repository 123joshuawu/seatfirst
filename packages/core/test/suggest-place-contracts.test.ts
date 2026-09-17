import { describe, expect, it } from "vitest";

import {
  placeQuerySchema,
  ResolvePlaceInputSchema,
  SuggestPlaceCandidatesSchema,
  SuggestPlaceInputSchema,
  SuggestPlaceResponseSchema,
} from "../src/index.js";

// S52.1 — SuggestPlaceInputSchema uses the exact Mapbox v6 envelope as ResolvePlaceInputSchema
// (1–256, no `;`, ≤20 tokens) and has no radius/limit. S52.2/S52.8 — response carries only
// labels (≤5) and never coordinates.

const validSuggestInput = {
  providerId: "amc",
  query: "Sunnyvale",
} as const;

describe("SuggestPlaceInputSchema bounds — shared query envelope (S52.1)", () => {
  it("accepts valid suggest input", () => {
    expect(SuggestPlaceInputSchema.parse(validSuggestInput)).toEqual(validSuggestInput);
  });

  it("rejects empty providerId (nonemptyString)", () => {
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, providerId: "" }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, providerId: "x" }).success,
    ).toBe(true);
  });

  it("rejects query shorter than 1 and longer than 256 — same envelope as resolve", () => {
    expect(SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "" }).success).toBe(
      false,
    );
    expect(SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "a" }).success).toBe(
      true,
    );
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "a".repeat(256) }).success,
    ).toBe(true);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "a".repeat(257) }).success,
    ).toBe(false);
  });

  it("accepts 1- and 2-character queries (backend does not enforce UI20's 3-char gate)", () => {
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "a" }).success).toBe(true);
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "ab" }).success).toBe(
      true,
    );
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "san" }).success).toBe(
      true,
    );
  });

  it("rejects query containing semicolon — factored validation", () => {
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "Sunnyvale; DROP" }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: ";Sunnyvale" }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "Sunny;vale" }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "Sunnyvale CA" }).success,
    ).toBe(true);
  });

  it("rejects query with >20 whitespace tokens and accepts 20 — same threshold as resolve", () => {
    const twenty = Array.from({ length: 20 }, () => "word").join(" ");
    const twentyOne = Array.from({ length: 21 }, () => "word").join(" ");
    const withExtraWhitespace = `  ${Array.from({ length: 20 }, () => "word").join("   \t  ")}  `;
    const twentyOneWithNewlines = Array.from({ length: 21 }, () => "tok").join("\n");

    expect(SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: twenty }).success).toBe(
      true,
    );
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: withExtraWhitespace })
        .success,
    ).toBe(true);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: twentyOne }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: twentyOneWithNewlines })
        .success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, query: "  Sunnyvale  " }).success,
    ).toBe(true);
  });

  it("mirrors ResolvePlaceInputSchema's query envelope exactly (factored placeQuerySchema)", () => {
    const probes = [
      "",
      "a",
      "ab",
      "san",
      "San Francisco",
      "a".repeat(256),
      "a".repeat(257),
      "hello; world",
      Array.from({ length: 20 }, () => "w").join(" "),
      Array.from({ length: 21 }, () => "w").join(" "),
      "  spaced   out  ",
    ];
    for (const query of probes) {
      const suggestOk = SuggestPlaceInputSchema.safeParse({ providerId: "amc", query }).success;
      const resolveOk = ResolvePlaceInputSchema.safeParse({
        providerId: "amc",
        query,
        radiusKm: 10,
        limit: 5,
      }).success;
      expect(suggestOk).toBe(resolveOk);
    }
  });

  it("exposes the shared placeQuerySchema instance", () => {
    expect(placeQuerySchema.safeParse("hello").success).toBe(true);
    expect(placeQuerySchema.safeParse("hello; world").success).toBe(false);
    expect(SuggestPlaceInputSchema.shape.query).toBe(placeQuerySchema);
    expect(ResolvePlaceInputSchema.shape.query).toBe(placeQuerySchema);
  });

  it("has no radiusKm/limit — strictObject rejects them", () => {
    expect(SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, radiusKm: 10 }).success).toBe(
      false,
    );
    expect(SuggestPlaceInputSchema.safeParse({ ...validSuggestInput, limit: 5 }).success).toBe(
      false,
    );
  });

  it("rejects extra coordinate fields (strictObject, no lat/lng/center)", () => {
    expect(
      SuggestPlaceInputSchema.safeParse({
        ...validSuggestInput,
        lat: 37.37,
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({
        ...validSuggestInput,
        lng: -122,
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({
        ...validSuggestInput,
        center: { lat: 1, lng: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("SuggestPlaceCandidatesSchema — label-only, capped at 5 (S52.1/S52.2)", () => {
  it("accepts empty candidates (no error, not PLACE_NOT_FOUND)", () => {
    expect(SuggestPlaceCandidatesSchema.parse({ candidates: [] })).toEqual({ candidates: [] });
  });

  it("accepts 1–5 label-only candidates", () => {
    const five = { candidates: Array.from({ length: 5 }, (_, i) => ({ label: `Place ${i}` })) };
    expect(SuggestPlaceCandidatesSchema.parse(five)).toEqual(five);
    expect(
      SuggestPlaceCandidatesSchema.parse({ candidates: [{ label: "San Francisco, CA" }] }),
    ).toEqual({
      candidates: [{ label: "San Francisco, CA" }],
    });
  });

  it("rejects more than 5 candidates", () => {
    const six = { candidates: Array.from({ length: 6 }, (_, i) => ({ label: `Place ${i}` })) };
    expect(SuggestPlaceCandidatesSchema.safeParse(six).success).toBe(false);
  });

  it("rejects candidate with empty label", () => {
    expect(SuggestPlaceCandidatesSchema.safeParse({ candidates: [{ label: "" }] }).success).toBe(
      false,
    );
  });

  it("rejects candidate that carries coordinates or extra fields (strictObject, no lat/lng)", () => {
    expect(
      SuggestPlaceCandidatesSchema.safeParse({
        candidates: [{ label: "Sunnyvale, CA", lat: 37.37, lng: -122 }],
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceCandidatesSchema.safeParse({
        candidates: [{ label: "Sunnyvale, CA", center: { lat: 1, lng: 1 } }],
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceCandidatesSchema.safeParse({
        candidates: [{ label: "Sunnyvale, CA", latitude: 1, longitude: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects top-level coordinate fields (strictObject at container level)", () => {
    expect(
      SuggestPlaceCandidatesSchema.safeParse({
        candidates: [{ label: "Sunnyvale, CA" }],
        lat: 37,
        lng: -122,
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceCandidatesSchema.safeParse({
        candidates: [{ label: "Sunnyvale, CA" }],
        center: { lat: 37, lng: -122 },
      }).success,
    ).toBe(false);
  });

  it("rejects non-array or missing candidates field", () => {
    expect(SuggestPlaceCandidatesSchema.safeParse({}).success).toBe(false);
    expect(SuggestPlaceCandidatesSchema.safeParse({ candidates: "not an array" }).success).toBe(
      false,
    );
  });
});

describe("SuggestPlaceResponseSchema — candidates | PLACE_RESOLUTION_UNAVAILABLE (S52.2/S52.8)", () => {
  it("accepts candidates union member", () => {
    const payload = { candidates: [{ label: "Sunnyvale, CA, United States" }] };
    expect(SuggestPlaceResponseSchema.parse(payload)).toEqual(payload);
    expect(SuggestPlaceCandidatesSchema.parse(payload)).toEqual(payload);
  });

  it("accepts PLACE_RESOLUTION_UNAVAILABLE union member", () => {
    const unavailable = { kind: "PLACE_RESOLUTION_UNAVAILABLE" as const };
    expect(SuggestPlaceResponseSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("empty candidates remains candidates, not unavailable and not PLACE_NOT_FOUND", () => {
    const empty = { candidates: [] as Array<{ label: string }> };
    expect(SuggestPlaceResponseSchema.parse(empty)).toEqual(empty);
    expect(SuggestPlaceResponseSchema.safeParse({ kind: "PLACE_NOT_FOUND" }).success).toBe(false);
  });

  it("rejects PLACE_NOT_FOUND (not part of suggest union)", () => {
    expect(SuggestPlaceResponseSchema.safeParse({ kind: "PLACE_NOT_FOUND" }).success).toBe(false);
  });

  it("rejects candidate response that sneaks coordinates (strict union)", () => {
    expect(
      SuggestPlaceResponseSchema.safeParse({
        candidates: [{ label: "Sunnyvale", lat: 37 }],
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceResponseSchema.safeParse({
        candidates: [{ label: "Sunnyvale" }],
        lat: 37,
      }).success,
    ).toBe(false);
  });

  it("round-trips unavailable through the union without coordinates", () => {
    const unavailable = { kind: "PLACE_RESOLUTION_UNAVAILABLE" as const };
    const parsed = SuggestPlaceResponseSchema.parse(unavailable);
    expect(parsed).toEqual(unavailable);
    expect(SuggestPlaceResponseSchema.safeParse({ ...unavailable, lat: 1, lng: 1 }).success).toBe(
      false,
    );
  });
});

describe("no-coordinate wire invariant across suggest contracts (S52.8)", () => {
  it("serialized suggest input/candidates/response contain no lat/lng/center string", () => {
    const inputs = [
      SuggestPlaceInputSchema.parse({ providerId: "amc", query: "Sunnyvale" }),
      SuggestPlaceCandidatesSchema.parse({ candidates: [{ label: "Sunnyvale, CA" }] }),
      SuggestPlaceCandidatesSchema.parse({ candidates: [] }),
      SuggestPlaceResponseSchema.parse({ kind: "PLACE_RESOLUTION_UNAVAILABLE" }),
    ];
    for (const value of inputs) {
      const json = JSON.stringify(value);
      expect(json).not.toMatch(/"lat"/);
      expect(json).not.toMatch(/"lng"/);
      expect(json).not.toMatch(/"center"/);
      expect(json).not.toMatch(/"latitude"/);
      expect(json).not.toMatch(/"longitude"/);
    }
  });
});
