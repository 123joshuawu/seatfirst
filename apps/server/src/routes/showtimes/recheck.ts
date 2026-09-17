import {
  initTRPC,
  TRPCError,
  type TRPCDefaultErrorShape,
  type TRPCErrorFormatter,
} from "@trpc/server";

import {
  RateLimitErrorSchema,
  RecheckInputSchema,
  RecheckResultSchema,
  SearchSpecSchema,
} from "@seatfirst/core";
import type { Placement, RecheckResult } from "@seatfirst/core";
import {
  NonceReplayError,
  poolClient,
  readRecheckOutcome,
  stageRecheckRun,
  withTransaction,
} from "@seatfirst/durability";
import type { RecheckOutcomeRow } from "@seatfirst/durability";

import { findSearchById } from "../../dispatch/queries.js";
import { verifyRecheckNonce } from "../../session/nonce.js";
import type { RecheckNonce } from "../../session/nonce.js";
import { assertCallerOwnsSearch } from "../../streaming/ownership.js";
import { readLatestSearchResultVersion } from "../../streaming/queries.js";
import { StructuredHttpError } from "../searches/create.js";

import type { RecheckContext } from "./recheckContext.js";
import { findTerminalPlacement } from "./terminal-placement.js";
import type { TerminalPlacement } from "./terminal-placement.js";

/**
 * `showtimes.recheck` — the single-flight recheck route (S22.8). One fresh browser
 * navigation through the capacity-1 provider fetch actor, run as a `RECHECK` class with
 * the decided priority ordering, bounded by the 30 s deadline, rate-limited by S16's
 * `recheck` dimension, and guarded by a single-use HMAC-signed nonce (ADR 0017).
 *
 * The procedure returns the three-branch `RecheckResultSchema` itself (not a 202): the
 * architecture's wire contract is the `RecheckResult`, and the 30 s deadline is sized to
 * cover navigation + cleanup + dispatch, so the call awaits the full cycle (S22.11).
 */

/* --------------------------------------------------------- structured error handling */

/**
 * The recheck route's own error formatter: the 429 body carries `RateLimitErrorSchema`
 * (S22.10), the one structured body this route emits — the same `StructuredHttpError`
 * shape `searches.create` established (S15.10).
 */
const errorFormatter: TRPCErrorFormatter<RecheckContext, TRPCDefaultErrorShape> = ({
  shape,
  error,
}) => {
  if (error instanceof StructuredHttpError) {
    return { ...shape, data: error.structuredBody } as TRPCDefaultErrorShape;
  }
  return shape;
};

/** The procedure builder for this route, exported for `router.ts`. */
export const t = initTRPC.context<RecheckContext>().create({ errorFormatter });

/* ---------------------------------------------------------------- the rate-limit check */

/**
 * S22.10 — the `recheck` dimension check, BEFORE any validation/durability work. Fails
 * OPEN on Redis loss (S16.16); denial → 429 with `RateLimitErrorSchema` and the derived
 * `Retry-After` (S16.6, never a constant).
 */
async function enforceRecheckRateLimit(ctx: RecheckContext, sessionId: string): Promise<void> {
  let check: Awaited<ReturnType<RecheckContext["limiter"]["check"]>>;
  try {
    check = await ctx.limiter.check(sessionId, "recheck", 1);
  } catch (error) {
    // Redis loss must not break the app (S16.16) — but the degradation is visible
    // (O11.8): an unenforced recheck budget is an operator signal, not silence.
    ctx.logger.warn(
      { session_id: sessionId, error },
      "showtimes.recheck: rate-limit check failed (failing open)",
    );
    return;
  }
  if (!check.allowed) {
    throw new StructuredHttpError({
      code: "TOO_MANY_REQUESTS",
      message: `recheck rate limit exceeded: ${check.limit}`,
      body: RateLimitErrorSchema.parse({
        code: "RATE_LIMITED",
        limit: check.limit,
        retryAfterSeconds: check.retryAfterSeconds,
      }),
    });
  }
}

