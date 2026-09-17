/**
 * Injected geocode seams for `searches.resolvePlace` (S51, ADR 0045 §1, §2)
 * and `searches.suggestPlace` (S52, ADR 0048 §S51-D8/§S51-D9).
 *
 * Both seams wrap a tRPC query and expose a narrow, injectable interface.
 * The geocoded coordinate is request-scoped on the server and never
 * appears in this module's types, storage, or return values — only the
 * resolved theatre set, transient distances, labels, exclusion counts, and
 * suggestion display labels are surfaced (ADR 0045 §1: never store, hash,
 * or return the coordinate; the place chip's display label comes from
 * `resolvedPlaceName`, the user's own query + radius `label`, or a
 * suggestion candidate's `label` — never a raw coordinate).
 */
import type {
  ResolvePlaceInput,
  ResolvePlaceResponse,
  SuggestPlaceInput,
  SuggestPlaceResponse,
} from "@seatfirst/core";

import { trpcClient } from "./trpc";

// ----- Result types (client seam) -----

export type GeocodeTheatreHit = {
  theatreId: string;
  distanceKm: number;
  /** Catalogue display name — the place-panel row's only name source. */
  name: string;
  city: string | null;
};

export type GeocodeSuccess = {
  theatres: GeocodeTheatreHit[];
  label: string;
  excluded: { outsideArea: number; byLimit: number };
  /** Mapbox-resolved display name (S52 §S51-D9) — shown on the committed chip. */
  resolvedPlaceName: string;
};

export type GeocodeNotFound = { kind: "PLACE_NOT_FOUND" };
export type GeocodeUnavailable = { kind: "PLACE_RESOLUTION_UNAVAILABLE" };

export type GeocodeResult = GeocodeSuccess | GeocodeNotFound | GeocodeUnavailable;

// ----- Injected interface -----

/**
 * Injected resolver for typed-place → theatre LIST resolution.
 *
 * Implementations must never store, hash, or return the geocoded
 * coordinate — only the theatre set + label + distances.
 */
export interface GeocodeResolver {
  resolvePlace(query: string, radiusKm: number, limit: number): Promise<GeocodeResult>;
}

// ----- tRPC-backed implementation -----

export type TrpcResolvePlaceClient = {
  searches: {
    resolvePlace: {
      query: (input: ResolvePlaceInput) => Promise<ResolvePlaceResponse>;
    };
  };
};

export type CreateGeocodeResolverOptions = {
  /** Catalogue provider, e.g. "amc". Not sent to Mapbox. */
  providerId: string;
  /** Vanilla tRPC client; defaults to the app's `trpcClient`. */
  client?: TrpcResolvePlaceClient;
};

/**
 * Create a `GeocodeResolver` backed by `searches.resolvePlace`.
 *
 * Maps the server's discriminated `ResolvePlaceResponse` to the seam's
 * `GeocodeResult` and maps any transport / tRPC error to
 * `PLACE_RESOLUTION_UNAVAILABLE` — never to `PLACE_NOT_FOUND`.
 * No coordinate is stored, hashed, or returned.
 */
export function createGeocodeResolver(options: CreateGeocodeResolverOptions): GeocodeResolver {
  const client = options.client ?? trpcClient;
  const providerId = options.providerId;

  return {
    async resolvePlace(query: string, radiusKm: number, limit: number): Promise<GeocodeResult> {
      let response: ResolvePlaceResponse;
      try {
        response = await client.searches.resolvePlace.query({
          providerId,
          query,
          radiusKm,
          limit,
        });
      } catch {
        // Transport / tRPC failure is PLACE_RESOLUTION_UNAVAILABLE, never PLACE_NOT_FOUND.
        return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
      }
      if (response.kind === "PLACE_NOT_FOUND") {
        return { kind: "PLACE_NOT_FOUND" };
      }
      if (response.kind === "PLACE_RESOLUTION_UNAVAILABLE") {
        return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
      }

      // kind === "ok" — return only the theatre set, label, resolved name, and excluded counts.
      return {
        theatres: response.theatres,
        label: response.label,
        resolvedPlaceName: response.resolvedPlaceName,
        excluded: response.excluded,
      };
    },
  };
}

// ----- Test double -----

export type StubGeocodeResolver = GeocodeResolver & {
  /** Ordered call history for assertions. */
  readonly calls: ReadonlyArray<{ query: string; radiusKm: number; limit: number }>;
  /** Queue a result to be returned on the next `resolvePlace` call (FIFO). */
  queueResult(result: GeocodeResult): void;
  /** Convenience: queue a successful LIST result. */
  queueSuccess(result: GeocodeSuccess): void;
  /** Convenience: queue a PLACE_NOT_FOUND. */
  queueNotFound(): void;
  /** Convenience: queue a PLACE_RESOLUTION_UNAVAILABLE. */
  queueUnavailable(): void;
  /** Clear history and queue. */
  reset(): void;
};

/**
 * Create an in-memory stub for component tests.
 *
 * The stub never stores or returns a coordinate. If no queued result is
 * available and no `defaultResult` was provided, it throws so tests fail
 * explicitly rather than silently producing a default.
 */
