/**
 * The provider fetch actor (S8): the shared RUN-handler body that acquires the
 * capacity-one provider semaphore, re-checks S5's fail-closed control state, passes the
 * durable `B4_PREDISPATCH` fence, drives one logical navigation through P6's corridor
 * transport, maps P6's typed `NavigationOutcome` onto S5's durability transitions
 * (exhaustively — never a guessed or default one), and releases capacity only after P6's
 * cleanup-completion signal resolves (S8.16).
 *
 * S8 owns no numeric policy: the semaphore lease TTL, the heartbeat interval, the
 * navigation bounds, the run-lease TTL, and the attempt budget are every one an
 * injected caller-supplied parameter with no default (S8.18 / gate 14). No HTML parser
 * is implemented here — parsing is the injected seam S8.9 defines, which P5 will supply
 * once it unblocks.
 *
 * S8.1: this module is the `RUN` branch only. The `JOB`-branch admission/dedup layer
 * (search-to-`FetchKey` subscription, freshness gate, find-or-create-run) has no
 * production durability code today and is a separate, not-yet-specced task.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import type { BrowserContext, Route } from "playwright-core";
import { trace } from "@opentelemetry/api";

import { attachRunKeyEntityAttributes, runCorridorNavigation } from "@seatfirst/browser-runtime";
import type {
  BrowserSupervisor,
  HopResponse,
  NavigationAttempt,
  NavigationLimits,
  NavigationOutcome,
  SanitizedPayload,
} from "@seatfirst/browser-runtime";
import {
  encodeAuditoriumLayoutGeometry,
  IanaTimezoneSchema,
  matchesMoviePredicate,
  matchesScheduleWindow,
  performancePolicy,
  rankCandidate,
  resolveScheduleWindowPlan,
  SearchSpecSchema,
  toTheatreLocal,
  UtcInstantSchema,
  type AuditoriumLayout,
  type TaggedFreshPerformance,
} from "@seatfirst/core";
import type { Performance } from "@seatfirst/providers";
// TODO(diagnostic-capture): uploadDiagnosticBlob is the exact name from this batch's
// shared contract but no sibling owns it yet (InfraS3AndOps is infra-repo only and
// declined it; no AWS SDK usage exists in the app repo to reuse — assumed home is
// @seatfirst/durability next to DIAGNOSTIC_CAPTURE_INSERT). DIAGNOSTIC_CAPTURE_INSERT
// itself has landed (packages/durability/src/boundaries.ts, params in contract order)
// and IS exported from the package index. Confirm the helper's home module once it
// lands and fix this import if it differs.
import {
  B3_HEARTBEAT_RUN,
  B4_PREDISPATCH,
  DIAGNOSTIC_CAPTURE_INSERT,
  RUN_DEFER_BUSY,
  SEMAPHORE_ACQUIRE,
  SEMAPHORE_RELEASE,
  acceptFetch,
  applyProviderControlTransition,
  failRun,
  heartbeatSemaphoreOrAbort,
  readProviderControlState,
  runStatement,
  stageRecheckComplete,
  stageRecheckFail,
  stageScheduleAcceptance,
  updatePerformanceProduct,
  uploadDiagnosticBlob,
  upsertMovie,
  withTransaction,
} from "@seatfirst/durability";
import type {
  ProviderControlTrigger,
  ProviderStateSource,
  RedisHashCache,
  RedisScriptExecutor,
  RunHandle,
  ScheduleSubscriberFilter,
} from "@seatfirst/durability";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { SeatfirstMetrics } from "@seatfirst/config/otel";

import { findSearchById } from "../queries.js";
import type { RunKeyKind, RunKeyRow } from "../queries.js";
import type { RunHandlerContext } from "../types.js";

/**
 * S8.9 — the injected parse seam. A closed union, not an open contract: a success names
 * the run kind it parsed, a failure names either the validated schema-incompatibility
 * cause or any other parse failure. There is no default implementation — S8 ships the
 * seam, P5 supplies the real parser.
 */
export type ParseResult =
  | Readonly<{
      ok: true;
      kind: "SHOWTIME_FETCH";
      bitmap: Uint8Array;
      freeCount: number;
      /** ADR 0032 — the built auditorium layout, encoded and persisted at acceptance. */
      layout: AuditoriumLayout;
      minPrice?: number | null;
      priceBasis?: "TICKET_ONLY" | "UNKNOWN" | null;
    }>
  | Readonly<{
      ok: true;
      kind: "SCHEDULE_RESOLUTION";
      /**
       * S14.1 — the parse seam now carries every product column `PERFORMANCE_UPDATE_PRODUCT`
       * needs, so one `SCHEDULE_RESOLUTION` acceptance can persist the resolved product
       * fields alongside the base showtime identity. The authoritative field set is the
       * settled `Performance` interface (`packages/providers/src/contract.ts:184-204`), picked
       * here for exactly the fields that persist, with the three deviations the seam has
       * always used: `showtimeId` and `movieId` stay plain `string` (the injected seam
       * predates the branded `ShowtimeId`/`MovieId`), and `startsAt` is the seam's name for
       * `Performance.showDateTimeUtc`. `minPrice`/`layoutId` are deliberately absent — both
       * are null-until-seat-fetch (`contract.ts:199-203`) and the handler passes them as
       * literal `null`, never from the seam. S24.5 adds `movieTitle` — picked so the same
       * acceptance can populate the movie catalogue (S24.5b).
       */
      performances: readonly (Pick<
        Performance,
        | "auditorium"
        | "utcOffset"
        | "runtimeMinutes"
        | "status"
        | "attributes"
        | "formatCode"
        | "deepLinkUrl"
        | "providerMeta"
        | "movieTitle"
      > & {
        readonly showtimeId: string;
        readonly startsAt: Date;
        readonly movieId: string;
      })[];
    }>
  | Readonly<{ ok: true; kind: "RECHECK"; placementAvailable: boolean }>
  | Readonly<{
      ok: false;
      cause: "PARSER_SCHEMA_INCOMPATIBLE";
      diagnostic?: UpstreamChangedDiagnostic;
    }>
  | Readonly<{ ok: false; cause: string; diagnostic?: UpstreamChangedDiagnostic }>;

