import { getBit, openCount, perPositionPopcount, createBitmap, setBit } from "./bitmap.js";
import type { AuditoriumLayoutGeometry } from "./layout.js";
import type { SeatMetrics } from "./metrics.js";
import { compileRegion, regionRunStarts } from "./region.js";
import type { RegionCompileResult } from "./region.js";
import { runScore } from "./scoring.js";
import type { GroupShape, SeatRegion, SplitGroupShape } from "./search-spec.js";
import type {
  IanaTimezone,
  Money,
  ResultContractSchemas,
  ResultGroup,
  ShowtimeStatus,
  UtcInstant,
} from "./result-contracts.js";

/**
 * The pure answer-assembly engine (E5): E1's layout geometry, E2's metrics, E3's compiled
 * region, and E4's per-cell scores plus per-showtime availability snapshots into one
 * contract-valid `ResultGroup` (`packages/core/src/result-contracts.ts:553-581`). No I/O, no
 * mutable module state — the aggregation engine's contract
 * (`docs/seatfirst-architecture.md:150`). This is the module the future AGGREGATE step
 * consumes; nothing else builds `groupHits` content.
 *
 * One pipeline, one variable: the candidate **pool mask** is chosen by the caller exactly
 * once per ADR 0011 (`docs/adr/0011-accessibility-ranking-policy.md:42-46`) — accessibleMask
 * when the spec requires accessibility, else ordinaryMask — before any run work runs. Every
 * downstream step (scoring, run detection, ranking) is identical code over that mask.
 */

export interface ResolvedGroupShowtimeInput {
  readonly resolved: true;
  readonly showtimeId: string;
  readonly theatreId: string;
  readonly distanceKm: number | null;
  readonly showDateTimeUtc: UtcInstant;
  readonly timezone: IanaTimezone;
  readonly minPrice: Money | null;
  readonly status: ShowtimeStatus;
  readonly deepLinkUrl: string;
  readonly capturedAt: UtcInstant;
  readonly staleAfter: UtcInstant;
  /** Availability snapshot: one bit per grid cell (rows × columns). */
  readonly availability: Uint8Array;
}

export interface UnresolvedGroupShowtimeInput {
  readonly resolved: false;
  readonly showtimeId: string;
  readonly theatreId: string;
  readonly distanceKm: number | null;
  readonly showDateTimeUtc: UtcInstant;
  readonly timezone: IanaTimezone;
  /** The wire contract requires null on unresolved entries (`result-contracts.ts:543-549`). */
  readonly minPrice: null;
  readonly status: ShowtimeStatus;
  readonly deepLinkUrl: string;
}

/** Per-showtime input, pre-ordered by `showDateTimeUtc` (`docs/seatfirst-query-design.md:153`). */
export type GroupShowtimeInput = ResolvedGroupShowtimeInput | UnresolvedGroupShowtimeInput;

export interface AssembleResultGroupInput {
  readonly layout: AuditoriumLayoutGeometry;
  readonly metrics: SeatMetrics;
  /** E4's per-cell scores, verbatim — asserted, never transformed (E5.4). */
  readonly seatScores: Float64Array;
  /** The ADR 0011 candidate pool (E5.1); chosen once by the caller before this call. */
  readonly poolMask: Uint8Array;
  /** Compiled `spec.region` — the `regionMask` preview output (F5's minimal reading). */
  readonly previewRegion: RegionCompileResult | null;
  /** Compiled `spec.groupRegion` — placement filtering via `regionRunStarts` (F5). */
  readonly placementRegion: RegionCompileResult | null;
  readonly group: GroupShape | undefined;
  readonly groupStrict: boolean;
  readonly rank: "SCORE" | "AVAILABILITY" | "DEPTH";
  readonly showtimes: readonly GroupShowtimeInput[];
  readonly layoutId: string;
  readonly theatreId: string;
  readonly formatCode: string;
  readonly auditorium: string | number | null;
  readonly attributes: readonly string[];
  /** Zod at every boundary: the caller's contract factory result (`result-contracts.ts:452`). */
  readonly resultGroupSchema: ResultContractSchemas["ResultGroupSchema"];
}

export interface GroupAssemblyUnsupported {
  readonly ok: false;
  readonly error:
    | {
        readonly code: "UNSUPPORTED_SPLIT_GROUP";
        readonly group: SplitGroupShape;
      }
    | {
        readonly code: "UNSUPPORTED_SCORE_REGION";
        readonly region: Extract<SeatRegion, { readonly kind: "SCORE" }>;
      }
    | {
        readonly code: "UNSUPPORTED_DEPTH_RANK";
        readonly rank: "DEPTH";
      };
}

export interface GroupAssemblySuccess {
  readonly ok: true;
  readonly result: ResultGroup;
}

export type GroupAssemblyResult = GroupAssemblySuccess | GroupAssemblyUnsupported;

