/**
 * Mapbox Geocoding v6 forward client (S51, ADR 0045 §2a, S52/ADR 0048).
 * Host is a literal — not a gate-14 tunable — mirroring TMDB client pattern
 * (`apps/server/src/tmdb/client.ts:13`). Direct egress from server host to
 * Mapbox API (never relay, ADR 0045 §2). `fetch` is injectable for tests;
 * no live Mapbox call in any test. S52 adds `suggest` with
 * `autocomplete=true&limit=5` sharing the same bucket and host.
 */

import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { GeocodeResolver, ResolvedPlace, SuggestCandidate } from "./resolver.js";
import type { TokenBucket } from "./token-bucket.js";

// Like TMDB client host literal — single literal in this module, not tunable.
export const MAPBOX_API_BASE_URL = "https://api.mapbox.com";

export class GeocodeUnavailableError extends Error {
  constructor(message = "geocode unavailable") {
    super(message);
    this.name = "GeocodeUnavailableError";
  }
}

export interface MapboxGeocodeResolverDeps {
  readonly accessToken: string;
  readonly bucket: TokenBucket;
  readonly logger: SeatfirstLogger;
  readonly fetch?: typeof fetch;
}

const ACCEPTED_FEATURE_TYPES = new Set([
  "address",
  "street",
  "neighborhood",
  "postcode",
  "locality",
  "place",
  "district",
  "region",
]);
export function createMapboxGeocodeResolver(deps: MapboxGeocodeResolverDeps): GeocodeResolver {
  const fetchImpl = deps.fetch ?? fetch;

  return {
    async resolve(query: string): Promise<ResolvedPlace | null> {
      await deps.bucket.acquire();

      const url =
        `${MAPBOX_API_BASE_URL}/search/geocode/v6/forward` +
        `?q=${encodeURIComponent(query)}` +
        `&country=US&worldview=us&autocomplete=false&limit=1` +
        `&access_token=${encodeURIComponent(deps.accessToken)}`;

      let response: Response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      } catch (error: unknown) {
        // Never log query or coordinates (ADR 0045 §1).
        deps.logger.warn({ error }, "mapbox geocode request failed");
        throw new GeocodeUnavailableError();
      }

      if (!response.ok) {
        // 429 / 5xx and other non-ok map to PLACE_RESOLUTION_UNAVAILABLE.
        // Do not log query, coordinates, or URL (which contains query + token).
        deps.logger.warn({ status: response.status }, "mapbox geocode request failed");
        throw new GeocodeUnavailableError(`mapbox geocode responded ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error: unknown) {
        deps.logger.warn({ error }, "mapbox geocode malformed response");
        throw new GeocodeUnavailableError();
      }

      if (
        typeof body !== "object" ||
        body === null ||
        !("features" in body) ||
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- body is unknown, need narrowing check
        !Array.isArray((body as { features: unknown }).features)
      ) {
        throw new GeocodeUnavailableError();
      }

      const features = (body as { features: unknown[] }).features;
      if (features.length === 0) return null;

      const feature = features[0] as {
        properties?: { feature_type?: unknown; full_address?: unknown };
        geometry?: { coordinates?: unknown };
      };

      const featureType = feature?.properties?.feature_type;
      if (typeof featureType !== "string" || !ACCEPTED_FEATURE_TYPES.has(featureType)) {
        return null;
      }

      const coords = feature?.geometry?.coordinates;
      if (
        !Array.isArray(coords) ||
        coords.length < 2 ||
        typeof coords[0] !== "number" ||
        typeof coords[1] !== "number"
      ) {
        deps.logger.warn({}, "mapbox geocode malformed response");
        throw new GeocodeUnavailableError();
      }

      const lng = coords[0];
      const lat = coords[1];

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        deps.logger.warn({}, "mapbox geocode malformed response");
        throw new GeocodeUnavailableError();
      }

      const fullAddress = feature?.properties?.full_address;
      if (typeof fullAddress !== "string" || fullAddress.length === 0) {
        deps.logger.warn({}, "mapbox geocode malformed response");
        throw new GeocodeUnavailableError();
      }

      return { lat, lng, resolvedPlaceName: fullAddress };
    },

    async suggest(query: string): Promise<readonly SuggestCandidate[]> {
      await deps.bucket.acquire();

      const url =
        `${MAPBOX_API_BASE_URL}/search/geocode/v6/forward` +
        `?q=${encodeURIComponent(query)}` +
        `&country=US&worldview=us&autocomplete=true&limit=5` +
        `&access_token=${encodeURIComponent(deps.accessToken)}`;

      let response: Response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      } catch (error: unknown) {
        deps.logger.warn({ error }, "mapbox geocode request failed");
        throw new GeocodeUnavailableError();
      }

      if (!response.ok) {
        deps.logger.warn({ status: response.status }, "mapbox geocode request failed");
        throw new GeocodeUnavailableError(`mapbox geocode responded ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error: unknown) {
        deps.logger.warn({ error }, "mapbox geocode malformed response");
        throw new GeocodeUnavailableError();
      }

      if (
        typeof body !== "object" ||
        body === null ||
        !("features" in body) ||
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- body is unknown, need narrowing check
        !Array.isArray((body as { features: unknown }).features)
      ) {
        throw new GeocodeUnavailableError();
      }

      const features = (body as { features: unknown[] }).features;
      if (features.length === 0) return [];

      const candidates: SuggestCandidate[] = [];
      for (const raw of features) {
        const feature = raw as {
          properties?: { feature_type?: unknown; full_address?: unknown };
        };
        const featureType = feature?.properties?.feature_type;
        if (typeof featureType !== "string" || !ACCEPTED_FEATURE_TYPES.has(featureType)) {
          continue;
        }
        const fullAddress = feature?.properties?.full_address;
        if (typeof fullAddress !== "string" || fullAddress.length === 0) {
          continue;
        }
        candidates.push({ label: fullAddress });
        if (candidates.length >= 5) break;
      }
      return candidates;
    },
  };
}
