import { z } from "zod";
import { parseNamespacedId } from "./ids.js";

import { sha256 } from "./sha256.js";

const nonemptyString = z.string().min(1);
const finiteNumber = z.number().finite();
const positiveInteger = z.number().int().positive();
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/**
 * Hard schema-layer ceiling on group-count-like fields (ADR 0003 §4 V1's "separately, and
 * regardless of which [product throttle] number wins" schema ceiling). This is
 * defense-in-depth independent of, and not a substitute for, the config-overridable
 * `maxPartySize` product throttle in `validateSearchSpecV1`: it applies unconditionally, at
 * parse time, to every caller of `SearchSpecSchema` — including `specHash`/
 * `canonicalizeSearchSpec` and `SearchResultSchema`'s embedded spec in result-contracts.ts,
 * both of which parse with the bare schema and never run `validateSearchSpecV1`. Typical
 * auditoriums seat 150-300; a request above 20 contiguous/blocked seats has no realistic
 * booking use case.
 */
const groupCount = z.number().int().min(1).max(20);

export const WeekdaySchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const SeatKindSchema = z.enum([
  "STANDARD",
  "WHEELCHAIR",
  "COMPANION",
  "NOT_A_SEAT",
  "UNKNOWN",
]);
export type SeatKind = z.infer<typeof SeatKindSchema>;

export const TheatreRefSchema = z.strictObject({
  id: nonemptyString,
  slugs: z.record(nonemptyString, nonemptyString).optional(),
});
export type TheatreRef = z.infer<typeof TheatreRefSchema>;

export const ListTheatreSelectorSchema = z.strictObject({
  kind: z.literal("LIST"),
  refs: z.array(TheatreRefSchema).min(1),
});
export type ListTheatreSelector = z.infer<typeof ListTheatreSelectorSchema>;

export const AreaTheatreSelectorSchema = z.strictObject({
  kind: z.literal("AREA"),
  center: z.strictObject({
    lat: finiteNumber.min(-90).max(90),
    lng: finiteNumber.min(-180).max(180),
  }),
  radiusKm: finiteNumber.positive(),
  limit: positiveInteger,
});
export type AreaTheatreSelector = z.infer<typeof AreaTheatreSelectorSchema>;

export const TheatreSelectorSchema = z.discriminatedUnion("kind", [
  ListTheatreSelectorSchema,
  AreaTheatreSelectorSchema,
]);
export type TheatreSelector = z.infer<typeof TheatreSelectorSchema>;

const moviePredicateSchema = z.strictObject({
  kind: z.literal("MOVIE"),
  ids: z.array(nonemptyString).min(1),
});
const attributePredicateSchema = z.strictObject({
  kind: z.literal("ATTRIBUTE"),
  code: nonemptyString,
});
const auditoriumPredicateSchema = z.strictObject({
  kind: z.literal("AUDITORIUM"),
  ids: z.array(z.number().int()).min(1),
});
const pricePredicateSchema = z
  .strictObject({
    kind: z.literal("PRICE"),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
  })
  .refine((predicate) => predicate.min !== undefined || predicate.max !== undefined, {
    message: "PRICE requires min or max",
  })
  .refine(
    (predicate) =>
      predicate.min === undefined || predicate.max === undefined || predicate.min <= predicate.max,
    { message: "PRICE min must not exceed max" },
  );
