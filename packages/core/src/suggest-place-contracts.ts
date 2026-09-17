import { z } from "zod";

import { placeQuerySchema, ResolvePlaceUnavailableSchema } from "./resolve-place-contracts.js";

/**
 * S52 / ADR 0048 S51-D8 — input for `searches.suggestPlace`.
 * `providerId` is validated for route consistency but never sent to Mapbox.
 * `query` reuses the exact Mapbox v6 envelope as ResolvePlaceInputSchema
 * (1–256 chars, no `;`, at most 20 whitespace-split words/numbers).
 * No `radiusKm` or `limit`; suggestions never touch the theatre catalogue.
 */
export const SuggestPlaceInputSchema = z.strictObject({
  providerId: z.string().min(1),
  query: placeQuerySchema,
});
export type SuggestPlaceInput = z.infer<typeof SuggestPlaceInputSchema>;

/**
 * Suggestion candidates — at most 5 display labels, no coordinates.
 * Empty array is a valid result (no suggestions yet) — not an error and
 * not PLACE_NOT_FOUND. The inner `label` is a Mapbox `properties.full_address`
 * string and is intentionally separate from ResolvePlaceOkSchema's user-query/radius `label`.
 */
export const SuggestPlaceCandidatesSchema = z.strictObject({
  candidates: z.array(z.strictObject({ label: z.string().min(1) })).max(5),
});
export type SuggestPlaceCandidates = z.infer<typeof SuggestPlaceCandidatesSchema>;

export const SuggestPlaceResponseSchema = z.union([
  SuggestPlaceCandidatesSchema,
  ResolvePlaceUnavailableSchema,
]);
export type SuggestPlaceResponse = z.infer<typeof SuggestPlaceResponseSchema>;