/** E3's own geometry assertion (`region.ts:54-65`): metrics must span the full grid. */
function assertGeometry(layout: AuditoriumLayoutGeometry, metrics: SeatMetrics): number {
  const cellCount = layout.rows * layout.columns;
  if (
    metrics.seatIndexInRow.length !== cellCount ||
    metrics.depth.length !== cellCount ||
    metrics.lateral.length !== cellCount ||
    metrics.aisleDistance.length !== cellCount
  ) {
    throw new RangeError("metric lengths do not match layout geometry");
  }
  return cellCount;
}

/** E5.4's contract assertion: length `rows × columns`, every element finite — never repaired. */
function assertSeatScores(seatScores: Float64Array, cellCount: number): void {
  if (seatScores.length !== cellCount) {
    throw new RangeError(
      `seatScores length ${seatScores.length} must equal rows × columns (${cellCount})`,
    );
  }
  for (let index = 0; index < cellCount; index += 1) {
    if (!Number.isFinite(seatScores[index])) {
      throw new RangeError(`seatScores[${index}] must be finite`);
    }
  }
}

/** Bitmap → flattened 0/1 wire array (`result-contracts.ts:566,593-598`). */
function maskToBits(mask: Uint8Array, cellCount: number): number[] {
  const bits = new Array<number>(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    bits[index] = getBit(mask, index, cellCount) ? 1 : 0;
  }
  return bits;
}

/** E1's `seatNames` with number keys stringified; `{}` when the field is null (E5.5). */
function stringifiedSeatNames(
  seatNames: Readonly<Record<number, string>> | null,
): Record<string, string> {
  const names: Record<string, string> = {};
  if (seatNames !== null) {
    for (const [index, name] of Object.entries(seatNames)) {
      names[index] = name;
    }
  }
  return names;
}