const runtimePredicateSchema = z.strictObject({
  kind: z.literal("RUNTIME"),
  maxMinutes: positiveInteger,
});
const dateRangePredicateSchema = z
  .strictObject({
    kind: z.literal("DATE_RANGE"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((predicate) => predicate.from <= predicate.to, {
    message: "DATE_RANGE from must not exceed to",
  });
export const DateScopeSchema = z.union([
  dateRangePredicateSchema,
  z.strictObject({
    kind: z.literal("OR"),
    of: z.array(dateRangePredicateSchema).min(2),
  }),
]);
export type DateScope = z.infer<typeof DateScopeSchema>;
const timeWindowPredicateSchema = z.strictObject({
  kind: z.literal("TIME_WINDOW"),
  days: z.array(WeekdaySchema).min(1),
  startLocal: localTimeSchema,
  endLocal: localTimeSchema,
});
const formatPredicateSchema = z.strictObject({
  kind: z.literal("FORMAT"),
  code: nonemptyString,
});

const predicateAndSchema = z.strictObject({
  kind: z.literal("AND"),
  get of(): z.ZodArray<typeof PerformancePredicateSchema> {
    return z.array(PerformancePredicateSchema).min(1);
  },
});
const predicateOrSchema = z.strictObject({
  kind: z.literal("OR"),
  get of(): z.ZodArray<typeof PerformancePredicateSchema> {
    return z.array(PerformancePredicateSchema).min(1);
  },
});
const predicateNotSchema = z.strictObject({
  kind: z.literal("NOT"),
  get of(): typeof PerformancePredicateSchema {
    return PerformancePredicateSchema;
  },
});

export const PerformancePredicateSchema = z.union([
  moviePredicateSchema,
  attributePredicateSchema,
  auditoriumPredicateSchema,
  pricePredicateSchema,
  runtimePredicateSchema,
  dateRangePredicateSchema,
  timeWindowPredicateSchema,
  formatPredicateSchema,
  predicateAndSchema,
  predicateOrSchema,
  predicateNotSchema,
]);
export type PerformancePredicate = z.infer<typeof PerformancePredicateSchema>;

export const PresetNameSchema = z.enum([
  "SWEET_SPOT",
  "CENTER_BLOCK",
  "BACK_CENTER",
  "AVOID_FRONT",
  "LEGROOM",
  "OUTER_RING",
]);
export type PresetName = z.infer<typeof PresetNameSchema>;

const allRegionSchema = z.strictObject({ kind: z.literal("ALL") });
const presetRegionSchema = z.strictObject({ kind: z.literal("PRESET"), name: PresetNameSchema });
const depthRegionSchema = z
  .strictObject({
    kind: z.literal("DEPTH"),
    from: finiteNumber.min(0).max(1),
    to: finiteNumber.min(0).max(1),
  })
  .refine((region) => region.from <= region.to, { message: "DEPTH from must not exceed to" });
const lateralRegionSchema = z.strictObject({
  kind: z.literal("LATERAL"),
  maxOffset: finiteNumber.min(0).max(1),
});
const aisleRegionSchema = z.strictObject({
  kind: z.literal("AISLE"),
  want: z.enum(["ADJACENT", "AVOID"]),
});
const seatTypeRegionSchema = z.strictObject({
  kind: z.literal("SEAT_TYPE"),
  include: z.array(SeatKindSchema).min(1),
});
const scoreRegionSchema = z.strictObject({
  kind: z.literal("SCORE"),
  min: finiteNumber.min(0).max(1),
});
const rowsRegionSchema = z
  .strictObject({
    kind: z.literal("ROWS"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .refine((region) => region.from <= region.to, { message: "ROWS from must not exceed to" });
const regionAndSchema = z.strictObject({
  kind: z.literal("AND"),
  get of(): z.ZodArray<typeof SeatRegionSchema> {
    return z.array(SeatRegionSchema).min(1);
  },
});
const regionOrSchema = z.strictObject({
  kind: z.literal("OR"),
  get of(): z.ZodArray<typeof SeatRegionSchema> {
    return z.array(SeatRegionSchema).min(1);
  },
});
const regionNotSchema = z.strictObject({
  kind: z.literal("NOT"),
  get of(): typeof SeatRegionSchema {
    return SeatRegionSchema;
  },
});

export const SeatRegionSchema = z.union([
  allRegionSchema,
  presetRegionSchema,
  depthRegionSchema,
  lateralRegionSchema,
  aisleRegionSchema,
  seatTypeRegionSchema,
  scoreRegionSchema,
  rowsRegionSchema,
  regionAndSchema,
  regionOrSchema,
  regionNotSchema,
]);
export type SeatRegion = z.infer<typeof SeatRegionSchema>;

export const AggregationThresholdSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("NONE") }),
  z.strictObject({ kind: z.literal("AT_LEAST"), n: positiveInteger }),
  z.strictObject({ kind: z.literal("ALL") }),
  z.strictObject({ kind: z.literal("FRACTION"), min: finiteNumber.min(0).max(1) }),
]);
export type AggregationThreshold = z.infer<typeof AggregationThresholdSchema>;

export const AggregationSchema = z.strictObject({
  reduce: z.literal("COUNT"),
  threshold: AggregationThresholdSchema.default({ kind: "NONE" }),
});
export type Aggregation = z.infer<typeof AggregationSchema>;

export const RunGroupShapeSchema = z.strictObject({
  kind: z.literal("RUN"),
  count: groupCount,
});
export type RunGroupShape = z.infer<typeof RunGroupShapeSchema>;

export const BlockGroupShapeSchema = z
  .strictObject({
    kind: z.literal("BLOCK"),
    rows: groupCount,
    cols: groupCount,
  })
  // `rows` and `cols` are each bounded to <= 20 by `groupCount` above, but that bounds each
  // dimension independently, not the product: a 20x20 BLOCK (400 seats) would otherwise pass
  // the bare schema. `partySize()`/`GROUP_TOO_LARGE` in `validateSearchSpecV1` catches this for
  // the configurable throttle, but per the doc comment on `groupCount`, this schema must also
  // enforce the effective total unconditionally, for callers (specHash, SearchResultSchema's
  // embedded spec) that never run `validateSearchSpecV1`.
  .refine((shape) => shape.rows * shape.cols <= 20, {
    message: "BLOCK rows * cols must not exceed 20",
  });
export type BlockGroupShape = z.infer<typeof BlockGroupShapeSchema>;

export const SplitGroupShapeSchema = z
  .strictObject({
    kind: z.literal("SPLIT"),
    count: groupCount,
    maxGroups: groupCount,
    sameRow: z.boolean(),
  })
  // Same class of bug as BLOCK above: `count` and `maxGroups` are each bounded to <= 20
  // independently. Per ADR 0003 §4/V4, SPLIT's search cost scales with `count * maxGroups`
  // against auditorium size, so the product — not just each field — must be bounded at the
  // schema layer.
  .refine((shape) => shape.count * shape.maxGroups <= 20, {
    message: "SPLIT count * maxGroups must not exceed 20",
  });
export type SplitGroupShape = z.infer<typeof SplitGroupShapeSchema>;

export const GroupShapeSchema = z.discriminatedUnion("kind", [
  RunGroupShapeSchema,
  BlockGroupShapeSchema,
  SplitGroupShapeSchema,
]);
export type GroupShape = z.infer<typeof GroupShapeSchema>;

function providerNamespace(value: string): string | undefined {
  const parsed = parseNamespacedId(value);
  return parsed.ok ? parsed.value.providerId : undefined;
}

function movieIds(root: PerformancePredicate): readonly string[] {
  if (root.kind === "MOVIE") {
    return root.ids;
  }
  if (root.kind === "AND" || root.kind === "OR") {
    return root.of.flatMap((child) => movieIds(child));
  }
  if (root.kind === "NOT") {
    return movieIds(root.of);
  }
  return [];
}

type MoviePredicateProjection = boolean | undefined;

/**
 * Evaluates only the movie-dependent part of a performance predicate.
 *
 * Other leaf predicates are neutral because their evaluators run at their own
 * selection stages. `undefined` carries that neutral value through boolean
 * structure without turning `NOT(ATTRIBUTE(...))` into a movie rejection.
 * Admitted v1 specs are movie-bound, but returning `true` for a tree with no
 * movie constraint keeps this evaluator composable for schema-valid future specs.
 */
function projectMoviePredicate(
  movieId: string | null,
  node: PerformancePredicate,
): MoviePredicateProjection {
  if (node.kind === "MOVIE") {
    return movieId !== null && node.ids.includes(movieId);
  }
  if (node.kind === "AND") {
    const children = node.of.map((child) => projectMoviePredicate(movieId, child));
    if (children.some((child) => child === false)) return false;
    return children.some((child) => child === true) ? true : undefined;
  }
  if (node.kind === "OR") {
    const children = node.of.map((child) => projectMoviePredicate(movieId, child));
    if (children.some((child) => child === true)) return true;
    return children.every((child) => child === false) ? false : undefined;
  }
  if (node.kind === "NOT") {
    const child = projectMoviePredicate(movieId, node.of);
    return child === undefined ? undefined : !child;
  }
  return undefined;
}

export function matchesMoviePredicate(
  movieId: string | null,
  predicate: PerformancePredicate,
): boolean {
  return projectMoviePredicate(movieId, predicate) ?? true;
}

type FormatPredicateProjection = boolean | undefined;

function projectFormatPredicate(
  formatCode: string | null,
  node: PerformancePredicate,
): FormatPredicateProjection {
  if (node.kind === "FORMAT") {
    if (node.code === "STANDARD") return formatCode === null;
    return formatCode !== null && formatCode === node.code;
  }
  if (node.kind === "AND") {
    const children = node.of.map((child) => projectFormatPredicate(formatCode, child));
    if (children.some((child) => child === false)) return false;
    return children.some((child) => child === true) ? true : undefined;
  }
  if (node.kind === "OR") {
    const children = node.of.map((child) => projectFormatPredicate(formatCode, child));
    if (children.some((child) => child === true)) return true;
    return children.every((child) => child === false) ? false : undefined;
  }
  if (node.kind === "NOT") {
    const child = projectFormatPredicate(formatCode, node.of);
    return child === undefined ? undefined : !child;
  }
  return undefined;
}

export function matchesFormatPredicate(
  formatCode: string | null,
  predicate: PerformancePredicate,
): boolean {
  return projectFormatPredicate(formatCode, predicate) ?? true;
}

/**
 * Reserved per ADR 0003 §9: gate 22's accessibility *policy* (what the engine does with this
 * field — e.g. running the same ranking over the accessible-seat subset) is an open product
 * decision, NOT implemented here. This is a field reservation only, landed now because
 * `SearchSpecSchema` changing shape after specs are already hashed and persisted is a
 * wire-format break requiring a `specVersion` bump. `.optional()` with no `.default()` means
 * a spec that omits it parses to an object with no `accessibility` key at all (see
 * `hashableSpec`/`canonicalJson`), so existing and future specs that don't set it hash
 * byte-identically to specs from before this field existed.
 */
export const AccessibilityRequestSchema = z.strictObject({ required: z.boolean() });
export type AccessibilityRequest = z.infer<typeof AccessibilityRequestSchema>;

export const SearchSpecSchema = z.strictObject({
  specVersion: positiveInteger,
  providerId: nonemptyString,
  theatres: TheatreSelectorSchema,
  where: PerformancePredicateSchema,
  region: SeatRegionSchema.optional(),
  aggregation: AggregationSchema,
  group: GroupShapeSchema.optional(),
  groupRegion: SeatRegionSchema.optional(),
  groupStrict: z.boolean().default(false),
  rank: z.enum(["SCORE", "AVAILABILITY", "DEPTH"]).default("SCORE"),
  accessibility: AccessibilityRequestSchema.optional(),
});
export type SearchSpecInput = z.input<typeof SearchSpecSchema>;
export type SearchSpec = z.infer<typeof SearchSpecSchema>;
export class SearchSpecNormalizationError extends Error {
  public readonly code = "BAD_REQUEST" as const;
  public readonly httpStatus = 400 as const;
  public readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "SearchSpecNormalizationError";
    this.reason = reason;
  }
}

const MS_PER_DAY_V2 = 86_400_000;

/**
 * S53.1 — canonicalizes an array of DATE_RANGE runs:
 * sorts ascending by `from` then `to`, removes exact duplicates,
 * merges overlapping runs, merges adjacent runs (next `from` is
 * exactly one calendar day after previous `to`), and returns
 * the ordered, non-overlapping result. A single run remains a
 * single element (the caller collapses a one-element OR to a
 * single DATE_RANGE leaf).
 */
export function canonicalizeDateRuns(
  runs: readonly { readonly from: string; readonly to: string }[],
): readonly { readonly from: string; readonly to: string }[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => {
    if (a.from < b.from) return -1;
    if (a.from > b.from) return 1;
    if (a.to < b.to) return -1;
    if (a.to > b.to) return 1;
    return 0;
  });
  const deduped: { from: string; to: string }[] = [];
  for (const r of sorted) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.from === r.from && last.to === r.to) continue;
    deduped.push({ from: r.from, to: r.to });
  }
  const merged: { from: string; to: string }[] = [];
  for (const r of deduped) {
    if (merged.length === 0) {
      merged.push(r);
      continue;
    }
    const last = merged[merged.length - 1]!;
    if (r.from <= last.to) {
      const newTo = r.to > last.to ? r.to : last.to;
      merged[merged.length - 1] = { from: last.from, to: newTo };
    } else {
      const lastToMs = Date.parse(`${last.to}T00:00:00Z`);
      const rFromMs = Date.parse(`${r.from}T00:00:00Z`);
      if (
        !Number.isNaN(lastToMs) &&
        !Number.isNaN(rFromMs) &&
        rFromMs === lastToMs + MS_PER_DAY_V2
      ) {
        const newTo = r.to > last.to ? r.to : last.to;
        merged[merged.length - 1] = { from: last.from, to: newTo };
      } else {
        merged.push(r);
      }
    }
  }
  return merged;
}

