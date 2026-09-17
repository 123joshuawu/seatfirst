import { sha256 } from "./sha256.js";
import {
  RecoveryOptionSchema,
  type Placement,
  type RecoveryOption,
  type ResultGroup,
} from "./result-contracts.js";

/**
 * S32 — the `showtimes.recheck` `GONE` recovery ladder, levels 1-4.
 *
 * Pure: no I/O, no mutable state, no `@seatfirst/durability` import, deterministic for
 * equal inputs (`docs/seatfirst-architecture.md:150-151`). Level 1 computes the decided
 * "nearest equivalent" rule — same shape within ±2 rows, minimizing `|Δrow|·W + |Δcol|`
 * (`docs/seatfirst-architecture.md:395`) — over the search's terminal `ResultGroup`
 * evidence, reusing E7's `Placement`/`placementKey` construction and the §6.1 tie-break
 * chain with its depth key omitted (finding F6: the depth key needs layout geometry the
 * terminal payload does not carry). Levels 2-4 are ADR 0026's decided search spaces,
 * ranking, and dedup (`docs/adr/0026-recheck-recovery-levels-2-4.md:29-40`); the Level 4
 * relaxation-flag mechanism and `label` are S32.16/ADR 0027 Part 1, and the Level 4
 * multi-showtime tie-break is ADR 0027 Part 2
 * (`docs/adr/0027-recheck-recovery-level4-label-and-showtime-tiebreak.md`).
 * `assembleRecoveryLadder` composes all four rungs as a strict first-success degradation
 * (S32.17); the seam (`apps/server/src/routes/showtimes/recovery-seam.ts`) calls it.
 *
 * `rowWeight` is the `W` of `docs/seatfirst-architecture.md:395`, injected with no default
 * (gate 14); the production value is `W=2` per the ADR 0024 amendment.
 */

/** ADR 0023 decision 1: `placementKey` keeps the first 16 hex characters (64 bits). */
const PLACEMENT_KEY_HEX_CHARS = 16;

/** Shared by every rung (S32.17): levels 2-4 ignore `rowWeight`, which only level 1 uses. */
export interface AssembleRecoveryLadderInput {
  readonly gonePlacement: Placement;
  readonly goneShowtimeId: string;
  readonly group: ResultGroup;
  /** `W` of `docs/seatfirst-architecture.md:395` — injected, no default (gate 14). */
  readonly rowWeight: number;
}

type GroupHit = NonNullable<ResultGroup["groupHits"]>[number];

/** S32.16 — the wire-open escape-hatch `kind`/`label` for the Level 4 relaxation. */
const LEVEL_4_RELAXATION_KIND = "S32_LEVEL_4_RELAXED";
const LEVEL_4_RELAXATION_LABEL = "Different showtime and seat";

/**
 * S32.6 — the winning placement, reusing E7's construction (E7.3's `buildCandidate`):
 * member cells in row-major cell order, seat names read from `group.seatNames`, and the
 * ADR 0023 decision-1 `placementKey` algorithm (never a second algorithm).
 */
function buildPlacement(
  group: ResultGroup,
  hit: GroupHit,
  count: number,
  memberCols: number,
): Placement | null {
  const seatNames: string[] = [];
  for (let rowOffset = 0; rowOffset < hit.rowSpan; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < memberCols; columnOffset += 1) {
      const cell = (hit.row + rowOffset) * group.columns + (hit.startCol + columnOffset);
      const name = group.seatNames[String(cell)];
      if (name === undefined) {
        // A hit with any missing member-cell name is excluded, never fabricated (E7.3).
        return null;
      }
      seatNames.push(name);
    }
  }
  const placementKey = sha256(
    `${group.layoutId}|${hit.row}|${hit.startCol}|${hit.rowSpan}|${count}`,
  ).slice(0, PLACEMENT_KEY_HEX_CHARS);
  return {
    layoutId: group.layoutId,
    row: hit.row,
    startCol: hit.startCol,
    rowSpan: hit.rowSpan,
    count,
    seatNames,
    placementKey,
  };
}

/** S32.8/S32.12-S32.15 — a gone showtime absent from the group ladders nowhere. */
function resolveGoneShowtimeIndex(group: ResultGroup, goneShowtimeId: string): number {
  return group.showtimes.findIndex((showtime) => showtime.showtimeId === goneShowtimeId);
}

