/**
 * Single injected geocoding seam (ADR 0045 §2, ADR 0042 §2, S51, S52/ADR 0048).
 *
 * One interface, one production implementation (Mapbox), injected into the
 * route context — mirroring ADR 0019's injectable `fetch`. A `null` return
 * is a first-class outcome meaning "no confident match" (not an error); the
 * caller maps it to `PLACE_NOT_FOUND` without logging query text or
 * coordinates. S52 adds `resolvedPlaceName` to the resolve result and a
 * `suggest` method for autocomplete candidates.
 */
export interface ResolvedPlace {
  readonly lat: number;
  readonly lng: number;
  readonly resolvedPlaceName: string;
}

export interface SuggestCandidate {
  readonly label: string;
}

export interface GeocodeResolver {
  resolve(query: string): Promise<ResolvedPlace | null>;
  suggest(query: string): Promise<readonly SuggestCandidate[]>;
}
