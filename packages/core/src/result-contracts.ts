import { z } from "zod";

import {
  DEFAULT_SEARCH_LIMITS,
  SearchSpecSchema,
  type PerformancePredicate,
} from "./search-spec.js";
import { TheatreSchema } from "./theatre.js";
import { IanaTimezoneSchema } from "./timezone.js";
import { MovieIdSchema, ShowtimeIdSchema, TheatreIdSchema } from "./ids.js";

// `IanaTimezoneSchema` now lives in `timezone.ts` (S20) so `result-contracts.ts` can
// import `TheatreSchema` from `theatre.ts` without an ESM import cycle (`theatre.ts`
// itself imports `IanaTimezoneSchema`). Re-exported here so the many existing consumers
// that import it from `./result-contracts.js` keep working unchanged.
export { IanaTimezoneSchema, type IanaTimezone } from "./timezone.js";

const nonemptyString = z.string().min(1);
const finiteNumber = z.number().finite();
const nonnegativeInteger = z.number().int().nonnegative();
const nonnegativeNumber = finiteNumber.nonnegative();

export const UtcInstantSchema = z.iso
  .datetime({ offset: false, local: false })
  .refine((value) => value.endsWith("Z"), { message: "instant must use the UTC Z suffix" });
export type UtcInstant = z.infer<typeof UtcInstantSchema>;

export const MoneySchema = z.strictObject({
  amount: nonnegativeNumber,
  currency: z.string().regex(/^[A-Z]{3}$/),
  basis: z.enum(["TICKET_ONLY", "UNKNOWN"]),
});
export type Money = z.infer<typeof MoneySchema>;

export const ShowtimeStatusSchema = z.enum([
  "OPEN",
  "LOW_AVAILABILITY",
  "SOLD_OUT",
  "CANCELED",
  "UNKNOWN",
]);
export type ShowtimeStatus = z.infer<typeof ShowtimeStatusSchema>;

export const PlacementSchema = z.strictObject({
  layoutId: nonemptyString,
  row: nonnegativeInteger,
  startCol: nonnegativeInteger,
  rowSpan: z.number().int().positive(),
  count: z.number().int().positive(),
  seatNames: z.array(nonemptyString).min(1),
  placementKey: nonemptyString,
});
export type Placement = z.infer<typeof PlacementSchema>;

const centeredReasonSchema = z.strictObject({
  kind: z.literal("CENTERED"),
  lateralPct: finiteNumber,
});
const middleThirdReasonSchema = z.strictObject({ kind: z.literal("MIDDLE_THIRD") });
const togetherReasonSchema = z.strictObject({
  kind: z.literal("TOGETHER"),
  count: z.number().int().positive(),
});
const aisleAdjacentReasonSchema = z.strictObject({ kind: z.literal("AISLE_ADJACENT") });
const multiShowtimeReasonSchema = z.strictObject({
  kind: z.literal("MULTI_SHOWTIME"),
  count: z.number().int().positive(),
});
const avoidsFrontReasonSchema = z.strictObject({ kind: z.literal("AVOIDS_FRONT") });
/**
 * Reserved per ADR 0003 §9: the accessibility field on `SearchSpec` needs a corresponding
 * `RecommendationReason` variant so the open-enum contract can round-trip it once the gate-22
 * ranking/presentation policy is decided. Only the shape is reserved here — no ranking,
 * filtering, or presentation semantics are implemented against it.
 */
const accessibleRequestedReasonSchema = z.strictObject({ kind: z.literal("ACCESSIBLE_REQUESTED") });
const knownRecommendationReasonSchema = z.discriminatedUnion("kind", [
  centeredReasonSchema,
  middleThirdReasonSchema,
  togetherReasonSchema,
  aisleAdjacentReasonSchema,
  multiShowtimeReasonSchema,
  avoidsFrontReasonSchema,
  accessibleRequestedReasonSchema,
]);
const knownRecommendationReasonKinds = new Set([
  "CENTERED",
  "MIDDLE_THIRD",
  "TOGETHER",
  "AISLE_ADJACENT",
  "MULTI_SHOWTIME",
  "AVOIDS_FRONT",
  "ACCESSIBLE_REQUESTED",
]);
const unknownRecommendationReasonSchema = z
  .looseObject({ kind: nonemptyString, label: z.string().optional() })
  .refine((value) => !knownRecommendationReasonKinds.has(value.kind), {
    message: "known recommendation reason kind must match its documented shape",
  });

export const RecommendationReasonSchema = knownRecommendationReasonSchema.or(
  unknownRecommendationReasonSchema,
);
export type RecommendationReason = z.infer<typeof RecommendationReasonSchema>;

const outsideRegionRelaxationSchema = z.strictObject({
  kind: z.literal("OUTSIDE_REGION"),
  region: nonemptyString,
});
const earlierRelaxationSchema = z.strictObject({ kind: z.literal("EARLIER_THAN_PREFERRED") });
const laterRelaxationSchema = z.strictObject({ kind: z.literal("LATER_THAN_PREFERRED") });
const differentFormatRelaxationSchema = z.strictObject({
  kind: z.literal("DIFFERENT_FORMAT"),
  from: nonemptyString,
  to: nonemptyString,
});
const fewerShowtimesRelaxationSchema = z.strictObject({ kind: z.literal("FEWER_SHOWTIMES") });
// E7.7 — UNRESOLVED_SHOWTIMES (ADR 0033): fires whenever this candidate's group has at least
// one showtime it could not resolve (`count` = unresolved entries in `group.showtimes`). Per
// ADR 0003's matrix, COMPLETE requires "all accepted", so this can only occur when the search
// is PARTIAL or HALTED; it routes an otherwise-perfect placement into HEDGED instead of being
// silently discarded as `exact` (which only promotes to CONFIDENT under COMPLETE).
const unresolvedShowtimesRelaxationSchema = z.strictObject({
  kind: z.literal("UNRESOLVED_SHOWTIMES"),
  count: z.number().int().positive(),
});
const knownRelaxationSchema = z.discriminatedUnion("kind", [
  outsideRegionRelaxationSchema,
  earlierRelaxationSchema,
  laterRelaxationSchema,
  differentFormatRelaxationSchema,
  fewerShowtimesRelaxationSchema,
  unresolvedShowtimesRelaxationSchema,
]);
const knownRelaxationKinds = new Set([
  "OUTSIDE_REGION",
  "EARLIER_THAN_PREFERRED",
  "LATER_THAN_PREFERRED",
  "DIFFERENT_FORMAT",
  "FEWER_SHOWTIMES",
  "UNRESOLVED_SHOWTIMES",
]);
const unknownRelaxationSchema = z
  .looseObject({ kind: nonemptyString, label: z.string().optional() })
  .refine((value) => !knownRelaxationKinds.has(value.kind), {
    message: "known relaxation kind must match its documented shape",
  });