/**
 * S32.14/S32.15's local comparator — the computable subset of the E7.5 chain (`runScore`
 * desc → `showtimeIndices.length` desc → `startCol` asc → `placementKey` asc). The shipped
 * `compareCandidates` (`packages/core/src/answer-assembly.ts:280`) is private and includes
 * the uncomputable `meanDepth` sweet-spot key, so it is not reused verbatim (ADR 0026:36,40).
 */
function compareRecoveryCandidates(
  left: { readonly hit: GroupHit; readonly placement: Placement },
  right: { readonly hit: GroupHit; readonly placement: Placement },
): number {
  if (left.hit.runScore !== right.hit.runScore) {
    return right.hit.runScore - left.hit.runScore;
  }
  if (left.hit.showtimeIndices.length !== right.hit.showtimeIndices.length) {
    return right.hit.showtimeIndices.length - left.hit.showtimeIndices.length;
  }
  if (left.hit.startCol !== right.hit.startCol) {
    return left.hit.startCol - right.hit.startCol;
  }
  if (left.placement.placementKey !== right.placement.placementKey) {
    return left.placement.placementKey < right.placement.placementKey ? -1 : 1;
  }
  return 0;
}

export function assembleRecoveryLevelOne(
  input: AssembleRecoveryLadderInput,
): RecoveryOption | null {
  const { gonePlacement, goneShowtimeId, group, rowWeight } = input;

  // S32.3 — the gone group is the group whose layoutId matches the gone placement's.
  if (group.layoutId !== gonePlacement.layoutId) {
    return null;
  }

  const goneShowtimeIndex = resolveGoneShowtimeIndex(group, goneShowtimeId);
  if (goneShowtimeIndex < 0) {
    return null;
  }

  const hits = group.groupHits;
  if (hits === undefined || hits.length === 0) {
    return null;
  }

  // Same shape is automatic within one group (E5.3's single group input): the placement's
  // member columns are `count / rowSpan` (RUN: rowSpan=1; BLOCK: count = rows·cols).
  const memberCols = gonePlacement.count / gonePlacement.rowSpan;

  interface Candidate {
    readonly hit: GroupHit;
    readonly placement: Placement;
    readonly distance: number;
  }

  const candidates: Candidate[] = [];
  for (const hit of hits) {
    // S32.3(a) — offered at the same showtime.
    if (!hit.showtimeIndices.includes(goneShowtimeIndex)) {
      continue;
    }
    // S32.3(b) — the gone placement is not its own alternative.
    if (hit.row === gonePlacement.row && hit.startCol === gonePlacement.startCol) {
      continue;
    }
    // S32.3(c) — the decided "within ±2 rows" window.
    if (Math.abs(hit.row - gonePlacement.row) > 2) {
      continue;
    }
    const placement = buildPlacement(group, hit, gonePlacement.count, memberCols);
    if (placement === null) {
      continue;
    }
    // S32.4 — the decided distance objective.
    const distance =
      Math.abs(hit.row - gonePlacement.row) * rowWeight +
      Math.abs(hit.startCol - gonePlacement.startCol);
    candidates.push({ hit, placement, distance });
  }

  if (candidates.length === 0) {
    return null;
  }

  // S32.4 (primary) + S32.5 (the §6.1 chain with the depth key omitted per finding F6).
  candidates.sort((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance - right.distance;
    }
    if (left.hit.runScore !== right.hit.runScore) {
      return right.hit.runScore - left.hit.runScore;
    }
    if (left.hit.showtimeIndices.length !== right.hit.showtimeIndices.length) {
      return right.hit.showtimeIndices.length - left.hit.showtimeIndices.length;
    }
    if (left.hit.startCol !== right.hit.startCol) {
      return left.hit.startCol - right.hit.startCol;
    }
    if (left.placement.placementKey !== right.placement.placementKey) {
      return left.placement.placementKey < right.placement.placementKey ? -1 : 1;
    }
    return 0;
  });

  const winner = candidates[0]!;

  // S32.7 — level 1 is unrelaxed; `requiresConsent` is level-4-only. "Zod at every
  // boundary" (the recheck route's own posture, `recheck.ts:77,95`): validate the
  // hand-constructed option before it crosses the module boundary. A `ZodError` here is a
  // genuine implementation bug — the value is built to match the type — never a legitimate
  // "no equivalent" case, which S32.8 already returns as `null`.
  return RecoveryOptionSchema.parse({
    level: 1,
    placement: winner.placement,
    showtimeId: goneShowtimeId,
    relaxed: [],
    requiresConsent: false,
  });
}

