import { TRPCError } from "@trpc/server";

import {
  RateLimitErrorSchema,
  ResolvePlaceInputSchema,
  TheatreIdSchema,
  type ResolvePlaceResponse,
} from "@seatfirst/core";
import {
  browseTheatres,
  findTheatresWithinRadius,
  poolClient,
  type TheatreRadiusRow,
} from "@seatfirst/durability";

import { GeocodeUnavailableError } from "../../geocode/mapbox.js";
import type { ResolvedPlace } from "../../geocode/resolver.js";
import { StructuredHttpError, t } from "./create.js";

/**
 * `searches.resolvePlace` (S51, ADR 0045 §1, §2a, S52/ADR 0048) — typed-location geocoding,
 * resolve-to-LIST. Server-side Mapbox Geocoding v6 forward, in-memory session memo,
 * radius catalogue query, transient distances, display label from user text and
 * Mapbox-resolved place name. S52 adds `resolvedPlaceName` to the success response.
 *
 * The geocoded coordinate is request-scoped only: used for the radius query and
 * then discarded, never logged, persisted, hashed, or returned (ADR 0045 §1).
 */
export const resolvePlace = t.procedure
  .input(ResolvePlaceInputSchema)
  .query(async ({ input, ctx }): Promise<ResolvePlaceResponse> => {
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to resolve a place (session.bootstrap first)",
      });
    }

    let windowCheck;
    try {
      windowCheck = await ctx.limiter.check(sessionId, "resolvePlace", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.resolvePlace: rate-limit window check failed (failing open)",
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

    let resolved: ResolvedPlace | null;
    const memoHit = ctx.memo.get(sessionId, normalizedLower);
    if (memoHit !== null) {
      resolved = memoHit;
    } else {
      try {
        resolved = await ctx.resolver.resolve(normalized);
      } catch (error) {
        if (error instanceof GeocodeUnavailableError) {
          ctx.logger.warn({ error }, "searches.resolvePlace: geocode unavailable");
          try {
            await ctx.limiter.charge(sessionId, "resolvePlace", 1);
          } catch (chargeError) {
            ctx.logger.warn(
              { session_id: sessionId, error: chargeError },
              "searches.resolvePlace: rate-limit charge failed (failing open)",
            );
          }
          return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
        }
        ctx.logger.warn({ error }, "searches.resolvePlace: geocode error");
        try {
          await ctx.limiter.charge(sessionId, "resolvePlace", 1);
        } catch (chargeError) {
          ctx.logger.warn(
            { session_id: sessionId, error: chargeError },
            "searches.resolvePlace: rate-limit charge failed (failing open)",
          );
        }
        return { kind: "PLACE_RESOLUTION_UNAVAILABLE" };
      }
      if (resolved !== null) {
        ctx.memo.set(sessionId, normalizedLower, resolved);
      }
    }

    if (resolved === null) {
      try {
        await ctx.limiter.charge(sessionId, "resolvePlace", 1);
      } catch (error) {
        ctx.logger.warn(
          { session_id: sessionId, error },
          "searches.resolvePlace: rate-limit charge failed (failing open)",
        );
      }
      return { kind: "PLACE_NOT_FOUND" };
    }

    const providerId = input.providerId;
    const radiusKm = input.radiusKm;
    const limit = input.limit;

    const [radiusRows, allTheatres] = await Promise.all([
      findTheatresWithinRadius(poolClient(ctx.db), {
        originLat: resolved.lat,
        originLng: resolved.lng,
        radiusKm,
      }),
      browseTheatres(poolClient(ctx.db)),
    ]);

    const filtered = radiusRows.filter((row: TheatreRadiusRow) => row.provider_id === providerId);
    const inRadiusCount = filtered.length;
    const maxTheatres = limit;
    const sliced = filtered.slice(0, maxTheatres);
    const theatres = sliced.map((row: TheatreRadiusRow) => ({
      // The DB CHECK already enforces the namespaced shape, but the wire contract brands
      // the id (TheatreIdSchema) — validated here at the boundary (Zod at every boundary,
      // the create.ts pattern).
      theatreId: TheatreIdSchema.parse(row.theatre_id),
      distanceKm: row.distance_km,
      // Catalogue display fields — the client's only name source in place
      // mode (its ambient search is disabled there per ADR 0045 §1).
      // Never coordinates: lat/lng stay request-scoped (S51.4).
      name: row.name,
      city: row.city,
    }));

    const totalProviderCount = allTheatres.filter((row) => row.provider_id === providerId).length;
    const outsideArea = Math.max(0, totalProviderCount - inRadiusCount);
    const byLimit = Math.max(0, inRadiusCount - theatres.length);

    const label = `${radiusKm} km around ${normalized}`;

    try {
      await ctx.limiter.charge(sessionId, "resolvePlace", 1);
    } catch (error) {
      ctx.logger.warn(
        { session_id: sessionId, error },
        "searches.resolvePlace: rate-limit charge failed (failing open)",
      );
    }

    return {
      kind: "ok",
      theatres,
      excluded: { outsideArea, byLimit },
      label,
      resolvedPlaceName: resolved.resolvedPlaceName,
    };
  });
