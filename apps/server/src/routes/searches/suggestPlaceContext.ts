import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { SessionRateLimitConfig, SessionRateLimiter } from "../../session/limiter.js";

import type { GeocodeMemo } from "../../geocode/memo.js";
import type { GeocodeResolver, SuggestCandidate } from "../../geocode/resolver.js";

export interface SuggestPlaceContext {
  readonly db: Pool;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly sessionId: string | undefined;
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<readonly SuggestCandidate[]>;
  readonly suggestMemo: GeocodeMemo<readonly SuggestCandidate[]>;
  readonly logger: SeatfirstLogger;
}

export interface CreateSuggestPlaceContextOptions {
  readonly db: Pool;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<readonly SuggestCandidate[]>;
  readonly suggestMemo?: GeocodeMemo<readonly SuggestCandidate[]>;
}

export function createSuggestPlaceContextFactory(
  opts: CreateSuggestPlaceContextOptions,
): (req: FastifyRequest) => SuggestPlaceContext {
  const { db, rateLimitConfig, limiter, resolver, memo } = opts;
  const suggestMemo = opts.suggestMemo ?? memo;
  return (req) => {
    const session = req.session;
    return {
      db,
      rateLimitConfig,
      limiter,
      sessionId: session === null ? undefined : session.sessionId,
      resolver,
      memo: suggestMemo,
      suggestMemo,
      logger: req.log,
    };
  };
}