/**
 * S32.12/S32.13 — Level 2: the gone placement itself, offered at another showtime. The
 * single `groupHits` entry matching the gone `(row, startCol, rowSpan)` enumerates every
 * showtime that offers it; the winner is the lowest non-gone `showtimeIndex` (ADR 0026:31 —
 * "purely a tie-break needed for determinism, not a ranked preference"). No rung candidate
 * when that hit is offered at no other showtime.
 */
export function assembleRecoveryLevelTwo(
  input: AssembleRecoveryLadderInput,
): RecoveryOption | null {
  const { gonePlacement, goneShowtimeId, group } = input;

  if (group.layoutId !== gonePlacement.layoutId) {
    return null;
  }
  const goneShowtimeIndex = resolveGoneShowtimeIndex(group, goneShowtimeId);
  if (goneShowtimeIndex < 0) {
    return null;
  }
  const hits = group.groupHits;
  if (hits === undefined || hits.length === 0) {
    return null;
  }

  const gonePlacementHit = hits.find(
    (hit) =>
      hit.row === gonePlacement.row &&
      hit.startCol === gonePlacement.startCol &&
      hit.rowSpan === gonePlacement.rowSpan,
  );
  if (gonePlacementHit === undefined) {
    return null;
  }

  const otherShowtimeIndices = gonePlacementHit.showtimeIndices.filter(
    (showtimeIndex) => showtimeIndex !== goneShowtimeIndex,
  );
  if (otherShowtimeIndices.length === 0) {
    return null;
  }
  const chosenShowtimeIndex = Math.min(...otherShowtimeIndices);
  const chosenShowtime = group.showtimes[chosenShowtimeIndex];
  if (chosenShowtime === undefined) {
    return null;
  }

  // S32.13 — the placement is the gone placement's, unchanged; only the showtime moved.
  return RecoveryOptionSchema.parse({
    level: 2,
    placement: gonePlacement,
    showtimeId: chosenShowtime.showtimeId,
    relaxed: [],
    requiresConsent: false,
  });
}

/**
 * S32.14 — Level 3: the same showtime, outside the ±2-row window. The `> 2` window bound
 * automatically excludes every Level-1-eligible hit and the Level-2 hit's own same-row
 * instance (Δrow = 0), so no separate dedup pass is needed (ADR 0026:36). Ranked by
 * `compareRecoveryCandidates`; at most one survivor is returned.
 */