/**
 * Raw/unredacted diagnostic payload for `UPSTREAM_CHANGED` (risk-accepted by Josh Wu;
 * see the ADR amendments in this batch). Populated by the provider parse layer, which
 * fires on an already-fetched HTML string with no live `Page` — so url+body+headers
 * only, never a screenshot. Additive: consumers that never look for it observe the
 * exact same outcome shape as before. Absent (undefined) = no capture attempted.
 */
export interface UpstreamChangedDiagnostic {
  /** Raw request URL, full query string included — never redacted. */
  readonly url: string;
  /** Raw response body (HTML string or bytes) — never redacted. */
  readonly body: string | Uint8Array;
  /** All raw response headers; whatever was available at the parse call site. */
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * P6's offline synthetic test-harness seams, passed through to `runCorridorNavigation`
 * verbatim. Production deployments omit them entirely — the transport then performs
 * each document hop through the browser's own network stack. They exist here only
 * because every S8 verification case runs against P6's local synthetic corridor
 * pattern, never live AMC traffic.
 */
export interface ProviderFetchNavigationSeams {
  readonly contextSetup?: (context: BrowserContext) => void | Promise<void>;
  readonly fetchHop?: (route: Route) => Promise<HopResponse>;
}

/**
 * The fully injected dependency set (S8.18): Postgres pool (durability's `createPool`),
 * the Redis script/hash surface (one ioredis-style client satisfies both), S5's
 * fail-closed control-state source backed by the same pool, the warm-process browser
 * supervisor (constructed once at process-entry time, never per navigation), and the
 * injected policy values. No numeric bound has a default — gate 14 / ADR 0006.
 */
export interface ProviderFetchActorDeps {
  /** Caller-owned pg pool; `withTransaction` provides the single-connection guarantee
   * every BEGIN-emitting durability helper requires. */
  readonly pool: Pool;
  /** One client satisfies both interfaces (ioredis does, structurally). */
  readonly redis: RedisScriptExecutor & RedisHashCache;
  /** S5's fail-closed authority read (`PROVIDER_EFFECTIVE_STATE`), backed by `pool`. */
  readonly controlSource: ProviderStateSource;
  /** The warm-process Chrome supervisor, created once at process entry. */
  readonly supervisor: BrowserSupervisor;
  /** Deployment-assigned AMC identity, validated by P1's policy at navigation time. */
  readonly userAgent: string;
  /** Per-navigation bounds — injected, no default (P6.18). */
  readonly navigationLimits: NavigationLimits;
  /** Semaphore lease TTL for `SEMAPHORE_ACQUIRE`/heartbeat — injected, no default. */
  readonly semaphoreTtlMs: number;
  /** Cadence for the B3 + semaphore heartbeat loop while navigation is in flight. */
  readonly heartbeatIntervalMs: number;
  /** Postgres interval literal for `B3_HEARTBEAT_RUN`'s own lease bump — separate from
   * S11's initial B2 lease TTL (gate 14). */
  readonly runLeaseTtl: string;
  /** Attempt budget handed to `failRun` — injected, no default (gate 14). */
  readonly maxAttempts: number;
  /** S8 does not itself know AMC URL shapes (provider-contract territory): the caller
   * supplies the prevalidated navigation target for a run's key. Async because the
   * SCHEDULE_RESOLUTION route reads the theatre's slugs (D2, S31.2). */
  readonly buildTargetUrl: (runKey: RunKeyRow) => Promise<string>;
  /** S8.9's parse seam — no default implementation. */
  readonly parseObservation: (payload: SanitizedPayload, runKey: RunKeyRow) => Promise<ParseResult>;
  /** Offline synthetic-harness seams (P6); omitted in production. */
  readonly navigationSeams?: ProviderFetchNavigationSeams;
  /**
   * S16.14 — the post-commit fetch-window charge, one per subscriber an accepted
   * outcome actually applied to. Optional (like `navigationSeams`): the S8/S11 test
   * harnesses construct deps without it, and the production entrypoint (not built in
   * S16) wires it to the session limiter's `fetches` window. Absent = the run performs
   * no rate accounting.
   */
  readonly chargeSubscriberFetch?: (sessionId: string) => Promise<void>;
  /**
   * S36.6 — per-subscriber cold fan-out filter (plain-data seam). The production
   * implementation parses the stored `search.spec` with `SearchSpecSchema` and
   * applies the shared core movie and theatre-local schedule-window evaluators.
   * Optional for test harnesses: absent means durability's caller-supplied filter
   * is undefined and the acceptance expands every showtime (pre-S36 behavior).
   * Production (`fetch-worker/entrypoint.ts`) injects `scheduleSubscriberFilter`
   * defined below.
   *
   * Exact filter API wired: `ScheduleSubscriberFilter` from `@seatfirst/durability`
   * (`packages/durability/src/transactions.ts`) — `(input: { searchId, spec,
   * timezone, showtimes }) => readonly ScheduleShowtime[]`.
   */
  readonly scheduleSubscriberFilter?: ScheduleSubscriberFilter;
  /** O6.6 — the fetch-job duration instrument (FULL|PARTIAL|HALTED outcome families);
   * absent = nothing recorded. */
  readonly metrics?: SeatfirstMetrics;
}

/**
 * S5's `ProviderStateSource` for the common case where the fail-closed authority read
 * goes through the same pool as everything else. Adapter only — the read itself is the
 * named boundary statement `PROVIDER_EFFECTIVE_STATE`, never inline SQL.
 */
export function providerStateSourceFromPool(pool: Pool): ProviderStateSource {
  return {
    async query(text, values) {
      const result = await pool.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as { state: "OPEN" | "PAUSED" | "HALTED" }[] };
    },
  };
}
/**
 * S36.6 — production `ScheduleSubscriberFilter`.
 *
 * Durability must never import `@seatfirst/core` (firewall in `packages/durability`);
 * this function lives in `apps/server` and is injected from the fetch-worker. It
 * delegates entirely to the shared core evaluator so warm-cache selection, cold
 * fan-out, and aggregate assembly cannot drift.
 *
 * - Parse the stored `spec` with `SearchSpecSchema` (valid search specs were
 *   already validated at admission; invalid → fail-closed []).
 * - Resolve the `where` predicate to a `ScheduleWindowPlan` via
 *   `resolveScheduleWindowPlan` (ambiguous `OR`/`NOT`, duplicate predicates,
 *   missing/multiple ranges or windows, crossing `startLocal > endLocal`, or
 *   empty plan → fail-closed [] as per ADR 0028 amendment 207-216).
 * - Require both `matchesMoviePredicate(movieId, movieTitle, where)` and
 *   `matchesScheduleWindow(utcInstant, timezone, plan)`. The stored daily
 *   performance rows remain complete; only this search's fetch fan-out is filtered.
 *
 * Durability's `stageScheduleAcceptance` receives the plain-data seam and retains
 * the cumulative capacity gate before dispatch.
 */
