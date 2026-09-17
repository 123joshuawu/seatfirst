import { describe, expect, it, vi } from "vitest";
import {
  CapacityPreviewResponseSchema,
  FacetCountsResponseSchema,
  SessionBootstrapResponseSchema,
  TheatreMoviesResponseSchema,
  ResolvePlaceResponseSchema,
  SuggestPlaceResponseSchema,
  TheatreSearchResponseSchema,
  type FacetCountsInput,
} from "@seatfirst/core";

import {
  DEV_MOVIE_GROUPS,
  DEV_THEATRE_HITS,
  devMovieId,
  devTheatreId,
  type FacetMode,
  makeCapacityPreviewExceeded,
  makeCapacityPreviewOk,
  makeCapacityPreviewUnavailable,
  makeFacetCountsResponse,
  makeResolvePlaceOk,
  makeSessionBootstrap,
  makeSuggestPlaceCandidates,
  makeTheatreMoviesResponse,
  makeTheatreSearchResponse,
} from "./apiFixtures";
import { API_PROFILE_NAMES, createApiHandler, isApiProfileName } from "./mockTransport";

/**
 * Same contract as `contracts.test.ts`: what the mock transport hands the app must be
 * what the server would hand it. Every builder, and every profile's output for every
 * procedure it answers, is parsed by the real schema.
 */
const facetInput: FacetCountsInput = {
  providerId: "amc",
  theatreIds: [devTheatreId("metreon"), devTheatreId("kabuki")],
  base: { weekdays: ["FRIDAY"], timeOfDay: "evening" },
  axes: [{ kind: "MOVIE", candidates: ["amc:movie:a", "amc:movie:b"] }],
} as FacetCountsInput;

/**
 * Why a second input: the mock returns all-zero counts without a movie context, so the
 * mode-driven synthesis below is only exercisable with a real `base.movieId`. A FORMAT
 * axis (not MOVIE) keeps the input schema-valid — `base.movieId` must be omitted when a
 * MOVIE axis is requested.
 */
const facetInputWithMovie = {
  providerId: "amc",
  theatreIds: [devTheatreId("metreon"), devTheatreId("kabuki")],
  base: { movieId: devMovieId("dune-part-three"), weekdays: ["FRIDAY"], timeOfDay: "evening" },
  axes: [{ kind: "FORMAT", candidates: ["imax", "STANDARD"] }],
} as FacetCountsInput;

