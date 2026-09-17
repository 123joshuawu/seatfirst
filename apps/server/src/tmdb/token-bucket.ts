/**
 * The TMDB rate limiter (S25.5, ADR 0019 amendment decision 3): a continuous-refill token
 * bucket of capacity 30, refilling 30 tokens/second (~1 token every 33.3ms) — a 25% margin
 * below ADR 0019's own "~40 requests/sec" estimate.
 *
 * These two numbers are authoritative and hard-coded: they are ADR-pinned literals, NOT
 * injected gate-14 tunables (a configurable rate would let a deployment silently violate
 * the pinned limit — the same hard-coding discipline S26 applies to its ADR-0022 cadence).
 * Only the clock and sleep are injectable so the refill arithmetic is unit-testable without
 * real timers; the capacity/refill are never overridden.
 */

export const TMDB_TOKEN_BUCKET_CAPACITY = 30;
export const TMDB_TOKEN_BUCKET_REFILL_PER_SECOND = 30;

export interface TokenBucket {
  /** Resolves once a token is available, waiting for continuous refill as needed. */
  acquire(): Promise<void>;
}

export interface TokenBucketDeps {
  /** Epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sleep for a non-negative millisecond count; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createTokenBucket(deps: TokenBucketDeps = {}): TokenBucket {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let tokens = TMDB_TOKEN_BUCKET_CAPACITY;
  let lastRefillMs = now();

  async function acquire(): Promise<void> {
    for (;;) {
      const t = now();
      const elapsedMs = t - lastRefillMs;
      tokens = Math.min(
        TMDB_TOKEN_BUCKET_CAPACITY,
        tokens + (elapsedMs / 1000) * TMDB_TOKEN_BUCKET_REFILL_PER_SECOND,
      );
      lastRefillMs = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const deficit = 1 - tokens;
      const waitMs = (deficit / TMDB_TOKEN_BUCKET_REFILL_PER_SECOND) * 1000;
      await sleep(waitMs);
    }
  }

  return { acquire };
}
