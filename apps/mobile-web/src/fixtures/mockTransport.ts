/**
 * Named API profiles for the dev transport seam.
 *
 * A profile answers the procedures the search form calls, so you can render a loading
 * spinner, an error string, or a particular facet-count reading without a backend and
 * without touching a component. Anything a profile does not name falls through to the
 * network unchanged.
 *
 * Scope: the read-side procedures the form depends on, plus `searches.create` for the
 * admission-rejected CTA and the ADR 0054 capacity-gate rejection. The search lifecycle
 * itself (`searches.onProgress` SSE, `searches.get`) is deliberately not mocked —
 * `scenarios.ts` seeds terminal result screens directly into the store, which is simpler
 * than simulating a stream.
 */
import type { FacetCountsInput } from "@seatfirst/core";
import { CAPACITY_CEILING_EXCEEDED, DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import type { DevTransportHandler, DevTransportResult } from "@/lib/devTransport";
import {
  makeFacetCountsResponse,
  makeResolvePlaceOk,
  makeSessionBootstrap,
  makeSuggestPlaceCandidates,
  makeTheatreMoviesResponse,
  makeTheatreSearchResponse,
  type FacetMode,
} from "./apiFixtures";

export const API_PROFILE_NAMES = [
  "happy",
  "theatre-search-loading",
  "theatre-search-empty",
  "theatre-search-error",
  "movies-loading",
  "movies-error",
  "movies-empty",
  "facets-partial",
  "facets-cold",
  "facets-warm-zero",
  "capacity-blocked",
  "place-not-found",
  "place-unavailable",
  "admission-rejected",
  "offline",
] as const;

export type ApiProfileName = (typeof API_PROFILE_NAMES)[number];

export interface ApiProfile {
  readonly name: ApiProfileName;
  readonly label: string;
}

export const API_PROFILES: readonly ApiProfile[] = [
  { name: "happy", label: "API: healthy" },
  { name: "theatre-search-loading", label: "API: theatre search loading" },
  { name: "theatre-search-empty", label: "API: theatre search empty" },
  { name: "theatre-search-error", label: "API: theatre search error" },
  { name: "movies-loading", label: "API: movies loading" },
  { name: "movies-error", label: "API: movies error" },
  { name: "movies-empty", label: "API: no movies playing" },
  { name: "facets-partial", label: "API: facet counts partial (N+)" },
  { name: "facets-cold", label: "API: facet counts cold" },
  { name: "facets-warm-zero", label: "API: facet counts warm zero" },
  { name: "capacity-blocked", label: "API: capacity ceiling exceeded" },
  { name: "place-not-found", label: "API: place not found" },
  { name: "place-unavailable", label: "API: place lookup unavailable" },
  { name: "admission-rejected", label: "API: admission rejected" },
  { name: "offline", label: "API: everything fails" },
];

export function isApiProfileName(value: string): value is ApiProfileName {
  return (API_PROFILE_NAMES as readonly string[]).includes(value);
}

function data(value: unknown, delayMs?: number): DevTransportResult {
  return delayMs === undefined
    ? { kind: "data", data: value }
    : { kind: "data", data: value, delayMs };
}

function isFacetInput(input: unknown): input is FacetCountsInput {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as { theatreIds?: unknown; axes?: unknown };
  return Array.isArray(candidate.theatreIds) && Array.isArray(candidate.axes);
}

function moviesInputRange(input: unknown): { theatreId?: string; from?: string; to?: string } {
  if (typeof input !== "object" || input === null) return {};
  const candidate = input as { theatreId?: unknown; from?: unknown; to?: unknown };
  return {
    ...(typeof candidate.theatreId === "string" ? { theatreId: candidate.theatreId } : {}),
    ...(typeof candidate.from === "string" ? { from: candidate.from } : {}),
    ...(typeof candidate.to === "string" ? { to: candidate.to } : {}),
  };
}

function placeInput(input: unknown): { query: string; radiusKm?: number } | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as { query?: unknown; radiusKm?: unknown };
  if (typeof candidate.query !== "string") return null;
  return {
    query: candidate.query,
    ...(typeof candidate.radiusKm === "number" ? { radiusKm: candidate.radiusKm } : {}),
  };
}

function suggestionLabels(query: string): readonly string[] {
  const prefix = query.trim().toLowerCase();
  if (prefix.startsWith("sun")) {
    return ["Sunnyvale, California, United States"];
  }
  if (prefix.startsWith("san")) {
    return [
      "San Francisco, CA, United States",
      "San Jose, California, United States",
      "San Mateo, California, United States",
    ];
  }
  if (prefix.startsWith("mountain")) {
    return ["Mountain View, California, United States"];
  }
  return [];
}