describe("API fixture builders parse against the real contracts", () => {
  it("builds a valid session bootstrap response", () => {
    expect(() => SessionBootstrapResponseSchema.parse(makeSessionBootstrap())).not.toThrow();
  });

  it("builds a valid theatre search response", () => {
    expect(() => TheatreSearchResponseSchema.parse(makeTheatreSearchResponse())).not.toThrow();
    expect(DEV_THEATRE_HITS.length).toBeGreaterThan(1);
  });

  it("builds a valid theatre movies response", () => {
    expect(() => TheatreMoviesResponseSchema.parse(makeTheatreMoviesResponse())).not.toThrow();
    expect(DEV_MOVIE_GROUPS.length).toBeGreaterThan(1);
  });

  it("echoes the requested theatre and date range", () => {
    const response = makeTheatreMoviesResponse({
      theatreId: devTheatreId("kabuki"),
      from: "2026-09-01",
      to: "2026-09-14",
    });
    expect(() => TheatreMoviesResponseSchema.parse(response)).not.toThrow();
    expect(response.theatreId).toBe(devTheatreId("kabuki"));
    expect(response.from).toBe("2026-09-01");
  });

  it("answers the axes it was asked for, in every facet mode", () => {
    for (const mode of ["warm", "partial", "cold", "warm-zero"] as const) {
      const response = makeFacetCountsResponse(facetInput, mode);
      expect(() => FacetCountsResponseSchema.parse(response)).not.toThrow();
      expect(response.counts.map((entry) => entry.candidate)).toEqual([
        "amc:movie:a",
        "amc:movie:b",
      ]);
    }
  });

  it("answers non-movie axes with a movie context, in every facet mode", () => {
    for (const mode of ["warm", "partial", "cold", "warm-zero"] as const) {
      const response = makeFacetCountsResponse(facetInputWithMovie, mode);
      expect(() => FacetCountsResponseSchema.parse(response)).not.toThrow();
      expect(response.counts.map((entry) => entry.candidate)).toEqual(["imax", "STANDARD"]);
    }
  });

  it("distinguishes the four facet readings the UI renders", () => {
    // `facetInputWithMovie`'s FORMAT axis asks for "imax" and "STANDARD"; `DEV_MOVIE_GROUPS`
    // only ever seeds STANDARD showtimes for "dune-part-three", so "STANDARD" is the
    // candidate with a real match to distinguish "some count" from "no count" below.
    const standardEntry = (mode: FacetMode) =>
      makeFacetCountsResponse(facetInputWithMovie, mode).counts.find(
        (entry) => entry.candidate === "STANDARD",
      );
    const cold = standardEntry("cold");
    const warmZero = standardEntry("warm-zero");
    const partial = standardEntry("partial");
    const warm = standardEntry("warm");
    // "not checked yet" — every theatre cold.
    expect(cold).toMatchObject({
      count: 0,
      coldTheatreCount: facetInputWithMovie.theatreIds.length,
    });
    // Dimmed dead end — warm and genuinely zero.
    expect(warmZero).toMatchObject({ count: 0, coldTheatreCount: 0 });
    // "N+" — some theatres still cold.
    expect(partial?.coldTheatreCount).toBeGreaterThan(0);
    expect(partial?.count).toBeGreaterThan(0);
    // Exact count.
    expect(warm).toMatchObject({ coldTheatreCount: 0 });
    expect(warm?.count).toBeGreaterThan(0);
  });

  it("derives FORMAT counts from real seeded showtimes instead of a synthetic sequence, so specific formats can never outnumber the movie's actual showtime total (seeded-ui-states-audit #2)", () => {
    const response = makeFacetCountsResponse(facetInputWithMovie, "warm");
    const imax = response.counts.find((entry) => entry.candidate === "imax");
    const standard = response.counts.find((entry) => entry.candidate === "STANDARD");
    // DEV_MOVIE_GROUPS only ever seeds STANDARD showtimes for this movie, so IMAX has zero
    // real matches and must read 0, not a synthetic positive count that could outnumber
    // "Any format"'s real client-computed total.
    expect(imax).toMatchObject({ count: 0 });
    expect(standard?.count).toBeGreaterThan(0);
  });

  it("returns all-zero entries per candidate when no movie is selected", () => {
    // `null` (explicitly no movie) and a missing `movieId` (never set) both mean "no movie
    // context" — the mock must not invent populated counts for either, in any mode.
    const inputs: FacetCountsInput[] = [
      { ...facetInputWithMovie, base: { ...facetInputWithMovie.base, movieId: null } },
      { ...facetInputWithMovie, base: { weekdays: ["FRIDAY"], timeOfDay: "evening" } },
    ];
    for (const input of inputs) {
      for (const mode of ["warm", "partial", "cold", "warm-zero"] as const) {
        const response = makeFacetCountsResponse(input, mode);
        expect(() => FacetCountsResponseSchema.parse(response)).not.toThrow();
        // One entry per requested candidate — just all zero.
        expect(response.counts.map((entry) => entry.candidate)).toEqual(["imax", "STANDARD"]);
        for (const entry of response.counts) {
          expect(entry).toMatchObject({ count: 0, coldTheatreCount: 0 });
        }
      }
    }
  });

  it("builds valid capacity preview responses", () => {
    expect(() => CapacityPreviewResponseSchema.parse(makeCapacityPreviewOk())).not.toThrow();
    expect(() => CapacityPreviewResponseSchema.parse(makeCapacityPreviewExceeded())).not.toThrow();
    expect(() =>
      CapacityPreviewResponseSchema.parse(makeCapacityPreviewUnavailable()),
    ).not.toThrow();
  });

  it("builds valid suggestion and resolved-place responses without coordinates", () => {
    const suggestions = makeSuggestPlaceCandidates(["Sunnyvale, California, United States"]);
    const resolved = makeResolvePlaceOk({
      query: "sun",
      radiusKm: 10,
      resolvedPlaceName: "Sunnyvale, California, United States",
    });
    expect(() => SuggestPlaceResponseSchema.parse(suggestions)).not.toThrow();
    expect(() => ResolvePlaceResponseSchema.parse(resolved)).not.toThrow();
    expect(suggestions).not.toHaveProperty("lat");
    expect(suggestions).not.toHaveProperty("lng");
    expect(resolved).not.toHaveProperty("lat");
    expect(resolved).not.toHaveProperty("lng");
  });
});