/* ----------------------------------------------------------------------- the deadline await */

/** The poll cadence while awaiting the worker's outcome. A mechanical choice, not policy. */
const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * S22.11 — await the run's `recheck_outcome`, bounded by the injected deadline. `null`
 * means the deadline elapsed first; the worker-side run is reclaimed by S10's sweeper.
 */
async function awaitOutcome(
  ctx: RecheckContext,
  runId: string,
  deadlineMs: number,
): Promise<ReturnType<typeof readRecheckOutcome>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const outcome = await readRecheckOutcome(poolClient(ctx.db), runId);
    if (outcome !== null) {
      return outcome;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/* ----------------------------------------------------------------------- the procedure */

export const recheck = t.procedure
  .input(RecheckInputSchema)
  .mutation(async ({ input, ctx }): Promise<RecheckResult> => {
    // S22.8 step 1 — session id from S16's plugin; absent → UNAUTHORIZED, fail closed.
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to recheck a showtime (session.bootstrap first)",
      });
    }

    // S22.8 step 2 — the rate check, before ownership/nonce/durability work (S22.10).
    await enforceRecheckRateLimit(ctx, sessionId);

    // Ownership (Verification 8) — a missing search is UNAUTHORIZED, never NOT_FOUND.
    await assertCallerOwnsSearch(ctx.db, input.searchId, sessionId);

    // The search's provider (for stageRecheckRun) and its terminal result version (for
    // nonce binding). The spec's `providerId` rides the search spec (`SearchSpecSchema`).
    const search = await findSearchById(ctx.db, input.searchId);
    const spec = SearchSpecSchema.parse(search?.spec);
    const providerId = spec.providerId;
    const terminal = await readLatestSearchResultVersion(ctx.db, input.searchId);

    // S22.9 — nonce validation: HMAC signature, expiry, and every bound field, against
    // the architecture's binding verbatim (`docs/seatfirst-architecture.md:397`). Any
    // failure is a rejection (the invalid-nonce status is safe-to-decide per ADR 0017;
    // UNAUTHORIZED fail-closed is chosen here — do not leak which check failed).
    const nonce: RecheckNonce | null = verifyRecheckNonce(input.nonce, ctx.nonceSecret);
    if (nonce === null || nonceBindingFails(nonce, input, sessionId, terminal?.version ?? null)) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "invalid recheck nonce (tampered, expired, or bound to a different context)",
      });
    }

    // S22.12 — resolve the placement the recheck re-verifies, fail-fast before the run.
    const terminalPlacement =
      terminal === null
        ? null
        : findTerminalPlacement(terminal.payload, input.placementKey, input.showtimeId);
    // D1 (S31.4): the widened `recheck_placement` carries the placement's geometry, so the
    // worker can locate the block in the freshly parsed grid. Unreachable for a nonce that
    // passed `resultVersion` binding; fail-closed rather than staging an unverifiable run.
    if (terminalPlacement === null) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "recheck cannot stage the run: terminal answer has no matching placement",
      });
    }
    const placement = terminalPlacement.placement;

    // S22.7 — stage the durable run (one transaction: key → run → outbox → nonce consume).
    let runId: string;
    try {
      const result = await withTransaction(ctx.db, (tx) =>
        stageRecheckRun(tx, {
          providerId,
          showtimeId: input.showtimeId,
          placementKey: placement.placementKey,
          row: placement.row,
          startCol: placement.startCol,
          rowSpan: placement.rowSpan,
          count: placement.count,
          nonceId: nonce.id,
        }),
      );
      runId = result.runId;
    } catch (error) {
      if (error instanceof NonceReplayError) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "recheck nonce already consumed",
        });
      }
      throw error;
    }

    // S22.10 — charge ONLY after the durable commit (failed/rolled-back work never burns
    // budget); swallowed on Redis loss (S16.16).
    try {
      await ctx.limiter.charge(sessionId, "recheck", 1);
    } catch (error) {
      // S16.16 — under-count in a reconstructible window, never a failed recheck;
      // surfaced for operators (O11.8).
      ctx.logger.warn(
        { session_id: sessionId, error },
        "showtimes.recheck: post-commit recheck-rate charge failed (failing open)",
      );
    }

    // S22.11 — await the worker's outcome under the deadline.
    const outcome = await awaitOutcome(ctx, runId, ctx.deadlineMs);

    // S22.12 — assemble + validate the response against `RecheckResultSchema`.
    const result = await assembleResult(outcome, terminalPlacement, ctx, input);
    return RecheckResultSchema.parse(result);
  });

