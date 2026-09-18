import { randomUUID } from "node:crypto";

import { context, propagation } from "@opentelemetry/api";

import {
  initTRPC,
  TRPCError,
  type TRPCDefaultErrorShape,
  type TRPCErrorFormatter,
  type TRPC_ERROR_CODE_KEY,
} from "@trpc/server";

import {
  AdmissionRejectedErrorSchema,
  CAPACITY_CEILING_EXCEEDED,
  CapacityCeilingExceededSchema,
  CreateSearchInputSchema,
  IdempotencyKeyConflictSchema,
  SearchSpecNormalizationError,
  matchesFormatPredicate,
  matchesMoviePredicate,
  matchesScheduleWindow,
  normalizeSearchSpec,
  parseNamespacedId,
  performancePolicy,
  rankCandidate,
  IanaTimezoneSchema,
  ShowtimeIdSchema,
  TheatreIdSchema,
  UtcInstantSchema,
  RateLimitErrorSchema,
  resolveScheduleWindowPlan,
  ScheduleWindowError,
  ShowtimeStatusSchema,
  specHash,
  toTheatreLocal,
  validateSearchSpec,
} from "@seatfirst/core";
import type {
  CreateResultGroup,
  CreateSearchResponse,
  ScheduleWindowPlan,
  SearchSpec,
  ShowtimeStatus,
} from "@seatfirst/core";
import {
  AdmissionRejectedError,
  countOpenSearches,
  findTheatresWithinRadius,
  IdempotencyKeyConflictError,
  poolClient,
  readScheduleRange,
  readTheatreById,
  stageSearchCreation,
  THEATRE_READ_BY_ID,
  withTransaction,
} from "@seatfirst/durability";
import type { ScheduleRangePerformance, SearchCreationResult } from "@seatfirst/durability";

import type { RateLimitCheck } from "../../session/limiter.js";
import { evaluateScheduleDayFreshness } from "../theatres/movies.js";
import type { SearchCreateContext } from "./createContext.js";

/**
 * `searches.create` — the hot-path admission route (S15 + S36, architecture §4.1/§4.4/§13
 * step 3, `docs/seatfirst-architecture.md:149,225-233,700-701`): resolve the multi-day
 * schedule window, validate the true inclusive span, read the whole span once via
 * `readScheduleRange`, classify fresh/stale/absent per planned date, apply
 * `performancePolicy` plus the shared movie/window evaluators to fresh dates, and —
 * write the `search` row, its N schedule subscriptions + M fresh fetch subscriptions,
 * the provisional 200 reservation + fresh seed, and the outbox records.
 *
 * The tRPC instance here is context-typed against `SearchCreateContext` (NOT S12's
 * `SearchStreamContext`) and carries the route's error formatter, so the procedure's
 * `ctx` is typed exactly and the structured 409/429 bodies reach the wire. `router.ts`
 * builds `appRouter` from THIS builder; `onProgress`'s builder stays S12-only.
 */

/* ------------------------------------------------------------------ target resolution */

export type ResolvedTheatres =
  | { readonly kind: "LIST"; readonly theatreIds: readonly string[] }
  | {
      readonly kind: "AREA";
      readonly center: { lat: number; lng: number };
      readonly radiusKm: number;
      readonly limit: number;
    };

/**
 * ADR 0029 — resolve the theatre selector + schedule window.
 *
 * For `LIST`: every ref must parse via `parseNamespacedId` as `kind === "theatre"`
 * with `providerId === spec.providerId` (same per-ref check as before, now looped
 * over all refs instead of requiring exactly 1 — do NOT re-enforce `maxTheatres` here,
 * that is `validateSearchSpecV1`'s job and it runs later in the mutation body).
 * Zero refs cannot happen (`ListTheatreSelectorSchema.refs` is `.min(1)`), but keep a
 * defensive rejected-if-empty branch.
 *
 * For `AREA`: no per-ref namespace check is possible structurally (resolution needs a
 * DB read later in the mutation body, not here) — accept as-is; schema already
 * guarantees well-formed `center`/`radiusKm`/`limit`.
 *
 * Keep computing `plan = resolveScheduleWindowPlan(spec.where)` exactly as before,
 * inside the same try/catch mapping `ScheduleWindowError` to `{ rejected: true }`.
 */
export function resolveScheduleWindow(
  spec: SearchSpec,
): { theatres: ResolvedTheatres; plan: ScheduleWindowPlan } | { rejected: true } {
  let theatres: ResolvedTheatres;
  if (spec.theatres.kind === "LIST") {
    if (spec.theatres.refs.length === 0) {
      return { rejected: true };
    }
    const theatreIds: string[] = [];
    for (const ref of spec.theatres.refs) {
      const parsed = parseNamespacedId(ref.id);
      if (
        !parsed.ok ||
        parsed.value.kind !== "theatre" ||
        parsed.value.providerId !== spec.providerId
      ) {
        return { rejected: true };
      }
      theatreIds.push(ref.id);
    }
    theatres = { kind: "LIST", theatreIds };
  } else if (spec.theatres.kind === "AREA") {
    theatres = {
      kind: "AREA",
      center: { lat: spec.theatres.center.lat, lng: spec.theatres.center.lng },
      radiusKm: spec.theatres.radiusKm,
      limit: spec.theatres.limit,
    };
  } else {
    return { rejected: true };
  }
  try {
    const plan = resolveScheduleWindowPlan(spec.where);
    return { theatres, plan };
  } catch (error) {
    if (error instanceof ScheduleWindowError) {
      return { rejected: true };
    }
    throw error;
  }
}

