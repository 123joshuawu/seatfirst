import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { SearchLimits } from "@seatfirst/core";

import type { GeocodeMemo } from "../../geocode/memo.js";
import type { GeocodeResolver, ResolvedPlace, SuggestCandidate } from "../../geocode/resolver.js";
import type { SessionRateLimitConfig, SessionRateLimiter } from "../../session/limiter.js";
/**
 * `searches.create` context (S15) — the sibling of S12's `SearchStreamContext`, split
 * deliberately: `create` needs the writable pool and the injected admission tunables,
 * none of which the SSE transport's context carries (and vice versa — the two routers
 * build against their own context-typed tRPC instances, see `create.ts`/`router.ts`).
 *
 * Every policy-relevant figure is a REQUIRED factory parameter — no defaults, per the
 * convention every task in this ADR's scope follows (gate 14):
 * - `limits`: the configurable v1 throttle, passed through to `validateSearchSpecV1`.
 *   The test harness supplies `DEFAULT_SEARCH_LIMITS` explicitly (S15.1: injected, not
 *   hardcoded in the route).
 * - `freshnessMs`: the ADR 0006 §A.1 showtimes freshness ceiling (≤ 10 minutes,
 *   `docs/adr/0006-capacity-cost-model-numeric-acceptance-criteria.md:188`), compared in
 *   `readCachedSchedule` (S15.4).
 * - `retryAfterSeconds`: the 429 `Retry-After` figure. NO accepted document fixes a
 *   number for it (S15.9: a reported finding, not a chosen default) — the factory has no
 *   fallback so a deployment that omits it fails at wiring time, never at request time.
 * - `rateLimitConfig` + `limiter`: S16.13's session rate checks, injected (ADR 0006
 *   §A.6's values, gate 14).
 */
export interface SearchCreateContext {
  /**
   * The caller's session id from the S16.16 plugin's decorated request — captured,
   * never defaulted or fabricated (S16.12). `undefined` when no valid signed cookie was
   * presented; the procedure fails closed on it, because `search.session_id` is NOT
   * NULL and inventing an id is exactly what S15.2 forbids.
   */
  readonly sessionId: string | undefined;
  /** The extracted client IP (S16.7) — consumed ONLY for S16.9's Redis breach keys. */
  readonly clientIp: string | undefined;
  /** The derived ASN (S16.8) — same only-consumer rule. */
  readonly asn: string | undefined;
  readonly db: Pool;
  readonly limits: SearchLimits;
  readonly freshnessMs: number;
  readonly retryAfterSeconds: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  /**
   * O11.5/O11.6/O11.8 — the request-scoped Fastify logger (`req.log`, already
   * child'd with the ULID requestId by the app's `onRequest` hook, O5.3). The
   * fail-open Redis catches in `searches.create` and the `theatres.movies`
   * extension log through it, so those lines carry request identity and ride the
   * OTel log bridge like every other route's — no ad hoc per-request logger.
   */
  readonly logger: SeatfirstLogger;
  /**
   * S51 — geocode seam for `searches.resolvePlace` (ADR 0045 §2).
   * Injected resolver + session memo; only that route reads them.
   * S52 adds `suggestMemo` for `searches.suggestPlace` (ADR 0048).
   */
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<ResolvedPlace>;
  readonly suggestMemo: GeocodeMemo<readonly SuggestCandidate[]>;
  /**
   * S47 / ADR 0039 Amendment A3 + A2 seams — see
   * `capacityPreviewContext.ts` for the full contract. Optional: production never
   * sets them (the route falls back to the accepted `SEARCH_DEADLINE_MS` and its
   * engineering poll tick); only the test harness injects smaller values.
   */
  readonly capacityPreviewDeadlineMs?: number | undefined;
  readonly capacityPreviewPollIntervalMs?: number | undefined;
}

export interface CreateSearchCreateContextOptions {
  readonly db: Pool;
  readonly limits: SearchLimits;
  readonly freshnessMs: number;
  readonly retryAfterSeconds: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<ResolvedPlace>;
  readonly suggestMemo: GeocodeMemo<readonly SuggestCandidate[]>;
  readonly capacityPreviewDeadlineMs?: number | undefined;
  readonly capacityPreviewPollIntervalMs?: number | undefined;
}

/**
 * Builds the per-request context factory. The session comes from the S16.16 plugin's
 * `req.session` decoration (set by its onRequest hook — guaranteed present before any
 * route handler runs; `null` is only the pre-hook default). `res` is unused here (no
 * keepalive transport on a mutation), so the factory takes only `req` — the tRPC
 * adapter still supplies both.
 */
export function createSearchCreateContextFactory(
  opts: CreateSearchCreateContextOptions,
): (req: FastifyRequest) => SearchCreateContext {
  const {
    db,
    limits,
    freshnessMs,
    retryAfterSeconds,
    rateLimitConfig,
    limiter,
    resolver,
    memo,
    suggestMemo,
  } = opts;
  return (req) => {
    const session = req.session;
    return {
      sessionId: session === null ? undefined : session.sessionId,
      clientIp: session === null ? undefined : session.clientIp,
      asn: session === null ? undefined : session.asn,
      db,
      limits,
      freshnessMs,
      retryAfterSeconds,
      rateLimitConfig,
      limiter,
      logger: req.log,
      resolver,
      memo,
      suggestMemo,
      ...(opts.capacityPreviewDeadlineMs === undefined
        ? {}
        : { capacityPreviewDeadlineMs: opts.capacityPreviewDeadlineMs }),
      ...(opts.capacityPreviewPollIntervalMs === undefined
        ? {}
        : { capacityPreviewPollIntervalMs: opts.capacityPreviewPollIntervalMs }),
    };
  };
}