/**
 * S53.1 + S53.2 — version-aware date-scope normalization.
 * For specVersion 2, locates exactly one date scope reachable
 * through AND nodes (either one DATE_RANGE leaf or one OR whose
 * direct children are DATE_RANGE leaves) and canonicalizes it
 * before hashing/planning/persistence. Sorts, dedupes, merges
 * overlapping+adjacent runs and collapses a single run to one
 * DATE_RANGE (never a one-child OR). Rejects with
 * SearchSpecNormalizationError (BAD_REQUEST) for every forbidden
 * v2 tree shape while leaving TIME_WINDOW and other S36 rules
 * to their existing validators.
 */
export function normalizeWhereForV2(where: PerformancePredicate): PerformancePredicate {
  const runs: { from: string; to: string }[] = [];
  let scopesFound = 0;
  let violated = false;
  let violatedReason = "";

  function walkCollect(node: PerformancePredicate, allowed: boolean): void {
    switch (node.kind) {
      case "AND": {
        for (const child of node.of) walkCollect(child, allowed);
        break;
      }
      case "OR": {
        if (allowed) {
          const allDate = node.of.every((c) => c.kind === "DATE_RANGE");
          const anyDate = node.of.some((c) => c.kind === "DATE_RANGE");
          if (allDate && anyDate) {
            scopesFound += 1;
            for (const c of node.of) {
              const dr = c as Extract<PerformancePredicate, { kind: "DATE_RANGE" }>;
              runs.push({ from: dr.from, to: dr.to });
            }
          } else if (anyDate) {
            violated = true;
            violatedReason = "date_or_mixed";
          } else {
            for (const child of node.of) walkCollect(child, false);
          }
        } else {
          for (const child of node.of) walkCollect(child, false);
        }
        break;
      }
      case "NOT": {
        walkCollect(node.of, false);
        break;
      }
      case "DATE_RANGE": {
        if (allowed) {
          scopesFound += 1;
          runs.push({ from: node.from, to: node.to });
        } else {
          violated = true;
          violatedReason = "ambiguous_predicate";
        }
        break;
      }
      case "TIME_WINDOW": {
        if (!allowed) {
          violated = true;
          violatedReason = "ambiguous_predicate";
        }
        break;
      }
      case "MOVIE":
      case "ATTRIBUTE":
      case "AUDITORIUM":
      case "PRICE":
      case "RUNTIME":
      case "FORMAT":
        break;
    }
  }

  walkCollect(where, true);

  if (violated) {
    throw new SearchSpecNormalizationError(
      `date scope structural violation: ${violatedReason}`,
      violatedReason,
    );
  }
  if (scopesFound === 0) {
    throw new SearchSpecNormalizationError(
      "schedule window requires exactly one reachable date scope",
      "missing_date_range",
    );
  }
  if (scopesFound > 1) {
    throw new SearchSpecNormalizationError(
      "schedule window requires exactly one reachable date scope (found multiple)",
      "multiple_date_ranges",
    );
  }

  const canonicalRuns = canonicalizeDateRuns(runs);

  function walkReplace(node: PerformancePredicate, allowed: boolean): PerformancePredicate {
    switch (node.kind) {
      case "AND": {
        const newOf = node.of.map((child) => walkReplace(child, allowed));
        return { kind: "AND", of: newOf };
      }
      case "OR": {
        if (allowed) {
          const allDate = node.of.every((c) => c.kind === "DATE_RANGE");
          const anyDate = node.of.some((c) => c.kind === "DATE_RANGE");
          if (allDate && anyDate) {
            if (canonicalRuns.length === 1) {
              const only = canonicalRuns[0]!;
              return { kind: "DATE_RANGE", from: only.from, to: only.to };
            }
            return {
              kind: "OR",
              of: canonicalRuns.map((r) => ({
                kind: "DATE_RANGE" as const,
                from: r.from,
                to: r.to,
              })),
            };
          }
          if (anyDate) {
            throw new SearchSpecNormalizationError(
              "date scope OR must contain only DATE_RANGE children",
              "date_or_mixed",
            );
          }
          return { kind: "OR", of: node.of.map((child) => walkReplace(child, false)) };
        }
        return { kind: "OR", of: node.of.map((child) => walkReplace(child, false)) };
      }
      case "NOT": {
        return { kind: "NOT", of: walkReplace(node.of, false) };
      }
      case "DATE_RANGE": {
        if (allowed) {
          if (canonicalRuns.length === 1) {
            const only = canonicalRuns[0]!;
            return { kind: "DATE_RANGE", from: only.from, to: only.to };
          }
          return {
            kind: "OR",
            of: canonicalRuns.map((r) => ({
              kind: "DATE_RANGE" as const,
              from: r.from,
              to: r.to,
            })),
          };
        }
        throw new SearchSpecNormalizationError(
          "DATE_RANGE under NOT or nested OR",
          "date_under_not_or_nested_or",
        );
      }
      case "TIME_WINDOW":
      case "MOVIE":
      case "ATTRIBUTE":
      case "AUDITORIUM":
      case "PRICE":
      case "RUNTIME":
      case "FORMAT":
        return node;
    }
  }

  return walkReplace(where, true);
}

