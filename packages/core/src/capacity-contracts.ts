import { z } from "zod";

import { TheatreIdSchema } from "./ids.js";
import { DEFAULT_SEARCH_LIMITS, PerformancePredicateSchema, WeekdaySchema } from "./search-spec.js";

const nonemptyString = z.string().min(1);
const nonnegativeInteger = z.number().int().nonnegative();

/**
 * S47 / ADR 0039 decision 3 — legacy short-form v1 input.
 */
export const CapacityPreviewV1InputSchema = z.strictObject({
  providerId: nonemptyString,
  theatreIds: z.array(TheatreIdSchema).min(1).max(DEFAULT_SEARCH_LIMITS.maxTheatres),
  /** v1 search requires a movie (ADR 0003 §4 V3's MOVIE_REQUIRED posture). */
  movieId: nonemptyString,
  weekdays: z.array(WeekdaySchema).optional(),
  timeOfDay: z.enum(["allTimes", "morning", "afternoon", "evening", "late"]).optional(),
  horizon: z.enum(["thisWeekend", "nextThreeWeekends"]).optional(),
  formatCode: z.string().nullable().optional(),
});
export type CapacityPreviewV1Input = z.infer<typeof CapacityPreviewV1InputSchema>;

/**
 * S53.7 / ADR 0050 — version-2 arm: the client passes the exact `where`
 * predicate that `searches.create` will receive, verbatim (no reconstruction
 * from parallel fields). Retains resolved `theatreIds` + `providerId` so the
 * route's selector model is unchanged (`theatreIds` remains the resolved set
 * for every Where path, including an AREA selection). `specVersion: 2` pins
 * the wire shape as `DATE_RANGE` or direct-`DATE_RANGE`-`OR` reachable
 * through AND nodes only (ADR 0050 §1).
 */
export const CapacityPreviewV2InputSchema = z.strictObject({
  specVersion: z.literal(2),
  providerId: nonemptyString,
  theatreIds: z.array(TheatreIdSchema).min(1).max(DEFAULT_SEARCH_LIMITS.maxTheatres),
  where: PerformancePredicateSchema,
});
export type CapacityPreviewV2Input = z.infer<typeof CapacityPreviewV2InputSchema>;

/**
 * S47 + S53 — `searches.capacityPreview` input: legacy short-form v1 UNION
 * version-2 `where`-carrying arm. V1 retains its horizon/weekday/timeOfDay
 * reconstruction via `buildWindow`; v2 carries the complete emitted `where`
 * verbatim and is routed through the same core normalizer + planner as
 * `searches.create` (ADR 0050 §3). The union is ordered v2-first so a
 * specVersion:2 input with a `where` is not mis-parsed as v1.
 */
export const CapacityPreviewInputSchema = z.union([
  CapacityPreviewV2InputSchema,
  CapacityPreviewV1InputSchema,
]);
export type CapacityPreviewInput = z.infer<typeof CapacityPreviewInputSchema>;

/** Wire literal for the ADR 0039 Amendment A3 unavailable result. */
export const CAPACITY_PREVIEW_UNAVAILABLE = "CAPACITY_PREVIEW_UNAVAILABLE";

/**
 * Exact answer: `matchedCount` is the total over warm AND resolved-cold dates, computed
 * with admission's own eligibility test. `ceilingExceeded` is derived ONLY from
 * `DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes` — the same constant the admission gate
 * enforces (`packages/durability/src/transactions.ts` cumulative check), per ADR 0003
 * §4's "one constant, two consumers" rule.
 */
export const CapacityPreviewOkSchema = z.strictObject({
  kind: z.literal("ok"),
  matchedCount: nonnegativeInteger,
  ceilingExceeded: z.boolean(),
});
export type CapacityPreviewOk = z.infer<typeof CapacityPreviewOkSchema>;

/**
 * ADR 0039 Amendment A3 — timeout, provider halt mid-resolution, or an otherwise
 * unresolvable cold date. Never carries a count: a partial number would be exactly the
 * dishonesty the amendment forbids. The client blocks submission and shows its
 * unavailable copy, distinct from the exceeds-ceiling message.
 */
export const CapacityPreviewUnavailableSchema = z.strictObject({
  kind: z.literal(CAPACITY_PREVIEW_UNAVAILABLE),
});
export type CapacityPreviewUnavailable = z.infer<typeof CapacityPreviewUnavailableSchema>;

export const CapacityPreviewResponseSchema = z.discriminatedUnion("kind", [
  CapacityPreviewOkSchema,
  CapacityPreviewUnavailableSchema,
]);
export type CapacityPreviewResponse = z.infer<typeof CapacityPreviewResponseSchema>;

/**
 * S56 / ADR 0054 decision 1 — route-level capacity ceiling gate. `searches.create`
 * rejects an all-fresh submission whose exact matched-showtime count exceeds
 * `DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes` with this structured body, before any
 * durable write and without charging a search unit. Fires only when the exact count
 * is known synchronously (no cold dates); cold/mixed searches keep the S36.5
 * provisional reserve path.
 */
export const CAPACITY_CEILING_EXCEEDED = "CAPACITY_CEILING_EXCEEDED" as const;

export const CapacityCeilingExceededSchema = z.strictObject({
  code: z.literal(CAPACITY_CEILING_EXCEEDED),
  matchedCount: nonnegativeInteger,
  limit: z.number().int().positive(),
});
export type CapacityCeilingExceeded = z.infer<typeof CapacityCeilingExceededSchema>;