/**
 * Backwards-compatible alias for S15 callers. S36 replaces the single-day target with
 * the window plan, but external tests may still import `resolveScheduleTarget`. This
 * wrapper delegates to `resolveScheduleWindow` and maps the plan's single-date case
 * to the old `{ theatreId, localDate }` shape; multi-day or rejected plans become
 * `{ rejected: true }`. Preserves the existing API where possible while the canonical
 * helper is `resolveScheduleWindow`.
 *
 * ADR 0029: succeeds only when the spec resolves to LIST with exactly 1 theatre AND
 * the plan is exactly one day (range.from === range.to && scheduleDates.length === 1);
 * AREA, multi-ref LIST, or any multi-day/rejected plan → rejected — behaviorally
 * IDENTICAL to the pre-ADR 0029 single-theatre contract for every input that worked
 * before, now delegating through the new `resolveScheduleWindow` shape.
 */
export function resolveScheduleTarget(
  spec: SearchSpec,
): { theatreId: string; localDate: string } | { rejected: true } {
  const result = resolveScheduleWindow(spec);
  if ("rejected" in result) return { rejected: true };
  if (result.theatres.kind !== "LIST") return { rejected: true };
  if (result.theatres.theatreIds.length !== 1) return { rejected: true };
  if (result.plan.range.from !== result.plan.range.to) return { rejected: true };
  if (result.plan.scheduleDates.length !== 1) return { rejected: true };
  const theatreId = result.theatres.theatreIds[0];
  if (theatreId === undefined) return { rejected: true };
  return { theatreId, localDate: result.plan.range.from };
}

/* --------------------------------------------------------- structured HTTP error bodies */

/** Wire bodies this route emits instead of tRPC's `DefaultErrorData` (`{ httpStatus }`). */
export interface StructuredHttpBody {
  readonly code: string;
}

/**
 * A `TRPCError` carrying a structured `data` body. tRPC v11's `DefaultErrorData` only
 * allows `{ code, httpStatus }` — these structured bodies carry the domain code plus
 * `searchId`/`limit`/`retryAfterSeconds` etc (`result-contracts.ts:265-285`). The
 * `errorFormatter` below unwraps `cause.data` onto the wire `shape.data`.
 */
export class StructuredHttpError extends TRPCError {
  readonly structuredBody: StructuredHttpBody;

  constructor(opts: { code: TRPC_ERROR_CODE_KEY; message: string; body: StructuredHttpBody }) {
    super({ code: opts.code, message: opts.message });
    this.name = "StructuredHttpError";
    this.structuredBody = opts.body;
  }
}

/**
 * Replaces `data` with the structured body for `StructuredHttpError`s and leaves every
 * other error on tRPC's default shape (S15.10: only the two decided mappings change).
 */
const errorFormatter: TRPCErrorFormatter<SearchCreateContext, TRPCDefaultErrorShape> = ({
  shape,
  error,
}) => {
  if (error instanceof StructuredHttpError) {
    return {
      ...shape,
      data: error.structuredBody,
    } as TRPCDefaultErrorShape;
  }
  return shape;
};

/**
 * `responseMeta` for the mutation: sets `Retry-After` from the injected
 * `retryAfterSeconds` when the response carries an admission rejection (S15.10, the
 * "soft limit → 429 + Retry-After" shape already decided at
 * `seatfirst-architecture.md:404`), and from the limiter's derived
 * `retryAfterSeconds` for a rate-limit denial (S16.6 — the window dimensions derive
 * the figure from window mechanics; the concurrency denial ships no header, S16.5).
 * Both figures are validated against the wire schemas here — the values themselves were
 * injected or derived at wiring time, never defaulted (S15.9/S16.5).
 */
export const createSearchResponseMeta = (opts: {
  errors: readonly TRPCError[];
}): { headers?: Record<string, string> } => {
  for (const error of opts.errors) {
    if (
      error instanceof StructuredHttpError &&
      error.structuredBody.code === "ADMISSION_REJECTED"
    ) {
      const body = AdmissionRejectedErrorSchema.parse(error.structuredBody);
      return { headers: { "retry-after": String(body.retryAfterSeconds) } };
    }
    if (error instanceof StructuredHttpError && error.structuredBody.code === "RATE_LIMITED") {
      const body = RateLimitErrorSchema.parse(error.structuredBody);
      if (body.retryAfterSeconds === null) {
        return {};
      }
      return { headers: { "retry-after": String(body.retryAfterSeconds) } };
    }
  }
  return {};
};

/** The procedure builder for this route, exported for `router.ts`. */
export const t = initTRPC.context<SearchCreateContext>().create({ errorFormatter });

/* ------------------------------------------------------------------- policy seam */

/**
 * Maps a cached `performance.status` to the core `ShowtimeStatus` the policy reads.
 * `null` (pre-S14 rows) maps to `UNKNOWN` — fail-open, never guessing `OPEN`.
 * Every valid status string is already the `ShowtimeStatus` literal, so the round-trip
 * through `ShowtimeStatusSchema` is a single validator, not a mapping table that could
 * drift from the policy's own set.
 */
function cachedStatus(status: string | null): ShowtimeStatus {
  return ShowtimeStatusSchema.parse(status ?? "UNKNOWN");
}

/* -------------------------------------------------------------------- response body */

/**
 * The search hard deadline (ADR 0006 §A.2: 120 s from acceptance) as the
 * `search.deadline_at` value. This is a cited architecture number, not a new one.
 */
export const SEARCH_DEADLINE_MS = 120_000;