/**
 * S53.1 — pure exported version-aware normalization/validation entry point.
 * Parses the existing grammar only; for specVersion 2 locates exactly one
 * date scope reachable through AND nodes and canonicalizes it before any
 * hashing/planning/persistence. For specVersion 1 returns the spec unchanged
 * (byte-for-byte identical). Throws SearchSpecNormalizationError (BAD_REQUEST)
 * for every forbidden v2 tree shape.
 */
export function normalizeSearchSpec(input: unknown): SearchSpec {
  const spec = SearchSpecSchema.parse(omitExplicitNull(input));
  if (spec.specVersion === 1) {
    return spec;
  }
  if (spec.specVersion !== 2) {
    return spec;
  }
  const normalizedWhere = normalizeWhereForV2(spec.where);
  return { ...spec, where: normalizedWhere };
}

/**
 * Version-aware product throttle (ADR 0003 §4 + ADR 0050 §2/§4).
 * For specVersion 1 delegates to validateSearchSpecV1 exactly.
 * For specVersion 2 applies the same limits but allows specVersion 2
 * and uses the same span/selector/complexity/movie-required checks.
 * Any other specVersion yields SPEC_VERSION_UNSUPPORTED.
 */
export function validateSearchSpec(
  spec: SearchSpec,
  contextInput: SearchValidationContext,
  limitsInput: SearchLimits = DEFAULT_SEARCH_LIMITS,
): readonly SearchSpecValidationIssue[] {
  if (spec.specVersion === 1) {
    return validateSearchSpecV1(spec, contextInput, limitsInput);
  }
  if (spec.specVersion === 2) {
    const context = SearchValidationContextSchema.parse(contextInput);
    const limits = SearchLimitsSchema.parse(limitsInput);
    const issues: SearchSpecValidationIssue[] = [];
    const spanDays =
      epochDay(context.resolvedDateSpan.to) - epochDay(context.resolvedDateSpan.from) + 1;
    if (spanDays > limits.maxDateSpanDays) {
      issues.push({ code: "RANGE_TOO_LARGE" });
    }
    if (context.resolvedDateSpan.to < context.today) {
      issues.push({ code: "RANGE_IN_PAST" });
    }
    if (
      context.resolvedShowtimeCount !== undefined &&
      context.resolvedShowtimeCount > limits.maxResolvedShowtimes
    ) {
      issues.push({ code: "TOO_MANY_SHOWTIMES", count: context.resolvedShowtimeCount });
    }
    const requestedPartySize = partySize(spec.group);
    if (requestedPartySize !== undefined && requestedPartySize > limits.maxPartySize) {
      issues.push({ code: "GROUP_TOO_LARGE" });
    }
    if (spec.group?.kind === "SPLIT" && !limits.splitGroupEnabled) {
      issues.push({ code: "GROUP_SHAPE_UNSUPPORTED" });
    }
    if (
      (spec.theatres.kind === "AREA" &&
        (!limits.areaSelectorEnabled ||
          spec.theatres.limit > limits.maxTheatres ||
          spec.theatres.radiusKm > limits.maxAreaRadiusKm)) ||
      (spec.theatres.kind === "LIST" && spec.theatres.refs.length > limits.maxTheatres)
    ) {
      issues.push({ code: "SELECTOR_UNSUPPORTED" });
    }
    const hasMismatchedTheatre =
      spec.theatres.kind === "LIST" &&
      spec.theatres.refs.some((reference) => providerNamespace(reference.id) !== spec.providerId);
    const hasMismatchedMovie = movieIds(spec.where).some(
      (movieId) => providerNamespace(movieId) !== spec.providerId,
    );
    if (
      (hasMismatchedTheatre || hasMismatchedMovie) &&
      !issues.some((issue) => issue.code === "SELECTOR_UNSUPPORTED")
    ) {
      issues.push({ code: "SELECTOR_UNSUPPORTED" });
    }
    const predicateSize = treeSize(spec.where);
    if (
      predicateSize.depth > limits.maxPredicateDepth ||
      predicateSize.nodes > limits.maxPredicateNodes
    ) {
      issues.push({ code: "PREDICATE_TOO_COMPLEX" });
    }
    for (const region of [spec.region, spec.groupRegion]) {
      if (region === undefined) continue;
      const regionSize = treeSize(region);
      if (regionSize.depth > limits.maxRegionDepth || regionSize.nodes > limits.maxRegionNodes) {
        issues.push({ code: "REGION_TOO_COMPLEX" });
        break;
      }
    }
    if (!isMovieBound(spec.where)) {
      issues.push({ code: "MOVIE_REQUIRED" });
    }
    return issues;
  }
  return [{ code: "SPEC_VERSION_UNSUPPORTED" }];
}

