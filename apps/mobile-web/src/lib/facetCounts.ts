/**
 * Tri-state facet count helpers (UI18.6, Design 4).
 *
 * S43 (ADR 0036) returns per-candidate `{count, coldTheatreCount}` where
 * `coldTheatreCount` is the number of theatres in `theatreIds` with no fresh
 * cached schedule for that candidate's resolved dates. The client renders
 * three-valued:
 * - a number when the whole window is warm (cold === 0)
 * - "n+"   when part cached part not (0 < cold < total)
 * - "not checked yet" when none warm (cold === total)
 *
 * Only a genuinely warm zero (count===0 && cold===0) dims and disables the
 * row (opacity 0.5, disabled). Cold/partial zero stays selectable and fully
 * opaque. Zero rows are never hidden, only dimmed in place (UI15/UI17 rule).
 *
 * Recompute rate is bounded by the hook's 300ms debounce + coalesce, keeping
 * ≤120 req/min/session under a realistic burst (task-owned timing, not a literal 120 check).
 */

export interface FacetCountEntry {
  count: number;
  coldTheatreCount: number;
}

export interface FacetDisplay {
  text: string;
  isWarmZero: boolean;
  isNotCheckedYet: boolean;
  isPartial: boolean;
}

/**
 * Derive the display text for one candidate given its entry and the total
 * theatre count for the request. `totalTheatres` is `theatreIds.length`, never
 * a hardcoded constant — callers pass the live selectedTheatres length.
 */
export function getFacetDisplay(
  entry: FacetCountEntry | undefined,
  totalTheatres: number,
): FacetDisplay {
  // No entry yet (still loading) — treat as not checked yet for test stability;
  // callers should show a placeholder or omit count, never a fabricated 0.
  if (!entry) {
    return {
      text: "not checked yet",
      isWarmZero: false,
      isNotCheckedYet: true,
      isPartial: false,
    };
  }
  const { count, coldTheatreCount } = entry;
  if (coldTheatreCount === totalTheatres && totalTheatres > 0) {
    return {
      text: "not checked yet",
      isWarmZero: false,
      isNotCheckedYet: true,
      isPartial: false,
    };
  }
  if (coldTheatreCount === 0) {
    return {
      text: String(count),
      isWarmZero: count === 0,
      isNotCheckedYet: false,
      isPartial: false,
    };
  }
  // 0 < cold < total => partially warm
  return {
    text: `${count}+`,
    isWarmZero: false,
    isNotCheckedYet: false,
    isPartial: true,
  };
}

/** Convenience: just the text, for inline label rendering. */
export function formatFacetCount(
  entry: FacetCountEntry | undefined,
  totalTheatres: number,
): string {
  return getFacetDisplay(entry, totalTheatres).text;
}

/** Only a warm zero dims. */
export function isWarmZero(entry: FacetCountEntry | undefined): boolean {
  if (!entry) return false;
  return entry.count === 0 && entry.coldTheatreCount === 0;
}

/** Only a warm zero dims+disables. Cold/partial zero stays selectable. */
export function shouldDimFacet(entry: FacetCountEntry | undefined, totalTheatres: number): boolean {
  void totalTheatres;
  return isWarmZero(entry);
}

export function shouldDisableFacet(
  entry: FacetCountEntry | undefined,
  totalTheatres: number,
): boolean {
  return shouldDimFacet(entry, totalTheatres);
}

/**
 * Warm scope summary for CTA (UI18.8): "Search N showtimes across M theatres"
 * using warm counts only. Sums only the warm (cold===0) entries — the CTA's
 * advisory hint and the authoritative capacity block are complementary; the 200
 * ceiling is consumed, never re-derived here.
 */
export function getWarmScopeSummary(
  entries: Map<string, FacetCountEntry> | Record<string, FacetCountEntry> | FacetCountEntry[],
  totalTheatres?: number,
): { warmShowtimes: number; warmTheatres: number } {
  void totalTheatres;
  const list: FacetCountEntry[] = Array.isArray(entries)
    ? entries
    : entries instanceof Map
      ? Array.from(entries.values())
      : Object.values(entries);
  let warmShowtimes = 0;
  let warmTheatres = 0;
  for (const e of list) {
    if (e.coldTheatreCount === 0) {
      warmShowtimes += e.count;
      warmTheatres += 1;
    }
  }
  return { warmShowtimes, warmTheatres };
}

/** True when every candidate is not checked yet (all cold). */
export function isAllNotCheckedYet(
  entries: Map<string, FacetCountEntry> | Record<string, FacetCountEntry>,
  totalTheatres: number,
): boolean {
  const vals = entries instanceof Map ? Array.from(entries.values()) : Object.values(entries);
  if (vals.length === 0) return false;
  return vals.every((e) => e.coldTheatreCount === totalTheatres && totalTheatres > 0);
}

/**
 * Build a lookup Map from a FacetCountsResponse-style array (S43 wire shape)
 * `{counts: Array<{kind,candidate,count,coldTheatreCount}>}` to candidate -> entry.
 * The assignment's simplified `Record<id,{warm,unknown}>` maps to this: warm is
 * `count`, unknown is `coldTheatreCount > 0`.
 */
export function toFacetMap(
  counts: Array<{ candidate: string; count: number; coldTheatreCount: number }>,
): Map<string, FacetCountEntry> {
  const m = new Map<string, FacetCountEntry>();
  for (const c of counts) {
    m.set(c.candidate, { count: c.count, coldTheatreCount: c.coldTheatreCount });
  }
  return m;
}

/**
 * For hook consumers that receive the simplified `Record<id,{warm,unknown,coldTheatreCount}>`
 * shape described in the assignment. Converts to the canonical FacetCountEntry map.
 */
export function fromSimplifiedRecord(
  record: Record<string, { warm: number; unknown: boolean; coldTheatreCount?: number }>,
  totalTheatres: number,
): Map<string, FacetCountEntry> {
  const m = new Map<string, FacetCountEntry>();
  for (const [k, v] of Object.entries(record)) {
    const effectiveCold =
      v.coldTheatreCount !== undefined
        ? v.coldTheatreCount
        : v.unknown
          ? Math.min(1, totalTheatres)
          : 0;
    m.set(k, { count: v.warm, coldTheatreCount: effectiveCold });
  }
  return m;
}
