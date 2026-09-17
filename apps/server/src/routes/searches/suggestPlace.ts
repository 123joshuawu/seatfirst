import { TRPCError } from "@trpc/server";

import {
  RateLimitErrorSchema,
  SuggestPlaceInputSchema,
  type SuggestPlaceResponse,
} from "@seatfirst/core";

import { GeocodeUnavailableError } from "../../geocode/mapbox.js";
import type { SuggestCandidate } from "../../geocode/resolver.js";
import { StructuredHttpError, t } from "./create.js";

/**
 * `searches.suggestPlace` (S52, ADR 0048) — typed-place suggestions.
 * Server-side Mapbox Geocoding v6 forward, in-memory session memo,
 * no catalogue query. Shares the single Mapbox bucket with `resolvePlace`.
 *
 * The candidate labels are Mapbox `full_address` strings — never coordinates.
 */
export const suggestPlace = t.procedure
  .input(SuggestPlaceInputSchema)
  .query(async ({ input, ctx }): Promise<SuggestPlaceResponse> => {
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to suggest a place (session.bootstrap first)",
      });
    }

    let windowCheck;
    try {
      windowCheck = await ctx.limiter.check(sessionId, "suggestPlace", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.suggestPlace: rate-limit window check failed (failing open)",
      );
      windowCheck = { allowed: true };
    }
    if (!windowCheck.allowed) {
      throw new StructuredHttpError({
        code: "TOO_MANY_REQUESTS",
        message: `session rate limit exceeded: ${windowCheck.limit}`,
        body: RateLimitErrorSchema.parse({
          code: "RATE_LIMITED",
          limit: windowCheck.limit,
          retryAfterSeconds: windowCheck.retryAfterSeconds,
        }),
      });
    }

    const normalized = input.query.trim().replace(/\s+/g, " ");
    const normalizedLower = normalized.toLowerCase();

    const memoInstance = ctx.suggestMemo;

    const memoHit = memoInstance.get(sessionId, normalizedLower);
    if (memoHit !== null) {
      return { candidates: [...memoHit] };
    }

    let candidates: readonly SuggestCandidate[];
    try {
      candidates = await ctx.resolver.suggest(normalized);
    } catch (error) {
      if (error instanceof GeocodeUnavailableError) {
        ctx.logger.warn({ error }, "searches.suggestPlace: geocode unavailable");
        try {
          await ctx.limiter.charge(sessionId, "suggestPlace", 1);
        } catch (chargeError) {
          ctx.logger.warn(
            { session_id: sessionId, error: chargeError },
            "searches.suggestPlace: rate-limit charge failed (failing open)",
          );
        }
        return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
      }
      ctx.logger.warn({ error }, "searches.suggestPlace: geocode error");
      try {
        await ctx.limiter.charge(sessionId, "suggestPlace", 1);
      } catch (chargeError) {
        ctx.logger.warn(
          { session_id: sessionId, error: chargeError },
          "searches.suggestPlace: rate-limit charge failed (failing open)",
        );
      }
      return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
    }

    memoInstance.set(sessionId, normalizedLower, candidates);

    try {
      await ctx.limiter.charge(sessionId, "suggestPlace", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.suggestPlace: rate-limit charge failed (failing open)",
      );
    }

    return { candidates: [...candidates] };
  });
