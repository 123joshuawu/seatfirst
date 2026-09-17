import { sha256 } from "./sha256.js";
import type { AuditoriumLayoutGeometry } from "./layout.js";
import type { SeatMetrics } from "./metrics.js";
import type { AggregationThreshold, GroupShape, SearchSpec, SeatRegion } from "./search-spec.js";
import type {
  Placement,
  Recommendation,
  RecommendationReason,
  Relaxation,
  ResultGroup,
  ShowtimeOffer,
} from "./result-contracts.js";

/**
 * The pure answer assembler (E7): turns one search's array of E5 `ResultGroup`s — the
 * aggregation-evidence layer (`docs/seatfirst-architecture.md:150`) — into
 * placement-level `AnswerEvidence` (`{ exact, hedged }`) shaped for
 * `packages/durability/src/lifecycle.ts`'s `deriveRankedAnswer`. No I/O, no mutable
 * module state, no durability import; the engine's own contract
 * (`docs/seatfirst-architecture.md:151`).
 *
 * The §6.1 product contract is already decided and is implemented against directly: the
 * `Placement` shape, the six-variant `RecommendationReason` vocabulary, the four-variant
 * `Relaxation` vocabulary, the CONFIDENT/HEDGED selection, and the deterministic key
 * chain (`docs/seatfirst-architecture.md:284-360,395`). Where a firing condition or
 * formula was a named finding, ADR 0023 (`docs/adr/0023-answer-assembly-aggregate-dispatch-implementation-decisions.md`)
 * pinned it — every number below is cited, never invented (E7.13).
 *
 * `placementKey` (ADR 0023 decision 1): SHA-256 of the pipe-joined string
 * `` `${layoutId}|${row}|${startCol}|${rowSpan}|${count}` ``, first 16 hex characters.
 * Computed with this package's pure `sha256` (`./sha256.js`), which is byte-identical to
 * `node:crypto`'s `createHash("sha256")` but keeps `@seatfirst/core` Hermes-usable
 * without a Node runtime import — the reason `sha256.ts` exists at all. A golden test
 * pins the output; a changed algorithm fails it (F8).
 */

/** ADR 0015's accepted sweet-spot peak: "1.0 at 65% of the auditorium's depth". */
const SWEET_SPOT_DEPTH = 0.65;
/** ADR 0023 decision 3: CENTERED fires when mean |lateral| ≤ 0.15. */
const CENTERED_MAX_ABS_LATERAL = 0.15;
/** ADR 0023 decision 3: the front-third boundary for MIDDLE_THIRD / AVOIDS_FRONT. */
const FRONT_THIRD = 1 / 3;
/** ADR 0023 decision 3: the back edge of the middle third for MIDDLE_THIRD. */
const MIDDLE_THIRD_BACK = 2 / 3;
/** ADR 0023 decision 3: `lateralPct = round(meanLateral * 100)`, signed. */
const LATERAL_PCT_SCALE = 100;
/** ADR 0023 decision 1: `placementKey` keeps the first 16 hex characters (64 bits). */
const PLACEMENT_KEY_HEX_CHARS = 16;

export type AssembledExactRecommendation = Recommendation & { readonly relaxed: readonly [] };

type AssembledHedgedRecommendation = Recommendation & {
  readonly relaxed: readonly [Relaxation, ...Relaxation[]];
};

/**
 * Two or three labeled alternatives (`docs/seatfirst-architecture.md:347-351`;
 * `HedgedAlternatives`, `lifecycle.ts:51-53`).
 */
export type AssembledHedgedAlternatives =
  | readonly [AssembledHedgedRecommendation, AssembledHedgedRecommendation]
  | readonly [
      AssembledHedgedRecommendation,
      AssembledHedgedRecommendation,
      AssembledHedgedRecommendation,
    ];

export type AnswerEvidence = {
  readonly exact: AssembledExactRecommendation | null;
  readonly hedged: AssembledHedgedAlternatives | null;
  /**
   * ADR 0017 amendment (2026-09-03) — every group hit's placement key, retained
   * instead of discarded. Aligned with `input.groups`: outer index per group,
   * inner index per that group's `groupHits` entry (in stored order). `null`
   * where `buildCandidate` returned null for the hit (no candidate, e.g. a
   * missing member-cell name). Read alongside — never instead of — `exact` /
   * `hedged`: selection, ranking, and pruning below are untouched.
   */
  readonly hitPlacementKeys: ReadonlyArray<ReadonlyArray<string | null>>;
};

