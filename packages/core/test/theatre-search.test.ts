import { describe, expect, it } from "vitest";

import { TheatreSearchInputSchema, TheatreSearchResponseSchema } from "../src/index.js";

describe("TheatreSearchInputSchema (S20.0)", () => {
  it("accepts a query and an optional location pair", () => {
    expect(TheatreSearchInputSchema.parse({ q: "AMC" })).toEqual({ q: "AMC" });
    expect(TheatreSearchInputSchema.parse({ q: "AMC", lat: 41, lng: -87 })).toEqual({
      q: "AMC",
      lat: 41,
      lng: -87,
    });
  });

  it("rejects lat without lng and lng without lat (both-or-neither)", () => {
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lat: 10 }).success).toBe(false);
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lng: 10 }).success).toBe(false);
  });

  it("rejects out-of-range lat/lng", () => {
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lat: 90.01, lng: 0 }).success).toBe(
      false,
    );
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lat: -90.01, lng: 0 }).success).toBe(
      false,
    );
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lat: 0, lng: 180.01 }).success).toBe(
      false,
    );
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", lat: 0, lng: -180.01 }).success).toBe(
      false,
    );
  });

  it("rejects extra properties (strict)", () => {
    expect(TheatreSearchInputSchema.safeParse({ q: "AMC", surprise: true }).success).toBe(false);
  });
});

describe("TheatreSearchInputSchema (S49 — browse mode)", () => {
  it('accepts {} (no q, no location) and { q: "" } as browse', () => {
    expect(TheatreSearchInputSchema.parse({})).toEqual({});
    expect(TheatreSearchInputSchema.parse({ q: "" })).toEqual({ q: "" });
    expect(TheatreSearchInputSchema.parse({ q: undefined })).toEqual({});
  });

  it("accepts { lat, lng } alone and { lat, lng, radiusKm }", () => {
    expect(TheatreSearchInputSchema.parse({ lat: 41, lng: -87 })).toEqual({ lat: 41, lng: -87 });
    expect(TheatreSearchInputSchema.parse({ lat: 41, lng: -87, radiusKm: 10 })).toEqual({
      lat: 41,
      lng: -87,
      radiusKm: 10,
    });
    expect(TheatreSearchInputSchema.parse({ q: "amc", lat: 41, lng: -87, radiusKm: 10 })).toEqual({
      q: "amc",
      lat: 41,
      lng: -87,
      radiusKm: 10,
    });
  });

  it("rejects radiusKm without a center (lat/lng)", () => {
    expect(TheatreSearchInputSchema.safeParse({ radiusKm: 10 }).success).toBe(false);
    expect(TheatreSearchInputSchema.safeParse({ radiusKm: 10, lat: 41 }).success).toBe(false);
    expect(TheatreSearchInputSchema.safeParse({ radiusKm: 10, lng: -87 }).success).toBe(false);
  });

  it("rejects radiusKm > 40 with SELECTOR_UNSUPPORTED", () => {
    const over = TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: 40.01 });
    expect(over.success).toBe(false);
    if (over.success) throw new Error("expected failure");
    const issues = over.error.issues;
    const unsupported = issues.find(
      (issue) =>
        (issue as unknown as { params?: { validationCode?: string } }).params?.validationCode ===
        "SELECTOR_UNSUPPORTED",
    );
    expect(unsupported).toBeDefined();
    expect(unsupported?.message).toBe("SELECTOR_UNSUPPORTED");
    // Exactly 40 is accepted.
    expect(TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: 40 }).success).toBe(
      true,
    );
    expect(TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: 25 }).success).toBe(
      true,
    );
  });

  it("still accepts q: amc (regression)", () => {
    expect(TheatreSearchInputSchema.parse({ q: "amc" })).toEqual({ q: "amc" });
  });

  it("rejects non-positive or non-finite radiusKm", () => {
    expect(TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: 0 }).success).toBe(
      false,
    );
    expect(TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: -5 }).success).toBe(
      false,
    );
    expect(
      TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: Infinity }).success,
    ).toBe(false);
    expect(TheatreSearchInputSchema.safeParse({ lat: 41, lng: -87, radiusKm: NaN }).success).toBe(
      false,
    );
  });
});

describe("TheatreSearchResponseSchema (S20.1)", () => {
  const baseHit = {
    id: "amc:theatre:1",
    providerId: "amc",
    name: "Alpha",
    location: { lat: 41, lng: -87 },
    timezone: "America/Chicago",
    city: null,
    address: null,
    slugs: null,
    // Wire form: `TheatreSearchHitSchema` overrides `TheatreSchema`'s domain `z.date()`
    // timestamps with `UtcInstantSchema` (ISO string, `Z` suffix) — the form the route
    // emits and that survives JSON transport.
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-02T00:00:00.000Z",
  };

  it("parses a hit with null distanceKm (no user location, G1.5)", () => {
    const hit = { ...baseHit, distanceKm: null };
    expect(TheatreSearchResponseSchema.parse({ theatres: [hit] })).toEqual({ theatres: [hit] });
  });

  it("parses a hit with a finite nonnegative distanceKm", () => {
    const hit = { ...baseHit, distanceKm: 12.5 };
    expect(TheatreSearchResponseSchema.parse({ theatres: [hit] })).toEqual({ theatres: [hit] });
  });

  it("rejects a negative or non-finite distanceKm", () => {
    expect(
      TheatreSearchResponseSchema.safeParse({ theatres: [{ ...baseHit, distanceKm: -1 }] }).success,
    ).toBe(false);
    expect(
      TheatreSearchResponseSchema.safeParse({
        theatres: [{ ...baseHit, distanceKm: Number.NaN }],
      }).success,
    ).toBe(false);
  });

  it("caps the theatres array at 50 results (ADR 0016, no pagination)", () => {
    const one = { ...baseHit, distanceKm: null };
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
      ...one,
      id: `amc:theatre:${i}`,
    }));
    expect(TheatreSearchResponseSchema.safeParse({ theatres: fiftyOne }).success).toBe(false);
    expect(TheatreSearchResponseSchema.safeParse({ theatres: fiftyOne.slice(0, 50) }).success).toBe(
      true,
    );
  });

  it("rejects extra properties on the envelope and on a hit (strict)", () => {
    expect(TheatreSearchResponseSchema.safeParse({ theatres: [], surprise: true }).success).toBe(
      false,
    );
    expect(
      TheatreSearchResponseSchema.safeParse({
        theatres: [{ ...baseHit, distanceKm: null, surprise: true }],
      }).success,
    ).toBe(false);
  });
});
