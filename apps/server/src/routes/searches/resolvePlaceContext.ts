import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { SessionRateLimitConfig, SessionRateLimiter } from "../../session/limiter.js";

import type { GeocodeMemo } from "../../geocode/memo.js";
import type { GeocodeResolver, ResolvedPlace } from "../../geocode/resolver.js";

export interface ResolvePlaceContext {
  readonly db: Pool;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly sessionId: string | undefined;
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<ResolvedPlace>;
  readonly logger: SeatfirstLogger;
}

export interface CreateResolvePlaceContextOptions {
  readonly db: Pool;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly resolver: GeocodeResolver;
  readonly memo: GeocodeMemo<ResolvedPlace>;
}

export function createResolvePlaceContextFactory(
  opts: CreateResolvePlaceContextOptions,
): (req: FastifyRequest) => ResolvePlaceContext {
  const { db, rateLimitConfig, limiter, resolver, memo } = opts;
  return (req) => {
    const session = req.session;
    return {
      db,
      rateLimitConfig,
      limiter,
      sessionId: session === null ? undefined : session.sessionId,
      resolver,
      memo,
      logger: req.log,
    };
  };
}
