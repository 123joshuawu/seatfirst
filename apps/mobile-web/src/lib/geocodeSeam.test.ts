import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createGeocodeResolver,
  createStubGeocodeResolver,
  createStubSuggestPlaceResolver,
  createSuggestPlaceResolver,
  type GeocodeResult,
  type TrpcResolvePlaceClient,
  type TrpcSuggestPlaceClient,
} from "./geocodeSeam";

function makeClient(
  impl: (input: {
    providerId: string;
    query: string;
    radiusKm: number;
    limit: number;
  }) => Promise<unknown>,
): TrpcResolvePlaceClient {
  return {
    searches: {
      resolvePlace: {
        query: impl as TrpcResolvePlaceClient["searches"]["resolvePlace"]["query"],
      },
    },
  };
}

function makeSuggestClient(
  impl: (input: { providerId: string; query: string }) => Promise<unknown>,
): TrpcSuggestPlaceClient {
  return {
    searches: {
      suggestPlace: {
        query: impl as TrpcSuggestPlaceClient["searches"]["suggestPlace"]["query"],
      },
    },
  };
}

describe("geocodeSeam — createGeocodeResolver", () => {
  it("success: returns LIST theatres + label + excluded, no coordinate, no kind", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      kind: "ok",
      theatres: [
        { theatreId: "amc:1", distanceKm: 0.5, name: "AMC One", city: "Sunnyvale" },
        { theatreId: "amc:2", distanceKm: 12.3, name: "AMC Two", city: null },
      ],
      label: "40 km around Sunnyvale",
      excluded: { outsideArea: 10, byLimit: 2 },
      resolvedPlaceName: "Sunnyvale, California, United States",
    });
    const client = makeClient(mockQuery);
    const resolver = createGeocodeResolver({ providerId: "amc", client });

    const result = await resolver.resolvePlace("Sunnyvale", 40, 25);

    expect(mockQuery).toHaveBeenCalledWith({
      providerId: "amc",
      query: "Sunnyvale",
      radiusKm: 40,
      limit: 25,
    });
    expect(result).toEqual({
      theatres: [
        { theatreId: "amc:1", distanceKm: 0.5, name: "AMC One", city: "Sunnyvale" },
        { theatreId: "amc:2", distanceKm: 12.3, name: "AMC Two", city: null },
      ],
      label: "40 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      excluded: { outsideArea: 10, byLimit: 2 },
    });
    // Never returns a coordinate or kind on success.
    expect(result).not.toHaveProperty("kind");
    expect(result).not.toHaveProperty("lat");
    expect(result).not.toHaveProperty("lng");
    expect(result).not.toHaveProperty("coordinate");
    // Theatres carry display name/city plus id + distanceKm — never lat/lng.
    if ("theatres" in result) {
      for (const t of result.theatres) {
        expect(t).not.toHaveProperty("lat");
        expect(t).not.toHaveProperty("lng");
      }
    }
    // Ensure raw response is not leaked — no kind field on success.
    expect((result as unknown as Record<string, unknown>).kind).toBeUndefined();
  });

  it("maps server PLACE_NOT_FOUND distinctly", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ kind: "PLACE_NOT_FOUND" });
    const client = makeClient(mockQuery);
    const resolver = createGeocodeResolver({ providerId: "amc", client });

    const result = await resolver.resolvePlace("missing place", 40, 25);

    expect(result).toEqual({ kind: "PLACE_NOT_FOUND" });
    expect(result).not.toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
  });

  it("maps server PLACE_RESOLUTION_UNAVAILABLE distinctly", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    const client = makeClient(mockQuery);
    const resolver = createGeocodeResolver({ providerId: "amc", client });

    const result = await resolver.resolvePlace("bad place", 40, 25);

    expect(result).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    expect(result).not.toEqual({ kind: "PLACE_NOT_FOUND" });
  });

  it("transport / tRPC throw maps to PLACE_RESOLUTION_UNAVAILABLE, never PLACE_NOT_FOUND", async () => {
    const mockQuery = vi.fn().mockRejectedValue(new Error("network down"));
    const client = makeClient(mockQuery);
    const resolver = createGeocodeResolver({ providerId: "amc", client });

    const result = await resolver.resolvePlace("any", 10, 5);

    expect(result).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    expect(result).not.toEqual({ kind: "PLACE_NOT_FOUND" });
  });

  it("forwards providerId, query, radiusKm, limit verbatim", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      kind: "ok",
      theatres: [],
      label: "10 km around foo",
      excluded: { outsideArea: 0, byLimit: 0 },
      resolvedPlaceName: "Foo, California, United States",
    });
    const client = makeClient(mockQuery);
    const resolver = createGeocodeResolver({ providerId: "amc", client });

    await resolver.resolvePlace("  foo  ", 10, 7);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith({
      providerId: "amc",
      query: "  foo  ",
      radiusKm: 10,
      limit: 7,
    });
  });

  it("never persists or returns coordinate — seam source contains no lat/lng persistence", () => {
    const filePath = path.resolve(__dirname, "geocodeSeam.ts");
    const src = readFileSync(filePath, "utf8");
    // The seam must not contain localStorage, sessionStorage, hash, spec_hash, or coordinate storage.
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/sessionStorage/);
    expect(src).not.toMatch(/spec_hash/);
    // No coordinate property access beyond transient local (we keep zero lat/lng in file).
    // If lat/lng appears, it must not be assigned to persistent storage.
    // This seam intentionally contains no "lat" or "lng" tokens at all.
    const latMatches = src.match(/\blat\b/g) ?? [];
    const lngMatches = src.match(/\blng\b/g) ?? [];
    // Allow zero occurrences; if any appear, they must be few and transient.
    expect(latMatches.length).toBe(0);
    expect(lngMatches.length).toBe(0);
  });
});