export const SearchLimitsSchema = z.strictObject({
  maxDateSpanDays: positiveInteger,
  maxResolvedShowtimes: z.number().int().nonnegative(),
  maxPartySize: positiveInteger,
  maxTheatres: positiveInteger,
  areaSelectorEnabled: z.boolean(),
  maxAreaRadiusKm: finiteNumber.positive(),
  splitGroupEnabled: z.boolean(),
  maxPredicateDepth: positiveInteger,
  maxPredicateNodes: positiveInteger,
  maxRegionDepth: positiveInteger,
  maxRegionNodes: positiveInteger,
});
export type SearchLimits = z.infer<typeof SearchLimitsSchema>;

/**
 * ADR 0029 §4: `maxTheatres` (renamed from `maxListTheatres`) replaces the v1
 * single-theatre-only cap of 1 with ADR 0003 §4 V2's own previously-non-binding number,
 * now made binding; it bounds both `LIST.refs.length` and `AREA.limit`. `maxAreaRadiusKm`
 * (40) is genuinely new — modest headroom over the "20 miles" example, ADR 0029 §4.
 * `areaSelectorEnabled` is `true`: ADR 0029 §3's orchestration wiring
 * (`searches.create`'s AREA resolution step, S37) landed alongside this flip — never a
 * standalone validator-only change.
 */
