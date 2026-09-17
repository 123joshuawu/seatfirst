import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SessionRateLimitConfig, SessionRateLimiter } from "../../session/limiter.js";

export interface FacetCountsContext {
  readonly db: Pool;
  readonly freshnessMs: number;
  readonly maxCandidatesPerRequest: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly sessionId: string | undefined;
}

export interface CreateFacetCountsContextOptions {
  readonly db: Pool;
  readonly freshnessMs: number;
  readonly maxCandidatesPerRequest: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
}

export function createFacetCountsContextFactory(
  opts: CreateFacetCountsContextOptions,
): (req: FastifyRequest) => FacetCountsContext {
  const { db, freshnessMs, maxCandidatesPerRequest, rateLimitConfig, limiter } = opts;
  return (req) => {
    const session = req.session;
    return {
      db,
      freshnessMs,
      maxCandidatesPerRequest,
      rateLimitConfig,
      limiter,
      sessionId: session === null ? undefined : session.sessionId,
    };
  };
}
