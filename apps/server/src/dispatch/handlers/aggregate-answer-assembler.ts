/**
 * The AGGREGATE dispatch handler (S27): the registry-slot factory `createAggregateAnswerHandler`,
 * its injected `AnswerAssemblerDeps`, and the registry composition `withAnswerAssembler`.
 *
 * One B7 claim (held by the consumer before this handler runs) protects each pass. A pass
 * reads the search's real durable state — schedule performances, latest seat snapshots,
 * layout rows, lifecycle facts — assembles E7's `AnswerEvidence`, derives the ADR 0003
 * answer, then either terminalizes through the claim-less `terminalizeClaimed` composition or
 * materializes the nonterminal `search_aggregate` row plus its `group` events, and releases
 * the claim. S46's skeleton `resolved` flips share the same batching as group events:
 * the same transaction that writes `B7_GROUP_EVENT` rows also writes a single
 * `B7_SKELETON_EVENT` for the newly resolved showtimes, on the existing debounce
 * cadence (no second timer).
 */
import type { Pool } from "pg";
import {
  B7_GROUP_EVENT,
  B7_RELEASE,
  B7_SKELETON_EVENT,
  B7_UPSERT_AGGREGATE,
  deriveRankedAnswer,
  runStatement,
  terminalizeClaimed,
  withTransaction,
} from "@seatfirst/durability";
import type {
  AnswerEvidence as DurabilityAnswerEvidence,
  LifecycleFacts,
  LifecycleStatus,
  TerminalState,
} from "@seatfirst/durability";
import {
  SearchSpecSchema,
  assembleAnswerEvidence,
  assembleResultGroup,
  compileRegion,
  computeSeatMetrics,
  createResultContractSchemas,
  decodeAuditoriumLayoutGeometry,
  matchesFormatPredicate,
  matchesMoviePredicate,
  matchesScheduleWindow,
  resolveScheduleWindowPlan,
  seatScores,
} from "@seatfirst/core";
import type {
  AnswerEvidence,
  AuditoriumLayoutGeometry,
  ExcludedCounts,
  GroupShowtimeInput,
  Money,
  PerTheatreExcludedCounts,
  ResultContractConfig,
  ResultGroup,
  SearchSpec,
  SeatMetrics,
  ShowtimeStatus,
} from "@seatfirst/core";

import { implementedHandler } from "../handlers.js";
import type { AggregateHandlerContext, AggregateHandlerFn, DispatchRegistry } from "../types.js";
import {
  readAggregateFailedShowtimeIds,
  readAggregateFetchFacts,
  readAggregateFetchFailures,
  readAggregatePerformances,
  readAggregateScheduleOutcome,
  readAuditoriumLayouts,
  readLatestShowtimeSnapshots,
} from "../queries.js";
import { findSearchById, isTerminalSearchStatus } from "../queries.js";
import type { AggregatePerformance } from "../queries.js";

/**
 * S27.3 — injected dependencies. `pool` is required for `withTransaction` (the
 * single-connection brand); a pooled `sqlClient` must never carry `BEGIN`/`COMMIT`.
 * `providerHostAllowlists` feeds the contract factory with no fallback (fails at wiring
 * time, `streaming/context.ts`). `offerStalenessMs` is the seat-offer staleness duration
 * (`staleAfter = capturedAt + offerStalenessMs` for resolved showtimes) — decided by ADR
 * 0023 decision 7 as 120000 ms, injected with no default inside this library (gate 14);
 * it is consumed by S27.6's resolved-showtime assembly (`staleAfter`), which runs on
 * every pass that reads layout rows.
 */
export interface AnswerAssemblerDeps {
  readonly pool: Pool;
  readonly providerHostAllowlists: ResultContractConfig["providerHostAllowlists"];
  readonly offerStalenessMs: number;
}

