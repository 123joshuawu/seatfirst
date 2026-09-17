import { useEffect, useState } from "react";

import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";

import { trpc } from "@/lib/trpc";
import { useSeatfirstStore } from "@/store/seatfirstStore";

export interface UseTheatreSearchOptions {
  q?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
  browse?: boolean;
  debounceMs?: number;
}

/**
 * Debounced, location-aware theatre search with browse-on-focus.
 * - `q` is optional (S49): empty q + `browse` ⇒ browse mode (no `q` in input,
 *   whole catalogue ordered nearest-first when centered, else name-ascending).
 * - Typed `q` is debounced by >=250ms (default 250); browse (empty q) fires
 *   immediately on focus with no debounce delay so the list populates instantly.
 * - `browse` is the explicit browse-on-focus flag: caller passes
 *   `isFocused && q.trim()===""`. Enabled when
 *   `bootstrapReady && (debouncedQ.trim().length>0 || browse) && !hasPartialLocation`.
 * - `lat`/`lng` are both-or-neither; a half-pair never fires (enabled=false).
 * - `radiusKm` is radius-filtered browse (requires lat/lng); clamped to
 *   `DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm` (40 km) — never hard-coded.
 * - `limit` is local UI selection state and is deliberately not forwarded because the strict
 *   `theatres.search` contract owns its response cap.
 */
export function useTheatreSearch(options: UseTheatreSearchOptions) {
  const { q = "", lat, lng, radiusKm, browse = false, debounceMs = 250 } = options;
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);

  const [debouncedQ, setDebouncedQ] = useState(q);

  useEffect(() => {
    // Browse (empty q) must populate instantly on focus — no debounce.
    if (q.trim().length === 0) {
      setDebouncedQ(q);
      return;
    }
    const t = setTimeout(() => setDebouncedQ(q), debounceMs);
    return () => clearTimeout(t);
  }, [q, debounceMs]);

  const hasLocation = lat !== undefined && lng !== undefined;
  const hasPartialLocation = (lat !== undefined) !== (lng !== undefined);
  const hasQuery = debouncedQ.trim().length > 0;
  const enabled = bootstrapReady && (hasQuery || browse) && !hasPartialLocation;

  // Clamp radiusKm through DEFAULT_SEARCH_LIMITS — never hard-code 40.
  const clampedRadiusKm =
    radiusKm !== undefined ? Math.min(radiusKm, DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm) : undefined;
  const hasValidRadius = clampedRadiusKm !== undefined && hasLocation;

  // Build input omitting empty q (browse) and omitting half-pairs / radius without center.
  const input: Record<string, unknown> = {};
  if (hasQuery) input.q = debouncedQ;
  if (hasLocation) {
    input.lat = lat;
    input.lng = lng;
    if (hasValidRadius) input.radiusKm = clampedRadiusKm;
  }
  // `theatres.search` has a strict input schema and owns its response cap; `limit`
  // remains local selection state for the eventual AREA/LIST search spec.

  return trpc.theatres.search.useQuery(input, { enabled, staleTime: 30_000 });
}