const SCHEMA_BY_PATH = {
  "session.bootstrap": SessionBootstrapResponseSchema,
  "theatres.search": TheatreSearchResponseSchema,
  "theatres.movies": TheatreMoviesResponseSchema,
  "searches.facetCounts": FacetCountsResponseSchema,
  "searches.capacityPreview": CapacityPreviewResponseSchema,
  "searches.suggestPlace": SuggestPlaceResponseSchema,
  "searches.resolvePlace": ResolvePlaceResponseSchema,
} as const;

const INPUT_BY_PATH: Record<keyof typeof SCHEMA_BY_PATH, unknown> = {
  "session.bootstrap": undefined,
  "theatres.search": { q: "metr" },
  "theatres.movies": { theatreId: devTheatreId("metreon"), from: "2026-08-29", to: "2026-09-27" },
  "searches.facetCounts": facetInput,
  "searches.capacityPreview": { providerId: "amc" },
  "searches.suggestPlace": { providerId: "amc", query: "sun" },
  "searches.resolvePlace": {
    providerId: "amc",
    query: "sun",
    radiusKm: 10,
    limit: 25,
  },
};

describe("mock API profiles emit contract-valid payloads", () => {
  it("names are unique and self-identifying", () => {
    expect(new Set(API_PROFILE_NAMES).size).toBe(API_PROFILE_NAMES.length);
    for (const name of API_PROFILE_NAMES) expect(isApiProfileName(name)).toBe(true);
    expect(isApiProfileName("not-a-profile")).toBe(false);
  });

  it.each(API_PROFILE_NAMES)("%s", (profile) => {
    const handler = createApiHandler(profile);
    for (const path of Object.keys(SCHEMA_BY_PATH) as (keyof typeof SCHEMA_BY_PATH)[]) {
      const result = handler({ path, type: "query", input: INPUT_BY_PATH[path] });
      if (result === null || result.kind === "pending") continue;
      if (result.kind === "error") {
        expect(result.code.length).toBeGreaterThan(0);
        continue;
      }
      expect(() => SCHEMA_BY_PATH[path].parse(result.data)).not.toThrow();
    }
  });

  it("passes unknown procedures through to the network", () => {
    const handler = createApiHandler("happy");
    expect(handler({ path: "searches.onProgress", type: "subscription", input: {} })).toBeNull();
  });

  it("carries the admission-rejected envelope the app reads", () => {
    const result = createApiHandler("admission-rejected")({
      path: "searches.create",
      type: "mutation",
      input: {},
    });
    if (result === null || result.kind !== "error") {
      throw new Error(`expected an error result, got ${String(result?.kind)}`);
    }
    expect(result.code).toBe("ADMISSION_REJECTED");
    expect(result.extras?.retryAfterSeconds).toBeTypeOf("number");
  });
});