export const scheduleSubscriberFilter: ScheduleSubscriberFilter = (input) => {
  try {
    const spec = SearchSpecSchema.parse(input.spec);
    const plan = resolveScheduleWindowPlan(spec.where);
    const tz = input.timezone;
    const filtered = input.showtimes.filter((st) => {
      try {
        const utc = st.startsAt.toISOString();
        return (
          matchesMoviePredicate(st.movieId, st.movieTitle ?? null, spec.where) &&
          matchesScheduleWindow(utc, tz, plan)
        );
      } catch {
        return false;
      }
    });
    // S44: rank each subscriber's filtered showtimes independently by cheap-tier
    // score (format/distance/time) using the real per-subscriber spec and theatre
    // timezone, then assign ordinal dispatchRank 0..N-1. This satisfies S44.9's
    // per-date independent ranking and S44 Design item 6's cold-path requirement.
    // DistanceKm is not available on ScheduleShowtime (single-theatre cold date
    // has null distance, so proximity is neutral), but formatCode and startsAt
    // are, and timezone is the real theatre timezone from the transaction's
    // per-subscriber lookup — far better than a global startsAt sort.
    const ranked = filtered
      .map((st, originalIndex) => {
        // Build TaggedFreshPerformance shape for rankCandidate; theatreId/distanceKm
        // are not on ScheduleShowtime, so use neutral values (null distance, theatreId from input)
        // and include timezone for correct local-time conversion.
        const tagged: TaggedFreshPerformance = {
          performance: {
            showtimeId: st.showtimeId,
            formatCode: (st as { formatCode?: string | null }).formatCode ?? null,
            startsAt: st.startsAt,
          },
          theatreId: (st as { theatreId?: string }).theatreId ?? "unknown",
          distanceKm: (st as { distanceKm?: number | null }).distanceKm ?? null,
          timezone: tz,
        };
        return { st, originalIndex, score: rankCandidate(tagged, spec, tz) };
      })
      .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
      .map((entry, dispatchRank) => {
        // S57 (ADR 0054 decision 2) — theatre-local datetime for the cold-date
        // skeleton emission: the same `toTheatreLocal` conversion `buildScheduleSkeleton`
        // uses in `routes/searches/create.ts` (no second conversion routine).
        // Fail-open to the UTC ISO string on invalid timezone/instant, mirroring create.ts.
        let showDateTimeLocal: string;
        try {
          showDateTimeLocal = toTheatreLocal(
            UtcInstantSchema.parse(entry.st.startsAt.toISOString()),
            IanaTimezoneSchema.parse(tz),
          ).localDateTime;
        } catch {
          showDateTimeLocal = entry.st.startsAt.toISOString();
        }
        return { ...entry.st, dispatchRank, showDateTimeLocal };
      });
    return ranked;
  } catch {
    return [];
  }
};

/**
 * The semaphore key convention established by the durability tier's Redis fencing tests
 * (`packages/durability/test/tier4.crash.test.ts`): the holder hash `sem:{providerId}`
 * plus a companion generation counter `sem:{providerId}:gen` that survives expiry.
 */
function semaphoreKeys(providerId: string): readonly [string, string] {
  return [`sem:${providerId}`, `sem:${providerId}:gen`];
}

/**
 * O3.1/O3.3 — attach the run's discrete structural entity identifiers (`runKeyId`,
 * `theatreId`, `showtimeId`, `localDate`) to the active trace span, if one exists
 * (O1's wiring activates one in production; absent → no-op). Only the ADR 0005 §D
 * amendment's permitted `RunKeyRow` parts are attached — never the reconstructed
 * `targetUrl` or a raw `requestUrl` from `providerMeta`. Null/undefined parts are
 * omitted, not stringified as `"null"` (O3.2). Called before navigation and on every
 * `failRun` path so a failure's span carries the entity identity needed to reproduce it.
 */
function attachRunKeyToActiveSpan(runKey: RunKeyRow): void {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return;
  }
  attachRunKeyEntityAttributes(span, runKey);
}

/**
 * S8.2–S8.5, S8.7–S8.16 — one logical navigation through the capacity-one actor:
 * control read → acquire → re-check → B4 → heartbeat loop → navigate → map outcome →
 * release after cleanup. Written once here and shared by both RUN-handler factories.
 */
