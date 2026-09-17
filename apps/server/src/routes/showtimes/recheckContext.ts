import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { RecoveryOption } from "@seatfirst/core";

import type { SessionRateLimiter } from "../../session/limiter.js";

/**
 * S22.12 — the GONE recovery-ladder seam. The four-level ladder is answer-assembly
 * territory (`docs/seatfirst-architecture.md:151,385-392`), deliberately unlanded in S22;
 * the route consumes an injected seam with NO default implementation (the exact S8.9
 * rule) so a deployment omitting it fails at wiring time, never by returning a fake
 * ladder before the assembler exists.
 */
export type RecoverySeam = (input: {
  readonly searchId: string;
  readonly showtimeId: string;
  readonly placementKey: string;
}) => Promise<readonly RecoveryOption[]>;

/**
 * `showtimes.recheck` context (S22.8) — the single-flight recheck route's per-request
 * surface. Every policy-relevant figure is a REQUIRED factory parameter (gate 14):
 * - `nonceSecret`: the HMAC key for the stateless recheck nonce (ADR 0017) — same
 *   injection posture as the session-cookie secret (`session/cookie.ts`), never in repo.
 * - `deadlineMs`: the 30 s recheck deadline (ADR 0006 §A.2, `:213-220`) — cited, injected.
 * - `recovery`: the GONE ladder seam (S22.12), no default.
 * - `limiter`: S16's session limiter, already carrying the `recheck` dimension (S16).
 */
export interface RecheckContext {
  readonly sessionId: string | undefined;
  readonly db: Pool;
  readonly limiter: SessionRateLimiter;
  readonly nonceSecret: string;
  readonly deadlineMs: number;
  readonly recovery: RecoverySeam;
  /**
   * O11.5/O11.8 — the request-scoped Fastify logger (`req.log`, already child'd
   * with the ULID requestId by the app's `onRequest` hook, O5.3). The recheck
   * procedure's fail-open Redis catch and the bespoke route handler's error
   * serialization log through it, so those lines carry request identity and ride
   * the OTel log bridge — the handler itself never receives the request.
   */
  readonly logger: SeatfirstLogger;
}

export interface RecheckContextOptions {
  readonly db: Pool;
  readonly limiter: SessionRateLimiter;
  readonly nonceSecret: string;
  readonly deadlineMs: number;
  readonly recovery: RecoverySeam;
}

export function createRecheckContextFactory(
  opts: RecheckContextOptions,
): (req: FastifyRequest) => RecheckContext {
  const { db, limiter, nonceSecret, deadlineMs, recovery } = opts;
  return (req) => {
    const session = req.session;
    return {
      sessionId: session === null ? undefined : session.sessionId,
      db,
      limiter,
      nonceSecret,
      deadlineMs,
      recovery,
      logger: req.log,
    };
  };
}