export function assembleResultGroup(input: AssembleResultGroupInput): GroupAssemblyResult {
  const { layout, metrics, seatScores, poolMask, previewRegion, placementRegion } = input;
  const cellCount = assertGeometry(layout, metrics);
  assertSeatScores(seatScores, cellCount);

  // Typed-unsupported gates (E5.8/E5.9), checked in this fixed order before any run work:
  // SPLIT shape, SCORE regions (either compiled region), then DEPTH ranking. None of these
  // has semantics in an accepted document — a typed result, never a throw, never an invention.
  if (input.group?.kind === "SPLIT") {
    return { ok: false, error: { code: "UNSUPPORTED_SPLIT_GROUP", group: input.group } };
  }
  if (previewRegion !== null && !previewRegion.ok) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_SCORE_REGION", region: previewRegion.error.region },
    };
  }
  if (placementRegion !== null && !placementRegion.ok) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_SCORE_REGION", region: placementRegion.error.region },
    };
  }
  // Only meaningful when hits would be ranked: without a group shape there are no hits.
  if (input.group !== undefined && input.rank === "DEPTH") {
    return { ok: false, error: { code: "UNSUPPORTED_DEPTH_RANK", rank: input.rank } };
  }

  // E5.10 — group showtimes pass through in caller order; resolved entries gain `openCount`
  // over ORDINARY seats only (the contract's own comment, `docs/seatfirst-query-design.md:454`).
  // ADR 0011 is silent on an accessibility-mode count — finding F4, escalated, not invented.
  const outputShowtimes = input.showtimes.map((showtime) => {
    if (!showtime.resolved) {
      return {
        showtimeId: showtime.showtimeId,
        theatreId: showtime.theatreId,
        distanceKm: showtime.distanceKm,
        showDateTimeUtc: showtime.showDateTimeUtc,
        timezone: showtime.timezone,
        minPrice: null,
        status: showtime.status,
        deepLinkUrl: showtime.deepLinkUrl,
        resolved: false,
        openCount: null,
      };
    }
    return {
      showtimeId: showtime.showtimeId,
      theatreId: showtime.theatreId,
      distanceKm: showtime.distanceKm,
      showDateTimeUtc: showtime.showDateTimeUtc,
      timezone: showtime.timezone,
      minPrice: showtime.minPrice,
      status: showtime.status,
      deepLinkUrl: showtime.deepLinkUrl,
      resolved: true,
      openCount: openCount(showtime.availability, layout.ordinaryMask, cellCount),
      capturedAt: showtime.capturedAt,
      staleAfter: showtime.staleAfter,
    };
  });

  // E5.5 — freeCount/freeIn are NOT pool-filtered: charts render accessible seats' true open
  // state (`docs/seatfirst-query-design.md:207-208`), and freeCount is computed unconditionally.
  const resolvedAvailabilities = input.showtimes.flatMap((showtime) =>
    showtime.resolved ? [showtime.availability] : [],
  );
  const freeCounts = perPositionPopcount(resolvedAvailabilities, cellCount);
  const freeIn: number[][] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    const indices: number[] = [];
    for (const [showtimeIndex, showtime] of input.showtimes.entries()) {
      if (showtime.resolved && getBit(showtime.availability, cell, cellCount)) {
        indices.push(showtimeIndex);
      }
    }
    freeIn.push(indices);
  }

  // F5's minimal grounded reading: `spec.region` → `regionMask` preview output only.
  const regionMask = previewRegion === null ? undefined : maskToBits(previewRegion.mask, cellCount);

  // E5.6/E5.7 — groupHits over the E5.1 pool, E3's exact `regionRunStarts` semantics.
  let groupHits: GroupHit[] | undefined;
  if (input.group !== undefined) {
    let placementMask: Uint8Array;
    if (placementRegion === null) {
      const compiledAll = compileRegion(layout, metrics, { kind: "ALL" });
      if (!compiledAll.ok) {
        // Unreachable: ALL has no SCORE branch. Kept fail-loud for the compiler's union.
        throw new Error("unreachable: ALL region failed to compile");
      }
      placementMask = compiledAll.mask;
    } else {
      placementMask = placementRegion.mask;
    }

    const rowSpan = input.group.kind === "RUN" ? 1 : input.group.rows;
    const memberCols = input.group.kind === "RUN" ? input.group.count : input.group.cols;
    const hitSets: { readonly mask: Uint8Array; readonly showtimeIndex: number }[] = [];
    for (const [showtimeIndex, showtime] of input.showtimes.entries()) {
      if (!showtime.resolved) {
        continue;
      }
      if (input.group.kind === "RUN") {
        hitSets.push({
          mask: regionRunStarts(
            showtime.availability,
            poolMask,
            layout,
            placementMask,
            input.group.count,
            input.groupStrict,
          ),
          showtimeIndex,
        });
      } else {
        // BLOCK: the row-r RUN mask AND'd with the rows above, per the query design's own
        // bitwise definition (`docs/seatfirst-query-design.md:293`) — no truncation.
        const blockRows = input.group.rows;
        const blockCols = input.group.cols;
        const runs = regionRunStarts(
          showtime.availability,
          poolMask,
          layout,
          placementMask,
          blockCols,
          input.groupStrict,
        );
        const blocks = createBitmap(cellCount);
        for (let row = 0; row + blockRows <= layout.rows; row += 1) {
          for (let column = 0; column < layout.columns; column += 1) {
            let present = true;
            for (let rowOffset = 0; rowOffset < blockRows; rowOffset += 1) {
              if (!getBit(runs, (row + rowOffset) * layout.columns + column, cellCount)) {
                present = false;
                break;
              }
            }
            if (present) {
              setBit(blocks, row * layout.columns + column, cellCount);
            }
          }
        }
        hitSets.push({ mask: blocks, showtimeIndex });
      }
    }

    // Every hit, never a top-N truncation (F2: the cap is undecided — emit everything).
    const hits: GroupHit[] = [];
    for (let row = 0; row < layout.rows; row += 1) {
      for (let column = 0; column < layout.columns; column += 1) {
        const cell = row * layout.columns + column;
        const showtimeIndices: number[] = [];
        for (const set of hitSets) {
          if (getBit(set.mask, cell, cellCount)) {
            showtimeIndices.push(set.showtimeIndex);
          }
        }
        if (showtimeIndices.length === 0) {
          continue;
        }
        const members: number[] = [];
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
          for (let columnOffset = 0; columnOffset < memberCols; columnOffset += 1) {
            // A valid hit never reaches past the grid end; the fallback lets `runScore`'s
            // own non-finite guard fail loudly if that invariant ever breaks.
            members.push(
              seatScores[(row + rowOffset) * layout.columns + column + columnOffset] ?? Number.NaN,
            );
          }
        }
        hits.push({
          row,
          startCol: column,
          rowSpan,
          runScore: runScore(members),
          showtimeIndices,
        });
      }
    }

    // E5.9 — SCORE descends by runScore; AVAILABILITY descends by how many showtimes offer
    // the placement. Ties break row-major (row, then startCol): deterministic, "safe to
    // decide yourself" (`docs/open-questions.md:3-13`).
    if (input.rank === "AVAILABILITY") {
      hits.sort(
        (left, right) =>
          right.showtimeIndices.length - left.showtimeIndices.length ||
          left.row - right.row ||
          left.startCol - right.startCol,
      );
    } else {
      hits.sort(
        (left, right) =>
          right.runScore - left.runScore || left.row - right.row || left.startCol - right.startCol,
      );
    }
    groupHits = hits;
  }

  const groupObject = {
    layoutId: input.layoutId,
    theatreId: input.theatreId,
    distanceKm: null,
    formatCode: input.formatCode,
    auditorium: input.auditorium,
    attributes: [...input.attributes],
    rows: layout.rows,
    columns: layout.columns,
    seatKinds: Array.from(layout.seatKinds),
    seatNames: stringifiedSeatNames(layout.seatNames),
    seatScores: Array.from(seatScores),
    ...(regionMask === undefined ? {} : { regionMask }),
    showtimes: outputShowtimes,
    freeCount: Array.from(freeCounts),
    freeIn,
    ...(groupHits === undefined ? {} : { groupHits }),
  };
  const parsed = input.resultGroupSchema.safeParse(groupObject);
  if (!parsed.success) {
    throw new Error(
      "assembled ResultGroup failed ResultGroupSchema validation: " +
        parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return { ok: true, result: parsed.data };
}

interface GroupHit {
  readonly row: number;
  readonly startCol: number;
  readonly rowSpan: number;
  readonly runScore: number;
  readonly showtimeIndices: number[];
}