export async function runProviderFetch(
  deps: ProviderFetchActorDeps,
  ctx: RunHandlerContext,
  kind: RunKeyKind,
): Promise<void> {
  const logger = ctx.logger;
  const { run, runKey } = ctx;
  // O3.1 — attach the run key's discrete entity identifiers to the active span before
  // any work, so both the navigation span and every downstream failRun path carry them.
  attachRunKeyToActiveSpan(runKey);
  // The holder identity is the run's own identity: one logical navigation per leased
  // run, and the same string gates every heartbeat and the release (ADR 0001 §4).
  const handle: RunHandle = { runId: run.runId, generation: run.generation };
  const providerId = runKey.providerId;
  const routeClass = runKey.routeClass;
  // O6.6 — every recorded branch measures from the actor's start, before the control
  // read, so the histogram covers the whole logical navigation.
  const startedAt = Date.now();

  // 1. Fail-closed control read BEFORE acquisition (S8.2/S8.3). S5's function, not a
  // reimplementation: a missing, stale, or unreadable entry is HALTED, never OPEN.
  const stateBefore = await readProviderControlState(
    deps.redis,
    deps.controlSource,
    providerId,
    routeClass,
  );
  if (stateBefore !== "OPEN") {
    logger.warn(
      {
        kind,
        run_id: run.runId,
        provider_id: providerId,
        route_class: routeClass,
        state: stateBefore,
      },
      "provider fetch: not dispatched — control state is not OPEN (fail-closed)",
    );
    return;
  }

  // 2. Capacity-one provider semaphore (S8.2). A non-numeric reply means the semaphore
  // is already held: this delivery lost the race, and instead of stranding its run
  // LEASED until the sweeper's lease expiry notices, it defers the run durably —
  // RUN_DEFER_BUSY below (ADR 0001 §5 recovery duty; S10 proved the stranded shape).
  const [semaphoreKey, generationKey] = semaphoreKeys(providerId);
  const acquired = await deps.redis.eval(
    SEMAPHORE_ACQUIRE,
    [semaphoreKey, generationKey],
    [handle.runId, deps.semaphoreTtlMs],
  );
  if (typeof acquired !== "number") {
    // Postgres is truth; the semaphore is only a hint. One fenced statement performs
    // both halves of the defer atomically: LEASED→PENDING with the lease cleared, plus
    // the fresh RUN outbox row that becomes the replacement delivery. Zero rows means
    // THIS delivery was stale or the run is no longer LEASED (a reclaim or newer
    // delivery won the race) — there is nothing to resurrect, so return.
    const deferred = await runStatement<{ outbox_id: string }>(ctx.sqlClient, RUN_DEFER_BUSY, [
      handle.runId,
      handle.generation,
    ]);
    if (deferred.length === 0) {
      logger.warn(
        { kind, run_id: run.runId, provider_id: providerId },
        "provider fetch: not dispatched — semaphore held and busy-defer lost (stale delivery or run no longer LEASED)",
      );
      return;
    }
    logger.warn(
      {
        kind,
        run_id: run.runId,
        provider_id: providerId,
        outbox_id: deferred[0]?.outbox_id,
      },
      "provider fetch: run deferred — provider semaphore busy; back to PENDING with a fresh outbox row",
    );
    return;
  }
  // Redis owns this generation independently from Postgres. They can diverge after a
  // busy run is re-leased, so heartbeat and release must use the generation returned by
  // SEMAPHORE_ACQUIRE, not the provider_run generation.
  const semaphoreGeneration = acquired;

  let attempt: NavigationAttempt | null = null;
  try {
    // 3. Re-check kill switch, epoch, and notBefore AFTER acquisition, immediately
    // before dispatch (S8.2/S8.3).
    const stateAfter = await readProviderControlState(
      deps.redis,
      deps.controlSource,
      providerId,
      routeClass,
    );
    if (stateAfter !== "OPEN") {
      logger.warn(
        {
          kind,
          run_id: run.runId,
          provider_id: providerId,
          route_class: routeClass,
          state: stateAfter,
        },
        "provider fetch: not dispatched — control state changed after semaphore acquisition",
      );
      return;
    }

    // 4. B4_PREDISPATCH — the mandatory final durable fence (S8.4). Zero rows means do
    // NOT dispatch: halted, still cooling down, or the lease was lost. The semaphore is
    // released by the finally below and no Playwright navigation is attempted.
    const fenced = await runStatement<{ provider_epoch: string }>(ctx.sqlClient, B4_PREDISPATCH, [
      handle.runId,
      handle.generation,
    ]);
    if (fenced.length === 0) {
      logger.warn(
        { kind, run_id: run.runId },
        "provider fetch: not dispatched — B4_PREDISPATCH denied (halted, still cooling down, or lease lost)",
      );
      return;
    }

    // 5. Heartbeat loop while the navigation is in flight (S8.5): B3 keeps the durable
    // lease alive and the semaphore heartbeat keeps the Redis fence alive. Either one
    // losing its fence aborts the real AbortSignal passed to the transport below.
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      void heartbeatTick(deps, ctx, handle, semaphoreKey, semaphoreGeneration, abortController);
    }, deps.heartbeatIntervalMs);

    // 6. One navigation through P6's public API only (S8.6). The interval is cleared
    // the moment the navigation settles — no leaked timer on any outcome.
    let navigationError: unknown = null;
    try {
      attempt = await runCorridorNavigation(deps.supervisor, {
        scope: {
          providerId,
          observationId: run.observationId,
          fetchRunId: run.runId,
          routeClass,
          egressIdentityLabel: deps.supervisor.egressIdentityLabel,
        },
        targetUrl: await deps.buildTargetUrl(runKey),
        userAgent: deps.userAgent,
        limits: deps.navigationLimits,
        signal: abortController.signal,
        ...(deps.navigationSeams?.contextSetup !== undefined
          ? { contextSetup: deps.navigationSeams.contextSetup }
          : {}),
        ...(deps.navigationSeams?.fetchHop !== undefined
          ? { fetchHop: deps.navigationSeams.fetchHop }
          : {}),
      });
    } catch (error) {
      navigationError = error;
    } finally {
      clearInterval(heartbeat);
    }

    // 7. Exhaustive outcome mapping (S8.7–S8.9, S8.12–S8.15). The duration start rides
    // along so each mapped branch records O6.6's fetchJobDuration from navigation start.
    if (attempt !== null) {
      await mapNavigationOutcome(deps, ctx, handle, kind, attempt.outcome, startedAt);
      return;
    }
    // The transport rejected outright (P6's API returns typed outcomes; a rejection is
    // a config-level failure such as P1's identity policy). Same rule as
    // NAVIGATION_FAILED: fail this run only, never a B9 transition — a transport-level
    // failure is not by itself a validated parser-schema incompatibility (S8.15).
    const cause =
      navigationError instanceof Error ? navigationError.message : String(navigationError);
    logger.error({ kind, run_id: run.runId, cause }, "provider fetch: navigation rejected");
    await failRunWithRecheckOutcome(deps, handle, kind, cause, "UPSTREAM_UNAVAILABLE");
    recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
  } finally {
    // S8.16 — capacity is released only after P6's cleanup-completion signal resolves:
    // the page and context are closed and no browser request can continue. This runs on
    // every branch, including every durability-call throw above.
    if (attempt !== null) {
      await attempt.cleanupCompleted;
    }
    await deps.redis.eval(SEMAPHORE_RELEASE, [semaphoreKey], [handle.runId, semaphoreGeneration]);
  }
}

