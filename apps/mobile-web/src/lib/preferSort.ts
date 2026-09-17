import type { ResultGroup, ScheduleSkeletonEntry } from "@seatfirst/core";
import { formatCodeToPref } from "@/lib/buildSearchSpec";
import { summarizePlacement } from "@/lib/rowSummary";

export interface PreferToggles {
  format: "any" | "imax" | "dolby" | "standard"; // single-select; "any" = no format filter
  centered: boolean;
  aisle: boolean;
  avoidFront: boolean;
}

export const NO_PREFERENCE: PreferToggles = {
  format: "any",
  centered: false,
  aisle: false,
  avoidFront: false,
};

/**
 * Client-side display sort mode (S59 / ADR 0062 §5, amending ADR 0041 decision 1).
 * "DEFAULT" preserves existing order; "PRICE_ASC" ("Cheapest") stably orders
 * showtime offers by ascending `minPrice.amount`, with unpriced entries
 * (`minPrice === null`, unresolved, or unknown) after priced ones.
 * Purely client-side over already-resolved offers — no new network requests,
 * backend aggregate ordering unchanged.
 */
export type DisplaySortMode = "DEFAULT" | "PRICE_ASC";

function priceOf(entry: ScheduleSkeletonEntry, groups: ResultGroup[]): number | null {
  const group = groups.find((g) => g.showtimes.some((s) => s.showtimeId === entry.showtimeId));
  const showtime = group?.showtimes.find((s) => s.showtimeId === entry.showtimeId);
  const amount = showtime?.minPrice?.amount;
  return typeof amount === "number" ? amount : null;
}

