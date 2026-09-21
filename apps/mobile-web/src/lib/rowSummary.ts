import type { ResultGroup } from "@seatfirst/core";

/**
 * UI17 rowSummary — pure derivation helpers for ADR 0041 decision 1 & 3.
 *
 * `summarizePlacement` now matches the approved 3-arg contract
 * `(group, hit, partySize)` — reconciled from the spec's original 2-arg listing.
 * `hit.rowSpan` exists but is always `1` for RUN groups
 * (packages/core/src/group-assembly.ts:258-259, `rowSpan=1` / `memberCols=partySize`)
 * and does not carry the seat count; `partySize` is not persisted on `hit`/`group`,
 * and persisting it would be a backend/wire change out of UI17's scope.
 * A 2-arg version cannot derive `Seats {first}-{last}` or `centered`.
 * Approved in this reconciliation (Option A) — see spec Shared Contracts.
 */
export interface RowDotGrid {
  /**
   * rows * columns cells, row-major, matching ResultGroup's own flattening.
   * `accessible` marks wheelchair/companion seats (UI39 / ADR 0069) so dot grids can
   * render the diamond silhouette — optional so existing fixtures stay valid.
   */
  cells: { free: boolean; isSeat: boolean; accessible?: boolean }[];
  rows: number;
  columns: number;
}

/**
 * Per-showtime dot grid.
 * - `free` iff `group.freeIn[cell].includes(showtimeIndex)` (per ResultGroup.freeIn contract)
 * - `isSeat` iff `group.seatKinds[cell] !== NOT_A_SEAT (code 0, packages/core/src/layout.ts SEAT_KIND_CODE.NOT_A_SEAT)`
 * Cites: ResultGroup docs + layout.ts:33-39, group-assembly.ts freeIn construction.
 */
export function buildRowDotGrid(group: ResultGroup, showtimeIndex: number): RowDotGrid {
  const cellCount = group.rows * group.columns;
  const cells: RowDotGrid["cells"] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    // isSeat derivation — seatKinds cell !== 0 (NOT_A_SEAT). Cites layout.ts SEAT_KIND_CODE.NOT_A_SEAT = 0
    const isSeat = group.seatKinds[cell] !== 0;
    // free derivation — freeIn[cell] lists showtime indices for which cell is free.
    // Cites result-contracts.ts ResultGroup.freeIn + group-assembly.ts:229-237
    const freeList = group.freeIn[cell];
    const free = Array.isArray(freeList) ? freeList.includes(showtimeIndex) : false;
    // accessible derivation — WHEELCHAIR (2) / COMPANION (3) per layout.ts SEAT_KIND_CODE.
    const kind = group.seatKinds[cell];
    const accessible = kind === 2 || kind === 3;
    cells.push({ free, isSeat, accessible });
  }
  return { cells, rows: group.rows, columns: group.columns };
}

/**
 * 1 - free/totalSeats for that showtime, rounded to nearest whole percent.
 * totalSeats = count of isSeat cells (0 if no seats — returns null, never divide by 0).
 * Cites: ADR 0041 decision 1 occupancy derivation.
 */
export function percentFull(grid: RowDotGrid): number | null {
  let totalSeats = 0;
  let freeSeats = 0;
  for (const cell of grid.cells) {
    if (cell.isSeat) {
      totalSeats += 1;
      if (cell.free) freeSeats += 1;
    }
  }
  if (totalSeats === 0) return null; // never divide by zero — spec mandates null
  const pct = (1 - freeSeats / totalSeats) * 100;
  return Math.round(pct);
}

export interface PlacementSummary {
  /** "Row {letter}, Seats {first}-{last}" from a groupHits entry, 1-indexed seat numbers
   *  within its row. Prefers real seatNames values when present for first/last,
   *  falling back to startCol+1 / startCol+partySize. */
  rowSeatLabel: string;
  centered: boolean; // reuses |startCol + partySize/2 - columns/2| < 2 (ShowtimeRow.deriveStatusText centre rule generalized)
  third: "front" | "middle" | "back"; // row bucketed into thirds of group.rows, row 0 = front
}

/**
 * Placement summary for a single groupHits entry.
 * - Seat run is row `hit.row`, columns `hit.startCol` through `hit.startCol + partySize - 1`.
 *   Cites: packages/core/src/group-assembly.ts:258-259 — RUN groups fix rowSpan=1 and memberCols=partySize,
 *   so rowSpan is NOT a seat count.
 * - rowSeatLabel is 1-indexed "Row {letter}, Seats {first}-{last}" — uses seatNames[cell] when
 *   present for first/last cells, otherwise synthetic startCol+1.
 *   Cites: result-contracts.ts seatNames + presentation.ts formatPlacementLabel analogy.
 * - centered via run's true centre column vs group.columns/2, threshold <2 consistent with
 *   apps/mobile-web/src/components/search/ShowtimeRow.tsx deriveStatusText (`|startCol+1 - columns/2| <2`).
 * - third by bucketing hit.row into thirds of group.rows (row 0 = front).
 */
