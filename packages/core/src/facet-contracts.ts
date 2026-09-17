import { z } from "zod";

import { DEFAULT_SEARCH_LIMITS, DateScopeSchema, WeekdaySchema } from "./search-spec.js";
import { TheatreIdSchema } from "./ids.js";

const nonemptyString = z.string().min(1);
const nonnegativeInteger = z.number().int().nonnegative();

export const FacetAxisKindSchema = z.enum([
  "MOVIE",
  "WEEKDAY",
  "TIME_OF_DAY",
  "HORIZON",
  "FORMAT",
  "DATE",
  "DATE_SCOPE",
]);
export type FacetAxisKind = z.infer<typeof FacetAxisKindSchema>;

const stringCandidateAxisSchema = z.strictObject({
  kind: z.enum(["MOVIE", "WEEKDAY", "TIME_OF_DAY", "HORIZON", "FORMAT"]),
  candidates: z.array(nonemptyString).min(1),
});
const dateAxisSchema = z.strictObject({
  kind: z.literal("DATE"),
  candidates: z.array(z.iso.date()).min(1),
});
const dateScopeCandidateSchema = z.strictObject({
  key: nonemptyString,
  dateScope: DateScopeSchema,
});
const dateScopeAxisSchema = z.strictObject({
  kind: z.literal("DATE_SCOPE"),
  candidates: z.array(dateScopeCandidateSchema).min(1),
});
const facetAxisSchema = z.union([stringCandidateAxisSchema, dateAxisSchema, dateScopeAxisSchema]);

export const FacetCountsInputSchema = z
  .strictObject({
    providerId: nonemptyString,
    theatreIds: z.array(TheatreIdSchema).min(1).max(DEFAULT_SEARCH_LIMITS.maxTheatres),
    base: z.strictObject({
      movieId: z.string().nullable().optional(),
      weekdays: z.array(WeekdaySchema).optional(),
      timeOfDay: z.enum(["allTimes", "morning", "afternoon", "evening", "late"]).optional(),
      horizon: z.enum(["thisWeekend", "nextThreeWeekends"]).optional(),
      dateScope: DateScopeSchema.optional(),
    }),
    axes: z.array(facetAxisSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const base = value.base;
    const axisKinds = new Set(value.axes.map((a) => a.kind));
    if (base.movieId !== undefined && base.movieId !== null && axisKinds.has("MOVIE")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base.movieId must be omitted when MOVIE axis is requested",
        path: ["base", "movieId"],
      });
    }
    if (base.weekdays !== undefined && axisKinds.has("WEEKDAY")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base.weekdays must be omitted when WEEKDAY axis is requested",
        path: ["base", "weekdays"],
      });
    }
    if (base.timeOfDay !== undefined && axisKinds.has("TIME_OF_DAY")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base.timeOfDay must be omitted when TIME_OF_DAY axis is requested",
        path: ["base", "timeOfDay"],
      });
    }
    if (base.horizon !== undefined && axisKinds.has("HORIZON")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base.horizon must be omitted when HORIZON axis is requested",
        path: ["base", "horizon"],
      });
    }
    if (base.dateScope !== undefined) {
      if (base.horizon !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "base.dateScope and base.horizon are mutually exclusive",
          path: ["base", "dateScope"],
        });
      }
      if (axisKinds.has("HORIZON")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "base.dateScope must be omitted when a HORIZON axis is requested",
          path: ["base", "dateScope"],
        });
      }
      if (axisKinds.has("DATE") || axisKinds.has("DATE_SCOPE")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "base.dateScope must be omitted when a DATE or DATE_SCOPE axis is requested",
          path: ["base", "dateScope"],
        });
      }
    }
  });

export type FacetCountsInput = z.infer<typeof FacetCountsInputSchema>;

export const FacetCountsResponseSchema = z.strictObject({
  counts: z.array(
    z.strictObject({
      kind: FacetAxisKindSchema,
      candidate: z.string(),
      count: nonnegativeInteger,
      coldTheatreCount: nonnegativeInteger,
    }),
  ),
});
export type FacetCountsResponse = z.infer<typeof FacetCountsResponseSchema>;