describe("geocodeSeam — createStubGeocodeResolver", () => {
  it("stub queues success / notFound / unavailable and records calls", async () => {
    const stub = createStubGeocodeResolver();

    stub.queueSuccess({
      theatres: [{ theatreId: "amc:1", distanceKm: 1, name: "AMC One", city: "X City" }],
      label: "40 km around X",
      excluded: { outsideArea: 0, byLimit: 0 },
      resolvedPlaceName: "X, California, United States",
    });
    stub.queueNotFound();
    stub.queueUnavailable();

    const r1 = await stub.resolvePlace("X", 40, 25);
    const r2 = await stub.resolvePlace("Y", 10, 5);
    const r3 = await stub.resolvePlace("Z", 10, 5);

    expect(r1).toEqual({
      theatres: [{ theatreId: "amc:1", distanceKm: 1, name: "AMC One", city: "X City" }],
      label: "40 km around X",
      excluded: { outsideArea: 0, byLimit: 0 },
      resolvedPlaceName: "X, California, United States",
    });
    expect(r2).toEqual({ kind: "PLACE_NOT_FOUND" });
    expect(r3).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });

    expect(stub.calls).toEqual([
      { query: "X", radiusKm: 40, limit: 25 },
      { query: "Y", radiusKm: 10, limit: 5 },
      { query: "Z", radiusKm: 10, limit: 5 },
    ]);
  });

  it("stub defaultResult is used when queue empty", async () => {
    const fallback: GeocodeResult = { kind: "PLACE_NOT_FOUND" };
    const stub = createStubGeocodeResolver(fallback);
    const r = await stub.resolvePlace("any", 40, 25);
    expect(r).toEqual(fallback);
  });

  it("stub queueResult accepts either success or error kinds", async () => {
    const stub = createStubGeocodeResolver();
    stub.queueResult({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    expect(await stub.resolvePlace("a", 1, 1)).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });

    stub.queueResult({
      theatres: [],
      label: "1 km around a",
      excluded: { outsideArea: 5, byLimit: 0 },
      resolvedPlaceName: "A, California, United States",
    });
    const r = await stub.resolvePlace("a", 1, 1);
    expect(r).toEqual({
      theatres: [],
      label: "1 km around a",
      excluded: { outsideArea: 5, byLimit: 0 },
      resolvedPlaceName: "A, California, United States",
    });
  });

  it("stub reset clears calls and queue", async () => {
    const stub = createStubGeocodeResolver({ kind: "PLACE_NOT_FOUND" });
    await stub.resolvePlace("a", 40, 25);
    expect(stub.calls.length).toBe(1);
    stub.reset();
    expect(stub.calls.length).toBe(0);
    // After reset with no queue and no fallback override, default fallback still applies.
    // Create a fresh stub without fallback to verify throw behavior after reset.
    const stub2 = createStubGeocodeResolver();
    stub2.queueNotFound();
    await stub2.resolvePlace("a", 1, 1);
    stub2.reset();
    await expect(stub2.resolvePlace("a", 1, 1)).rejects.toThrow(/no queued result/);
  });

  it("stub success result never contains coordinate", async () => {
    const stub = createStubGeocodeResolver();
    stub.queueSuccess({
      theatres: [{ theatreId: "amc:1", distanceKm: 2.5, name: "AMC One", city: null }],
      label: "10 km around Place",
      excluded: { outsideArea: 1, byLimit: 0 },
      resolvedPlaceName: "Place, California, United States",
    });
    const r = await stub.resolvePlace("Place", 10, 5);
    expect(r).not.toHaveProperty("lat");
    expect(r).not.toHaveProperty("lng");
    if ("theatres" in r) {
      for (const t of r.theatres) {
        expect(t).not.toHaveProperty("lat");
        expect(t).not.toHaveProperty("lng");
      }
    }
  });
});

