import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { SearchLimits } from "@seatfirst/core";

import type { SessionRateLimitConfig, SessionRateLimiter } from "../../session/limiter.js";

/**
 * `searches.capacityPreview` context (S47; ADR 0039 decision 3 + Amendment) — the
 * fields the preview needs on top of what `SearchCreateContext` already carries. The
 * production route is registered against the router's `SearchCreateContext` (the same
 * arrangement as `facetCounts`), with the two timing seams below threaded through
 * `createSearchCreateContextFactory`:
 *
 * - `capacityPreviewDeadlineMs` — Amendment A3's resolution wait budget. Production
 *   value is `SEARCH_DEADLINE_MS` (the accepted 120 s search hard deadline, ADR 0006
 *   §A.2), imported and reused — never a new number. Optional ONLY as a test seam
 *   (`TEST_*` injection precedent); a deployment that omits it gets the accepted
 *   constant.
 * - `capacityPreviewPollIntervalMs` — how often the wait loop re-reads the schedule
 *   cache while cold dates resolve. An engineering cadence, not a policy number;
 *   same optional-test-seam posture.
 */
export interface CapacityPreviewContext {
  readonly sessionId: string | undefined;
  readonly db: Pool;
  readonly limits: SearchLimits;
  readonly freshnessMs: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly logger: SeatfirstLogger;
  readonly capacityPreviewDeadlineMs?: number | undefined;
  readonly capacityPreviewPollIntervalMs?: number | undefined;
}

export interface CreateCapacityPreviewContextOptions {
  readonly db: Pool;
  readonly limits: SearchLimits;
  readonly freshnessMs: number;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly limiter: SessionRateLimiter;
  readonly capacityPreviewDeadlineMs?: number | undefined;
  readonly capacityPreviewPollIntervalMs?: number | undefined;
}

export function createCapacityPreviewContextFactory(
  opts: CreateCapacityPreviewContextOptions,
): (req: FastifyRequest) => CapacityPreviewContext {
  const {
    db,
    limits,
    freshnessMs,
    rateLimitConfig,
    limiter,
    capacityPreviewDeadlineMs,
    capacityPreviewPollIntervalMs,
  } = opts;
  return (req) => {
    const session = req.session;
    return {
      sessionId: session === null ? undefined : session.sessionId,
      db,
      limits,
      freshnessMs,
      rateLimitConfig,
      limiter,
      logger: req.log,
      ...(capacityPreviewDeadlineMs === undefined ? {} : { capacityPreviewDeadlineMs }),
      ...(capacityPreviewPollIntervalMs === undefined ? {} : { capacityPreviewPollIntervalMs }),
    };
  };
}
