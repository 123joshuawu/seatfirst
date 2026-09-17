import { z } from "zod";

import { TheatreIdSchema } from "./ids.js";
import { DEFAULT_SEARCH_LIMITS } from "./search-spec.js";

const nonemptyString = z.string().min(1);
const finiteNumber = z.number().finite();
const nonnegativeInteger = z.number().int().nonnegative();
const nonnegativeNumber = z.number().finite().nonnegative();

/**
 * Shared Mapbox v6 place query envelope: 1–256 chars, no `;`, at most 20 whitespace-split
 * words/numbers. Factored for reuse by SuggestPlaceInputSchema (S52 S51-D8) and
 * ResolvePlaceInputSchema (S51). Backend accepts 1–256; UI20's 3-char gate is client shaping.
 */
export const placeQuerySchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((value, ctx) => {
    if (value.includes(";")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query must not contain ';'",
        path: [],
      });
    }
    // Split on whitespace per spec; filter empty tokens from leading/trailing whitespace.
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "query must not contain more than 20 words",
        path: [],
      });
    }
  });

/**
 * S51 / ADR 0045 §2a — input for `searches.resolvePlace`.
 * `query` enforces Mapbox v6's published 256-char ceiling and rejects
 * semicolons and >20 words/numbers (split on whitespace).
 * `radiusKm` and `limit` are bounded by ADR 0029 §4's catalogue limits.
 */
export const ResolvePlaceInputSchema = z.strictObject({
  providerId: nonemptyString,
  query: placeQuerySchema,
  radiusKm: finiteNumber.positive().max(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm),
  limit: z.number().int().positive().max(DEFAULT_SEARCH_LIMITS.maxTheatres),
});
export type ResolvePlaceInput = z.infer<typeof ResolvePlaceInputSchema>;

/**
 * Successful resolve — nearest-first transient theatre distances (≤ limit),
 * distinct exclusion counts, a display label derived from the user's
 * own query + radius (never Mapbox place text), and the Mapbox-resolved
 * display name (S52 S51-D9). Each theatre carries its catalogue display
 * name/city so place-mode rows never fall back to raw ids (the client has
 * no other name source in place mode — ADR 0045 §1 keeps coordinates
 * server-side, so the ambient search is disabled there). Coordinate never
 * leaves the handler's local scope and never appears in this response.
 */
export const ResolvePlaceOkSchema = z.strictObject({
  kind: z.literal("ok"),
  theatres: z.array(
    z.strictObject({
      theatreId: TheatreIdSchema,
      distanceKm: nonnegativeNumber,
      name: nonemptyString,
      city: z.string().nullable(),
    }),
  ),
  excluded: z.strictObject({
    outsideArea: nonnegativeInteger,
    byLimit: nonnegativeInteger,
  }),
  label: z.string().min(1),
  resolvedPlaceName: z.string().min(1),
});
export type ResolvePlaceOk = z.infer<typeof ResolvePlaceOkSchema>;

export const ResolvePlaceNotFoundSchema = z.strictObject({
  kind: z.literal("PLACE_NOT_FOUND"),
});
export type ResolvePlaceNotFound = z.infer<typeof ResolvePlaceNotFoundSchema>;

export const ResolvePlaceUnavailableSchema = z.strictObject({
  kind: z.literal("PLACE_RESOLUTION_UNAVAILABLE"),
});
export type ResolvePlaceUnavailable = z.infer<typeof ResolvePlaceUnavailableSchema>;

export const ResolvePlaceResponseSchema = z.discriminatedUnion("kind", [
  ResolvePlaceOkSchema,
  ResolvePlaceNotFoundSchema,
  ResolvePlaceUnavailableSchema,
]);
export type ResolvePlaceResponse = z.infer<typeof ResolvePlaceResponseSchema>;