export function createStubGeocodeResolver(defaultResult?: GeocodeResult): StubGeocodeResolver {
  const calls: { query: string; radiusKm: number; limit: number }[] = [];
  const queue: GeocodeResult[] = [];
  let fallback: GeocodeResult | undefined = defaultResult;

  const resolver: StubGeocodeResolver = {
    get calls(): ReadonlyArray<{ query: string; radiusKm: number; limit: number }> {
      return calls;
    },

    queueResult(result: GeocodeResult): void {
      queue.push(result);
    },

    queueSuccess(result: GeocodeSuccess): void {
      queue.push(result);
    },

    queueNotFound(): void {
      queue.push({ kind: "PLACE_NOT_FOUND" });
    },

    queueUnavailable(): void {
      queue.push({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    },

    reset(): void {
      calls.length = 0;
      queue.length = 0;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async resolvePlace(query: string, radiusKm: number, limit: number): Promise<GeocodeResult> {
      calls.push({ query, radiusKm, limit });
      const next = queue.shift() ?? fallback;
      if (next === undefined) {
        throw new Error(
          "createStubGeocodeResolver: no queued result and no defaultResult — call queueSuccess/queueNotFound/queueUnavailable first",
        );
      }
      return next;
    },
  };

  // Allow tests to override fallback after construction.
  Object.defineProperty(resolver, "_setFallback", {
    value: (r: GeocodeResult | undefined) => {
      fallback = r;
    },
    enumerable: false,
  });

  return resolver;
}

// ----- Suggest-place result types (client seam) -----

/** A single suggestion — a Mapbox display label, never a coordinate. */
export type SuggestCandidate = { label: string };

export type SuggestCandidates = { candidates: SuggestCandidate[] };
export type SuggestUnavailable = { kind: "PLACE_RESOLUTION_UNAVAILABLE" };

export type SuggestResult = SuggestCandidates | SuggestUnavailable;

// ----- Injected interface -----

/**
 * Injected resolver for typed-place-prefix → suggestion LIST resolution
 * (S52, ADR 0048 §S51-D8). Never returns or stores a coordinate — only
 * display labels. An empty candidate list is a valid result, not an error.
 */
export interface SuggestPlaceResolver {
  suggestPlace(query: string): Promise<SuggestResult>;
}

// ----- tRPC-backed implementation -----

export type TrpcSuggestPlaceClient = {
  searches: {
    suggestPlace: {
      query: (input: SuggestPlaceInput) => Promise<SuggestPlaceResponse>;
    };
  };
};

export type CreateSuggestPlaceResolverOptions = {
  /** Catalogue provider, e.g. "amc". Not sent to Mapbox. */
  providerId: string;
  /** Vanilla tRPC client; defaults to the app's `trpcClient`. */
  client?: TrpcSuggestPlaceClient;
};

/**
 * Create a `SuggestPlaceResolver` backed by `searches.suggestPlace`.
 *
 * Maps the server's discriminated `SuggestPlaceResponse` to the seam's
 * `SuggestResult` and maps any transport / tRPC error to
 * `PLACE_RESOLUTION_UNAVAILABLE` — the same mapping `createGeocodeResolver`
 * uses. No coordinate is requested or returned.
 */
export function createSuggestPlaceResolver(
  options: CreateSuggestPlaceResolverOptions,
): SuggestPlaceResolver {
  const client: TrpcSuggestPlaceClient = options.client ?? trpcClient;
  const providerId = options.providerId;

  return {
    async suggestPlace(query: string): Promise<SuggestResult> {
      let response: SuggestPlaceResponse;
      try {
        response = await client.searches.suggestPlace.query({ providerId, query });
      } catch {
        // Transport / tRPC failure is PLACE_RESOLUTION_UNAVAILABLE.
        return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
      }
      if ("candidates" in response) {
        return { candidates: response.candidates };
      }
      return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
    },
  };
}

// ----- Test double -----

export type StubSuggestPlaceResolver = SuggestPlaceResolver & {
  /** Ordered call history for assertions. */
  readonly calls: ReadonlyArray<{ query: string }>;
  /** Queue a result to be returned on the next `suggestPlace` call (FIFO). */
  queueResult(result: SuggestResult): void;
  /** Convenience: queue a successful candidate list from plain labels. */
  queueCandidates(labels: readonly string[]): void;
  /** Convenience: queue a successful empty candidate list ("no suggestions yet"). */
  queueEmpty(): void;
  /** Convenience: queue a PLACE_RESOLUTION_UNAVAILABLE. */
  queueUnavailable(): void;
  /** Clear history and queue. */
  reset(): void;
};

/**
 * Create an in-memory stub for component tests.
 *
 * The stub never stores or returns a coordinate. If no queued result is
 * available and no `defaultResult` was provided, it throws so tests fail
 * explicitly rather than silently producing a default.
 */
export function createStubSuggestPlaceResolver(
  defaultResult?: SuggestResult,
): StubSuggestPlaceResolver {
  const calls: { query: string }[] = [];
  const queue: SuggestResult[] = [];
  let fallback: SuggestResult | undefined = defaultResult;

  const resolver: StubSuggestPlaceResolver = {
    get calls(): ReadonlyArray<{ query: string }> {
      return calls;
    },

    queueResult(result: SuggestResult): void {
      queue.push(result);
    },

    queueCandidates(labels: readonly string[]): void {
      queue.push({ candidates: labels.map((label) => ({ label })) });
    },

    queueEmpty(): void {
      queue.push({ candidates: [] });
    },

    queueUnavailable(): void {
      queue.push({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    },

    reset(): void {
      calls.length = 0;
      queue.length = 0;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async suggestPlace(query: string): Promise<SuggestResult> {
      calls.push({ query });
      const next = queue.shift() ?? fallback;
      if (next === undefined) {
        throw new Error(
          "createStubSuggestPlaceResolver: no queued result and no defaultResult — call queueCandidates/queueEmpty/queueUnavailable first",
        );
      }
      return next;
    },
  };

  // Allow tests to override fallback after construction.
  Object.defineProperty(resolver, "_setFallback", {
    value: (r: SuggestResult | undefined) => {
      fallback = r;
    },
    enumerable: false,
  });

  return resolver;
}