/** E7.2 — one entry per layout the caller passes (E5's output shape). */
interface AnswerEvidenceInput {
  readonly groups: readonly {
    readonly group: ResultGroup;
    readonly layout: AuditoriumLayoutGeometry;
    readonly metrics: SeatMetrics;
  }[];
  readonly spec: SearchSpec;
}

interface Candidate {
  readonly runScore: number;
  readonly showtimeCount: number;
  readonly meanDepth: number;
  readonly startCol: number;
  readonly placementKey: string;
  readonly recommendation: Recommendation;
}

function groupDimensions(
  group: GroupShape | undefined,
): { readonly count: number; readonly memberCols: number } | null {
  if (group === undefined) {
    return null;
  }
  switch (group.kind) {
    case "RUN":
      return { count: group.count, memberCols: group.count };
    case "BLOCK":
      return { count: group.rows * group.cols, memberCols: group.cols };
    case "SPLIT":
      // Typed-unsupported inside E5 and never reaches E7 (E7.2). Defensive, not reachable.
      return null;
  }
}

/**
 * ADR 0023 decision 5: `OUTSIDE_REGION.region` = `PRESET.name` for presets, else the
 * region kind's own identifier string (never invented display copy).
 */
function regionLabel(region: SeatRegion): string {
  return region.kind === "PRESET" ? region.name : region.kind;
}

/**
 * E7.7 — `FEWER_SHOWTIMES` when `spec.aggregation.threshold` is unmet by the placement's
 * showtime count. The threshold is a rendering contract: "free in at least 3 of these
 * showtimes" (`docs/seatfirst-query-design.md:263-265`). "These showtimes" is the set the
 * aggregation actually assessed — resolved showtimes only, matching `freeCount`'s own
 * resolved-only popcount and §3.2's "intersection (`count == total`)".
 */
function thresholdMet(
  threshold: AggregationThreshold,
  showtimeCount: number,
  resolvedShowtimeCount: number,
): boolean {
  switch (threshold.kind) {
    case "NONE":
      return true;
    case "AT_LEAST":
      return showtimeCount >= threshold.n;
    case "ALL":
      return showtimeCount === resolvedShowtimeCount;
    case "FRACTION":
      return showtimeCount / resolvedShowtimeCount >= threshold.min;
  }
}

/** E7.9 — a resolved `GroupShowtime` reshaped into a `ShowtimeOffer` (strip resolved/openCount). */
function toShowtimeOffer(
  showtime: ResultGroup["showtimes"][number],
  seatNames: readonly string[],
): ShowtimeOffer {
  // `showtimeIndices` only ever reference resolved showtimes (E5.6), so `resolved` is true
  // and `capturedAt`/`staleAfter` are present. The narrow below documents that invariant.
  if (!showtime.resolved) {
    throw new Error("unreachable: a placement's showtimeIndices referenced an unresolved showtime");
  }
  return {
    showtimeId: showtime.showtimeId,
    theatreId: showtime.theatreId,
    distanceKm: showtime.distanceKm,
    showDateTimeUtc: showtime.showDateTimeUtc,
    timezone: showtime.timezone,
    minPrice: showtime.minPrice,
    status: showtime.status,
    deepLinkUrl: withSeatNames(showtime.deepLinkUrl, seatNames),
    capturedAt: showtime.capturedAt,
    staleAfter: showtime.staleAfter,
    // Issued per-serve by the answer surface (S34); the persisted answer carries the placeholder.
    nonce: null,
  };
}

/**
 * P9.4 (ADR 0002 §3.5 Phase 2, 2026-09-05) — resolve the candidate placement's seat-level
 * deep link (`/showtimes/<id>/seats?seats=<seatNames>`) from the group's stored base URL.
 * `@seatfirst/core` holds no provider dependency and stays Hermes-usable (no `URL` global —
 * see the `sha256` note above), so the single `seats` param is appended as a string rather
 * than via the AMC route builder; the provider allowlist (`isAllowedUrl`) remains the
 * validator downstream. `encodeURIComponent` renders the comma join byte-identical to the
 * provider builder's `searchParams.set` form (`%2C`).
 */
function withSeatNames(deepLinkUrl: string, seatNames: readonly string[]): string {
  if (seatNames.length === 0) {
    return deepLinkUrl;
  }
  const separator = deepLinkUrl.includes("?") ? "&" : "?";
  return `${deepLinkUrl}${separator}seats=${encodeURIComponent(seatNames.join(","))}`;
}