export const DEFAULT_SEARCH_LIMITS: Readonly<SearchLimits> = Object.freeze({
  maxDateSpanDays: 30,
  maxResolvedShowtimes: 200,
  maxPartySize: 6,
  maxTheatres: 25,
  areaSelectorEnabled: true,
  maxAreaRadiusKm: 40,
  splitGroupEnabled: false,
  maxPredicateDepth: 6,
  maxPredicateNodes: 30,
  maxRegionDepth: 6,
  maxRegionNodes: 20,
});

export const SearchSpecValidationCodeSchema = z.enum([
  "SPEC_VERSION_UNSUPPORTED",
  "RANGE_TOO_LARGE",
  "RANGE_IN_PAST",
  "TOO_MANY_SHOWTIMES",
  "GROUP_TOO_LARGE",
  "GROUP_SHAPE_UNSUPPORTED",
  "SELECTOR_UNSUPPORTED",
  "PREDICATE_TOO_COMPLEX",
  "REGION_TOO_COMPLEX",
  "UNBOUNDED_QUERY",
  "MOVIE_REQUIRED",
]);
export type SearchSpecValidationCode = z.infer<typeof SearchSpecValidationCodeSchema>;

const validationIssueWithoutCountSchema = z.strictObject({
  code: SearchSpecValidationCodeSchema.exclude(["TOO_MANY_SHOWTIMES"]),
});
const tooManyShowtimesIssueSchema = z.strictObject({
  code: z.literal("TOO_MANY_SHOWTIMES"),
  count: z.number().int().nonnegative(),
});
export const SearchSpecValidationIssueSchema = z.union([
  validationIssueWithoutCountSchema,
  tooManyShowtimesIssueSchema,
]);
export type SearchSpecValidationIssue = z.infer<typeof SearchSpecValidationIssueSchema>;

export const SearchValidationContextSchema = z.strictObject({
  today: z.iso.date(),
  resolvedDateSpan: z
    .strictObject({ from: z.iso.date(), to: z.iso.date() })
    .refine((span) => span.from <= span.to, { message: "resolved span from must not exceed to" }),
  resolvedShowtimeCount: z.number().int().nonnegative().optional(),
});
export type SearchValidationContext = z.infer<typeof SearchValidationContextSchema>;

type TreeNode = { readonly kind: string; readonly of?: TreeNode | readonly TreeNode[] };

