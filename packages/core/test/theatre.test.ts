import { describe, expect, it } from "vitest";

import { TheatreSchema, distanceKm } from "../src/index.js";

const theatre = {
  id: "amc:theatre:2325",
  providerId: "amc",
  name: "AMC Metreon 16",
  location: { lat: 37.784, lng: -122.403 },
  timezone: "America/Los_Angeles",
  city: "San Francisco",
  address: "135 4th St, San Francisco, CA",
  slugs: { market: "san-francisco", theatre: "amc-metreon-16" },
  firstSeenAt: new Date("2026-08-01T00:00:00Z"),
  lastSeenAt: new Date("2026-08-04T00:00:00Z"),
};

describe("TheatreSchema", () => {
  it("accepts a strict namespaced theatre entity", () => {
    expect(TheatreSchema.parse(theatre)).toEqual({ ...theatre, amenities: [] });
  });

  it.each([
    { location: { lat: -90.01, lng: 0 } },
    { location: { lat: 90.01, lng: 0 } },
    { location: { lat: 0, lng: -180.01 } },
    { location: { lat: 0, lng: 180.01 } },
  ])("rejects out-of-range coordinates", (override) => {
    expect(TheatreSchema.safeParse({ ...theatre, ...override }).success).toBe(false);
  });

  it("rejects a non-IANA timezone, unnamespaced id, and extra properties", () => {
    expect(TheatreSchema.safeParse({ ...theatre, timezone: "PST" }).success).toBe(false);
    expect(TheatreSchema.safeParse({ ...theatre, id: "2325" }).success).toBe(false);
    expect(TheatreSchema.safeParse({ ...theatre, surprise: true }).success).toBe(false);
  });
});

describe("distanceKm", () => {
  it("matches a published New York–Paris city-pair distance", () => {
    // Independent reference: Around the World 360, “Distance from New York City, NY to Paris,”
    // publishes a 5,837 km straight-line city-pair distance:
    // https://www.aroundtheworld360.com/distance/new-york-city_ny_us/paris_fr/
    // (retrieved 2026-08-04). The test uses the stated NYC/Paris centre coordinates below and a
    // ±2 km tolerance for the table's whole-kilometre rounding and centre-point choice.
    const distance = distanceKm({ lat: 40.7128, lng: -74.006 }, { lat: 48.8566, lng: 2.3522 });
    expect(Math.abs(distance - 5837)).toBeLessThanOrEqual(2);
  });

  it("is symmetric and zero for identical points", () => {
    const sanFrancisco = { lat: 37.7749, lng: -122.4194 };
    const losAngeles = { lat: 34.0522, lng: -118.2437 };
    expect(distanceKm(sanFrancisco, losAngeles)).toBe(distanceKm(losAngeles, sanFrancisco));
    expect(distanceKm(sanFrancisco, sanFrancisco)).toBe(0);
  });

  it("handles antipodes", () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(20015, 0);
  });

  it("retains sub-kilometre precision at equal longitude", () => {
    // 0.001 latitude degree is about 111.195 m from the physical mean meridional scale.
    expect(distanceKm({ lat: 10, lng: 20 }, { lat: 10.001, lng: 20 })).toBeCloseTo(0.111195, 6);
  });

  it("takes the short path across the antimeridian", () => {
    // 0.2 longitude degree at the equator is about 22.239 km, not nearly a circumference.
    expect(distanceKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })).toBeCloseTo(22.239, 3);
  });
});