export const RelaxationSchema = knownRelaxationSchema.or(unknownRelaxationSchema);
export type Relaxation = z.infer<typeof RelaxationSchema>;

const widenWindowSchema = z.strictObject({
  kind: z.literal("WIDEN_WINDOW"),
  direction: z.enum(["EARLIER", "LATER", "FULL_DAY"]),
});
const nearbyTheatreSchema = z.strictObject({
  kind: z.literal("NEARBY_THEATRE"),
  theatreId: nonemptyString,
  distanceKm: nonnegativeNumber,
});
const otherFormatSchema = z.strictObject({
  kind: z.literal("OTHER_FORMAT"),
  formatCode: nonemptyString,
});
const splitPartySchema = z.strictObject({
  kind: z.literal("SPLIT_PARTY"),
  groups: z.array(z.number().int().positive()).min(2),
});
const knownSuggestedWidenSchema = z.discriminatedUnion("kind", [
  widenWindowSchema,
  nearbyTheatreSchema,
  otherFormatSchema,
  splitPartySchema,
]);
const knownSuggestedWidenKinds = new Set([
  "WIDEN_WINDOW",
  "NEARBY_THEATRE",
  "OTHER_FORMAT",
  "SPLIT_PARTY",
]);
const unknownSuggestedWidenSchema = z
  .looseObject({ kind: nonemptyString, label: z.string().optional() })
  .refine((value) => !knownSuggestedWidenKinds.has(value.kind), {
    message: "known suggested-widen kind must match its documented shape",
  });

export const SuggestedWidenSchema = knownSuggestedWidenSchema.or(unknownSuggestedWidenSchema);
export type SuggestedWiden = z.infer<typeof SuggestedWidenSchema>;

export const FormatPointerSchema = z.strictObject({
  formatCode: nonemptyString,
  bestRunScore: finiteNumber,
});
export type FormatPointer = z.infer<typeof FormatPointerSchema>;

export const EmptyCauseSchema = z.enum([
  "SOLD_OUT",
  "TOO_FEW_SHOWTIMES",
  "NO_SHAPE_MATCH",
  "HALTED",
  "CAPACITY",
  "PARTIAL_SCHEDULE",
]);
export type EmptyCause = z.infer<typeof EmptyCauseSchema>;

export const SearchStatusSchema = z.enum([
  "PENDING_SCHEDULE",
  "RUNNING",
  "COMPLETE",
  "PARTIAL",
  "HALTED",
  "CANCELLED",
]);
export type SearchStatus = z.infer<typeof SearchStatusSchema>;

export const PerTheatreExcludedCountsSchema = z
  .strictObject({
    soldOut: nonnegativeInteger,
    outsideWindow: nonnegativeInteger,
    outsideRegion: nonnegativeInteger,
    outsideArea: nonnegativeInteger,
    wrongAttributes: nonnegativeInteger,
    overPrice: nonnegativeInteger,
    notReservedSeating: nonnegativeInteger,
    fetchFailed: nonnegativeInteger,
    fetchFailedByCause: z.record(nonemptyString, nonnegativeInteger),
  })
  .refine(
    (counts) =>
      Object.values(counts.fetchFailedByCause).reduce((sum, count) => sum + count, 0) ===
      counts.fetchFailed,
    { message: "fetchFailed must equal the fetchFailedByCause total" },
  );
export type PerTheatreExcludedCounts = z.infer<typeof PerTheatreExcludedCountsSchema>;

export const ExcludedCountsSchema = z
  .strictObject({
    soldOut: nonnegativeInteger,
    outsideWindow: nonnegativeInteger,
    outsideRegion: nonnegativeInteger,
    outsideArea: nonnegativeInteger,
    wrongAttributes: nonnegativeInteger,
    overPrice: nonnegativeInteger,
    notReservedSeating: nonnegativeInteger,
    fetchFailed: nonnegativeInteger,
    fetchFailedByCause: z.record(nonemptyString, nonnegativeInteger),
    byTheatre: z.record(nonemptyString, PerTheatreExcludedCountsSchema).default({}),
  })
  .refine(
    (counts) =>
      Object.values(counts.fetchFailedByCause).reduce((sum, count) => sum + count, 0) ===
      counts.fetchFailed,
    { message: "fetchFailed must equal the fetchFailedByCause total" },
  );
export type ExcludedCounts = z.infer<typeof ExcludedCountsSchema>;

export const CreateResultGroupSchema = z.strictObject({
  layoutId: nonemptyString,
  theatreId: nonemptyString,
  distanceKm: nonnegativeNumber.nullable(),
  formatCode: nonemptyString,
  auditorium: z.union([nonemptyString, z.number().int()]).nullable(),
  showtimeCount: nonnegativeInteger,
});
export type CreateResultGroup = z.infer<typeof CreateResultGroupSchema>;

export const ScheduleSkeletonEntrySchema = z.strictObject({
  showtimeId: ShowtimeIdSchema,
  theatreId: TheatreIdSchema,
  showDateTimeLocal: nonemptyString,
  formatCode: z.string().nullable(),
  distanceKm: finiteNumber.nullable(),
  rank: nonnegativeInteger,
  admitted: z.boolean(),
  resolved: z.boolean(),
  // ADR 0057 Rec 3.1 — terminal fetch-outcome attribution for an unresolved-looking row.
  // `undefined` (every pre-existing entry, and any entry whose `SHOWTIME_FETCH` job hasn't
  // terminalized yet) means "not yet known" — never fabricated, never defaulted to "OK".
  // "SOLD_OUT" mirrors the theatre's own reported performance status (not a fetch failure).
  // "FAILED" means the scrape job terminalized without producing a seat snapshot.
  fetchStatus: z.enum(["OK", "FAILED", "SOLD_OUT"]).optional(),
});
export type ScheduleSkeletonEntry = z.infer<typeof ScheduleSkeletonEntrySchema>;

export const CreateSearchInputSchema = z.strictObject({
  spec: SearchSpecSchema,
  idempotencyKey: nonemptyString,
  continuesSearchId: z.string().optional(),
});
export type CreateSearchInput = z.infer<typeof CreateSearchInputSchema>;