/** S27.15 — the eight `ExcludedCounts` buckets. Predicate/region/price buckets carry the
 * minimal grounded reading (F2): `soldOut` re-applies C1's policy to `performance.status`,
 * `outsideArea` is 0 always in v1, `fetchFailed`/`fetchFailedByCause` come from persisted
 * `search_job.fail_cause`, and `outsideRegion`/`outsideWindow`/`wrongAttributes`/
 * `overPrice`/`notReservedSeating` are computed by the minimal rule named in S27.15 — 0 —
 * because the selection actor that would populate them (seat-fetch predicate/region
 * filtering) is unbuilt, `searches.create` applies no PRICE predicate (ADR 0062 §1, so
 * `overPrice` stays 0 even now that seat fetches persist `min_price`), and no
 * reserved-seating column exists. The unpinned counting-rule residue is escalated,
 * not invented (finding F2).
 * ADR 0029 §5 item 3 — additive per-theatre breakdown `byTheatre`: groups the same
 * inputs by `theatreId` (distinct theatreIds present in `performances`) and recomputes
 * the identical bucket logic per theatre. `outsideArea` remains 0 in every per-theatre
 * entry as well (open finding: populating it for zero-radius-match AREA searches would
 * require `searches.create` to persist which candidate theatres were excluded by the
 * `maxTheatres`/radius ceiling for this handler to read back; no such column exists).
 * The top-level aggregate fields remain the sum across all theatres exactly as before. */
function computeExcludedCounts(
  performances: readonly { readonly theatreId: string; readonly status: string | null }[],
  fetchFailures: readonly {
    readonly failCause: string;
    readonly theatreId: string | null;
    readonly count: number;
  }[],
  wrongAttributesInput: {
    readonly eligible: readonly {
      readonly theatreId: string;
      readonly formatCode: string | null;
    }[];
    readonly spec: SearchSpec;
  } | null = null,
): ExcludedCounts {
  const soldOut = performances.filter(
    (p) => p.status === "SOLD_OUT" || p.status === "CANCELED",
  ).length;
  // S42.5 — wrongAttributes counts movie+window-eligible performances whose format
  // does not match the spec's FORMAT predicate. When no eligible set is supplied
  // (legacy call path, never in production) it remains 0.
  let wrongAttributes = 0;
  const wrongAttributesByTheatre = new Map<string, number>();
  if (wrongAttributesInput !== null) {
    for (const perf of wrongAttributesInput.eligible) {
      if (!matchesFormatPredicate(perf.formatCode, wrongAttributesInput.spec.where)) {
        wrongAttributes += 1;
        wrongAttributesByTheatre.set(
          perf.theatreId,
          (wrongAttributesByTheatre.get(perf.theatreId) ?? 0) + 1,
        );
      }
    }
  }
  // Aggregate fetchFailed — sum across all returned rows (GROUP BY fail_cause, theatre_id
  // may yield multiple rows for the same failCause across theatres, so we must sum, not
  // overwrite).
  const fetchFailedByCause: Record<string, number> = {};
  for (const failure of fetchFailures) {
    fetchFailedByCause[failure.failCause] =
      (fetchFailedByCause[failure.failCause] ?? 0) + failure.count;
  }
  const fetchFailed = Object.values(fetchFailedByCause).reduce((sum, count) => sum + count, 0);

  // Per-theatre breakdown — one entry per distinct theatreId in performances.
  const theatreIds = [...new Set(performances.map((p) => p.theatreId))];
  const byTheatre: Record<string, PerTheatreExcludedCounts> = {};
  for (const theatreId of theatreIds) {
    const perTheatreStatuses = performances.filter((p) => p.theatreId === theatreId);
    const perSoldOut = perTheatreStatuses.filter(
      (p) => p.status === "SOLD_OUT" || p.status === "CANCELED",
    ).length;
    const perFetchFailedByCause: Record<string, number> = {};
    for (const failure of fetchFailures) {
      if (failure.theatreId === theatreId) {
        perFetchFailedByCause[failure.failCause] =
          (perFetchFailedByCause[failure.failCause] ?? 0) + failure.count;
      }
    }
    const perFetchFailed = Object.values(perFetchFailedByCause).reduce(
      (sum, count) => sum + count,
      0,
    );
    byTheatre[theatreId] = {
      soldOut: perSoldOut,
      outsideWindow: 0,
      outsideRegion: 0,
      outsideArea: 0,
      wrongAttributes: wrongAttributesByTheatre.get(theatreId) ?? 0,
      overPrice: 0,
      notReservedSeating: 0,
      fetchFailed: perFetchFailed,
      fetchFailedByCause: perFetchFailedByCause,
    };
  }

  return {
    soldOut,
    outsideWindow: 0,
    outsideRegion: 0,
    outsideArea: 0,
    wrongAttributes,
    overPrice: 0,
    notReservedSeating: 0,
    fetchFailed,
    fetchFailedByCause,
    byTheatre,
  };
}