describe("devSeed cache clearing and scenario application", () => {
  it("clears queryClient and clearTheatreMovieCache when applying an API profile", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { applyApiProfile } = await import("./devSeed");
    const { getDevTransportHandler, setDevTransportHandler } = await import("@/lib/devTransport");
    const { queryClient } = await import("@/lib/trpc");
    const useTheatreMovieSetModule = await import("@/hooks/useTheatreMovieSet");

    const clearSpy = vi.spyOn(queryClient, "clear");
    const movieCacheSpy = vi.spyOn(useTheatreMovieSetModule, "clearTheatreMovieCache");

    const applied = await applyApiProfile("movies-loading");
    expect(applied).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    expect(movieCacheSpy).toHaveBeenCalled();
    expect(getDevTransportHandler()).not.toBeNull();
    setDevTransportHandler(null);
  });

  it("clears queryClient and clearTheatreMovieCache when applying a dev scenario", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { applyDevSeed } = await import("./devSeed");
    const { setDevTransportHandler } = await import("@/lib/devTransport");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");
    const { queryClient } = await import("@/lib/trpc");
    const useTheatreMovieSetModule = await import("@/hooks/useTheatreMovieSet");

    const clearSpy = vi.spyOn(queryClient, "clear");
    const movieCacheSpy = vi.spyOn(useTheatreMovieSetModule, "clearTheatreMovieCache");

    const applied = await applyDevSeed("form-movies-loading");
    expect(applied).toBe(true);
    expect(clearSpy).toHaveBeenCalled();
    expect(movieCacheSpy).toHaveBeenCalled();
    expect(useSeatfirstStore.getState().movieFocused).toBe(true);
    setDevTransportHandler(null);
  });

  it("applies form-admission-rejected with seeded error state", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { applyDevSeed } = await import("./devSeed");
    const { setDevTransportHandler } = await import("@/lib/devTransport");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");

    const applied = await applyDevSeed("form-admission-rejected");
    expect(applied).toBe(true);
    const state = useSeatfirstStore.getState();
    expect(state.error?.code).toBe("ADMISSION_REJECTED");
    expect(state.error?.retryAfterSeconds).toBe(30);
    setDevTransportHandler(null);
  });

  it("applies where-place-not-found and where-place-unavailable scenarios with place errors", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { applyDevSeed } = await import("./devSeed");
    const { setDevTransportHandler } = await import("@/lib/devTransport");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");

    await applyDevSeed("where-place-not-found");
    expect(useSeatfirstStore.getState().wherePlaceErrorKind).toBe("PLACE_NOT_FOUND");
    expect(useSeatfirstStore.getState().wherePlaceError).toContain("couldn't find that place");

    await applyDevSeed("where-place-unavailable");
    expect(useSeatfirstStore.getState().wherePlaceErrorKind).toBe("PLACE_RESOLUTION_UNAVAILABLE");
    expect(useSeatfirstStore.getState().wherePlaceError).toContain("temporarily unavailable");

    await applyDevSeed("backend-offline");
    expect(useSeatfirstStore.getState().screen).toBe("search");
    setDevTransportHandler(null);
  });

  it("applies where-place-selected-open and where-theatres-selected-open scenarios", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { applyDevSeed } = await import("./devSeed");
    const { setDevTransportHandler } = await import("@/lib/devTransport");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");

    await applyDevSeed("where-place-selected-open");
    const placeState = useSeatfirstStore.getState();
    expect(placeState.wherePlace?.resolvedPlaceName).toContain("San Francisco");
    expect(placeState.whereFocused).toBe(true);
    expect(placeState.selectedTheatres.length).toBe(3);

    await applyDevSeed("where-theatres-selected-open");
    const theatreState = useSeatfirstStore.getState();
    expect(theatreState.wherePlace).toBeNull();
    expect(theatreState.whereFocused).toBe(true);
    expect(theatreState.selectedTheatres.length).toBe(2);
    setDevTransportHandler(null);
  });
});