// The approved documents do not settle whether cold-create counts should be absent or null.
// Preserve the reviewed wire shape explicitly until that transport ambiguity is resolved.
const pendingCreateSearchResponseSchema = z.strictObject({
  status: z.literal("PENDING_SCHEDULE"),
  searchId: nonemptyString,
  showtimeCount: z.null(),
  cachedCount: z.null(),
  estimatedMs: nonnegativeInteger,
  groups: z.array(CreateResultGroupSchema),
  scheduleSkeleton: z.array(ScheduleSkeletonEntrySchema),
});
const runningCreateSearchResponseSchema = z.strictObject({
  status: z.literal("RUNNING"),
  searchId: nonemptyString,
  showtimeCount: nonnegativeInteger,
  cachedCount: nonnegativeInteger,
  estimatedMs: nonnegativeInteger,
  groups: z.array(CreateResultGroupSchema),
  scheduleSkeleton: z.array(ScheduleSkeletonEntrySchema),
});
export const CreateSearchResponseSchema = z.discriminatedUnion("status", [
  pendingCreateSearchResponseSchema,
  runningCreateSearchResponseSchema,
]);
export type CreateSearchResponse = z.infer<typeof CreateSearchResponseSchema>;

export const IdempotencyKeyConflictSchema = z.strictObject({
  code: z.literal("IDEMPOTENCY_KEY_CONFLICT"),
  searchId: nonemptyString,
});
export type IdempotencyKeyConflict = z.infer<typeof IdempotencyKeyConflictSchema>;

/**
 * `searches.cancel` response (S23, ADR 0018): the search's resulting status — `CANCELLED`
 * on a live cancel, or the echoed existing terminal status on the idempotent no-op (S23.5).
 */
export const CancelSearchResponseSchema = z.strictObject({
  searchId: nonemptyString,
  status: SearchStatusSchema,
});
export type CancelSearchResponse = z.infer<typeof CancelSearchResponseSchema>;

/**
 * 429 admission-rejection body (`searches.create`, S15.9). The VALUE of
 * `retryAfterSeconds` is deliberately not fixed by any accepted document — it is an
 * injected, caller-supplied figure (S15.9 reports that gap explicitly rather than
 * picking a number; ADR 0006 §D.1 fixes the ceiling and mechanism, not this figure).
 * This schema pins the wire shape only: `code` discriminates it from the 409 conflict
 * above, and `retryAfterSeconds` feeds the `Retry-After` header verbatim.
 */
export const AdmissionRejectedErrorSchema = z.strictObject({
  code: z.literal("ADMISSION_REJECTED"),
  retryAfterSeconds: nonnegativeInteger,
});
export type AdmissionRejectedError = z.infer<typeof AdmissionRejectedErrorSchema>;

/**
 * 429 rate-limit body (S16.6) — the same "soft limit → 429" wire shape as the
 * admission rejection above, discriminated by `code`. `limit` names the per-session
 * limiter dimension that denied (ADR 0006 §A.6's four), and `retryAfterSeconds` feeds
 * the `Retry-After` header when non-null. The WINDOW dimensions derive it from window
 * mechanics (S16.5); the concurrency dimension's value is deliberately not fixed by any
 * accepted document and ships as `null` — that gap is a reported finding (S16.5), never
 * a silently-picked number.
 */
export const RateLimitErrorSchema = z.strictObject({
  code: z.literal("RATE_LIMITED"),
  limit: z.enum([
    "searches_per_hour",
    "fetches_per_hour",
    "concurrent_searches",
    "recheck_calls_per_minute",
    "facet_counts_per_minute",
    "resolve_place_per_minute",
    "suggest_place_per_minute",
  ]),
  retryAfterSeconds: z.union([nonnegativeInteger, z.null()]),
});
export type RateLimitError = z.infer<typeof RateLimitErrorSchema>;

/**
 * `session.bootstrap` response (S16.11; seatfirst-architecture.md:274). The limits
 * mirror the injected `SessionRateLimitConfig` the limiter itself consumes (one source
 * of truth), so a client sees exactly the windows that will be enforced against it.
 */
export const SessionBootstrapResponseSchema = z.strictObject({
  sessionId: nonemptyString,
  limits: z.strictObject({
    searchesPerHour: nonnegativeInteger,
    upstreamFetchesPerHour: nonnegativeInteger,
    concurrentSearches: nonnegativeInteger,
    recheckCallsPerMinute: nonnegativeInteger,
    facetCountsPerMinute: nonnegativeInteger,
    resolvePlacePerMinute: nonnegativeInteger,
    suggestPlacePerMinute: nonnegativeInteger,
  }),
});
export type SessionBootstrapResponse = z.infer<typeof SessionBootstrapResponseSchema>;

/**
 * `theatres.search` input (S20.0; `seatfirst-architecture.md:264`). `q` carries only the
 * codebase's existing `min(1)` non-empty-string convention — no longer minimum, no cap.
 * `lat`/`lng` are physically bounded exactly like `GeoPointSchema` (G1.2,
 * `theatre.ts:10-11`) and are a both-or-neither location pair. The response cap (50),
 * ordering (nearest-first), and envelope are decided by ADR 0016
 * (`docs/adr/0016-theatres-search-movies-response-limits.md`).
 */
export const TheatreSearchInputSchema = z
  .strictObject({
    q: z.string().optional(),
    lat: finiteNumber.min(-90).max(90).optional(),
    lng: finiteNumber.min(-180).max(180).optional(),
    radiusKm: finiteNumber.positive().optional(),
  })
  .refine(({ lat, lng }) => (lat === undefined) === (lng === undefined), {
    message: "lat and lng must be supplied together as a location pair",
  })
  .refine(
    ({ lat, lng, radiusKm }) => radiusKm === undefined || (lat !== undefined && lng !== undefined),
    {
      message: "radiusKm requires lat and lng",
    },
  )
  .superRefine((value, context) => {
    if (value.radiusKm !== undefined && value.radiusKm > DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm) {
      context.addIssue({
        code: "custom",
        message: "SELECTOR_UNSUPPORTED",
        params: { validationCode: "SELECTOR_UNSUPPORTED" },
        path: ["radiusKm"],
      });
    }
  });
export type TheatreSearchInput = z.infer<typeof TheatreSearchInputSchema>;

/**
 * One `theatres.search` hit (S20.1): the `Theatre` entity plus a `distanceKm` that is
 * non-null exactly when the caller supplied a `lat`/`lng` origin (S20.5). `nonnegative`
 * mirrors `nearbyTheatreSchema.distanceKm` (`result-contracts.ts`); `nullable` mirrors
 * G1.5's rule that a no-user-location context has no distance
 * (`docs/tasks/G1-theatre-entity-geo/spec.md`). `.extend` on the strict `TheatreSchema`
 * keeps its base fields strict.
 *
 * This is a **wire** schema (goes over tRPC HTTP JSON), so its timestamps use the repo's
 * wire convention `UtcInstantSchema` (ISO string, `Z` suffix) rather than inheriting
 * `TheatreSchema`'s domain-model `z.date()` (pg returns real `Date`s; JSON transport
 * serializes them to strings and `z.date()` cannot round-trip). The route converts
 * `Date` → `.toISOString()` when building a hit.
 */