/**
 * S27.1 — wires the `aggregate` slot to the real handler, mirroring `withProviderFetchActor`
 * exactly. It alters ONLY the `aggregate` slot; `job.*`/`run.*` spread through untouched, and
 * `createPlaceholderRegistry` is untouched. Deployment composes the real registry at the
 * existing override point (`entry.ts:100`); no `entry.ts` edit is required.
 */
export function withAnswerAssembler(
  registry: DispatchRegistry,
  deps: AnswerAssemblerDeps,
): DispatchRegistry {
  return { ...registry, aggregate: implementedHandler(createAggregateAnswerHandler(deps)) };
}

export function createAggregateAnswerHandler(deps: AnswerAssemblerDeps): AggregateHandlerFn {
  const schemas = createResultContractSchemas({
    providerHostAllowlists: deps.providerHostAllowlists,
  });
  const { SearchResultSchema, RankedAnswerSchema, ResultGroupSchema } = schemas;

  return async (context: AggregateHandlerContext): Promise<void> => {
    const { search, aggGeneration, aggRequestedRev, sqlClient, logger } = context;
    const searchId = search.searchId;

    // S27.5 — parse fail-closed BEFORE any write. A parse failure aborts the pass with
    // zero writes (the fail-closed posture S19.3 states for the serving side, mirrored).
    const spec: SearchSpec = SearchSpecSchema.parse(search.spec);

    // S36.2/S36.6 — shared evaluators: filter the unioned (fresh + cold)
    // performances by movie and theatre-local schedule window before any downstream
    // snapshot/count/evidence work. Warm planning and cold fan-out use these same
    // evaluators, so the three stages cannot drift.
    const plan = resolveScheduleWindowPlan(spec.where);
    const rawPerformances = await readAggregatePerformances(sqlClient, searchId);
    // S42: movie+window-eligible set before the format filter — the counting base for
    // wrongAttributes (movie/window-excluded rows never count there).
    const movieAndWindowEligible = rawPerformances.filter((p) => {
      try {
        return (
          // C4 — the `performance` table stores no title column, so aggregate assembly
          // matches on canonical provider movie IDs only (title reads as null).
          matchesMoviePredicate(p.movieId, null, spec.where) &&
          matchesScheduleWindow(p.startsAt, p.timezone, plan)
        );
      } catch {
        return false;
      }
    });
    const performances = movieAndWindowEligible.filter((p) =>
      matchesFormatPredicate(p.formatCode, spec.where),
    );
    const snapshots = await readLatestShowtimeSnapshots(
      sqlClient,
      performances.map((performance) => performance.showtimeId),
    );
    const layoutIds = [
      ...new Set(
        performances
          .map((performance) => performance.layoutId)
          .filter((layoutId): layoutId is string => layoutId !== null),
      ),
    ];
    const layouts = await readAuditoriumLayouts(sqlClient, layoutIds);

    // S27.6/S27.7 — E5/E7 assembly (F6 closed by ADR 0032, landing with S41): decode every
    // layout row read by S27.4(c) — a decode failure throws and aborts the pass with zero
    // writes, exactly like every other unhandled throw here — then assemble one
    // `ResultGroup` per supported layout. Performances group by the COMPOSITE
    // `${theatreId}\0${layoutId}` key (ADR 0029's explicit rule, mirrored from
    // `cachedGroupSkeletons` in `routes/searches/create.ts`: two different theatres'
    // auditoriums never merge even when they coincidentally reuse a layoutId string),
    // skipping any performance with a null `layoutId`. Group-level display fields
    // (`formatCode`/`auditorium`/`attributes`) come from the FIRST member of each group
    // (first-row-wins); members keep encounter order and are sorted by `startsAt`
    // ascending before showtime building (S27.6: pre-ordered by `showDateTimeUtc`).
    const layoutById = new Map<string, AuditoriumLayoutGeometry>();
    for (const row of layouts) {
      // `readAuditoriumLayouts` can return more than one row per layoutId (a globally
      // shared layout referenced from theatres with different timezones survives the
      // DISTINCT); the geometry bytes are content-addressed, so last-write-wins on
      // layoutId is lossless.
      layoutById.set(
        row.layoutId,
        decodeAuditoriumLayoutGeometry(row.geometry, {
          layoutId: row.layoutId,
          rows: row.rows,
          columns: row.columns,
        }),
      );
    }
    // ADR 0033 addendum (2026-08-23) — a performance whose showtime fetch never got far
    // enough to establish a layout (`layoutId === null`, e.g. the seat-map fetch itself
    // failed) used to be silently dropped here, before `buildCandidate` ever saw it. That
    // defeated ADR 0033's `UNRESOLVED_SHOWTIMES` relaxation for exactly the real-world
    // case it exists for: a `PARTIAL` search whose only failures are showtimes we never
    // even got a layout for. We cannot know which specific auditorium/layout group such a
    // showtime would have joined, so — conservatively, per the same "never overclaim
    // completeness" rule ADR 0033 already applies — its count is attributed to EVERY group
    // already resolved for the SAME theatre (never merged across theatres, matching ADR
    // 0029's grouping key). This never creates a new group and never touches
    // `resolved`/`total` (both still count from the unfiltered `performances`/`snapshots`
    // arrays above), so `S27.13`/`S27.14`'s own arithmetic is untouched.
    const unresolvedByTheatre = new Map<string, AggregatePerformance[]>();
    const groupedPerformances = new Map<string, AggregatePerformance[]>();
    for (const performance of performances) {
      if (performance.layoutId === null) {
        const bucket = unresolvedByTheatre.get(performance.theatreId);
        if (bucket === undefined) {
          unresolvedByTheatre.set(performance.theatreId, [performance]);
        } else {
          bucket.push(performance);
        }
        continue;
      }
      const key = `${performance.theatreId}\0${performance.layoutId}`;
      const members = groupedPerformances.get(key);
      if (members === undefined) {
        groupedPerformances.set(key, [performance]);
      } else {
        members.push(performance);
      }
    }
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.showtimeId, snapshot]));
    const groups: ResultGroup[] = [];
    const evidenceGroups: {
      group: ResultGroup;
      layout: AuditoriumLayoutGeometry;
      metrics: SeatMetrics;
    }[] = [];
    for (const [key, members] of groupedPerformances) {
      const first = members[0];
      if (first === undefined || first.layoutId === null) {
        throw new Error(`aggregate answer: assembled an empty performance group (${key})`);
      }
      const { layoutId } = first;
      const layout = layoutById.get(layoutId);
      if (layout === undefined) {
        // Unreachable while the rows behind `layoutIds` stand (the same performances fed
        // both reads), but S27.6 does not authorize silently dropping a resolvable
        // layout — throw instead.
        throw new Error(
          `aggregate answer: no auditorium_layout row decoded for layout ${layoutId}`,
        );
      }
      const metrics = computeSeatMetrics(layout);
      // E5.1/ADR 0011 — the candidate pool is chosen exactly once per layout, before any
      // scoring or run work.
      const poolMask =
        spec.accessibility?.required === true ? layout.accessibleMask : layout.ordinaryMask;
      const scores = seatScores(metrics);
      const previewRegion = spec.region ? compileRegion(layout, metrics, spec.region) : null;
      const placementRegion = spec.groupRegion
        ? compileRegion(layout, metrics, spec.groupRegion)
        : null;
      const sortedMembers = [...members, ...(unresolvedByTheatre.get(first.theatreId) ?? [])].sort(
        (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
      );
      // S27.6 + ADR 0033 addendum guard: an unresolved (layoutId null) performance may carry a
      // snapshot whose bitmap was captured against a different auditorium geometry than this
      // group's layout. Presenting that bitmap as resolved would hit bitmapAnd's exact-length
      // assert (bitmap byte length does not match bitLength) and fail the whole AGGREGATE
      // pass forever (stale RUNNING, gen loop). Treat a geometry-mismatched bitmap as not
      // yet resolvable for this group — count it as unresolved so UNRESOLVED_SHOWTIMES still
      // fires and the aggregate can terminalize without fabricating geometry.
      const cellCount = layout.rows * layout.columns;
      const expectedBytes = Math.ceil(cellCount / 8);
      const showtimes: GroupShowtimeInput[] = sortedMembers.map((performance) => {
        // F7 (ADR 0023 decision 6, amended by ADR 0062) — offer fields pass through
        // verbatim: a NULL in a required field (`status`/`deepLinkUrl`) surfaces as
        // `assembleResultGroup`'s internal `ResultGroupSchema` parse failure → the pass
        // fails loud with zero writes; `minPrice` maps to `Money` only when the seat
        // fetch persisted both amount and currency, else stays null.
        const shared = {
          showtimeId: performance.showtimeId,
          theatreId: performance.theatreId,
          distanceKm: null,
          showDateTimeUtc: performance.startsAt,
          timezone: performance.timezone,
          minPrice:
            performance.minPrice !== null && performance.currency !== null
              ? {
                  amount: Number(performance.minPrice),
                  currency: performance.currency,
                  basis: (performance.priceBasis as Money["basis"]) ?? "TICKET_ONLY",
                }
              : null,
          status: performance.status as ShowtimeStatus,
          deepLinkUrl: performance.deepLinkUrl as string,
        };
        const snapshot = snapshotById.get(performance.showtimeId);
        // The wire contract requires null on unresolved entries: a priced but
        // unresolvable showtime still reports `minPrice: null`.
        if (snapshot === undefined) {
          return { ...shared, resolved: false, minPrice: null };
        }
        // An attributed layoutId === null performance can never be proven to match this
        // group's geometry — byte-length equality is not a layout proof. Always
        // unresolved in every group, so the row is false in both small and medium groups.
        if (performance.layoutId === null) {
          return { ...shared, resolved: false, minPrice: null };
        }
        if (snapshot.bitmap.length !== expectedBytes) {
          return { ...shared, resolved: false, minPrice: null };
        }
        return {
          ...shared,
          resolved: true,
          availability: snapshot.bitmap,
          capturedAt: snapshot.capturedAt,
          staleAfter: new Date(
            new Date(snapshot.capturedAt).getTime() + deps.offerStalenessMs,
          ).toISOString(),
        };
      });
      const result = assembleResultGroup({
        layout,
        metrics,
        seatScores: scores,
        poolMask,
        previewRegion,
        placementRegion,
        group: spec.group,
        groupStrict: spec.groupStrict,
        rank: spec.rank,
        showtimes,
        layoutId,
        theatreId: first.theatreId,
        // ADR 0035 Decision 2 + 2026-09-21 amendment: a null formatCode means "Standard" —
        // map it to the reserved "STANDARD" sentinel here too, never cast null to string
        // (a null cast previously crashed the whole AGGREGATE job on ResultGroupSchema
        // validation, permanently stalling the search — production incident 2026-09-21).
        formatCode: first.formatCode ?? "STANDARD",
        auditorium: first.auditorium,
        attributes: first.attributes,
        resultGroupSchema: ResultGroupSchema,
      });
      if (result.ok) {
        groups.push(result.result);
        evidenceGroups.push({ group: result.result, layout, metrics });
      }
      // A typed-unsupported result (`SPLIT`, SCORE region, DEPTH rank) omits the group
      // honestly — E5.8's discipline: no throw, no error log.
    }
    const evidence: AnswerEvidence = assembleAnswerEvidence({ groups: evidenceGroups, spec });
    // ADR 0017 amendment (2026-09-03) — retain every hit's placement key on the
    // terminal groups payload. `groups[i]` and the evidence input's groups align 1:1
    // (pushed together above), as do `hitPlacementKeys[i]` and
    // `groups[i].groupHits[j]`. Per-covered-showtime nonces stay `null` placeholders
    // here — the serve surface (`searches.get`) signs the best hit's nonce per
    // showtime at terminal serve, mirroring the answer-offer `nonce: null` pattern.
    // This fix also retains the FULL placement (`hit.placement`, in parallel with
    // `hit.placementKey`) from `evidence.hitPlacements`, so `findTerminalPlacement`
    // can recheck a hit that lives only in `groups[].groupHits[]`, outside
    // `answer.primary`/`alternatives` — every such hit already holds a valid
    // `issueHitNonces` nonce (ADR 0017 amendment). Null-safe exactly like the
    // `placementKey`/`hit` lookups: a null placement (no candidate for the hit)
    // leaves the hit's field null, matching its null key.
    // This mutates only the additive hit fields; `primary`/`alternatives` selection
    // and the persisted answer shape are untouched.
    evidence.hitPlacementKeys.forEach((keys, groupIndex) => {
      const group = groups[groupIndex];
      if (group === undefined || group.groupHits === undefined) {
        return;
      }
      keys.forEach((placementKey, hitIndex) => {
        if (placementKey === null) {
          return;
        }
        const hit = group.groupHits?.[hitIndex];
        if (hit === undefined) {
          return;
        }
        hit.placementKey = placementKey;
        hit.placement = evidence.hitPlacements[groupIndex]?.[hitIndex] ?? null;
        hit.showtimeNonces = hit.showtimeIndices.map(() => null);
      });
    });

    // S27.8 — lifecycle facts from real persisted state (tier-3-proven query shapes). The
    // status/terminalCause are NOT handler-derived; the terminal path overlays them from
    // `stageTerminalization`'s returned `TerminalState` (B8's CASE chain is the authority).
    const scheduleOutcome = await readAggregateScheduleOutcome(sqlClient, searchId);
    const { acceptedFetches, freeSeats } = await readAggregateFetchFacts(sqlClient, searchId);
    const fetchFailures = await readAggregateFetchFailures(sqlClient, searchId);

    // S27.13/S27.14 — resolved/total/capturedAtRange.
    const total = performances.length;
    const resolved = snapshots.length;
    const capturedAtRange =
      snapshots.length === 0
        ? null
        : (() => {
            const times = snapshots.map((snapshot) => snapshot.capturedAt).sort();
            return [times[0]!, times[times.length - 1]!] as [string, string];
          })();

    // S27.15 — excluded counts (ADR 0029 §5 item 3: per-theatre breakdown).
    // S42.5 — wrongAttributes derived from the movie+window-eligible set, not the
    // format-filtered performances (soldOut already counts from format-filtered).
    const excluded = computeExcludedCounts(
      performances.map((performance) => ({
        theatreId: performance.theatreId,
        status: performance.status,
      })),
      fetchFailures,
      {
        eligible: movieAndWindowEligible.map((p) => ({
          theatreId: p.theatreId,
          formatCode: p.formatCode,
        })),
        spec,
      },
    );

    // S27.9 — the terminal `resultPayload`: derive the answer for the terminal state (non-null
    // by construction), re-validate with `RankedAnswerSchema.parse` (the declared persistence
    // seam / type bridge), and validate the whole payload before it becomes immutable. Runs
    // inside `stageTerminalization` BEFORE `B8_RESULT_VERSION`, so a parse failure throws
    // before any write (S6U3.1 ordering).
    const resultPayload = (state: TerminalState): unknown => {
      const facts: LifecycleFacts = {
        status: state.status as LifecycleStatus,
        terminalCause: state.cause,
        scheduleOutcome,
        acceptedFetches,
        freeSeats,
      };
      const answer = deriveRankedAnswer(facts, {
        exact: evidence.exact,
        hedged: evidence.hedged as DurabilityAnswerEvidence["hedged"],
      });
      if (answer === null) {
        throw new Error(
          `deriveRankedAnswer returned null for terminal status ${state.status} — no matrix row`,
        );
      }
      const wireAnswer = RankedAnswerSchema.parse(answer);
      return SearchResultSchema.parse({
        searchId,
        spec,
        status: state.status,
        resolved,
        total,
        capturedAtRange,
        groups,
        excluded,
        answer: wireAnswer,
      });
    };

    // S27.9/S27.10 — attempt terminalization first, composed claim-less.
    const terminal = await withTransaction(deps.pool, (tx) =>
      terminalizeClaimed(tx, searchId, aggGeneration, aggRequestedRev, { resultPayload }),
    );
    if (terminal !== null) {
      return;
    }

    // S27.11 — the fence spoke: `stageTerminalization` returned null and rolled back. Re-read
    // the search: terminal → another actor won the race (log and return, nothing written, claim
    // not released); nonterminal → fall through to the nonterminal path with the same claim.
    const reRead = await findSearchById(sqlClient, searchId);
    if (reRead === null || isTerminalSearchStatus(reRead.status)) {
      logger.error(
        { search_id: searchId, agg_generation: aggGeneration, status: reRead?.status ?? "missing" },
        "aggregate: search terminalized by another actor; claim not released",
      );
      return;
    }
    const nonterminalStatus = reRead.status;

    // S27.12 — nonterminal payload: `answer: null`, `status` = the re-read nonterminal status.
    const payload = SearchResultSchema.parse({
      searchId,
      spec,
      status: nonterminalStatus,
      resolved,
      total,
      capturedAtRange,
      groups,
      excluded,
      answer: null,
    });

    // S46.6 — compute which skeleton entries flipped from false→true since last skeleton event.
    // The previous skeleton's payload is the source of truth for rank/admitted/other fields,
    // so the update preserves them and only flips resolved. Shares the same debounce as group
    // events: a single B7_SKELETON_EVENT in the same transaction, no second timer.
    const prevSkeletonRows = await sqlClient.query(
      `SELECT payload FROM search_event WHERE search_id = $1 AND type = 'skeleton' ORDER BY seq DESC LIMIT 1`,
      [searchId],
    );
    const prevPayload = (prevSkeletonRows.rows[0] as Record<string, unknown> | undefined)
      ?.payload as { scheduleSkeleton?: unknown } | undefined;
    const prevEntries = Array.isArray(
      (prevPayload as unknown as { scheduleSkeleton?: unknown })?.scheduleSkeleton,
    )
      ? (
          prevPayload as unknown as {
            scheduleSkeleton: Array<{
              showtimeId: string;
              resolved: boolean;
              [k: string]: unknown;
            }>;
          }
        ).scheduleSkeleton
      : null;
    const prevResolvedById = new Map<string, boolean>();
    if (prevEntries) {
      for (const e of prevEntries) prevResolvedById.set(e.showtimeId, e.resolved);
    }
    const failedShowtimeIds = await readAggregateFailedShowtimeIds(sqlClient, searchId);
    const performanceByShowtimeId = new Map(performances.map((p) => [p.showtimeId, p]));
    function deriveFetchStatus(showtimeId: string): "OK" | "SOLD_OUT" {
      const status = performanceByShowtimeId.get(showtimeId)?.status ?? null;
      return status === "SOLD_OUT" || status === "CANCELED" ? "SOLD_OUT" : "OK";
    }
    const newlyResolvedEntries: Array<Record<string, unknown>> = [];
    if (prevEntries) {
      for (const entry of prevEntries) {
        const wasResolved = prevResolvedById.get(entry.showtimeId) ?? false;
        const isResolved = snapshotById.has(entry.showtimeId);
        if (!wasResolved && isResolved) {
          newlyResolvedEntries.push({
            ...entry,
            resolved: true,
            fetchStatus: deriveFetchStatus(entry.showtimeId),
          });
        } else if (
          !isResolved &&
          entry.fetchStatus !== "FAILED" &&
          failedShowtimeIds.has(entry.showtimeId)
        ) {
          newlyResolvedEntries.push({ ...entry, fetchStatus: "FAILED" }); // resolved stays false
        }
      }
    } else if (performances.length > 0) {
      for (const p of performances) {
        if (snapshotById.has(p.showtimeId)) {
          newlyResolvedEntries.push({
            showtimeId: p.showtimeId,
            theatreId: p.theatreId,
            showDateTimeLocal: p.startsAt,
            formatCode: p.formatCode ?? null,
            distanceKm: null,
            rank: 0,
            admitted: true,
            resolved: true,
            fetchStatus: deriveFetchStatus(p.showtimeId),
          });
        }
      }
    }

    // S27.12/S27.16 — one transaction: one `B7_GROUP_EVENT` per group, then
    // `B7_UPSERT_AGGREGATE`. Upsert zero rows → the throw rolls the group events back (a stale
    // pass leaks nothing); else COMMIT, then `B7_RELEASE` AFTER the transaction.
    await withTransaction(deps.pool, async (tx) => {
      for (const group of groups) {
        const eventRows = await runStatement(tx, B7_GROUP_EVENT, [
          searchId,
          JSON.stringify({ group, resolved, total }),
        ]);
        if (eventRows.length === 0) {
          throw new Error(
            "B7_GROUP_EVENT returned 0 rows — the search vanished or terminalized mid-pass",
          );
        }
      }
      // S46.6 — emit skeleton resolved flips in the same transaction as group events,
      // batched on the same debounce cadence (no second timer). What breaks if this
      // swaps outside the transaction or onto its own timer: a crash between group and
      // skeleton would leave the client seeing a group for a showtime it still thinks
      // is unresolved, or a second timer would emit skeleton at a different cadence
      // than groups (uncoordinated, violates spec's "not a second independent timer").
      if (newlyResolvedEntries.length > 0) {
        const skRows = await runStatement(tx, B7_SKELETON_EVENT, [
          searchId,
          JSON.stringify({ scheduleSkeleton: newlyResolvedEntries }),
        ]);
        if (skRows.length === 0) {
          throw new Error(
            "B7_SKELETON_EVENT returned 0 rows — the search vanished or terminalized mid-pass",
          );
        }
      }
      const upsertRows = await runStatement(tx, B7_UPSERT_AGGREGATE, [
        searchId,
        aggRequestedRev,
        JSON.stringify(payload),
        JSON.stringify(evidence),
      ]);
      if (upsertRows.length === 0) {
        throw new Error("B7_UPSERT_AGGREGATE returned 0 rows — this pass is stale, discard it");
      }
    });
    await runStatement(sqlClient, B7_RELEASE, [searchId, aggRequestedRev, aggGeneration]);
  };
}