function isTreeNodeArray(value: TreeNode | readonly TreeNode[]): value is readonly TreeNode[] {
  return Array.isArray(value);
}

function treeChildren(root: TreeNode): readonly TreeNode[] {
  if (root.of === undefined) {
    return [];
  }
  return isTreeNodeArray(root.of) ? root.of : [root.of];
}

function treeSize(root: TreeNode): { readonly depth: number; readonly nodes: number } {
  let depth = 1;
  let nodes = 1;
  for (const child of treeChildren(root)) {
    const childSize = treeSize(child);
    depth = Math.max(depth, childSize.depth + 1);
    nodes += childSize.nodes;
  }
  return { depth, nodes };
}

/**
 * A predicate tree is "movie-bound" when every satisfying assignment is constrained by at
 * least one `MOVIE` predicate. This is a semantic property of the boolean structure, not a
 * syntactic "does a MOVIE node appear anywhere" check — the latter is bypassable via `NOT`
 * (`NOT(MOVIE(x))` is a movie-LESS predicate by construction: it matches everything except
 * `x`'s movie) and via an `OR` branch that doesn't mention `MOVIE` at all (`OR[MOVIE(x),
 * ATTRIBUTE(IMAX)]` is satisfied by the `ATTRIBUTE` branch alone, with no movie constraint).
 *
 * Rule, defined per node kind:
 *   - `MOVIE` leaf        → bound (trivially — it *is* the constraint).
 *   - any other leaf      → not bound.
 *   - `AND(children)`     → bound if ANY child is bound. `AND` requires every child to hold
 *                           simultaneously, so once one child pins the result to a movie, the
 *                           whole conjunction is pinned too — the other conjuncts can only
 *                           narrow further, never escape the movie constraint.
 *   - `OR(children)`      → bound only if EVERY child is bound. `OR` is satisfied by any single
 *                           branch, so one unbound branch is a way to satisfy the whole
 *                           predicate with no movie constraint at all — exactly the
 *                           `OR[MOVIE, ATTRIBUTE]` bypass this function exists to close.
 *   - `NOT(child)`        → never bound, regardless of what is inside. Nested negation
 *                           (`NOT(NOT(MOVIE(x)))`) is logically equivalent to `MOVIE(x)`, but
 *                           this function performs no double-negation elimination or other
 *                           boolean simplification — `NOT` is treated as an opaque,
 *                           never-binding barrier. This is the deliberately CONSERVATIVE
 *                           (reject) choice for a construct this function does not attempt to
 *                           reason through further; a permissive answer here would require
 *                           general boolean simplification to be correct, which is out of
 *                           scope for a validator-layer check.
 *
 * The schema enforces `of.length >= 1` for `AND`/`OR`, so the empty-array case never reaches
 * this function. A single-child `AND`/`OR` (however it arose) reduces `.some`/`.every` on a
 * one-element array to that one child's own bound-ness, which is the correct answer for a
 * collapsed single-child boolean node — no special case needed.
 */
function isMovieBound(node: PerformancePredicate): boolean {
  if (node.kind === "MOVIE") {
    return true;
  }
  if (node.kind === "AND") {
    return node.of.some((child) => isMovieBound(child));
  }
  if (node.kind === "OR") {
    return node.of.every((child) => isMovieBound(child));
  }
  return false;
}

function partySize(group: GroupShape | undefined): number | undefined {
  if (group === undefined) {
    return undefined;
  }
  return group.kind === "BLOCK" ? group.rows * group.cols : group.count;
}

function epochDay(localDate: string): number {
  const [yearText, monthText, dayText] = localDate.split("-");
  return Math.floor(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)) / (24 * 60 * 60 * 1_000),
  );
}