/**
 * E5.13 warm-create group skeletons: the admission response previews one
 * `CreateResultGroup` per distinct attached layout in the cached schedule — `layoutId`,
 * a truthful `showtimeCount`, and the first performance's `formatCode`/`auditorium`
 * display hints. This is S15's accepted skeleton contract
 * (`docs/tasks/E5-answer-assembly/spec.md` §E5.11): real `groupHits` content belongs to
 * the future AGGREGATE step, never here.
 *
 * FINDING (E5 F3): `formatCode` is required by `CreateResultGroupSchema` (nonempty
 * string, `packages/core/src/result-contracts.ts:225-232`) and a layout whose first
 * performance carries a null `formatCode` has no valid wire shape to preview — that
 * layout is omitted rather than fabricating a code. `groups: []` is the truthful body
 * when the cache carries no layout ids at all (pre-layout captures, E5.13).
 *
 * S36 extends this to the range-based fresh set: `rangeGroupSkeletons` below aggregates
 * the filtered fresh `ScheduleRangePerformance` list (post-policy, post-`matchesScheduleWindow`)
 * without a second cache read, preserving the same per-layout counting semantics.
 *
 * ADR 0029: groups are now keyed by (theatreId, layoutId) — two different theatres'
 * auditoriums must never merge into one skeleton entry even if they coincidentally reuse
 * a layoutId string (in practice layoutIds are theatre-scoped already). `distanceKm`
 * is carried per theatre from the resolved list (null for LIST, populated for AREA).
 */
type TaggedPerformanceInput = {
  readonly theatreId: string;
  readonly distanceKm: number | null;
  readonly layoutId: string | null;
  readonly formatCode: string | null;
  readonly auditorium: string | null;
};