export function assembleRecoveryLevelThree(
  input: AssembleRecoveryLadderInput,
): RecoveryOption | null {
  const { gonePlacement, goneShowtimeId, group } = input;

  if (group.layoutId !== gonePlacement.layoutId) {
    return null;
  }
  const goneShowtimeIndex = resolveGoneShowtimeIndex(group, goneShowtimeId);
  if (goneShowtimeIndex < 0) {
    return null;
  }
  const hits = group.groupHits;
  if (hits === undefined || hits.length === 0) {
    return null;
  }
  const memberCols = gonePlacement.count / gonePlacement.rowSpan;

  const candidates: Array<{ hit: GroupHit; placement: Placement }> = [];
  for (const hit of hits) {
    // Same showtime.
    if (!hit.showtimeIndices.includes(goneShowtimeIndex)) {
      continue;
    }
    // Outside the ±2-row window (also excludes Levels 1 and 2's Δrow=0 hit — ADR 0026:36).
    if (Math.abs(hit.row - gonePlacement.row) <= 2) {
      continue;
    }
    const placement = buildPlacement(group, hit, gonePlacement.count, memberCols);
    if (placement === null) {
      continue;
    }
    candidates.push({ hit, placement });
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort(compareRecoveryCandidates);
  const winner = candidates[0]!;

  return RecoveryOptionSchema.parse({
    level: 3,
    placement: winner.placement,
    showtimeId: goneShowtimeId,
    relaxed: [],
    requiresConsent: false,
  });
}

/**
 * S32.15/S32.16 — Level 4: any showtime, anywhere in the room. Candidates are (hit,
 * showtimeIndex) pairs, deduplicated at the pair level against Levels 1-3: any pairing at
 * the gone showtime is Level-1/3 territory (including the gone placement's own hit at the
 * gone showtime — never its own alternative, S32.3(b) restated), and any other-showtime
 * pairing of the gone placement's own hit is Level-2 territory. The winning hit is ranked
 * by `compareRecoveryCandidates`; among its surviving showtimes, ADR 0027 Part 2 picks the
 * one nearest in `showDateTimeUtc` to the gone showtime, ties broken earlier-first then
 * `showtimeIndex` ascending. `requiresConsent: true` and the wire-open escape-hatch
 * relaxation (S32.16; ADR 0027 Part 1's label) mark this as a bent preference.
 */
export function assembleRecoveryLevelFour(
  input: AssembleRecoveryLadderInput,
): RecoveryOption | null {
  const { gonePlacement, goneShowtimeId, group } = input;

  if (group.layoutId !== gonePlacement.layoutId) {
    return null;
  }
  const goneShowtimeIndex = resolveGoneShowtimeIndex(group, goneShowtimeId);
  if (goneShowtimeIndex < 0) {
    return null;
  }
  const hits = group.groupHits;
  if (hits === undefined || hits.length === 0) {
    return null;
  }
  const memberCols = gonePlacement.count / gonePlacement.rowSpan;

  const candidates: Array<{
    hit: GroupHit;
    placement: Placement;
    eligibleShowtimeIndices: number[];
  }> = [];
  for (const hit of hits) {
    const isGonePlacementHit =
      hit.row === gonePlacement.row &&
      hit.startCol === gonePlacement.startCol &&
      hit.rowSpan === gonePlacement.rowSpan;

    const eligibleShowtimeIndices = hit.showtimeIndices.filter((showtimeIndex) => {
      if (showtimeIndex === goneShowtimeIndex) {
        return false; // Level 1/3 territory.
      }
      if (isGonePlacementHit) {
        return false; // Level 2 territory.
      }
      return true;
    });
    if (eligibleShowtimeIndices.length === 0) {
      continue;
    }
    const placement = buildPlacement(group, hit, gonePlacement.count, memberCols);
    if (placement === null) {
      continue;
    }
    candidates.push({ hit, placement, eligibleShowtimeIndices });
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort(compareRecoveryCandidates);
  const winner = candidates[0]!;

  // ADR 0027 Part 2 — nearest showDateTimeUtc to the gone showtime; ties earlier-first,
  // then showtimeIndex ascending for full determinism.
  const goneTime = Date.parse(group.showtimes[goneShowtimeIndex]!.showDateTimeUtc);
  const scoredShowtimes = winner.eligibleShowtimeIndices.map((showtimeIndex) => {
    const time = Date.parse(group.showtimes[showtimeIndex]!.showDateTimeUtc);
    return { showtimeIndex, time, diff: Math.abs(time - goneTime) };
  });
  scoredShowtimes.sort((left, right) => {
    if (left.diff !== right.diff) {
      return left.diff - right.diff;
    }
    if (left.time !== right.time) {
      return left.time - right.time;
    }
    return left.showtimeIndex - right.showtimeIndex;
  });
  const chosenShowtime = group.showtimes[scoredShowtimes[0]!.showtimeIndex]!;

  return RecoveryOptionSchema.parse({
    level: 4,
    placement: winner.placement,
    showtimeId: chosenShowtime.showtimeId,
    relaxed: [{ kind: LEVEL_4_RELAXATION_KIND, label: LEVEL_4_RELAXATION_LABEL }],
    requiresConsent: true,
  });
}

/**
 * S32.17 — the strict first-success `L1 → L2 → L3 → L4` ladder. Advances only when the
 * preceding rung yields no candidate; `null` when all four fail (F5: "no equivalent",
 * never a fabricated option).
 */
export function assembleRecoveryLadder(input: AssembleRecoveryLadderInput): RecoveryOption | null {
  return (
    assembleRecoveryLevelOne(input) ??
    assembleRecoveryLevelTwo(input) ??
    assembleRecoveryLevelThree(input) ??
    assembleRecoveryLevelFour(input)
  );
}