export function summarizePlacement(
  group: ResultGroup,
  hit: NonNullable<ResultGroup["groupHits"]>[number],
  partySize: number,
): PlacementSummary {
  const rowLetter = String.fromCharCode(65 + hit.row);
  const firstIdx = hit.row * group.columns + hit.startCol;
  const lastIdx = firstIdx + partySize - 1;

  // Prefer real seatNames values when present for first/last cells.
  // seatNames is Record<string,string> keyed by flattened cell index (result-contracts.ts:846, layout.ts:57)
  let firstStr: string;
  let lastStr: string;
  const firstName = (group.seatNames as Record<string, string> | undefined)?.[String(firstIdx)];
  const lastName = (group.seatNames as Record<string, string> | undefined)?.[String(lastIdx)];
  if (firstName !== undefined && lastName !== undefined) {
    // seatNames entries are typically "A12"-style (presentation.ts SEAT_NAME_PATTERN).
    // Prefer the numeric suffix for the Seats portion while keeping the rowLetter derived from hit.row.
    const firstMatch = /^([A-Za-z]+)(\d+)$/.exec(firstName);
    const lastMatch = /^([A-Za-z]+)(\d+)$/.exec(lastName);
    if (firstMatch && lastMatch) {
      // Real seat numbering can run in either direction across columns (e.g. house-left
      // numbering that decreases left-to-right) — always display the lower number first,
      // matching the presentation.ts formatPlacementLabel convention (min–max, not
      // positional first/last), so "Seats 7-4" never reaches the UI.
      const firstNum = Number(firstMatch[2]);
      const lastNum = Number(lastMatch[2]);
      const lo = Math.min(firstNum, lastNum);
      const hi = Math.max(firstNum, lastNum);
      firstStr = String(lo);
      lastStr = String(hi);
    } else {
      // Fallback: use raw seatNames values verbatim if they don't follow RowLetterNumber pattern.
      firstStr = firstName;
      lastStr = lastName;
    }
  } else {
    // Synthetic 1-indexed seat numbers within the row.
    firstStr = String(hit.startCol + 1);
    lastStr = String(hit.startCol + partySize);
  }
  const rowSeatLabel = `Row ${rowLetter}, Seats ${firstStr}-${lastStr}`;

  // Centered: run's true centre vs columns/2, threshold <2.
  // Cites ShowtimeRow.deriveStatusText centre rule (|startCol+1 - columns/2| <2) generalized to partySize/2.
  const centre = group.columns / 2;
  const runCentre = hit.startCol + partySize / 2;
  const centered = Math.abs(runCentre - centre) < 2;

  // Third: bucket hit.row into thirds of group.rows, row 0 = front.
  // Thresholds rows/3 and 2*rows/3.
  const third: PlacementSummary["third"] =
    hit.row < group.rows / 3 ? "front" : hit.row < (2 * group.rows) / 3 ? "middle" : "back";

  return { rowSeatLabel, centered, third };
}

/**
 * Free seats / total seats for one showtime.
 * Shares derivation with percentFull's grid but operates directly on group.
 * totalSeats = count of seatKinds[cell] !== NOT_A_SEAT (0)
 * free = count of those where freeIn[cell].includes(showtimeIndex)
 * Cites: layout.ts SEAT_KIND_CODE.NOT_A_SEAT, result-contracts.ts freeIn.
 */
export function freeAndTotalSeats(
  group: ResultGroup,
  showtimeIndex: number,
): { free: number; totalSeats: number } {
  const cellCount = group.rows * group.columns;
  let totalSeats = 0;
  let free = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    const isSeat = group.seatKinds[cell] !== 0; // NOT_A_SEAT = 0
    if (isSeat) {
      totalSeats += 1;
      const freeList = group.freeIn[cell];
      if (Array.isArray(freeList) && freeList.includes(showtimeIndex)) {
        free += 1;
      }
    }
  }
  return { free, totalSeats };
}

/**
 * Relative-time label from an ISO capturedAt instant and now.
 * Returns:
 *  - "just now" if <60s,
 *  - "N minute(s) ago" if <1h,
 *  - "N hour(s) ago" if <24h,
 *  - "N day(s) ago" otherwise.
 * No "checked " prefix — caller composes "checked X ago" / "Available · checked X ago".
 * Style consistent with app's existing copy; no prior formatter exists in apps/mobile-web/src/lib
 * (grep for relative-time found none, so new implementation here).
 */
export function checkedAgoLabel(capturedAt: string, now: Date = new Date()): string {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return "just now";
  const diffMs = now.getTime() - capturedMs;
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diffSec / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
/**
 * Freshness disclosure for a resolved showtime snapshot (ADR 0065 §Decision 3).
 * Thin tier classification over checkedAgoLabel: "fresh" (<30s), "cached"
 * (30s–120s), "stale" (>120s). Null when there is no usable capturedAt —
 * the caller omits the freshness label rather than rendering a placeholder.
 */
export type FreshnessTier = "fresh" | "cached" | "stale";

export interface FreshnessInfo {
  readonly label: string;
  readonly tier: FreshnessTier;
  readonly ageMs: number;
}

export function formatFreshnessInfo(
  capturedAt: string | undefined | null,
  now: Date = new Date(),
): FreshnessInfo | null {
  if (!capturedAt) return null;
  const capturedTime = Date.parse(capturedAt);
  if (Number.isNaN(capturedTime)) return null;

  const ageMs = Math.max(0, now.getTime() - capturedTime);
  const relativeText = checkedAgoLabel(capturedAt, now);

  let tier: FreshnessTier = "fresh";
  if (ageMs > 120_000) {
    tier = "stale";
  } else if (ageMs >= 30_000) {
    tier = "cached";
  }

  return {
    label: `Available · checked ${relativeText}`,
    tier,
    ageMs,
  };
}