/**
 * S8.5 — one heartbeat tick. B3 first, then the semaphore heartbeat; a zero-row B3 (or
 * a failed heartbeat of either kind) is fail-closed: if the actor cannot prove it still
 * owns its fences, the navigation must stop rather than continue unfenced.
 */
async function heartbeatTick(
  deps: ProviderFetchActorDeps,
  ctx: RunHandlerContext,
  handle: RunHandle,
  semaphoreKey: string,
  semaphoreGeneration: number,
  abortController: AbortController,
): Promise<void> {
  try {
    const leased = await runStatement<{ run_id: string }>(ctx.sqlClient, B3_HEARTBEAT_RUN, [
      handle.runId,
      handle.generation,
      deps.runLeaseTtl,
    ]);
    if (leased.length === 0) {
      abortController.abort(
        `run lease lost (B3_HEARTBEAT_RUN returned zero rows for ${handle.runId})`,
      );
      return;
    }
    await heartbeatSemaphoreOrAbort(
      deps.redis,
      semaphoreKey,
      handle.runId,
      semaphoreGeneration,
      deps.semaphoreTtlMs,
      abortController,
    );
  } catch (error) {
    abortController.abort(
      `heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    ctx.logger.warn(
      { run_id: handle.runId },
      "provider fetch: heartbeat failed — aborting navigation",
    );
  }
}

/**
 * S16.14 — the weighted fetch charge: one `fetches` window charge per subscriber an
 * accepted outcome actually applied to ("the abuse meter charges every subscriber
 * session the full logical-navigation weight", seatfirst-architecture.md:233).
 * Exactly-once rides the already-idempotent per-subscriber application record
 * `(fetchRunId, searchId)` (seatfirst-architecture.md:230): `fannedIn` contains only
 * subscribers that transitioned, so a crash-re-apply — whose acceptance fans in nobody
 * new — charges zero. This runs strictly AFTER the acceptance transaction committed
 * (rollback charges nothing) and is best-effort per subscriber: a failed charge (Redis
 * loss, S16.16) is an under-count in a reconstructible window, never a failed run, and
 * no session id is ever logged.
 */
async function chargeFannedInSubscribers(
  deps: ProviderFetchActorDeps,
  logger: SeatfirstLogger,
  handle: RunHandle,
  kind: RunKeyKind,
  fannedIn: readonly { search_id: string }[],
): Promise<void> {
  if (deps.chargeSubscriberFetch === undefined) {
    return; // not wired — the S8/S11 harnesses construct deps without this seam.
  }
  for (const row of fannedIn) {
    try {
      const search = await findSearchById(deps.pool, row.search_id);
      if (search === null) {
        logger.warn(
          { kind, run_id: handle.runId, search_id: row.search_id },
          "provider fetch: no search row for applied subscriber; fetch window not charged",
        );
        continue;
      }
      await deps.chargeSubscriberFetch(search.sessionId);
    } catch (cause) {
      logger.warn(
        {
          kind,
          run_id: handle.runId,
          search_id: row.search_id,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        "provider fetch: fetch charge failed for subscriber",
      );
    }
  }
}

/**
 * S22.4 — fail a run, and for a RECHECK run also persist its UNAVAILABLE outcome in the
 * SAME transaction (the run is FAILED = terminal, satisfying S22.6's invariant). The
 * `outcomeCause` is the S22.12 UNAVAILABLE cause, which may differ from the run's own
 * `failCause` (e.g. GUARD_REJECTED → "UPSTREAM_CHANGED"). Non-RECHECK kinds behave
 * exactly as before.
 */
async function failRunWithRecheckOutcome(
  deps: ProviderFetchActorDeps,
  handle: RunHandle,
  kind: RunKeyKind,
  failCause: string,
  outcomeCause: string,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    await failRun(tx, handle, failCause, deps.maxAttempts);
    if (kind === "RECHECK") {
      await stageRecheckFail(tx, handle.runId, outcomeCause);
    }
  });
}

/**
 * Best-effort raw diagnostic capture for `UPSTREAM_CHANGED` only. Runs strictly AFTER
 * the real outcome/durability transition has committed: a capture failure (S3 or
 * Postgres) logs a warning and never fails the run. No-op when the parse failure
 * carries no diagnostic payload. `screenshot_s3_key` is always NULL here — the parser
 * boundary has no live `Page`.
 */
async function captureUpstreamChangedDiagnostic(
  deps: ProviderFetchActorDeps,
  logger: SeatfirstLogger,
  runId: string,
  parsed: Extract<ParseResult, { ok: false }>,
): Promise<void> {
  const diagnostic = parsed.diagnostic;
  if (diagnostic === undefined) {
    return;
  }
  const captureId = `dcap_${randomUUID()}`;
  const bodyS3Key = `UPSTREAM_CHANGED/${runId}/${captureId}-body`;
  try {
    const body = typeof diagnostic.body === "string" ? diagnostic.body : Buffer.from(diagnostic.body);
    await uploadDiagnosticBlob(bodyS3Key, body, "text/html; charset=utf-8");
    await runStatement<{ capture_id: string }>(deps.pool, DIAGNOSTIC_CAPTURE_INSERT, [
      captureId,
      runId,
      "UPSTREAM_CHANGED",
      diagnostic.url,
      JSON.stringify(diagnostic.headers ?? {}),
      bodyS3Key,
      null,
    ]);
  } catch (err) {
    logger.warn(
      { run_id: runId, capture_id: captureId, err },
      "provider fetch: diagnostic capture failed — outcome already recorded",
    );
  }
}
/**
 * Best-effort raw diagnostic capture for `UPSTREAM_BLOCKED` / `CHALLENGE_REQUIRED`.
 * Runs strictly AFTER the real B9/control transition has committed: a capture
 * failure (S3 or Postgres) logs a warning and never fails the run. No-op when the
 * outcome carries no raw payload — synthetic/offline corridors never populate it.
 * Mirrors `captureUpstreamChangedDiagnostic` exactly: upload-then-insert, the whole
 * step in one try/catch. One deliberate adaptation: `body_s3_key` is NOT NULL in
 * `026_diagnostic_capture.sql`, so a bodyless capture is unrepresentable and skips
 * cleanly (no uploads, no row) instead of issuing an insert the schema rejects.
 */
async function captureBlockedOrChallengeDiagnostic(
  deps: ProviderFetchActorDeps,
  logger: SeatfirstLogger,
  runId: string,
  outcome: Extract<NavigationOutcome, { kind: "UPSTREAM_BLOCKED" | "CHALLENGE_REQUIRED" }>,
): Promise<void> {
  const raw = outcome.rawDiagnostic;
  if (raw === undefined || raw.body === undefined) {
    return;
  }
  const captureId = `dcap_${randomUUID()}`;
  const bodyS3Key = `${outcome.kind}/${runId}/${captureId}-body`;
  const screenshotS3Key = `${outcome.kind}/${runId}/${captureId}-screenshot`;
  try {
    await uploadDiagnosticBlob(bodyS3Key, raw.body, "text/html; charset=utf-8");
    let persistedScreenshotKey: string | null = null;
    if (raw.screenshot !== undefined) {
      await uploadDiagnosticBlob(screenshotS3Key, Buffer.from(raw.screenshot), "image/png");
      persistedScreenshotKey = screenshotS3Key;
    }
    await runStatement<{ capture_id: string }>(deps.pool, DIAGNOSTIC_CAPTURE_INSERT, [
      captureId,
      runId,
      outcome.kind,
      raw.url,
      JSON.stringify(raw.headers),
      bodyS3Key,
      persistedScreenshotKey,
    ]);
  } catch (err) {
    logger.warn(
      { run_id: runId, capture_id: captureId, err },
      "provider fetch: diagnostic capture failed — outcome already recorded",
    );
  }
}

/**
 * S8.7 — the exhaustive `NavigationOutcome` → durability mapping, over all 8 variants
 * with a `never` check (mirroring `deriveControlTransition`'s pattern). Never a default
 * branch that swallows an unhandled variant.
 *
 * O6.6 — every terminal branch records O6's `fetchJobDuration` histogram with the run
 * state machine's coarse outcome family: `FULL` for accepted parses, `HALTED` for
 * control transitions (and the validated parser-schema pause), `PARTIAL` for everything
 * else. Durations measure from the actor's start (`startedAt`, threaded from
 * `runProviderFetch`).
 */
async function mapNavigationOutcome(
  deps: ProviderFetchActorDeps,
  ctx: RunHandlerContext,
  handle: RunHandle,
  kind: RunKeyKind,
  outcome: NavigationOutcome,
  startedAt: number,
): Promise<void> {
  const logger = ctx.logger;
  const { runKey } = ctx;
  // O3.1 — this function is where every failRun lives; attach the entity identifiers to
  // the active span again so a failure carries them even if the span changed since the
  // navigation started.
  attachRunKeyToActiveSpan(runKey);
  const providerId = runKey.providerId;
  const routeClass = runKey.routeClass;
  switch (outcome.kind) {
    case "SUCCESS": {
      const parsed = await deps.parseObservation(outcome.payload, runKey);
      if (!parsed.ok) {
        if (parsed.cause === "PARSER_SCHEMA_INCOMPATIBLE") {
          // S8.15: a validated parse-time schema failure on a successfully fetched
          // document pauses the affected route AND fails this run. failRun MUST win
          // its fence first: B9_FENCE_RUNS bumps every leased run's generation for the
          // provider, and a failRun issued after that bump would zero-row forever.
          await failRunWithRecheckOutcome(
            deps,
            handle,
            kind,
            "PARSER_SCHEMA_INCOMPATIBLE",
            "UPSTREAM_CHANGED",
          );
          await controlTransition(deps, providerId, {
            kind: "PARSER_SCHEMA_INCOMPATIBLE",
            routeClass,
          });
          // Best-effort raw capture AFTER the real transition committed — never throws.
          await captureUpstreamChangedDiagnostic(deps, logger, handle.runId, parsed);
          recordFetchDuration(deps.metrics, startedAt, "HALTED");
          return;
        }
        // Any other parse failure: fail this run only, no B9 call (S8.15's contrast —
        // a generic parse failure is not by itself a validated schema incompatibility).
        await failRunWithRecheckOutcome(deps, handle, kind, parsed.cause, "UPSTREAM_CHANGED");
        // Best-effort raw capture AFTER the real transition committed — never throws.
        await captureUpstreamChangedDiagnostic(deps, logger, handle.runId, parsed);
        recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
        return;
      }
      if (parsed.kind !== kind) {
        // The injected parser returned a success for the wrong branch — out of the
        // S8.9 contract, so it fails this run rather than guessing an acceptance.
        logger.error(
          { kind, run_id: handle.runId, parsed_kind: parsed.kind },
          "provider fetch: parse returned wrong kind — failing the run",
        );
        await withTransaction(deps.pool, (tx) =>
          failRun(tx, handle, `PARSE_KIND_MISMATCH:${parsed.kind}`, deps.maxAttempts),
        );
        recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
        return;
      }
      if (parsed.kind === "RECHECK") {
        // S22.4 — a successful recheck parse resolves RECHECK_COMPLETE (AVAILABLE/GONE):
        // no acceptFetch/acceptSchedule, no B5 acceptance, no snapshot write, no subscriber
        // charge (a recheck has no subscribers). The outcome payload carries only the
        // verdict; the route assembles the full RecheckResult from the terminal answer +
        // the injected recovery seam (S22.12).
        const status = parsed.placementAvailable ? "AVAILABLE" : "GONE";
        await withTransaction(deps.pool, (tx) =>
          stageRecheckComplete(tx, handle, status, {
            placementAvailable: parsed.placementAvailable,
          }),
        );
        recordFetchDuration(deps.metrics, startedAt, "FULL");
        return;
      }
      if (parsed.kind === "SHOWTIME_FETCH") {
        const accepted = await withTransaction(deps.pool, (tx) =>
          acceptFetch(tx, handle, {
            bitmap: Buffer.from(parsed.bitmap),
            freeCount: parsed.freeCount,
            capturedAt: new Date(),
            layout: {
              layoutId: parsed.layout.layoutId,
              geometry: encodeAuditoriumLayoutGeometry(parsed.layout),
              rows: parsed.layout.rows,
              columns: parsed.layout.columns,
            },
            minPrice: parsed.minPrice,
            currency: parsed.minPrice !== null && parsed.minPrice !== undefined ? "USD" : null,
            priceBasis: parsed.priceBasis ?? null,
          }),
        );
        // S16.14 — charge only AFTER the transaction committed, and only the
        // subscribers that actually transitioned (exactly-once, see the helper).
        await chargeFannedInSubscribers(deps, ctx.logger, handle, kind, accepted.fannedIn);
        recordFetchDuration(deps.metrics, startedAt, "FULL");
        return;
      }
      // SCHEDULE_RESOLUTION: the durability tier derives theatre_id/local_date from the
      // run's own run_key row; `attributes` are carried by the parse seam but still have
      // no schema home (PERFORMANCE_UPDATE_PRODUCT writes the resolved product columns,
      // not `attributes`). skipFetch forwards the cold-path policy gate (ADR 0009): a
      // SOLD_OUT/CANCELED status tells stageScheduleAcceptance to create no SHOWTIME_FETCH
      // job for this performance.
      //
      // S14.2: the product columns are persisted atomically with acceptance. `acceptSchedule`
      // composes its own BEGIN/COMMIT (committing before any later loop could run), so the
      // handler composes the raw `stageScheduleAcceptance` variant instead, then writes one
      // PERFORMANCE_UPDATE_PRODUCT per performance inside the SAME `withTransaction` — a
      // failure in any product write rolls back the acceptance itself, never leaving a
      // performance row with base columns but missing/stale product columns.
      const capturedAt = new Date();
      const showtimes = parsed.performances.map((performance) => ({
        showtimeId: performance.showtimeId,
        movieId: performance.movieId,
        // C4 — carry the observed schedule title so the subscriber filter can
        // match cold titles alongside provider movie IDs.
        movieTitle: performance.movieTitle,
        startsAt: performance.startsAt,
        skipFetch: performancePolicy(performance.status) === "SKIP_SOLD_OUT",
        formatCode: (performance as { formatCode?: string | null }).formatCode ?? null,
        theatreId: (performance as { theatreId?: string }).theatreId ?? "unknown",
      }));
      const accepted = await withTransaction(deps.pool, async (tx) => {
        const result = await stageScheduleAcceptance(tx, handle, showtimes, {
          capturedAt,
          ...(deps.scheduleSubscriberFilter !== undefined
            ? { filter: deps.scheduleSubscriberFilter }
            : {}),
        });
        // S24.5b — populate the movie catalogue in the same transaction that writes the
        // performances, so a movie row exists the instant its first performance is captured
        // (no separate population task). One upsert per distinct movie (deduped by movieId),
        // not per performance. Movies-first ordering is the catalogue-before-reference
        // convention; without the deliberately absent FK from performance.movie_id (S24.0)
        // it is not load-bearing. A failure anywhere below rolls the movies back with the
        // acceptance — never a movie row for an unaccepted schedule. Zero-showtime runs
        // upsert nothing (there are no movies to record).
        const movies = new Map<string, string>();
        for (const performance of parsed.performances) {
          movies.set(performance.movieId, performance.movieTitle);
        }
        for (const [movieId, title] of movies) {
          await upsertMovie(tx, {
            movieId,
            providerId,
            title,
            firstSeenAt: capturedAt,
            lastSeenAt: capturedAt,
          });
        }
        for (const performance of parsed.performances) {
          await updatePerformanceProduct(tx, {
            showtimeId: performance.showtimeId,
            movieId: performance.movieId,
            auditorium: performance.auditorium == null ? null : String(performance.auditorium),
            utcOffset: performance.utcOffset,
            runtimeMinutes: performance.runtimeMinutes,
            status: performance.status,
            formatCode: performance.formatCode,
            minPrice: null,
            deepLinkUrl: performance.deepLinkUrl,
            providerMeta: performance.providerMeta,
            layoutId: null,
            updatedAt: capturedAt,
          });
        }
        return result;
      });
      // S16.14 — same post-commit, exactly-once charge as the fetch branch.
      await chargeFannedInSubscribers(deps, ctx.logger, handle, kind, accepted.fannedIn);
      recordFetchDuration(deps.metrics, startedAt, "FULL");
      return;
    }
    case "QUEUE_ENTERED":
      // Provider-wide halt; B9 itself fences this leased run — no separate failRun.
      await controlTransition(deps, providerId, { kind: "UPSTREAM_QUEUED" });
      recordFetchDuration(deps.metrics, startedAt, "HALTED");
      return;
    case "CHALLENGE_REQUIRED":
      await controlTransition(deps, providerId, { kind: "CHALLENGE_REQUIRED" });
      // Best-effort raw capture AFTER the real transition committed — never throws.
      await captureBlockedOrChallengeDiagnostic(deps, logger, handle.runId, outcome);
      recordFetchDuration(deps.metrics, startedAt, "HALTED");
      return;
    case "UPSTREAM_BLOCKED":
      await controlTransition(deps, providerId, { kind: "UPSTREAM_BLOCKED" });
      // Best-effort raw capture AFTER the real transition committed — never throws.
      await captureBlockedOrChallengeDiagnostic(deps, logger, handle.runId, outcome);
      recordFetchDuration(deps.metrics, startedAt, "HALTED");
      return;
    case "RATE_LIMITED": {
      const notBefore = parseRetryAfterDate(outcome.headers["retry-after"]);
      if (notBefore === null) {
        // S8.12: a missing or unparseable Retry-After is a finding, not a guessed
        // cooldown — fail this run only and leave the provider-wide/route-class control
        // state untouched.
        logger.warn(
          { kind, run_id: handle.runId },
          "provider fetch: rate-limited without a parseable Retry-After — failing the run only",
        );
        await failRunWithRecheckOutcome(
          deps,
          handle,
          kind,
          "RATE_LIMITED_NO_RETRY_AFTER",
          "RATE_LIMITED",
        );
        recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
        return;
      }
      await controlTransition(deps, providerId, { kind: "RATE_LIMITED", routeClass, notBefore });
      recordFetchDuration(deps.metrics, startedAt, "HALTED");
      return;
    }
    case "GUARD_REJECTED":
      // S8.13: ADR 0001's B9 table gives GUARD_REJECTED no provider_status change and
      // no parser-pause entry point — fail this run with a guard-derived cause only.
      await failRunWithRecheckOutcome(
        deps,
        handle,
        kind,
        `GUARD_REJECTED:${outcome.reason}`,
        "UPSTREAM_CHANGED",
      );
      recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
      return;
    case "CANCELLED":
      // S8.14: transport-level cancellation only. It arises from S8.5's own
      // heartbeat-loss abort — the run's lease/generation fence is already lost, so no
      // acceptFetch/failRun/B9 call is legal or necessary. S10's sweeper reclaims the
      // stranded run.
      logger.warn(
        { kind, run_id: handle.runId },
        "provider fetch: cancelled — no durability transition (lease already lost; sweeper reclaims)",
      );
      recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
      return;
    case "NAVIGATION_FAILED":
      // S8.7/S8.15: fail this run only. A generic transport error never reaches the
      // parser-schema-incompatibility path.
      await failRunWithRecheckOutcome(deps, handle, kind, outcome.error, "UPSTREAM_UNAVAILABLE");
      recordFetchDuration(deps.metrics, startedAt, "PARTIAL");
      return;
    default: {
      const never: never = outcome;
      throw new Error(`provider fetch: unhandled navigation outcome ${JSON.stringify(never)}`);
    }
  }
}

/**
 * O6.6 — records one fetch job's duration on the `fetchJobDuration` histogram under the
 * coarse outcome family (`FULL`|`PARTIAL`|`HALTED`). Undefined metrics = nothing recorded
 * (the S8/S11 harnesses construct deps without the instrument).
 */
function recordFetchDuration(
  metrics: SeatfirstMetrics | undefined,
  startedAt: number,
  bucket: "FULL" | "PARTIAL" | "HALTED",
): void {
  metrics?.fetchJobDuration.record(Date.now() - startedAt, { outcome: bucket });
}

/** One B9 transition through `withTransaction` — the trigger IS the persisted scope. */
function controlTransition(
  deps: ProviderFetchActorDeps,
  providerId: string,
  trigger: ProviderControlTrigger,
): Promise<unknown> {
  return withTransaction(deps.pool, (tx) =>
    applyProviderControlTransition(tx, providerId, trigger),
  );
}

/**
 * RFC 9110 `Retry-After`: delay-seconds or an HTTP-date — never a guessed cooldown
 * (S8.12). Mirrors the two-branch reference algorithm in `packages/providers`' private
 * `parseRetryAfter` (`packages/providers/src/amc/fetcher.ts`, not exported):
 * all-digits → seconds from now; otherwise a date parsed per HTTP-date, accepted only
 * when it is in the future. Returns the concrete `notBefore` Date, or null when the
 * header is absent, unparseable, or already past.
 */
function parseRetryAfterDate(header: string | undefined): Date | null {
  if (header === undefined) {
    return null;
  }
  const value = header.trim();
  if (value === "") {
    return null;
  }
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds)) {
      return null;
    }
    return new Date(Date.now() + seconds * 1000);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const notBefore = new Date(parsed);
  return notBefore.getTime() >= Date.now() ? notBefore : null;
}