function buildCandidate(
  group: ResultGroup,
  layout: AuditoriumLayoutGeometry,
  metrics: SeatMetrics,
  hit: NonNullable<ResultGroup["groupHits"]>[number],
  dimensions: { readonly count: number; readonly memberCols: number },
  spec: SearchSpec,
): Candidate | null {
  const rowSpan = hit.rowSpan;

  // E7.3 — member cells in row-major "cell order"; a hit with any missing member-cell
  // name is excluded, never fabricated (E5.5's `{}`-when-null makes this reachable).
  const memberCells: number[] = [];
  const seatNames: string[] = [];
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < dimensions.memberCols; columnOffset += 1) {
      const cell = (hit.row + rowOffset) * layout.columns + (hit.startCol + columnOffset);
      const name = group.seatNames[String(cell)];
      if (name === undefined) {
        return null;
      }
      memberCells.push(cell);
      seatNames.push(name);
    }
  }

  // E7.5/E7.6 reason facts — the placement's depth/lateral are the arithmetic mean of its
  // member cells' E2 metrics; aisle adjacency is any member cell at distance 0.
  let depthSum = 0;
  let lateralSum = 0;
  let absLateralSum = 0;
  let aisleAdjacent = false;
  let outsideRegion = false;
  for (const cell of memberCells) {
    const cellDepth = metrics.depth[cell] ?? 0;
    const cellLateral = metrics.lateral[cell] ?? 0;
    depthSum += cellDepth;
    lateralSum += cellLateral;
    absLateralSum += Math.abs(cellLateral);
    if ((metrics.aisleDistance[cell] ?? -1) === 0) {
      aisleAdjacent = true;
    }
    if (group.regionMask !== undefined && group.regionMask[cell] === 0) {
      outsideRegion = true;
    }
  }
  const meanDepth = depthSum / memberCells.length;
  const meanLateral = lateralSum / memberCells.length;
  const meanAbsLateral = absLateralSum / memberCells.length;

  const placementKey = sha256(
    `${group.layoutId}|${hit.row}|${hit.startCol}|${rowSpan}|${dimensions.count}`,
  ).slice(0, PLACEMENT_KEY_HEX_CHARS);

  const placement: Placement = {
    layoutId: group.layoutId,
    row: hit.row,
    startCol: hit.startCol,
    rowSpan,
    count: dimensions.count,
    seatNames,
    placementKey,
  };

  // E7.6 — the schema-grounded vocabulary. TOGETHER first (guaranteed min-1 reasons), then
  // MULTI_SHOWTIME, then the ADR 0023 decision-3 metrics-grounded reasons.
  const reasons: RecommendationReason[] = [{ kind: "TOGETHER", count: dimensions.count }];
  if (hit.showtimeIndices.length > 1) {
    reasons.push({ kind: "MULTI_SHOWTIME", count: hit.showtimeIndices.length });
  }
  if (meanAbsLateral <= CENTERED_MAX_ABS_LATERAL) {
    reasons.push({ kind: "CENTERED", lateralPct: Math.round(meanLateral * LATERAL_PCT_SCALE) });
  }
  if (meanDepth >= FRONT_THIRD && meanDepth <= MIDDLE_THIRD_BACK) {
    reasons.push({ kind: "MIDDLE_THIRD" });
  }
  if (aisleAdjacent) {
    reasons.push({ kind: "AISLE_ADJACENT" });
  }
  if (meanDepth >= FRONT_THIRD) {
    reasons.push({ kind: "AVOIDS_FRONT" });
  }

  // E7.7 — only the two trigger-grounded relaxations. ORDER follows §6.1's vocabulary.
  const relaxations: Relaxation[] = [];
  if (group.regionMask !== undefined && spec.region !== undefined && outsideRegion) {
    relaxations.push({ kind: "OUTSIDE_REGION", region: regionLabel(spec.region) });
  }
  const resolvedShowtimeCount = group.showtimes.filter((showtime) => showtime.resolved).length;
  if (
    !thresholdMet(spec.aggregation.threshold, hit.showtimeIndices.length, resolvedShowtimeCount)
  ) {
    relaxations.push({ kind: "FEWER_SHOWTIMES" });
  }
  // E7.7 — UNRESOLVED_SHOWTIMES (ADR 0033): any unresolved showtime in this group means the
  // candidate's coverage is incomplete — per ADR 0003's matrix COMPLETE requires "all
  // accepted", so this fires only under PARTIAL/HALTED — and the placement must surface as a
  // relaxed (HEDGED) alternative rather than being treated as an exact match.
  const unresolvedShowtimeCount = group.showtimes.length - resolvedShowtimeCount;
  if (unresolvedShowtimeCount > 0) {
    relaxations.push({ kind: "UNRESOLVED_SHOWTIMES", count: unresolvedShowtimeCount });
  }

  // E7.9 — subset `group.showtimes` to the hit's `showtimeIndices`, preserving order.
  // P9.4 — each offer carries the candidate placement's seat-level deep link
  // (`/showtimes/<id>/seats?seats=<seatNames>`), not the general schedule URL.
  const showtimes = hit.showtimeIndices.map((index) =>
    toShowtimeOffer(group.showtimes[index]!, placement.seatNames),
  );
  const recommendation: Recommendation = {
    placement,
    reasons,
    relaxed: relaxations,
    showtimes,
  };

  return {
    runScore: hit.runScore,
    showtimeCount: hit.showtimeIndices.length,
    meanDepth,
    startCol: hit.startCol,
    placementKey,
    recommendation,
  };
}

