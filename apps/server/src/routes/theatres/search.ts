import { initTRPC } from "@trpc/server";

import {
  DEFAULT_SEARCH_LIMITS,
  distanceKm,
  TheatreIdSchema,
  TheatreSearchInputSchema,
  type TheatreAmenity,
  type TheatreSearchHit,
  type TheatreSearchResponse,
} from "@seatfirst/core";
import {
  browseTheatres,
  findTheatresWithinRadius,
  poolClient,
  searchTheatresByName,
} from "@seatfirst/durability";
import type { TheatreRow } from "@seatfirst/durability";

import type { TheatreSearchContext } from "./searchContext.js";

/**
 * `theatres.search` (S20; `seatfirst-architecture.md:264`) — a synchronous, read-only
 * lookup over the durable theatre catalogue S2 built: text match on `q`, optional
 * `distanceKm` annotation with nearest-first ordering when `lat`/`lng` are supplied,
 * and ZERO upstream traffic (S20.7). The catalogue is empty at runtime today (no
 * production caller of `upsertTheatre` exists — S20 F1), so every response is
 * `{ theatres: [] }` until a population path lands; that is documented truth, not a
 * stub (S20.6, mirroring E5.13).
 *
 * The procedure builder is bound to `TheatreSearchContext` (only `db`, no tunables),
 * mirroring `searches/create.ts`'s `t`. Zod input failures map to `BAD_REQUEST` by
 * tRPC's default input-validation behavior — the mapping S15.10 already established.
 */
export const t = initTRPC.context<TheatreSearchContext>().create();

/** Maps a durable `TheatreRow` to the `TheatreSearchHit` wire shape (S20.1 + ADR 0029 §7). */
function toHit(row: TheatreRow, distanceKmValue: number | null): TheatreSearchHit {
  return {
    // The DB `theatre` CHECK already enforces the namespaced kind, but the wire contract
    // brands the id (TheatreIdSchema) — validated here at the boundary (Zod at every
    // boundary, the create.ts pattern) so the hit's `id` carries the brand.
    id: TheatreIdSchema.parse(row.theatre_id),
    providerId: row.provider_id,
    name: row.name,
    location: { lat: row.lat, lng: row.lng },
    timezone: row.timezone,
    city: row.city,
    address: row.address,
    slugs: row.slugs,
    // The hit is a wire schema whose timestamps use `UtcInstantSchema` (ISO string, `Z`
    // suffix), not `TheatreSchema`'s domain `z.date()`. The pg driver returns real `Date`s,
    // so convert to the ISO instant form that satisfies `UtcInstantSchema`.
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    amenities: Array.isArray(row.amenities) ? (row.amenities as TheatreAmenity[]) : [],
    distanceKm: distanceKmValue,
  };
}

export const search = t.procedure
  .input(TheatreSearchInputSchema)
  .query(async ({ input, ctx }): Promise<TheatreSearchResponse> => {
    const hasRadius =
      input.radiusKm !== undefined && input.lat !== undefined && input.lng !== undefined;
    if (hasRadius) {
      const radiusRows = await findTheatresWithinRadius(poolClient(ctx.db), {
        originLat: input.lat as number,
        originLng: input.lng as number,
        radiusKm: input.radiusKm as number,
      });
      const hits = radiusRows.map((row) => toHit(row, row.distance_km));
      const cap = Math.min(50, DEFAULT_SEARCH_LIMITS.maxTheatres);
      return { theatres: hits.slice(0, cap) };
    }

    const hasQuery = typeof input.q === "string" && input.q.length > 0;
    if (hasQuery) {
      const rows = await searchTheatresByName(poolClient(ctx.db), input.q as string);

      // S20.5/S20.8 — `lat`/`lng` are annotation and ordering only, NEVER filtering: when no
      // `radiusKm` is present the endpoint must never trigger `THEATRE_RADIUS_QUERY`. When
      // both are present every hit carries a non-null `distanceKm` and results sort
      // nearest-first (ADR 0016); when absent every hit is `null` and the boundary's
      // `name, theatre_id` order holds. The nearest-first sort is stable, so equal-distance
      // ties keep boundary (name) order — deterministic.
      const origin =
        input.lat !== undefined && input.lng !== undefined
          ? { lat: input.lat, lng: input.lng }
          : null;

      const hits = rows.map((row) =>
        toHit(row, origin === null ? null : distanceKm(origin, { lat: row.lat, lng: row.lng })),
      );

      if (origin !== null) {
        hits.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
      }

      // ADR 0016: the 50-result cap, applied route-side AFTER the nearest-first sort so
      // the sort sees the full match set (S20.2/S20.4).
      return { theatres: hits.slice(0, 50) };
    }

    const rows = await browseTheatres(poolClient(ctx.db));

    const origin =
      input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng }
        : null;

    const hits = rows.map((row) =>
      toHit(row, origin === null ? null : distanceKm(origin, { lat: row.lat, lng: row.lng })),
    );

    if (origin !== null) {
      hits.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    }

    // ADR 0016: the 50-result cap, applied route-side AFTER the nearest-first sort so
    // the sort sees the full match set (S20.2/S20.4).
    return { theatres: hits.slice(0, 50) };
  });