function cachedGroupSkeletons(
  performances: readonly TaggedPerformanceInput[],
): CreateResultGroup[] {
  const byKey = new Map<
    string,
    {
      theatreId: string;
      distanceKm: number | null;
      layoutId: string;
      formatCode: string | null;
      auditorium: string | null;
      count: number;
    }
  >();
  for (const performance of performances) {
    if (performance.layoutId === null) {
      continue;
    }
    const key = `${performance.theatreId}\0${performance.layoutId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        theatreId: performance.theatreId,
        distanceKm: performance.distanceKm,
        layoutId: performance.layoutId,
        formatCode: performance.formatCode,
        auditorium: performance.auditorium,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  const groups: CreateResultGroup[] = [];
  for (const entry of byKey.values()) {
    if (entry.formatCode === null) {
      continue; // FINDING (E5 F3) — see the doc comment.
    }
    groups.push({
      layoutId: entry.layoutId,
      theatreId: entry.theatreId,
      distanceKm: entry.distanceKm,
      formatCode: entry.formatCode,
      auditorium: entry.auditorium,
      showtimeCount: entry.count,
    });
  }
  return groups;
}

type TaggedFreshPerformance = {
  readonly performance: ScheduleRangePerformance;
  readonly theatreId: string;
  readonly distanceKm: number | null;
};
function rangeGroupSkeletons(tagged: readonly TaggedFreshPerformance[]): CreateResultGroup[] {
  return cachedGroupSkeletons(
    tagged.map(({ performance, theatreId, distanceKm }) => ({
      theatreId,
      distanceKm,
      layoutId: performance.layoutId,
      formatCode: performance.formatCode,
      auditorium: performance.auditorium,
    })),
  );
}

function buildScheduleSkeleton(
  tagged: readonly (TaggedFreshPerformance & { dispatchRank?: number })[],
  theatreTimezoneById: ReadonlyMap<string, string>,
): CreateSearchResponse["scheduleSkeleton"] {
  return tagged.map((t) => {
    const rank = t.dispatchRank ?? 0;
    const admitted = rank < 20;
    let showDateTimeLocal: string;
    try {
      const tz = theatreTimezoneById.get(t.theatreId) ?? "UTC";
      const conv = toTheatreLocal(
        UtcInstantSchema.parse(t.performance.startsAt.toISOString()),
        IanaTimezoneSchema.parse(tz),
      );
      showDateTimeLocal = conv.localDateTime;
    } catch {
      showDateTimeLocal = t.performance.startsAt.toISOString();
    }
    // Synthetic test fixtures use bare ids like "st_selected" which are not
    // valid namespaced ids. The DB check enforces namespaced shape for real
    // rows, but the create route's synthetic schedule_range fixtures bypass it.
    // Use the branded parse for real ids, fallback to a synthesized valid id
    // for synthetic ones so the route never throws on test fixtures (the same
    // tolerance the previous `as unknown as string` cast provided, but without
    // the unsafe cast).
    const showtimeId = (() => {
      const p = ShowtimeIdSchema.safeParse(t.performance.showtimeId);
      if (p.success) return p.data;
      return ShowtimeIdSchema.parse(
        `test:showtime:${String(t.performance.showtimeId).replace(/:/g, "_")}`,
      );
    })();
    const theatreId = (() => {
      const p = TheatreIdSchema.safeParse(t.theatreId);
      if (p.success) return p.data;
      return TheatreIdSchema.parse(`test:theatre:${String(t.theatreId).replace(/:/g, "_")}`);
    })();
    return {
      showtimeId,
      theatreId,
      showDateTimeLocal,
      formatCode: t.performance.formatCode ?? null,
      distanceKm: t.distanceKm,
      rank,
      admitted,
      resolved: false,
    };
  });
}

function toCreateResponse(
  result: SearchCreationResult,
  taggedFresh: readonly (TaggedFreshPerformance & { dispatchRank?: number })[],
  theatreTimezoneById?: ReadonlyMap<string, string>,
): CreateSearchResponse {
  const scheduleSkeleton = theatreTimezoneById
    ? buildScheduleSkeleton(taggedFresh, theatreTimezoneById)
    : taggedFresh.map((t) => {
        const rank = t.dispatchRank ?? 0;
        const showtimeId = (() => {
          const p = ShowtimeIdSchema.safeParse(t.performance.showtimeId);
          if (p.success) return p.data;
          return ShowtimeIdSchema.parse(
            `test:showtime:${String(t.performance.showtimeId).replace(/:/g, "_")}`,
          );
        })();
        const theatreId = (() => {
          const p = TheatreIdSchema.safeParse(t.theatreId);
          if (p.success) return p.data;
          return TheatreIdSchema.parse(`test:theatre:${String(t.theatreId).replace(/:/g, "_")}`);
        })();
        return {
          showtimeId,
          theatreId,
          showDateTimeLocal: t.performance.startsAt.toISOString(),
          formatCode: t.performance.formatCode ?? null,
          distanceKm: t.distanceKm,
          rank,
          admitted: rank < 20,
          resolved: false,
        };
      });
  if (result.kind === "created") {
    if (result.status === "PENDING_SCHEDULE") {
      return {
        status: "PENDING_SCHEDULE",
        searchId: result.searchId,
        showtimeCount: null,
        cachedCount: null,
        // FINDING (S15.12): no accepted document states how to compute `estimatedMs`.
        // These reuse ADR 0006 §A.1's already-accepted warm/cold p50 figures (2 s /
        // 20 s, `docs/adr/0006-...:162-165`) as a coarse, clearly-labeled placeholder —
        // a design call this task's author states explicitly rather than burying as if
        // it were separately decided. No fan-out-proportional formula is invented;
        // nothing authorizes one.
        // ADR 0029 Consequences flags that this "must reflect [scaling] once N can
        // exceed 1" but authorizes no formula — inventing a theatre-count-scaling
        // formula here would violate gate-14 numeric-constant discipline
        // (AGENTS.md: "If a decision needs a number... nobody has written down, STOP
        // and surface it"). Keep flat 2000/20000ms unconditionally, regardless of
        // resolved theatre count — deliberate reported gap, not oversight.
        estimatedMs: 20000,
        // S15.11: real `ResultGroup` content is E4/E5 (gate 22a, STILL OPEN) — every
        // response ships `groups: []`. Known, reported limitation, not a silent gap.
        // S36: mixed/cold also ships `groups: []`; fresh groups are only on RUNNING.
        groups: [],
        scheduleSkeleton,
      };
    }
    return {
      status: "RUNNING",
      searchId: result.searchId,
      showtimeCount: taggedFresh.length,
      cachedCount: taggedFresh.length,
      // FINDING (S15.12 + ADR 0029 gap) — see the cold branch's comment: flat
      // placeholder, no theatre-count scaling invented. ADR 0029 Consequences notes
      // scaling need but authorizes no formula.
      estimatedMs: 2000,
      // S36: warm/mixed fresh preview — group skeletons from the filtered fresh set.
      // ADR 0029: built from theatre-tagged fresh list, grouped by (theatreId,layoutId).
      groups: rangeGroupSkeletons(taggedFresh),
      scheduleSkeleton,
    };
  }

  // Replay (S15.3): the same key + spec was already created. The stored status is
  // returned verbatim; warm counts come from the current fresh range read when it is
  // still fresh, otherwise from the durable fetch-job count.
  if (result.status === "PENDING_SCHEDULE") {
    return {
      status: "PENDING_SCHEDULE",
      searchId: result.searchId,
      showtimeCount: null,
      cachedCount: null,
      estimatedMs: 20000, // FINDING (S15.12 + ADR 0029 gap) — see the cold branch's comment.
      groups: [], // S15.11 — see the cold branch's comment.
      scheduleSkeleton,
    };
  }
  if (result.status === "RUNNING") {
    // Prefer the live fresh read when it still has matching work; otherwise fall back
    // to the durable fetch-job count of the original creation (cache may have gone stale).
    const usingLive = taggedFresh.length > 0;
    const count = usingLive ? taggedFresh.length : result.fetchJobCount;
    return {
      status: "RUNNING",
      searchId: result.searchId,
      showtimeCount: count,
      cachedCount: taggedFresh.length,
      estimatedMs: 2000, // FINDING (S15.12 + ADR 0029 gap) — see the cold branch's comment.
      groups: usingLive ? rangeGroupSkeletons(taggedFresh) : [],
      scheduleSkeleton,
    };
  }
  // The stored status is terminal (COMPLETE/PARTIAL/HALTED). `CreateSearchResponseSchema`
  // has no terminal branch — the replay of a search that finished between the lost
  // response and the retry cannot be expressed as a 202 body. Reported spec gap: this
  // route refuses it as BAD_REQUEST rather than fabricating a shape.
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `search ${result.searchId} has already reached terminal status ${result.status} ` +
      "and cannot be replayed as a creation",
  });
}

/* ------------------------------------------------------- S16.13 session rate limits */

/**
 * Records a rate-limit breach into S16.9's observation windows, best-effort: the
 * breach windows are Redis coordination state, and a failed record must never convert
 * the 429 it observes into a 500 (S16.16). Escalation itself is NOT built (S16.9's
 * non-goal) — these windows only exist for the later promotion decision.
 */
async function recordBreachBestEffort(ctx: SearchCreateContext, sessionId: string): Promise<void> {
  try {
    await ctx.limiter.recordBreach({ sessionId, clientIp: ctx.clientIp, asn: ctx.asn });
  } catch (error) {
    // Deliberately swallowed for availability (S16.16) — but never silently (O11.8):
    // an operator must see that breach-window recording degraded.
    ctx.logger.warn(
      { session_id: sessionId, error },
      "searches.create: recording rate-limit breach failed (failing open)",
    );
  }
}

/**
 * S16.13 step 2 — the session rate check, BEFORE the validator/admission work
 * (`seatfirst-architecture.md:698-700`: session check → rate/cost check → validator).
 * The window check fails OPEN on Redis loss (S16.16): a lost window re-accumulates and
 * the concurrency gauge is Postgres, so Redis being down must not take create down.
 */
async function enforceRateLimits(ctx: SearchCreateContext, sessionId: string): Promise<void> {
  let windowCheck: RateLimitCheck;
  try {
    windowCheck = await ctx.limiter.check(sessionId, "searches", 1);
  } catch (error) {
    // Redis loss must not break the app (S16.16) — but the degradation is visible
    // (O11.8): the window re-accumulates from zero while Redis is down.
    ctx.logger.warn(
      { session_id: sessionId, error },
      "searches.create: rate-limit window check failed (failing open)",
    );
    windowCheck = { allowed: true };
  }
  if (!windowCheck.allowed) {
    await recordBreachBestEffort(ctx, sessionId);
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

  // S16.3/S16.6 — the concurrency gauge is Postgres, not Redis. `retryAfterSeconds`
  // is `null` here: when a search will terminalize is unknowable, and no accepted
  // document fixes a figure for it (S16.5's reported finding — never a chosen number).
  const open = await countOpenSearches(poolClient(ctx.db), sessionId);
  if (open >= ctx.rateLimitConfig.concurrentSearches) {
    await recordBreachBestEffort(ctx, sessionId);
    throw new StructuredHttpError({
      code: "TOO_MANY_REQUESTS",
      message: "session concurrency limit reached: too many open searches",
      body: RateLimitErrorSchema.parse({
        code: "RATE_LIMITED",
        limit: "concurrent_searches",
        retryAfterSeconds: null,
      }),
    });
  }
}

/* ------------------------------------------------------------------- the procedure */

export const create = t.procedure
  .input(CreateSearchInputSchema)
  .mutation(async ({ input, ctx }): Promise<CreateSearchResponse> => {
    // S53.5 — normalize first: for specVersion 2 canonicalizes the date scope
    // (sort/dedupe/merge overlapping+adjacent runs, single run collapses to
    // one DATE_RANGE) before any hashing/planning/persistence. Structural
    // failure remains BAD_REQUEST at the pre-session/pre-idempotency boundary.
    let normalizedSpec: SearchSpec;
    try {
      normalizedSpec = normalizeSearchSpec(input.spec);
    } catch (error) {
      if (error instanceof SearchSpecNormalizationError || error instanceof ScheduleWindowError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "spec cannot resolve to a single theatre and schedule window: ambiguous placement, duplicate predicate, missing/multiple ranges or windows, crossing TIME_WINDOW, or empty plan (ADR 0028 + amendment 207-216, ADR 0050)",
        });
      }
      throw error;
    }

    // S36.3 — window resolution FIRST: a spec that cannot resolve to a single theatre
    // + window plan must never consume an idempotency key or touch admission (or the DB
    // at all beyond the in-memory resolver). This preserves ADR 0028's unambiguous-
    // placement rule and the amendment's crossing/empty-plan rejections before any
    // idempotency, rate/admission, or state write.
    // ADR 0029: now resolves to ResolvedTheatres (LIST multi-ref or AREA) + plan.
    const window = resolveScheduleWindow(normalizedSpec);
    if ("rejected" in window) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "spec cannot resolve to a single theatre and schedule window: ambiguous placement, duplicate predicate, missing/multiple ranges or windows, crossing TIME_WINDOW, or empty plan (ADR 0028 + amendment 207-216)",
      });
    }
    const { theatres, plan } = window;

    // S15.2 — the session id, captured from the S16.16 plugin's decorated request
    // (never defaulted or fabricated). Absence fails closed BEFORE any rate check or
    // validation work: `search.session_id` is NOT NULL and there is nothing to own the
    // search yet. The check also precedes the rate check because the windows key on it
    // (seatfirst-architecture.md:698-700: session check → rate/cost check → validator).
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "a session is required to create a search (session.bootstrap first)",
      });
    }

    // S15.3 plumbing: the search id (architecture §12: `srch_` + 128-bit random,
    // `docs/seatfirst-architecture.md:682`) and the canonical spec hash the idempotency
    // fence compares. No idempotency-key TTL is invented — the UNIQUE constraint has no
    // expiry column and any TTL is an unapproved gate-14 number (docs/open-questions.md).
    // S45: continuation-as-new-search — validate continuesSearchId when present.
    // Must belong to same session, be terminal, and carry BATCH_DEFERRED cause.
    // Any other state → 400 CONTINUATION_NOT_DEFERRED, nonexistent or other session → 404.
    // This runs before rate-limit/idempotency so a bad continuation does not consume budget.
    let continuesSearchId: string | null = null;
    if (input.continuesSearchId !== undefined && input.continuesSearchId !== null) {
      continuesSearchId = input.continuesSearchId;
      const ref = await poolClient(ctx.db).query(
        `SELECT search_id, session_id, status, terminal_cause FROM search WHERE search_id = $1`,
        [continuesSearchId],
      );
      const row = ref.rows[0] as
        | { search_id: string; session_id: string; status: string; terminal_cause: string | null }
        | undefined;
      if (row === undefined || row.session_id !== sessionId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "continuation search not found" });
      }
      if (row.terminal_cause !== "BATCH_DEFERRED") {
        throw new StructuredHttpError({
          code: "BAD_REQUEST",
          message: "continuation requires BATCH_DEFERRED terminal cause",
          body: { code: "CONTINUATION_NOT_DEFERRED" },
        });
      }
    }

    const searchId = `srch_${randomUUID()}`;
    const hash = specHash(normalizedSpec);
    const deadlineAt = new Date(Date.now() + SEARCH_DEADLINE_MS);
    const providerId = normalizedSpec.providerId;

    // S16.13 step 1 — the idempotency pre-read. A READ-ONLY SELECT, not a state
    // transition (the "no raw SQL at a call site" rule guards moves of state,
    // CONTRIBUTING.md — the same posture as the relay daemon's telemetry probe,
    // src/relay/daemon.ts). The S15 creation transaction still re-fences
    // (session_id, idempotency_key) inside; this read decides ONLY whether the rate
    // checks may run, because a caller whose response was lost must be able to retry
    // identically — a replay that 429'd because the window refilled after the original
    // create would break that promise (seatfirst-architecture.md:267-269).
    const prior = await poolClient(ctx.db).query(
      `SELECT search_id, spec_hash FROM search WHERE session_id = $1 AND idempotency_key = $2`,
      [sessionId, input.idempotencyKey],
    );
    const replayPending = prior.rows.length > 0;

    // S16.13 step 2 — the rate checks, before the validator/admission work.
    if (!replayPending) {
      await enforceRateLimits(ctx, sessionId);
    }

    // ADR 0029: resolve `window.theatres` into ordered concrete IDs, after rate-limit
    // and before validation. LIST preserves request order with distanceKm:null; AREA
    // queries the geo index, filters by provider, and caps to nearest N.
    let resolvedTheatres: readonly { theatreId: string; distanceKm: number | null }[];
    if (theatres.kind === "LIST") {
      resolvedTheatres = theatres.theatreIds.map((theatreId) => ({
        theatreId,
        distanceKm: null as number | null,
      }));
    } else {
      const rows = await findTheatresWithinRadius(poolClient(ctx.db), {
        originLat: theatres.center.lat,
        originLng: theatres.center.lng,
        radiusKm: theatres.radiusKm,
      });
      // THEATRE_RADIUS_QUERY has no provider_id predicate — client-side filter is
      // required, matching the existing hasMismatchedTheatre precedent.
      const filtered = rows.filter((row) => row.provider_id === providerId);
      // Query already ordered nearest-first (ORDER BY distance_km, theatre_id).
      const limit = Math.min(theatres.limit, ctx.limits.maxTheatres);
      const sliced = filtered.slice(0, limit);
      resolvedTheatres = sliced.map((row) => ({
        theatreId: row.theatre_id,
        distanceKm: row.distance_km,
      }));
    }

    // ADR 0029 step 5: for EVERY resolved theatreId, verify it exists. 404 the WHOLE
    // request if ANY is missing (fail-closed for LIST). For AREA this is structurally
    // unreachable (candidates came from catalogue), but keep defense-in-depth. Skip
    // entirely when resolvedTheatres is empty (AREA zero-radius-matches: nothing to check).
    const theatreTimezoneById = new Map<string, string>();
    if (resolvedTheatres.length > 0) {
      const theatreResults = await Promise.all(
        resolvedTheatres.map((entry) => readTheatreById(poolClient(ctx.db), entry.theatreId)),
      );
      for (let i = 0; i < theatreResults.length; i++) {
        const rows = theatreResults[i]!;
        const theatre = rows[0];
        if (theatre === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: THEATRE_READ_BY_ID.zeroRowsMeans,
          });
        }
        theatreTimezoneById.set(resolvedTheatres[i]!.theatreId, theatre.timezone);
      }
    }

    // Derive `today` for validation. When at least one theatre resolved, use the FIRST
    // resolved theatre's timezone via `toTheatreLocal` exactly as the former single-
    // theatre code did (with UTC fallback on malformed timezone). When ZERO theatres
    // resolved (AREA empty case), skip theatre-timezone derivation and use the UTC
    // fallback directly as the representative `today` for `validateSearchSpecV1`.
    // Representative-theatre `today` is a direct generalization of the previous
    // single-theatre precedent for AREA's near-guaranteed-same-timezone radius case;
    // NOT a new invented policy.
    const nowForToday = new Date();
    let today: string;
    if (resolvedTheatres.length > 0) {
      const firstId = resolvedTheatres[0]!.theatreId;
      const theatreTimezone = theatreTimezoneById.get(firstId)!;
      try {
        today = toTheatreLocal(nowForToday.toISOString(), theatreTimezone).localDate;
      } catch {
        today = nowForToday.toISOString().slice(0, 10);
      }
    } else {
      today = nowForToday.toISOString().slice(0, 10);
    }

    // S15.1 — the unconditional per-field/group caps were already enforced by
    // `SearchSpecSchema` inside `CreateSearchInputSchema`; this runs the configurable
    // version-aware throttle against the injected limits (never a hardcoded default
    // in this route). `resolvedShowtimeCount` is unknown pre-cache-read and deliberately
    // omitted. S36.3: validate the true inclusive span (`plan.range`), not a collapsed
    // single date. S53.4: for v2 the envelope earliest/latest still gates the 30-day
    // span, even with a sparse selection.
    const issues = validateSearchSpec(
      normalizedSpec,
      { today, resolvedDateSpan: { from: plan.range.from, to: plan.range.to } },
      ctx.limits,
    );
    if (issues.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `search spec failed validation: ${issues.map((issue) => issue.code).join(", ")}`,
      });
    }

    // S36.4 + ADR 0029: per-theatre `readScheduleRange` loops, each producing its own
    // cold-dates list and fresh-performances list with the SAME policy/
    // matchesScheduleWindow logic as the former single-theatre loop, using EACH theatre's
    // own IANA timezone for `matchesScheduleWindow` (not the representative one above).
    // S63.3: freshness is the tiered `evaluateScheduleDayFreshness` (ADR 0100), evaluated
    // with the same per-theatre timezone — SWR days are BOTH served and staged.
    // Tag every `scheduleKey` with its theatreId, and every fresh performance with
    // { theatreId, distanceKm } for skeleton-group building — ScheduleRangePerformance
    // itself carries no theatreId field, so track externally.
    const allScheduleKeys: { theatreId: string; localDate: string }[] = [];
    const allTaggedFresh: TaggedFreshPerformance[] = [];
    const nowForFreshness = new Date();

    if (resolvedTheatres.length > 0) {
      // Fetch all theatre ranges in parallel (read-only), preserve resolved order.
      const ranges = await Promise.all(
        resolvedTheatres.map(async (entry) => {
          const range = await readScheduleRange(poolClient(ctx.db), {
            providerId,
            theatreId: entry.theatreId,
            dateFrom: plan.range.from,
            dateTo: plan.range.to,
          });
          return { entry, range };
        }),
      );

      for (const { entry, range } of ranges) {
        const theatreTimezoneForMatches = theatreTimezoneById.get(entry.theatreId)!;
        const dayByDate = new Map(range.days.map((d) => [d.localDate, d]));
        const coldDates: string[] = [];
        const freshForTheatre: ScheduleRangePerformance[] = [];

        for (const date of plan.scheduleDates) {
          const day = dayByDate.get(date);
          if (day === undefined) {
            coldDates.push(date);
            continue;
          }
          // S63.3 — tiered freshness (ADR 0100): hard-cold days (past the hard TTL or
          // NULL-capture) are excluded from being served and join the cold fan-out below;
          // soft-stale-while-revalidate days ARE served from cache (fall through to the
          // performance loop) but ALSO join `coldDates` so `stageSearchCreation` stages a
          // background SCHEDULE_RESOLUTION for them via its existing scheduleKeys path.
          // Fresh days need no staging. `ctx.freshnessMs` stays in the context type
          // (facetCounts/capacityPreview still read it) but no longer gates this check.
          const freshness = evaluateScheduleDayFreshness(
            day,
            nowForFreshness,
            theatreTimezoneForMatches,
          );
          if (!freshness.isFresh && !freshness.isStaleWhileRevalidate) {
            coldDates.push(date);
            continue;
          }
          if (freshness.isStaleWhileRevalidate) {
            coldDates.push(date);
          }
          for (const perf of day.performances) {
            const status = cachedStatus(perf.status);
            if (performancePolicy(status) === "SKIP_SOLD_OUT") continue;
            if (!matchesMoviePredicate(perf.movieId, perf.title ?? null, normalizedSpec.where))
              continue;
            if (!matchesFormatPredicate(perf.formatCode, normalizedSpec.where)) continue;
            const utcInstant = perf.startsAt.toISOString();
            let matches: boolean;
            try {
              matches = matchesScheduleWindow(utcInstant, theatreTimezoneForMatches, plan);
            } catch {
              matches = false;
            }
            if (!matches) continue;
            freshForTheatre.push(perf);
          }
        }
        for (const localDate of coldDates) {
          allScheduleKeys.push({ theatreId: entry.theatreId, localDate });
        }
        for (const perf of freshForTheatre) {
          allTaggedFresh.push({
            performance: perf,
            theatreId: entry.theatreId,
            distanceKm: entry.distanceKm,
          });
        }
      }
    } else {
      // Zero resolved theatres (AREA empty): no readScheduleRange, no scheduleKeys,
      // no fresh performances — fall through to stageSearchCreation with empty lists.
    }

    // S44: rank candidates by cheap-tier score and assign ordinal dispatch_rank.
    // Order is load-bearing: SWEEP_OVERDUE_OUTBOX drains by dispatch_rank ASC so
    // best-ranked showtimes dispatch first. Rank is ordinal 0..N-1 per search,
    // never raw score, so cross-search ranks are comparable (ADR 0037 decision 2).
    const rankedTaggedFresh = [...allTaggedFresh]
      .map((tagged, originalIndex) => ({
        tagged,
        originalIndex,
        score: rankCandidate(
          tagged,
          normalizedSpec,
          theatreTimezoneById.get(tagged.theatreId) ?? "UTC",
        ),
      }))
      .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
      .map((entry, dispatchRank) => ({
        performance: entry.tagged.performance,
        theatreId: entry.tagged.theatreId,
        distanceKm: entry.tagged.distanceKm,
        dispatchRank,
      }));
    // Replace allTaggedFresh ordering with ranked order for downstream
    // skeleton and response building (S46 will use this same ranked list).
    // S45: when continuation, exclude every showtimeId already jobbed anywhere in chain
    let filteredRankedForAdmission = rankedTaggedFresh;
    if (continuesSearchId !== null) {
      const excluded = new Set<string>();
      let currentId: string | null = continuesSearchId;
      // Walk full continuation chain via continues_search_id (S45 Design item 7 / S45.9).
      // Bounded by 200/20 = 10 hops max for a fixed matched set, defensive cap 20.
      // What breaks if this walk is single-hop: a second continuation would re-fetch
      // showtimes from two hops back (correctness bug, not style).
      for (let hops = 0; hops < 20 && currentId !== null; hops++) {
        const jobs = await poolClient(ctx.db).query(
          `SELECT run_key_id FROM search_job WHERE search_id = $1 AND kind = 'SHOWTIME_FETCH'`,
          [currentId],
        );
        for (const j of jobs.rows as { run_key_id: string }[]) {
          const rk = await poolClient(ctx.db).query(
            `SELECT showtime_id FROM run_key WHERE run_key_id = $1`,
            [j.run_key_id],
          );
          const rkRow = rk.rows[0] as { showtime_id: string | null } | undefined;
          if (rkRow?.showtime_id) excluded.add(rkRow.showtime_id);
          else {
            // Fallback for legacy run_key_id encoding (tests may use synthetic keys)
            const parts = j.run_key_id.split("_");
            const sid = parts[parts.length - 1]!;
            if (sid) excluded.add(sid);
          }
        }
        const parent = await poolClient(ctx.db).query(
          `SELECT continues_search_id FROM search WHERE search_id = $1`,
          [currentId],
        );
        const prow = parent.rows[0] as { continues_search_id: string | null } | undefined;
        currentId = prow?.continues_search_id ?? null;
      }
      filteredRankedForAdmission = rankedTaggedFresh.filter(
        (t) => !excluded.has(t.performance.showtimeId),
      );
    }
    const scheduleKeys = allScheduleKeys;
    const showtimes = filteredRankedForAdmission.map((t) => ({
      showtimeId: t.performance.showtimeId,
      dispatchRank: t.dispatchRank,
    }));
    const freshMatchCount = showtimes.length;
    // S56 / ADR 0054 decision 1 — route-level capacity ceiling gate. An all-fresh
    // (all-warm, `scheduleKeys.length === 0`) submission whose exact matched-showtime
    // count exceeds the ceiling is rejected here with a structured, client-actionable
    // body — before any durable write and without charging a search unit (the charge
    // only runs when `result.kind === "created"`). Cold/mixed searches keep the S36.5
    // provisional reserve path and are never blocked here.
    if (scheduleKeys.length === 0 && freshMatchCount > ctx.limits.maxResolvedShowtimes) {
      throw new StructuredHttpError({
        code: "BAD_REQUEST",
        message: `Matched ${freshMatchCount} showtimes, which exceeds the ${ctx.limits.maxResolvedShowtimes} limit`,
        body: CapacityCeilingExceededSchema.parse({
          code: CAPACITY_CEILING_EXCEEDED,
          matchedCount: freshMatchCount,
          limit: ctx.limits.maxResolvedShowtimes,
        }),
      });
    }
    // S36.5: reserve is the provisional 200 for any cold/mixed search (one slot, one 200),
    // and the exact fresh count for all-fresh. This preserves ADR 0028 stage-one: one
    // reservation + one slot per cold search regardless of N.
    const reserve = scheduleKeys.length > 0 ? ctx.limits.maxResolvedShowtimes : freshMatchCount;

    // O7.6/ADR 0031 — capture the active request span (O5) as a W3C traceparent and
    // thread it into the outbox rows stageSearchCreation writes. Null when no request
    // span is active — a fabricated parent would graft the search onto a stale trace.
    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
    const traceparent = traceCarrier.traceparent ?? null;

    // S46.2/46.5 — build scheduleSkeleton once from the same filtered+ranked list
    // that determines admission (filteredRankedForAdmission). This is the single
    // source for both the 202 response and the B7_SKELETON_EVENT emitted in the
    // same transaction as creation (no second convention, no drift).
    const scheduleSkeletonEntries = buildScheduleSkeleton(
      filteredRankedForAdmission,
      theatreTimezoneById,
    );

    let result: SearchCreationResult;
    try {
      result = await withTransaction(ctx.db, (tx) =>
        stageSearchCreation(tx, {
          searchId,
          sessionId,
          idempotencyKey: input.idempotencyKey,
          spec: normalizedSpec,
          specHash: hash,
          deadlineAt,
          providerId,
          reserve,
          scheduleKeys,
          showtimes,
          freshMatchCount,
          traceparent,
          skeletonEntries: scheduleSkeletonEntries,
          continuesSearchId,
        }),
      );
    } catch (error) {
      // S15.10 mappings. Both bodies are re-validated against their core schemas at this
      // boundary (Zod at every boundary) — the formatter then emits exactly that shape.
      if (error instanceof IdempotencyKeyConflictError) {
        throw new StructuredHttpError({
          code: "CONFLICT",
          message:
            `an existing search (${error.searchId}) already consumed this idempotency key ` +
            "with a different spec",
          body: IdempotencyKeyConflictSchema.parse({
            code: "IDEMPOTENCY_KEY_CONFLICT",
            searchId: error.searchId,
          }),
        });
      }
      if (error instanceof AdmissionRejectedError) {
        throw new StructuredHttpError({
          code: "TOO_MANY_REQUESTS",
          message: `provider ${error.providerId} admission ceiling reached; retry later`,
          body: AdmissionRejectedErrorSchema.parse({
            code: "ADMISSION_REJECTED",
            retryAfterSeconds: ctx.retryAfterSeconds,
          }),
        });
      }
      throw error;
    }

    // S16.5 — charge AFTER the durable commit, and only on NEW work: a replay
    // (`kind === "replay"`) is never charged, and failed/rolled-back work never burned
    // budget. The charge failure is swallowed deliberately: Redis loss must not break
    // the app (S16.16) — an under-count in a reconstructible window, never a failed
    // create.
    if (result.kind === "created") {
      try {
        await ctx.limiter.charge(sessionId, "searches", 1);
      } catch (error) {
        // S16.16 — an under-count in a reconstructible window, never a failed
        // create; surfaced for operators (O11.8).
        ctx.logger.warn(
          { session_id: sessionId, error },
          "searches.create: post-commit search-rate charge failed (failing open)",
        );
      }
    }

    return toCreateResponse(result, filteredRankedForAdmission, theatreTimezoneById);
  });