describe("geocodeSeam — suggestPlace", () => {
  it("forwards providerId and query only, returning labels without coordinates", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      candidates: [{ label: "Sunnyvale, California, United States" }],
    });
    const resolver = createSuggestPlaceResolver({
      providerId: "amc",
      client: makeSuggestClient(mockQuery),
    });

    const result = await resolver.suggestPlace("sun");

    expect(mockQuery).toHaveBeenCalledWith({ providerId: "amc", query: "sun" });
    expect(result).toEqual({
      candidates: [{ label: "Sunnyvale, California, United States" }],
    });
    expect(result).not.toHaveProperty("lat");
    expect(result).not.toHaveProperty("lng");
  });

  it("preserves empty candidates and maps unavailable and transport failures", async () => {
    const empty = createSuggestPlaceResolver({
      providerId: "amc",
      client: makeSuggestClient(vi.fn().mockResolvedValue({ candidates: [] })),
    });
    const unavailable = createSuggestPlaceResolver({
      providerId: "amc",
      client: makeSuggestClient(
        vi.fn().mockResolvedValue({ kind: "PLACE_RESOLUTION_UNAVAILABLE" }),
      ),
    });
    const failed = createSuggestPlaceResolver({
      providerId: "amc",
      client: makeSuggestClient(vi.fn().mockRejectedValue(new Error("offline"))),
    });

    await expect(empty.suggestPlace("none")).resolves.toEqual({ candidates: [] });
    await expect(unavailable.suggestPlace("sun")).resolves.toEqual({
      kind: "PLACE_RESOLUTION_UNAVAILABLE",
    });
    await expect(failed.suggestPlace("sun")).resolves.toEqual({
      kind: "PLACE_RESOLUTION_UNAVAILABLE",
    });
  });

  it("stub queues candidates, empty, and unavailable while recording calls", async () => {
    const stub = createStubSuggestPlaceResolver();
    stub.queueCandidates(["San Francisco, CA, United States"]);
    stub.queueEmpty();
    stub.queueUnavailable();

    await expect(stub.suggestPlace("san")).resolves.toEqual({
      candidates: [{ label: "San Francisco, CA, United States" }],
    });
    await expect(stub.suggestPlace("none")).resolves.toEqual({ candidates: [] });
    await expect(stub.suggestPlace("fail")).resolves.toEqual({
      kind: "PLACE_RESOLUTION_UNAVAILABLE",
    });
    expect(stub.calls).toEqual([{ query: "san" }, { query: "none" }, { query: "fail" }]);

    stub.reset();
    expect(stub.calls).toEqual([]);
  });
});