function stablePriceAsc(
  skeleton: ScheduleSkeletonEntry[],
  groups: ResultGroup[],
): ScheduleSkeletonEntry[] {
  return skeleton
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const pa = priceOf(a.entry, groups);
      const pb = priceOf(b.entry, groups);
      if (pa === null && pb === null) return a.index - b.index;
      if (pa === null) return 1;
      if (pb === null) return -1;
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/**
 * Check whether a hit's seat run is aisle-adjacent.
 * An aisle seat is adjacent to a NOT_A_SEAT cell (code 0, packages/core/src/layout.ts
 * SEAT_KIND_CODE.NOT_A_SEAT) or the physical row edge (grid boundary).
 * We test the run's first column (startCol) left neighbor and last column
 * (startCol+partySize-1) right neighbor — if either touches edge or NOT_A_SEAT,
 * the hit is aisle-adjacent. Cites: spec's aisle note (seatKinds gap column test).
 */
function isAisleHit(
  group: ResultGroup,
  hit: NonNullable<ResultGroup["groupHits"]>[number],
  partySize: number,
): boolean {
  const columns = group.columns;
  const row = hit.row;
  const firstCol = hit.startCol;
  const lastCol = hit.startCol + partySize - 1;

  // Left of first seat
  if (firstCol === 0) {
    // At left grid boundary -> considered aisle-adjacent per spec ("row edge")
    return true;
  }
  const leftIdx = row * columns + (firstCol - 1);
  // seatKinds[leftIdx] === 0 means NOT_A_SEAT gap adjacent
  if (group.seatKinds[leftIdx] === 0) return true;

  // Right of last seat
  if (lastCol === columns - 1) {
    // At right grid boundary
    return true;
  }
  const rightIdx = row * columns + (lastCol + 1);
  if (group.seatKinds[rightIdx] === 0) return true;

  return false;
}

/**
 * Stable partition, never a weighted score (ADR 0041 decision 8).
 * Rows satisfying every active toggle first (original relative order preserved),
 * then every other row (original relative order preserved). NO_PREFERENCE (or any
 * all-inactive combination) returns `skeleton` unchanged.
 *
 * - Format matching reuses `formatCodeToPref` from buildSearchSpec.ts (do not reimplement).
 *   Cites: apps/mobile-web/src/lib/buildSearchSpec.ts formatCodeToPref.
 * - A seat-preference toggle (centered/aisle/avoidFront) is satisfied only by a resolved
 *   HIT row whose best groupHits entry's summarizePlacement result matches:
 *     centered -> centered===true
 *     aisle -> run touches aisle-adjacent column (isAisleHit above)
 *     avoidFront -> third !== 'front' is satisfied (Avoid front preference is satisfied
 *                   when the run's third is NOT 'front')
 *   Non-hit rows (checking/queued/deferred/miss) never satisfy a seat-preference toggle
 *   but are never dropped — only reordered.
 *   Cites: ShowtimeRow hit-detection logic (groupHits[].showtimeIndices includes showtimeIndex)
 *          + rowSummary.summarizePlacement.
 * - Optional `sortMode` (`DisplaySortMode`, default "DEFAULT") re-ranks first: "PRICE_ASC"
 *   stably orders by ascending `minPrice.amount` with unpriced entries last, and the
 *   partition then preserves that order within each half.
 */
export function applyPreferOrder(
  skeleton: ScheduleSkeletonEntry[],
  groups: ResultGroup[],
  partySize: number,
  toggles: PreferToggles,
  sortMode: DisplaySortMode = "DEFAULT",
): ScheduleSkeletonEntry[] {
  const isInactive =
    toggles.format === "any" && !toggles.centered && !toggles.aisle && !toggles.avoidFront;
  // Price ranking applies first so the partition below stays stable within each
  // price tier: satisfying rows in price order, then the rest in price order.
  const ranked = sortMode === "PRICE_ASC" ? stablePriceAsc(skeleton, groups) : skeleton;
  if (isInactive && sortMode === "DEFAULT") {
    // Spec allows same array reference; return original to preserve identity.
    return skeleton;
  }

  const needFormat = toggles.format !== "any";
  const needCentered = toggles.centered;
  const needAisle = toggles.aisle;
  const needAvoidFront = toggles.avoidFront;

  function satisfies(entry: ScheduleSkeletonEntry): boolean {
    // Format toggle — applies to every row regardless of hit status.
    // Cites buildSearchSpec.ts formatCodeToPref mapping (imax/dolby/standard/any)
    if (needFormat) {
      // entry.formatCode may be null; formatCodeToPref maps null/unknown to "standard"
      const pref = formatCodeToPref(entry.formatCode ?? null);
      if (pref !== toggles.format) return false;
    }

    // If no seat preferences active, format alone determines satisfaction.
    if (!needCentered && !needAisle && !needAvoidFront) {
      return true;
    }

    // Seat preferences — satisfied only by resolved HIT (reuse ShowtimeRow's hit-detection).
    // Find owning group for this showtimeId.
    const group = groups.find((g) => g.showtimes.some((s) => s.showtimeId === entry.showtimeId));
    if (!group) return false;
    const showtimeIdx = group.showtimes.findIndex((s) => s.showtimeId === entry.showtimeId);
    if (showtimeIdx === -1) return false;
    const showtime = group.showtimes[showtimeIdx] as unknown as { resolved?: boolean } | undefined;
    if (!showtime || showtime.resolved !== true) return false;

    // Hit lookup via groupHits[].showtimeIndices.includes(showtimeIdx) — preserves ShowtimeRow logic
    const hits = (group.groupHits ?? []).filter((h) => h.showtimeIndices.includes(showtimeIdx));
    if (hits.length === 0) return false;
    const hit = hits[0]!; // best hit (ShowtimeRow picks hits[0])
    const placement = summarizePlacement(group, hit, partySize);

    if (needCentered && !placement.centered) return false;
    if (needAisle && !isAisleHit(group, hit, partySize)) return false;
    // 'Avoid front' preference is satisfied when the run's third is NOT 'front' (explicit per assignment)
    if (needAvoidFront && placement.third === "front") return false;

    return true;
  }

  const satisfying: ScheduleSkeletonEntry[] = [];
  const other: ScheduleSkeletonEntry[] = [];
  for (const entry of ranked) {
    if (satisfies(entry)) satisfying.push(entry);
    else other.push(entry);
  }
  return [...satisfying, ...other];
}