export const TheatreSearchHitSchema = TheatreSchema.extend({
  distanceKm: nonnegativeNumber.nullable(),
  firstSeenAt: UtcInstantSchema,
  lastSeenAt: UtcInstantSchema,
});
export type TheatreSearchHit = z.infer<typeof TheatreSearchHitSchema>;

/**
 * `theatres.search` response (S20.1/S20.6) — envelope `{ theatres: [...] }` confirmed by
 * ADR 0016, capped at 50 results route-side (no pagination). The body today is always
 * `{ theatres: [] }` because the runtime catalogue is empty (S20 F1).
 */
export const TheatreSearchResponseSchema = z.strictObject({
  theatres: z.array(TheatreSearchHitSchema).max(50),
});
export type TheatreSearchResponse = z.infer<typeof TheatreSearchResponseSchema>;

/**
 * `theatres.movies` input (S21.0) — the namespaced theatre id plus an inclusive
 * `[from, to]` date span. The `from <= to` refine is the verbatim reuse of the existing
 * date-span convention (`search-spec.ts:104-111`), and the span-cap refine enforces
 * ADR 0016's 30-day ceiling (reusing §5.1's `RANGE_TOO_LARGE` figure, not a new number).
 * `z.iso.date()` yields UTC-midnight `Date`s, so the span is an exact day multiple — no
 * DST or clock drift. Both refines reject with tRPC's default `BAD_REQUEST` mapping.
 */
export const TheatreMoviesInputSchema = z
  .strictObject({
    theatreId: TheatreIdSchema,
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(({ from, to }) => from <= to, {
    message: "from must not exceed to",
  })
  .refine(({ from, to }) => (Date.parse(to) - Date.parse(from)) / 86_400_000 <= 30, {
    message: "date span must not exceed 30 days",
  });
export type TheatreMoviesInput = z.infer<typeof TheatreMoviesInputSchema>;

/**
 * One `theatres.movies` showtime (S21.6). Every field maps to a durable source: the
 * product columns S14 persists (`003_catalog.sql:45-58`) and the settled `Performance`
 * contract (`packages/providers/src/contract.ts:184-204`). `showDateTimeUtc` is the
 * `starts_at` timestamptz; `status` is carried verbatim (no `performancePolicy`
 * filtering, S21.7).
 */
const TheatreMovieShowtimeSchema = z.strictObject({
  showtimeId: ShowtimeIdSchema,
  showDateTimeUtc: UtcInstantSchema,
  status: ShowtimeStatusSchema,
  formatCode: z.string().nullable(),
  auditorium: z.string().nullable(),
  runtimeMinutes: z.number().int().positive().nullable(),
  deepLinkUrl: z.url(),
  attributes: z.array(z.string()),
});
export type TheatreMovieShowtime = z.infer<typeof TheatreMovieShowtimeSchema>;

/** One `theatres.movies` movie group: the catalogue title plus its showtimes (S21.6).
 * S25 (ADR 0019) adds `posterPath` — the TMDB-resolved poster, null on a first-time
 * cache miss or when TMDB has no match. Null is legitimate and expected, never fabricated.
 * S55 (ADR 0019 amendment 2026-09-02) adds `runtimeMinutes`/`genres` from the same
 * `tmdb_movie` row: `runtimeMinutes: null` and `genres: []` are the same legitimate
 * "not resolved yet" states, filled in asynchronously by the same backfill path. */
const TheatreMovieGroupSchema = z.strictObject({
  movieId: MovieIdSchema,
  title: nonemptyString,
  posterPath: z.string().nullable(),
  runtimeMinutes: z.number().int().positive().nullable(),
  genres: z.array(nonemptyString),
  showtimes: z.array(TheatreMovieShowtimeSchema),
});
export type TheatreMovieGroup = z.infer<typeof TheatreMovieGroupSchema>;

/**
 * `theatres.movies` response (S21.6) — envelope `{ theatreId, timezone, from, to, movies }`.
 * `timezone` is the theatre row's; a fully cold/empty span is an honest `movies: []`
 * (E5.13 posture), never a stub.
 * S63.2 (ADR 0100): `isWarm` is true iff every requested day in `[from, to]` is at
 * least soft-fresh per the tiered matrix — false when ANY day is stale-while-revalidate,
 * hard-cold, or absent. The UI uses it for the "data may be stale" affordance.
 */
export const TheatreMoviesResponseSchema = z.strictObject({
  theatreId: TheatreIdSchema,
  timezone: IanaTimezoneSchema,
  from: z.iso.date(),
  to: z.iso.date(),
  movies: z.array(TheatreMovieGroupSchema),
  isWarm: z.boolean(),
});
export type TheatreMoviesResponse = z.infer<typeof TheatreMoviesResponseSchema>;

export const RecheckInputSchema = z.strictObject({
  searchId: nonemptyString,
  showtimeId: nonemptyString,
  placementKey: nonemptyString,
  nonce: nonemptyString,
});
export type RecheckInput = z.infer<typeof RecheckInputSchema>;

export const RecoveryOptionSchema = z.discriminatedUnion("level", [
  z.strictObject({
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    placement: PlacementSchema,
    showtimeId: nonemptyString,
    relaxed: z.array(RelaxationSchema),
    requiresConsent: z.boolean(),
  }),
  z.strictObject({
    level: z.literal(4),
    placement: PlacementSchema,
    showtimeId: nonemptyString,
    relaxed: z.array(RelaxationSchema).min(1),
    requiresConsent: z.literal(true),
  }),
]);
export type RecoveryOption = z.infer<typeof RecoveryOptionSchema>;

export const RecheckResultSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("AVAILABLE"),
      placement: PlacementSchema,
      checkedAt: UtcInstantSchema,
    }),
    z.strictObject({
      status: z.literal("GONE"),
      recovery: z.array(RecoveryOptionSchema).min(1),
    }),
    z.strictObject({
      status: z.literal("UNAVAILABLE"),
      cause: z.enum([
        "RATE_LIMITED",
        "UPSTREAM_BLOCKED",
        "CHALLENGE_REQUIRED",
        "UPSTREAM_QUEUED",
        "UPSTREAM_CHANGED",
        "TIMEOUT",
        "UPSTREAM_UNAVAILABLE",
      ]),
      lastKnown: z.strictObject({
        placement: PlacementSchema,
        capturedAt: UtcInstantSchema,
      }),
    }),
  ])
  .superRefine((result, context) => {
    if (result.status !== "GONE") {
      return;
    }
    for (let index = 1; index < result.recovery.length; index += 1) {
      const previous = result.recovery[index - 1];
      const current = result.recovery[index];
      if (previous !== undefined && current !== undefined && previous.level > current.level) {
        context.addIssue({
          code: "custom",
          path: ["recovery", index, "level"],
          message: "recovery options must follow the level 1 to level 4 ladder",
        });
      }
    }
  });