function resolvedPlaceName(query: string): string {
  const normalized = query.trim().toLowerCase();
  if (normalized.startsWith("sun")) return "Sunnyvale, California, United States";
  if (normalized.startsWith("san fran")) return "San Francisco, CA, United States";
  if (normalized.startsWith("san jose")) return "San Jose, California, United States";
  if (normalized.startsWith("san mateo")) return "San Mateo, California, United States";
  if (normalized.startsWith("mountain")) return "Mountain View, California, United States";
  return query.trim();
}

/** The baseline every profile starts from: a healthy backend with a stocked catalogue. */
function happyResponse(
  op: { path: string; input: unknown },
  facetMode: FacetMode,
): DevTransportResult | null {
  switch (op.path) {
    case "session.bootstrap":
      return data(makeSessionBootstrap());
    case "theatres.search":
      return data(makeTheatreSearchResponse(), 120);
    case "theatres.movies":
      // Echo the requested theatre and date range so the client's own cache keys line up.
      return data(makeTheatreMoviesResponse(moviesInputRange(op.input)), 150);
    case "searches.facetCounts":
      return isFacetInput(op.input) ? data(makeFacetCountsResponse(op.input, facetMode), 80) : null;
    case "searches.suggestPlace": {
      const input = placeInput(op.input);
      return input ? data(makeSuggestPlaceCandidates(suggestionLabels(input.query)), 80) : null;
    }
    case "searches.resolvePlace": {
      const input = placeInput(op.input);
      return input && input.radiusKm !== undefined
        ? data(
            makeResolvePlaceOk({
              query: input.query,
              radiusKm: input.radiusKm,
              resolvedPlaceName: resolvedPlaceName(input.query),
            }),
            80,
          )
        : null;
    }
    default:
      return null;
  }
}

/**
 * `retryAfterSeconds` is arbitrary mock data. The contract is explicit that this figure
 * is caller-supplied and fixed by no accepted document, so nothing should read a policy
 * into the number here.
 */
const ADMISSION_REJECTED: DevTransportResult = {
  kind: "error",
  code: "ADMISSION_REJECTED",
  message: "Too many searches in flight",
  extras: { retryAfterSeconds: 30 },
};

export function createApiHandler(profile: ApiProfileName): DevTransportHandler {
  return (op) => {
    if (profile === "offline") {
      return { kind: "error", code: "INTERNAL_SERVER_ERROR", message: "Mocked backend is offline" };
    }

    switch (profile) {
      case "theatre-search-loading":
        if (op.path === "theatres.search") return { kind: "pending" };
        break;
      case "theatre-search-empty":
        if (op.path === "theatres.search") return data({ theatres: [] });
        break;
      case "theatre-search-error":
        if (op.path === "theatres.search") {
          return {
            kind: "error",
            code: "INTERNAL_SERVER_ERROR",
            message: "Theatre search is temporarily unavailable",
          };
        }
        break;
      case "movies-loading":
        if (op.path === "theatres.movies") return { kind: "pending" };
        break;
      case "movies-error":
        if (op.path === "theatres.movies") {
          return { kind: "error", code: "NOT_FOUND", message: "Theatre not found" };
        }
        break;
      case "movies-empty":
        if (op.path === "theatres.movies") {
          return data(makeTheatreMoviesResponse({ ...moviesInputRange(op.input), movies: [] }));
        }
        break;
      case "capacity-blocked":
        // ADR 0054: the submit flow calls `create` directly — the ceiling rejection
        // arrives as a structured create error, read via readTrpcErrorExtras.
        if (op.path === "searches.create")
          return {
            kind: "error",
            code: CAPACITY_CEILING_EXCEEDED,
            message: "Capacity ceiling exceeded",
            extras: {
              matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 137,
              limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
            },
            delayMs: 250,
          };
        break;
      case "admission-rejected":
        if (op.path === "searches.create") return ADMISSION_REJECTED;
        break;
      case "place-not-found":
        if (op.path === "searches.resolvePlace") return data({ kind: "PLACE_NOT_FOUND" }, 80);
        break;
      case "place-unavailable":
        if (op.path === "searches.suggestPlace" || op.path === "searches.resolvePlace") {
          return data({ kind: "PLACE_RESOLUTION_UNAVAILABLE" }, 80);
        }
        break;
      case "happy":
      case "facets-partial":
      case "facets-cold":
      case "facets-warm-zero":
        break;
    }

    const facetMode: FacetMode =
      profile === "facets-partial"
        ? "partial"
        : profile === "facets-cold"
          ? "cold"
          : profile === "facets-warm-zero"
            ? "warm-zero"
            : "warm";

    return happyResponse(op, facetMode);
  };
}