/** E7.5 — the §6.1 deterministic key chain applied as the total order. */
function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.runScore !== right.runScore) {
    return right.runScore - left.runScore;
  }
  if (left.showtimeCount !== right.showtimeCount) {
    return right.showtimeCount - left.showtimeCount;
  }
  const leftDistance = Math.abs(left.meanDepth - SWEET_SPOT_DEPTH);
  const rightDistance = Math.abs(right.meanDepth - SWEET_SPOT_DEPTH);
  if (leftDistance !== rightDistance) {
    return leftDistance - rightDistance;
  }
  if (left.meanDepth !== right.meanDepth) {
    // Equidistant ties resolve to the shallower depth (ADR 0015's steeper front-side decay).
    return left.meanDepth - right.meanDepth;
  }
  if (left.startCol !== right.startCol) {
    return left.startCol - right.startCol;
  }
  if (left.placementKey !== right.placementKey) {
    return left.placementKey < right.placementKey ? -1 : 1;
  }
  return 0;
}

function toExact(candidate: Candidate): AssembledExactRecommendation {
  return { ...candidate.recommendation, relaxed: [] as const };
}

function toHedged(candidate: Candidate): AssembledHedgedRecommendation {
  return {
    ...candidate.recommendation,
    relaxed: candidate.recommendation.relaxed as [Relaxation, ...Relaxation[]],
  };
}

export function assembleAnswerEvidence(input: AnswerEvidenceInput): AnswerEvidence {
  // ADR 0017 amendment — placeholder keys for every hit up front, so even the
  // early (no-evidence) returns below stay aligned with `input.groups`.
  const hitPlacementKeys: Array<Array<string | null>> = input.groups.map(({ group }) =>
    (group.groupHits ?? []).map(() => null),
  );
  const dimensions = groupDimensions(input.spec.group);
  if (dimensions === null) {
    // No group shape, or a shape E5 would have typed-unsupported: no placements to assemble.
    return { exact: null, hedged: null, hitPlacementKeys };
  }

  const candidates: Candidate[] = [];
  let groupIndex = 0;
  for (const { group, layout, metrics } of input.groups) {
    if (group.groupHits === undefined || group.groupHits.length === 0) {
      groupIndex += 1;
      continue;
    }
    let hitIndex = 0;
    for (const hit of group.groupHits) {
      const candidate = buildCandidate(group, layout, metrics, hit, dimensions, input.spec);
      if (candidate !== null) {
        candidates.push(candidate);
        hitPlacementKeys[groupIndex]![hitIndex] = candidate.placementKey;
      }
      hitIndex += 1;
    }
    groupIndex += 1;
  }

  if (candidates.length === 0) {
    return { exact: null, hedged: null, hitPlacementKeys };
  }

  candidates.sort(compareCandidates);

  // E7.8 — A3/A4. `exact` is the best-ranked unrelaxed candidate; when one exists there is
  // a single confident answer (hedged = null). Otherwise the top 2-3 relaxed candidates.
  // (ADR 0017 amendment: `hitPlacementKeys` above is purely additive — the selection,
  // ranking, and pruning below are byte-for-byte the pre-amendment behavior.)
  const exact = candidates.find((candidate) => candidate.recommendation.relaxed.length === 0);
  if (exact !== undefined) {
    return { exact: toExact(exact), hedged: null, hitPlacementKeys };
  }

  const hedged = candidates.slice(0, 3);
  if (hedged.length < 2) {
    return { exact: null, hedged: null, hitPlacementKeys };
  }
  const alternatives = hedged.map(toHedged);
  if (alternatives.length === 3) {
    return {
      exact: null,
      hedged: [alternatives[0]!, alternatives[1]!, alternatives[2]!],
      hitPlacementKeys,
    };
  }
  return { exact: null, hedged: [alternatives[0]!, alternatives[1]!], hitPlacementKeys };
}