/** Applies the configurable v1 product throttle to an already parsed SearchSpec. */
export function validateSearchSpecV1(
  spec: SearchSpec,
  contextInput: SearchValidationContext,
  limitsInput: SearchLimits = DEFAULT_SEARCH_LIMITS,
): readonly SearchSpecValidationIssue[] {
  const context = SearchValidationContextSchema.parse(contextInput);
  const limits = SearchLimitsSchema.parse(limitsInput);
  const issues: SearchSpecValidationIssue[] = [];
  const spanDays =
    epochDay(context.resolvedDateSpan.to) - epochDay(context.resolvedDateSpan.from) + 1;

  if (spec.specVersion !== 1) {
    issues.push({ code: "SPEC_VERSION_UNSUPPORTED" });
  }
  if (spanDays > limits.maxDateSpanDays) {
    issues.push({ code: "RANGE_TOO_LARGE" });
  }
  if (context.resolvedDateSpan.to < context.today) {
    issues.push({ code: "RANGE_IN_PAST" });
  }
  if (
    context.resolvedShowtimeCount !== undefined &&
    context.resolvedShowtimeCount > limits.maxResolvedShowtimes
  ) {
    issues.push({ code: "TOO_MANY_SHOWTIMES", count: context.resolvedShowtimeCount });
  }

  const requestedPartySize = partySize(spec.group);
  if (requestedPartySize !== undefined && requestedPartySize > limits.maxPartySize) {
    issues.push({ code: "GROUP_TOO_LARGE" });
  }
  if (spec.group?.kind === "SPLIT" && !limits.splitGroupEnabled) {
    issues.push({ code: "GROUP_SHAPE_UNSUPPORTED" });
  }
  if (
    (spec.theatres.kind === "AREA" &&
      (!limits.areaSelectorEnabled ||
        spec.theatres.limit > limits.maxTheatres ||
        spec.theatres.radiusKm > limits.maxAreaRadiusKm)) ||
    (spec.theatres.kind === "LIST" && spec.theatres.refs.length > limits.maxTheatres)
  ) {
    issues.push({ code: "SELECTOR_UNSUPPORTED" });
  }
  const hasMismatchedTheatre =
    spec.theatres.kind === "LIST" &&
    spec.theatres.refs.some((reference) => providerNamespace(reference.id) !== spec.providerId);
  const hasMismatchedMovie = movieIds(spec.where).some(
    (movieId) => providerNamespace(movieId) !== spec.providerId,
  );
  if (
    (hasMismatchedTheatre || hasMismatchedMovie) &&
    !issues.some((issue) => issue.code === "SELECTOR_UNSUPPORTED")
  ) {
    issues.push({ code: "SELECTOR_UNSUPPORTED" });
  }

  const predicateSize = treeSize(spec.where);
  if (
    predicateSize.depth > limits.maxPredicateDepth ||
    predicateSize.nodes > limits.maxPredicateNodes
  ) {
    issues.push({ code: "PREDICATE_TOO_COMPLEX" });
  }
  for (const region of [spec.region, spec.groupRegion]) {
    if (region === undefined) {
      continue;
    }
    const regionSize = treeSize(region);
    if (regionSize.depth > limits.maxRegionDepth || regionSize.nodes > limits.maxRegionNodes) {
      issues.push({ code: "REGION_TOO_COMPLEX" });
      break;
    }
  }
  if (!isMovieBound(spec.where)) {
    issues.push({ code: "MOVIE_REQUIRED" });
  }

  return issues;
}

/** SearchSpec parser with the v1 throttle attached as stable-code Zod refinements. */
export function createSearchSpecV1Schema(
  contextInput: SearchValidationContext,
  limitsInput: SearchLimits = DEFAULT_SEARCH_LIMITS,
) {
  const context = SearchValidationContextSchema.parse(contextInput);
  const limits = SearchLimitsSchema.parse(limitsInput);
  return SearchSpecSchema.superRefine((spec, refinementContext) => {
    for (const issue of validateSearchSpecV1(spec, context, limits)) {
      refinementContext.addIssue({
        code: "custom",
        message: issue.code,
        params: {
          validationCode: issue.code,
          ...(issue.code === "TOO_MANY_SHOWTIMES" ? issue : {}),
        },
      });
    }
  });
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue | undefined };

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !isJsonArray(value);
}

function compareLexicographically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter((entry) => entry[1] !== null && entry[1] !== undefined)
    .sort(([left], [right]) => compareLexicographically(left, right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item as JsonValue)}`)
    .join(",")}}`;
}

function normalizeBooleanTree(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) {
    return value;
  }
  const kind = value.kind;
  if ((kind === "AND" || kind === "OR") && value.of !== undefined && isJsonArray(value.of)) {
    const byCanonical = new Map<string, JsonValue>();
    for (const child of value.of) {
      const normalized = normalizeBooleanTree(child);
      byCanonical.set(canonicalJson(normalized), normalized);
    }
    const children = Array.from(byCanonical.entries())
      .sort(([left], [right]) => compareLexicographically(left, right))
      .map((entry) => entry[1]);
    if (children.length === 1) {
      return children[0] as JsonValue;
    }
    return { ...value, of: children };
  }
  if (kind === "NOT" && value.of !== undefined) {
    return { ...value, of: normalizeBooleanTree(value.of) };
  }
  return value;
}

function hashableSpec(spec: SearchSpec): JsonObject {
  const theatres: JsonValue =
    spec.theatres.kind === "LIST"
      ? { kind: "LIST", refs: spec.theatres.refs.map((reference) => ({ id: reference.id })) }
      : {
          kind: "AREA",
          center: {
            lat: Math.round(spec.theatres.center.lat * 100_000) / 100_000,
            lng: Math.round(spec.theatres.center.lng * 100_000) / 100_000,
          },
          radiusKm: spec.theatres.radiusKm,
          limit: spec.theatres.limit,
        };

  return {
    ...spec,
    theatres,
    where: normalizeBooleanTree(spec.where),
    region: spec.region === undefined ? undefined : normalizeBooleanTree(spec.region),
    groupRegion:
      spec.groupRegion === undefined ? undefined : normalizeBooleanTree(spec.groupRegion),
  };
}

function omitExplicitNull(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => omitExplicitNull(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== null)
      .map(([key, item]) => [key, omitExplicitNull(item)]),
  );
}

/** Canonical JSON used by specHash; exported so golden tests and persistence can inspect it. */
export function canonicalizeSearchSpec(input: unknown): string {
  const normalized = normalizeSearchSpec(input);
  return canonicalJson(hashableSpec(normalized));
}

/** Stable SHA-256 content address for a SearchSpec. */
export function specHash(input: unknown): string {
  return sha256(canonicalizeSearchSpec(input));
}