/** The binding check (S22.9): any field mismatch is a rejection, single-use handled by the DB. */
function nonceBindingFails(
  nonce: RecheckNonce,
  input: { searchId: string; showtimeId: string; placementKey: string },
  sessionId: string,
  resultVersion: number | null,
): boolean {
  return (
    nonce.expiry < Date.now() ||
    nonce.sessionId !== sessionId ||
    nonce.searchId !== input.searchId ||
    nonce.showtimeId !== input.showtimeId ||
    nonce.placementKey !== input.placementKey ||
    resultVersion === null ||
    nonce.resultVersion !== resultVersion
  );
}

/** S22.12 — map the outcome + terminal answer to a `RecheckResult` (validated by caller). */
async function assembleResult(
  outcome: RecheckOutcomeRow | null,
  terminalPlacement: TerminalPlacement | null,
  ctx: RecheckContext,
  input: { searchId: string; showtimeId: string; placementKey: string },
): Promise<RecheckResult> {
  if (outcome === null) {
    // S22.11 — deadline expired: TIMEOUT, with `lastKnown` from the terminal answer.
    return {
      status: "UNAVAILABLE",
      cause: "TIMEOUT",
      lastKnown: lastKnownOrThrow(terminalPlacement),
    };
  }
  switch (outcome.status) {
    case "AVAILABLE":
      if (terminalPlacement === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "recheck verdict AVAILABLE but the terminal answer has no matching placement",
        });
      }
      return {
        status: "AVAILABLE",
        placement: terminalPlacement.placement,
        checkedAt: new Date().toISOString(),
      };
    case "GONE": {
      // S22.12 — the ladder is the injected recovery seam's output (no default).
      const recovery = await ctx.recovery({
        searchId: input.searchId,
        showtimeId: input.showtimeId,
        placementKey: input.placementKey,
      });
      return { status: "GONE", recovery: [...recovery] };
    }
    case "UNAVAILABLE": {
      const cause = readUnavailableCause(outcome.payload);
      return {
        status: "UNAVAILABLE",
        cause,
        lastKnown: lastKnownOrThrow(terminalPlacement),
      };
    }
  }
}

/** The `RecheckResultSchema` UNAVAILABLE cause vocabulary (S22.12). */
type UnavailableCause = Extract<RecheckResult, { status: "UNAVAILABLE" }>["cause"];

const UNAVAILABLE_CAUSES: ReadonlySet<string> = new Set([
  "RATE_LIMITED",
  "UPSTREAM_BLOCKED",
  "CHALLENGE_REQUIRED",
  "UPSTREAM_QUEUED",
  "UPSTREAM_CHANGED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
]);

/** Reads the UNAVAILABLE cause the actor wrote into the outcome payload (`{ cause }`). */
function readUnavailableCause(payload: unknown): UnavailableCause {
  if (typeof payload !== "object" || payload === null) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "malformed recheck outcome" });
  }
  const cause = (payload as { cause?: unknown }).cause;
  if (typeof cause !== "string" || !UNAVAILABLE_CAUSES.has(cause)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "malformed recheck outcome cause",
    });
  }
  return cause as UnavailableCause;
}

function lastKnownOrThrow(terminalPlacement: TerminalPlacement | null): {
  placement: Placement;
  capturedAt: string;
} {
  if (terminalPlacement === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "recheck cannot assemble lastKnown: terminal answer has no matching placement",
    });
  }
  return { placement: terminalPlacement.placement, capturedAt: terminalPlacement.capturedAt };
}