export type RecheckResult = z.infer<typeof RecheckResultSchema>;

export const ResultContractConfigSchema = z.strictObject({
  providerHostAllowlists: z.record(nonemptyString, z.array(nonemptyString).min(1)),
});
export type ResultContractConfig = z.input<typeof ResultContractConfigSchema>;

function providerFromId(value: string): string | undefined {
  const separator = value.indexOf(":");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

function exactHttpsHostname(value: string): string | undefined {
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  const authority = match?.[1];
  if (authority === undefined || authority.includes("@") || authority.includes(":")) {
    return undefined;
  }
  return authority.toLowerCase();
}

function instantMilliseconds(value: UtcInstant): number {
  return Date.parse(value);
}

function resolvedDoesNotExceedTotal(event: { readonly resolved: number; readonly total: number }) {
  return event.resolved <= event.total;
}

const resolvedCountRefinement = {
  path: ["resolved"],
  message: "resolved must not exceed total",
};

/**
 * C4/ADR 0100 (Cold Mode) — visits movie ids for namespace validation, skipping
 * any MOVIE leaf that carries a `titles` fallback: the evaluator
 * (`matchesMovieLeaf` in search-spec.ts) matches by normalized title during
 * cold resolution when no id match is found, so a cross-namespace id on such a
 * leaf is admissible. Must stay consistent with `hasUnsupportedMovieSelector`
 * in search-spec.ts, which applies the same exception.
 */
function visitMovieIds(
  predicate: PerformancePredicate,
  visit: (id: string, index: number) => void,
): void {
  switch (predicate.kind) {
    case "MOVIE":
      // C4/ADR 0100 (Cold Mode) — a MOVIE leaf with a `titles` fallback resolves
      // by title, so none of its ids are subject to the namespace check.
      if (predicate.titles !== undefined) break;
      predicate.ids.forEach(visit);
      break;
    case "AND":
    case "OR":
      predicate.of.forEach((child) => visitMovieIds(child, visit));
      break;
    case "NOT":
      visitMovieIds(predicate.of, visit);
      break;
    case "ATTRIBUTE":
    case "AUDITORIUM":
    case "PRICE":
    case "RUNTIME":
    case "DATE_RANGE":
    case "TIME_WINDOW":
    case "FORMAT":
      break;
  }
}

/** Creates all schemas that contain provider-controlled deep links. */
export function createResultContractSchemas(configInput: ResultContractConfig) {
  const config = ResultContractConfigSchema.parse(configInput);
  const hostsByProvider = new Map(
    Object.entries(config.providerHostAllowlists).map(([providerId, hosts]) => [
      providerId,
      new Set(hosts.map((host) => host.toLowerCase())),
    ]),
  );

  const showtimeScheduleShape = {
    showtimeId: nonemptyString,
    theatreId: nonemptyString,
    distanceKm: nonnegativeNumber.nullable(),
    showDateTimeUtc: UtcInstantSchema,
    timezone: IanaTimezoneSchema,
    minPrice: MoneySchema.nullable(),
    status: ShowtimeStatusSchema,
    deepLinkUrl: z.url(),
  } as const;
  const showtimeFreshnessShape = {
    capturedAt: UtcInstantSchema,
    staleAfter: UtcInstantSchema,
  } as const;

  function validateShowtimeIdentity(
    offer: {
      readonly showtimeId: string;
      readonly theatreId: string;
      readonly deepLinkUrl: string;
    },
    context: z.core.$RefinementCtx,
  ): void {
    const showtimeProvider = providerFromId(offer.showtimeId);
    const theatreProvider = providerFromId(offer.theatreId);
    if (showtimeProvider === undefined || showtimeProvider !== theatreProvider) {
      context.addIssue({
        code: "custom",
        path: ["theatreId"],
        message: "showtimeId and theatreId must use the same namespaced provider",
        input: offer,
      });
      return;
    }

    const allowedHosts = hostsByProvider.get(showtimeProvider);
    const hostname = exactHttpsHostname(offer.deepLinkUrl);
    if (hostname === undefined || allowedHosts === undefined || !allowedHosts.has(hostname)) {
      context.addIssue({
        code: "custom",
        path: ["deepLinkUrl"],
        message: "deep link must use HTTPS and an allowlisted host for its provider",
        input: offer,
      });
    }
  }

  function validateFreshness(
    offer: { readonly capturedAt: UtcInstant; readonly staleAfter: UtcInstant },
    context: z.core.$RefinementCtx,
  ): void {
    if (instantMilliseconds(offer.staleAfter) < instantMilliseconds(offer.capturedAt)) {
      context.addIssue({
        code: "custom",
        path: ["staleAfter"],
        message: "staleAfter must not precede capturedAt",
        input: offer,
      });
    }
  }

  const ShowtimeOfferSchema = z
    .strictObject({
      ...showtimeScheduleShape,
      ...showtimeFreshnessShape,
      // ADR 0017 — a single-use recheck nonce bound to {sessionId, searchId, resultVersion,
      // showtimeId, placementKey}. `null` until issued at serve time (S34); never persisted as a
      // minted token — the terminal answer stores the placeholder, the surface signs per serve.
      nonce: z.string().nullable(),
    })
    .superRefine((offer, context) => {
      validateShowtimeIdentity(offer, context);
      validateFreshness(offer, context);
    });

  const ResolvedGroupShowtimeSchema = z
    .strictObject({
      ...showtimeScheduleShape,
      ...showtimeFreshnessShape,
      resolved: z.literal(true),
      openCount: nonnegativeInteger,
    })
    .superRefine((showtime, context) => {
      validateShowtimeIdentity(showtime, context);
      validateFreshness(showtime, context);
    });
  const UnresolvedGroupShowtimeSchema = z
    .strictObject({
      ...showtimeScheduleShape,
      minPrice: z.null(),
      resolved: z.literal(false),
      openCount: z.null(),
    })
    .superRefine(validateShowtimeIdentity);
  const GroupShowtimeSchema = z.discriminatedUnion("resolved", [
    ResolvedGroupShowtimeSchema,
    UnresolvedGroupShowtimeSchema,
  ]);

  const RecommendationSchema = z.strictObject({
    placement: PlacementSchema,
    reasons: z.array(RecommendationReasonSchema).min(1),
    relaxed: z.array(RelaxationSchema),
    showtimes: z.array(ShowtimeOfferSchema).min(1),
  });

  const ConfidentAnswerSchema = z.strictObject({
    mode: z.literal("CONFIDENT"),
    primary: RecommendationSchema.extend({ relaxed: z.tuple([]) }),
    otherFormats: z.array(FormatPointerSchema),
  });
  const HedgedRecommendationSchema = RecommendationSchema.extend({
    relaxed: z.array(RelaxationSchema).min(1),
  });
  const HedgedAnswerSchema = z.strictObject({
    mode: z.literal("HEDGED"),
    alternatives: z.union([
      z.tuple([HedgedRecommendationSchema, HedgedRecommendationSchema]),
      z.tuple([HedgedRecommendationSchema, HedgedRecommendationSchema, HedgedRecommendationSchema]),
    ]),
    otherFormats: z.array(FormatPointerSchema),
  });
  const EmptyAnswerSchema = z.strictObject({
    mode: z.literal("EMPTY"),
    cause: EmptyCauseSchema,
    suggestions: z.array(SuggestedWidenSchema),
  });
  const RankedAnswerSchema = z.discriminatedUnion("mode", [
    ConfidentAnswerSchema,
    HedgedAnswerSchema,
    EmptyAnswerSchema,
  ]);
  /**
   * ADR 0003 §6's status↔answer consistency (the A8 rule), shared by `SearchResultSchema`
   * (polling) and `RevealPayloadSchema` (streaming) so the two surfaces cannot drift.
   * The COMPLETE rule admits `EMPTY:HALTED` alongside the three complete-coverage causes:
   * ADR 0009 widened the absence-of-data guard so a COMPLETE search whose every
   * performance was policy-skipped (`acceptedFetches === 0`) derives `EMPTY:HALTED`
   * (`docs/adr/0009-p5-5-schedule-status-evidence-policy.md:68-89`).
   */
  function refineStatusAnswerConsistency(
    status: "COMPLETE" | "PARTIAL" | "HALTED" | "CANCELLED",
    answer: z.infer<typeof RankedAnswerSchema>,
    context: z.RefinementCtx,
    issuePath: PropertyKey[] = ["answer"],
  ): void {
    if (status === "PARTIAL") {
      const allowed =
        answer.mode === "HEDGED" ||
        (answer.mode === "EMPTY" &&
          (answer.cause === "HALTED" ||
            answer.cause === "NO_SHAPE_MATCH" ||
            answer.cause === "PARTIAL_SCHEDULE"));
      if (!allowed) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message:
            "PARTIAL permits HEDGED, EMPTY:HALTED, EMPTY:NO_SHAPE_MATCH, or EMPTY:PARTIAL_SCHEDULE",
        });
      }
    }
    if (status === "HALTED") {
      const allowed =
        answer.mode === "EMPTY" && (answer.cause === "HALTED" || answer.cause === "CAPACITY");
      if (!allowed) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message: "HALTED permits only EMPTY:HALTED or EMPTY:CAPACITY",
        });
      }
    }
    if (status === "CANCELLED") {
      const allowed =
        answer.mode === "HEDGED" ||
        (answer.mode === "EMPTY" &&
          (answer.cause === "HALTED" || answer.cause === "NO_SHAPE_MATCH"));
      if (!allowed) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message: "CANCELLED permits HEDGED, EMPTY:HALTED, or EMPTY:NO_SHAPE_MATCH (ADR 0018)",
        });
      }
    }
    if (status === "COMPLETE" && answer.mode === "EMPTY") {
      const allowed =
        answer.cause === "SOLD_OUT" ||
        answer.cause === "TOO_FEW_SHOWTIMES" ||
        answer.cause === "NO_SHAPE_MATCH" ||
        answer.cause === "HALTED";
      if (!allowed) {
        context.addIssue({
          code: "custom",
          path: [...issuePath, "cause"],
          message: "COMPLETE empty answers require a complete-coverage cause, or HALTED (ADR 0009)",
        });
      }
    }
  }

  const ResultGroupSchema = z
    .strictObject({
      layoutId: nonemptyString,
      theatreId: nonemptyString,
      distanceKm: nonnegativeNumber.nullable(),
      formatCode: nonemptyString,
      auditorium: z.union([nonemptyString, z.number().int()]).nullable(),
      attributes: z.array(nonemptyString),
      rows: z.number().int().positive(),
      columns: z.number().int().positive(),
      seatKinds: z.array(nonnegativeInteger),
      seatNames: z.record(z.string().regex(/^(?:0|[1-9]\d*)$/), nonemptyString),
      seatScores: z.array(finiteNumber),
      regionMask: z.array(z.union([z.literal(0), z.literal(1)])).optional(),
      showtimes: z.array(GroupShowtimeSchema),
      freeCount: z.array(nonnegativeInteger),
      freeIn: z.array(z.array(nonnegativeInteger)),
      groupHits: z
        .array(
          z.strictObject({
            row: nonnegativeInteger,
            startCol: nonnegativeInteger,
            rowSpan: z.number().int().positive(),
            runScore: finiteNumber,
            showtimeIndices: z.array(nonnegativeInteger),
            // ADR 0017 amendment (2026-09-03) — every resolved hit carries its
            // placement key (computed by E7's `buildCandidate`, threaded into the
            // terminal groups payload by the aggregate answer assembler). Absent/null
            // when no candidate exists for the hit (e.g. missing member-cell name).
            // Optional + nullable so pre-amendment persisted payloads still parse.
            placementKey: nonemptyString.nullable().optional(),
            // ADR 0017 amendment (2026-09-03) — per-covered-showtime recheck nonce,
            // parallel to `showtimeIndices` (same length, same order). Exactly one
            // nonce is ever issued per showtime: the best hit covering it (first hit
            // in stored `groupHits` order with a non-null `placementKey` — the same
            // hit ShowtimeRow renders as `hits[0]`) gets the nonce bound to its
            // placementKey; every other slot stays null. `null` until issued at serve
            // time, mirroring `ShowtimeOffer.nonce`.
            showtimeNonces: z.array(z.string().nullable()).optional(),
          }),
        )
        .optional(),
    })
    .superRefine((group, context) => {
      const cellCount = group.rows * group.columns;
      for (const field of ["seatKinds", "seatScores", "freeCount", "freeIn"] as const) {
        if (group[field].length !== cellCount) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} length must equal rows * columns`,
          });
        }
      }
      if (group.regionMask !== undefined && group.regionMask.length !== cellCount) {
        context.addIssue({
          code: "custom",
          path: ["regionMask"],
          message: "regionMask length must equal rows * columns",
        });
      }

      for (const key of Object.keys(group.seatNames)) {
        if (Number(key) >= cellCount) {
          context.addIssue({
            code: "custom",
            path: ["seatNames", key],
            message: "seat-name index must be within the flattened grid",
          });
        }
      }

      group.showtimes.forEach((showtime, index) => {
        if (showtime.theatreId !== group.theatreId) {
          context.addIssue({
            code: "custom",
            path: ["showtimes", index, "theatreId"],
            message: "group showtime theatreId must match its containing group",
          });
        }
        if (showtime.distanceKm !== group.distanceKm) {
          context.addIssue({
            code: "custom",
            path: ["showtimes", index, "distanceKm"],
            message: "group showtime distanceKm must match its containing group",
          });
        }
      });

      group.freeIn.forEach((indices, cellIndex) => {
        indices.forEach((showtimeIndex, index) => {
          if (showtimeIndex >= group.showtimes.length) {
            context.addIssue({
              code: "custom",
              path: ["freeIn", cellIndex, index],
              message: "freeIn index must refer to a group showtime",
            });
          }
        });
      });

      group.groupHits?.forEach((hit, hitIndex) => {
        if (hit.row >= group.rows || hit.row + hit.rowSpan > group.rows) {
          context.addIssue({
            code: "custom",
            path: ["groupHits", hitIndex, "row"],
            message: "group-hit rows must be within the grid",
          });
        }
        if (hit.startCol >= group.columns) {
          context.addIssue({
            code: "custom",
            path: ["groupHits", hitIndex, "startCol"],
            message: "group-hit startCol must be within the grid",
          });
        }
        hit.showtimeIndices.forEach((showtimeIndex, index) => {
          if (showtimeIndex >= group.showtimes.length) {
            context.addIssue({
              code: "custom",
              path: ["groupHits", hitIndex, "showtimeIndices", index],
              message: "group-hit showtime index must refer to a group showtime",
            });
          }
        });
        if (
          hit.showtimeNonces !== undefined &&
          hit.showtimeNonces.length !== hit.showtimeIndices.length
        ) {
          context.addIssue({
            code: "custom",
            path: ["groupHits", hitIndex, "showtimeNonces"],
            message: "group-hit showtimeNonces must parallel showtimeIndices",
          });
        }
      });
    });

  const TopRunSchema = z.strictObject({
    layoutId: nonemptyString,
    row: nonnegativeInteger,
    startCol: nonnegativeInteger,
    rowSpan: z.number().int().positive(),
    runScore: finiteNumber,
    showtimeIds: z.array(nonemptyString).min(1),
  });

  const SearchResultSchema = z
    .strictObject({
      searchId: nonemptyString,
      spec: SearchSpecSchema,
      status: SearchStatusSchema,
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
      capturedAtRange: z.tuple([UtcInstantSchema, UtcInstantSchema]).nullable(),
      groups: z.array(ResultGroupSchema),
      topRuns: z.array(TopRunSchema).optional(),
      excluded: ExcludedCountsSchema,
      answer: RankedAnswerSchema.nullable(),
      terminalCause: z
        .enum([
          "CAPACITY",
          "PARTIAL_SCHEDULE",
          "PROVIDER_HALTED",
          "TOO_FEW_SHOWTIMES",
          "BATCH_DEFERRED",
        ])
        .nullable()
        .optional(),
    })
    .superRefine((result, context) => {
      if (result.resolved > result.total) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "resolved must not exceed total",
        });
      }
      if (
        result.capturedAtRange !== null &&
        instantMilliseconds(result.capturedAtRange[0]) >
          instantMilliseconds(result.capturedAtRange[1])
      ) {
        context.addIssue({
          code: "custom",
          path: ["capturedAtRange"],
          message: "capturedAtRange must be ordered oldest to newest",
        });
      }

      const providerId = result.spec.providerId;
      const capturedAtValues: UtcInstant[] = [];
      if (result.spec.theatres.kind === "LIST") {
        result.spec.theatres.refs.forEach((theatre, theatreIndex) => {
          if (providerFromId(theatre.id) !== providerId) {
            context.addIssue({
              code: "custom",
              path: ["spec", "theatres", "refs", theatreIndex, "id"],
              message: "SearchSpec theatre namespace must match SearchSpec.providerId",
            });
          }
        });
      }
      visitMovieIds(result.spec.where, (movieId, movieIndex) => {
        if (providerFromId(movieId) !== providerId) {
          context.addIssue({
            code: "custom",
            path: ["spec", "where", "ids", movieIndex],
            message: "SearchSpec movie namespace must match SearchSpec.providerId",
          });
        }
      });
      result.groups.forEach((group, groupIndex) => {
        if (providerFromId(group.theatreId) !== providerId) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "theatreId"],
            message: "result-group theatre namespace must match SearchSpec.providerId",
          });
        }
        group.showtimes.forEach((showtime, showtimeIndex) => {
          if (providerFromId(showtime.showtimeId) !== providerId) {
            context.addIssue({
              code: "custom",
              path: ["groups", groupIndex, "showtimes", showtimeIndex, "showtimeId"],
              message: "group-showtime namespace must match SearchSpec.providerId",
            });
          }
          if (showtime.resolved) {
            capturedAtValues.push(showtime.capturedAt);
          }
        });
      });
      result.topRuns?.forEach((run, runIndex) => {
        run.showtimeIds.forEach((showtimeId, showtimeIndex) => {
          if (providerFromId(showtimeId) !== providerId) {
            context.addIssue({
              code: "custom",
              path: ["topRuns", runIndex, "showtimeIds", showtimeIndex],
              message: "top-run showtime namespace must match SearchSpec.providerId",
            });
          }
        });
      });

      const recommendations =
        result.answer?.mode === "CONFIDENT"
          ? [result.answer.primary]
          : result.answer?.mode === "HEDGED"
            ? result.answer.alternatives
            : [];
      recommendations.forEach((recommendation, recommendationIndex) => {
        recommendation.showtimes.forEach((showtime, showtimeIndex) => {
          if (providerFromId(showtime.showtimeId) !== providerId) {
            context.addIssue({
              code: "custom",
              path: ["answer", recommendationIndex, "showtimes", showtimeIndex, "showtimeId"],
              message: "answer-offer namespace must match SearchSpec.providerId",
            });
          }
          capturedAtValues.push(showtime.capturedAt);
        });
      });
      if (result.answer?.mode === "EMPTY") {
        result.answer.suggestions.forEach((suggestion, suggestionIndex) => {
          if (
            suggestion.kind === "NEARBY_THEATRE" &&
            "theatreId" in suggestion &&
            typeof suggestion.theatreId === "string" &&
            providerFromId(suggestion.theatreId) !== providerId
          ) {
            context.addIssue({
              code: "custom",
              path: ["answer", "suggestions", suggestionIndex, "theatreId"],
              message: "suggested-theatre namespace must match SearchSpec.providerId",
            });
          }
        });
      }

      if (capturedAtValues.length > 0 && result.capturedAtRange === null) {
        context.addIssue({
          code: "custom",
          path: ["capturedAtRange"],
          message: "capturedAtRange is required when the result contains captured offers",
        });
      } else if (result.capturedAtRange !== null) {
        const oldest = instantMilliseconds(result.capturedAtRange[0]);
        const newest = instantMilliseconds(result.capturedAtRange[1]);
        capturedAtValues.forEach((capturedAt) => {
          const captured = instantMilliseconds(capturedAt);
          if (captured < oldest || captured > newest) {
            context.addIssue({
              code: "custom",
              path: ["capturedAtRange"],
              message: "capturedAtRange must contain every captured offer",
            });
          }
        });
      }

      const isNonterminal = result.status === "PENDING_SCHEDULE" || result.status === "RUNNING";
      if (isNonterminal && result.answer !== null) {
        context.addIssue({
          code: "custom",
          path: ["answer"],
          message: "nonterminal results must have a null answer",
        });
      }
      if (!isNonterminal && result.answer === null) {
        context.addIssue({
          code: "custom",
          path: ["answer"],
          message: "terminal results require an answer",
        });
        return;
      }
      if (result.answer === null) {
        return;
      }

      if (result.status === "PENDING_SCHEDULE" || result.status === "RUNNING") {
        // A nonterminal result carrying an answer already raised its issue above; the
        // shared refinement only speaks for terminal statuses.
        return;
      }
      refineStatusAnswerConsistency(result.status, result.answer, context);
    });

  const ScheduleResolvedEventSchema = z.strictObject({
    type: z.literal("schedule_resolved"),
    showtimeCount: nonnegativeInteger,
  });
  const ProgressEventSchema = z
    .strictObject({
      type: z.literal("progress"),
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
    })
    .refine(resolvedDoesNotExceedTotal, resolvedCountRefinement);
  const GroupEventSchema = z
    .strictObject({
      type: z.literal("group"),
      group: ResultGroupSchema,
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
    })
    .refine(resolvedDoesNotExceedTotal, resolvedCountRefinement);
  const CompleteEventSchema = z
    .strictObject({
      type: z.literal("complete"),
      status: z.literal("COMPLETE"),
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
    })
    .refine(resolvedDoesNotExceedTotal, resolvedCountRefinement);
  const PartialEventSchema = z
    .strictObject({
      type: z.literal("partial"),
      status: z.literal("PARTIAL"),
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
    })
    .refine(resolvedDoesNotExceedTotal, resolvedCountRefinement);
  const HaltedEventSchema = z
    .strictObject({
      type: z.literal("halted"),
      status: z.literal("HALTED"),
      cause: z.enum([
        "UPSTREAM_BLOCKED",
        "CHALLENGE_REQUIRED",
        "UPSTREAM_QUEUED",
        "UPSTREAM_CHANGED",
        "UPSTREAM_UNAVAILABLE",
        "CAPACITY",
      ]),
      resolved: nonnegativeInteger,
      total: nonnegativeInteger,
    })
    .refine(resolvedDoesNotExceedTotal, resolvedCountRefinement);
  const SearchProgressEventSchema = z.discriminatedUnion("type", [
    ScheduleResolvedEventSchema,
    ProgressEventSchema,
    GroupEventSchema,
    CompleteEventSchema,
    PartialEventSchema,
    HaltedEventSchema,
  ]);

  /**
   * The terminal reveal payload (S6U3.0): the `SEARCH_TERMINAL` event's widened payload
   * `{ status, cause, answer }`. `cause` uses the durability tier's `TerminalCause`
   * vocabulary (`packages/durability/src/lifecycle.ts:13-14`) — the reveal event's own
   * vocabulary, deliberately distinct from `HaltedEventSchema`'s provider-cause enum,
   * which describes a different surface. The status↔answer rules are the SAME shared
   * refinement `SearchResultSchema` uses, so the polling and streaming surfaces cannot
   * drift.
   */
  const RevealPayloadSchema = z
    .strictObject({
      status: z.enum(["COMPLETE", "PARTIAL", "HALTED", "CANCELLED"]),
      cause: z
        .enum([
          "CAPACITY",
          "PARTIAL_SCHEDULE",
          "PROVIDER_HALTED",
          "TOO_FEW_SHOWTIMES",
          "BATCH_DEFERRED",
        ])
        .nullable(),
      answer: RankedAnswerSchema,
    })
    .superRefine((payload, context) => {
      refineStatusAnswerConsistency(payload.status, payload.answer, context);
    });

  return {
    ShowtimeOfferSchema,
    ResolvedGroupShowtimeSchema,
    UnresolvedGroupShowtimeSchema,
    GroupShowtimeSchema,
    RecommendationSchema,
    ConfidentAnswerSchema,
    HedgedAnswerSchema,
    EmptyAnswerSchema,
    RankedAnswerSchema,
    ResultGroupSchema,
    TopRunSchema,
    SearchResultSchema,
    ScheduleResolvedEventSchema,
    ProgressEventSchema,
    GroupEventSchema,
    CompleteEventSchema,
    PartialEventSchema,
    HaltedEventSchema,
    SearchProgressEventSchema,
    RevealPayloadSchema,
  } as const;
}

export type ResultContractSchemas = ReturnType<typeof createResultContractSchemas>;
export type ShowtimeOffer = z.infer<ResultContractSchemas["ShowtimeOfferSchema"]>;
export type GroupShowtime = z.infer<ResultContractSchemas["GroupShowtimeSchema"]>;
export type Recommendation = z.infer<ResultContractSchemas["RecommendationSchema"]>;
export type RankedAnswer = z.infer<ResultContractSchemas["RankedAnswerSchema"]>;
export type ResultGroup = z.infer<ResultContractSchemas["ResultGroupSchema"]>;
export type SearchResult = z.infer<ResultContractSchemas["SearchResultSchema"]>;
export type SearchProgressEvent = z.infer<ResultContractSchemas["SearchProgressEventSchema"]>;
export type RevealPayload = z.infer<ResultContractSchemas["RevealPayloadSchema"]>;
