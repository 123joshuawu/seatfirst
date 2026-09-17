/**
 * Geocode rate limiter (S51, ADR 0045 §2a): a continuous-refill token bucket
 * of capacity 750, refilling 12.5 tokens/second (750/minute).
 *
 * Source: Mapbox Geocoding v6 docs currently publish a default temporary-
 * geocoding limit of 1,000 requests/minute per token (may vary per token);
 * see https://docs.mapbox.com/api/search/geocoding/ . This bucket applies a
 * 25% safety margin below that published default (750 = 1,000 × 0.75,
 * 12.5/s = 750/60), mirroring the ADR 0019 decision 3 discipline used by
 * `apps/server/src/tmdb/token-bucket.ts:2-8` — a configurable rate would let
 * a deployment silently violate the pinned limit. The exact provisioned
 * token's account limit is operator-verified at implementation time (ADR 0045
 * "Approved integration values").
 *
 * These two numbers are authoritative and hard-coded: they are ADR-pinned
 * literals, NOT injected gate-14 tunables. Only the clock and sleep are
 * injectable so the refill arithmetic is unit-testable without real timers;
 * the capacity/refill are never overridden.
 */

export const GEOCODE_TOKEN_BUCKET_CAPACITY = 750;
export const GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND = 12.5;

export interface GeocodeTokenBucket {
  /** Resolves once a token is available, waiting for continuous refill as needed. */
  acquire(): Promise<void>;
}

/** Back-compat alias for consumers that import `TokenBucket` by the tmdb name. */
export type TokenBucket = GeocodeTokenBucket;

export interface GeocodeTokenBucketDeps {
  /** Epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sleep for a non-negative millisecond count; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createGeocodeTokenBucket(deps: GeocodeTokenBucketDeps = {}): GeocodeTokenBucket {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let tokens = GEOCODE_TOKEN_BUCKET_CAPACITY;
  let lastRefillMs = now();

  async function acquire(): Promise<void> {
    for (;;) {
      const t = now();
      const elapsedMs = t - lastRefillMs;
      tokens = Math.min(
        GEOCODE_TOKEN_BUCKET_CAPACITY,
        tokens + (elapsedMs / 1000) * GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND,
      );
      lastRefillMs = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const deficit = 1 - tokens;
      const waitMs = (deficit / GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND) * 1000;
      await sleep(waitMs);
    }
  }

  return { acquire };
}

/** Alias matching the tmdb factory name for callers that generically expect `createTokenBucket`. */
export const createTokenBucket = createGeocodeTokenBucket;
