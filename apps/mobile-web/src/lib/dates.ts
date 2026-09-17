/** Local calendar date (not UTC) as YYYY-MM-DD — matches the `z.iso.date()` wire format
 * `theatres.movies` expects (`packages/core/src/result-contracts.ts:410-411`). */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Movie browse window (UI2.5): today through the ADR 0016 max span — 30 days inclusive
// (`packages/core/src/result-contracts.ts:416-418`, reused verbatim, not a new number) —
// the broadest "now playing" listing available with no narrower product decision on file.
export const MOVIE_BROWSE_SPAN_DAYS = 30;

/**
 * Absolute-date chip formatting — ADR 0044 Design 7: chips read "Fri 28", never bare
 * weekday like "Friday". Makes Saturday edge visible ("This weekend" on Saturday
 * reads "Sat 29 – Sun 30"). Uses Intl weekday short + day-of-month.
 */
export function formatAbsoluteDate(date: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  const day = date.getDate();
  return `${weekday} ${day}`;
}
/**
 * Formats a wire `local` time ("HH:MM") as a rounded, minute-less 12h clock label
 * for display, e.g. "17:00" -> "5 PM", "16:59" -> "5 PM" (band-end bounds round up
 * to the next hour so ranges read as whole hours, never "4:59 PM"). Callers only ever
 * pass "HH:00" or "HH:59" (timeOfDayBounds/getMergedTimeBounds) — never use this for
 * the wire `localTimeSchema` value itself, only for rendered text.
 */
export function formatClockTime12h(local: string): string {
  const [hhStr, mmStr] = local.split(":");
  let hh = Number(hhStr);
  const mm = Number(mmStr ?? "0");
  if (mm >= 30) hh = (hh + 1) % 24;
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12} ${period}`;
}
const MS_PER_DAY = 86_400_000;

/**
 * Sort lexicographically and deduplicate a date list (YYYY-MM-DD). Mirrors S53's
 * `canonicalizeDateRuns` pre-step but for single-date sets.
 */
export function canonicalizeCustomDates(dates: readonly string[]): string[] {
  const sorted = [...dates].sort();
  const out: string[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last === d) continue;
    out.push(d);
  }
  return out;
}

/**
 * Canonicalize DATE_RANGE runs exactly like `packages/core/src/search-spec.ts:canonicalizeDateRuns`:
 * sorts by from then to, dedupes identical runs, merges overlapping (`r.from <= last.to`)
 * and adjacent (last.to +1 day == r.from) runs.
 */
export function canonicalizeDateRuns(
  runs: readonly { readonly from: string; readonly to: string }[],
): Array<{ from: string; to: string }> {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => {
    if (a.from < b.from) return -1;
    if (a.from > b.from) return 1;
    if (a.to < b.to) return -1;
    if (a.to > b.to) return 1;
    return 0;
  });
  const deduped: { from: string; to: string }[] = [];
  for (const r of sorted) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.from === r.from && last.to === r.to) continue;
    deduped.push({ from: r.from, to: r.to });
  }
  const merged: { from: string; to: string }[] = [];
  for (const r of deduped) {
    if (merged.length === 0) {
      merged.push(r);
      continue;
    }
    const last = merged[merged.length - 1]!;
    if (r.from <= last.to) {
      const newTo = r.to > last.to ? r.to : last.to;
      merged[merged.length - 1] = { from: last.from, to: newTo };
    } else {
      const lastToMs = Date.parse(`${last.to}T00:00:00Z`);
      const rFromMs = Date.parse(`${r.from}T00:00:00Z`);
      if (!Number.isNaN(lastToMs) && !Number.isNaN(rFromMs) && rFromMs === lastToMs + MS_PER_DAY) {
        const newTo = r.to > last.to ? r.to : last.to;
        merged[merged.length - 1] = { from: last.from, to: newTo };
      } else {
        merged.push(r);
      }
    }
  }
  return merged;
}

/**
 * Convert a set of YYYY-MM-DD strings to sorted, deduped, adjacent-merged runs.
 * Sparse selections become multiple runs; contiguous selections become one run.
 * Implementation reuses `canonicalizeDateRuns` via singleton runs so the merge
 * semantics stay byte-identical to the server.
 */
export function customDatesToRuns(dates: readonly string[]): Array<{ from: string; to: string }> {
  const normalized = canonicalizeCustomDates(dates);
  if (normalized.length === 0) return [];
  const singletonRuns = normalized.map((d) => ({ from: d, to: d }));
  return canonicalizeDateRuns(singletonRuns);
}

/**
 * Validate a custom date set by its earliest-to-latest inclusive span.
 * Reuses the existing `30`-day ceiling via `MOVIE_BROWSE_SPAN_DAYS`.
 */
export function validateCustomDates(dates: readonly string[]): {
  valid: boolean;
  spanDays: number;
  error?: string;
} {
  if (dates.length === 0) {
    return { valid: false, spanDays: 0, error: "Pick at least one date" };
  }
  const sorted = canonicalizeCustomDates(dates);
  const from = sorted[0]!;
  const to = sorted[sorted.length - 1]!;
  const fromD = new Date(from + "T00:00:00");
  const toD = new Date(to + "T00:00:00");
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
    return { valid: false, spanDays: 0, error: "Invalid date" };
  }
  if (toD.getTime() < fromD.getTime()) {
    return { valid: false, spanDays: 0, error: "End must not be before start" };
  }
  const spanDays = Math.round((toD.getTime() - fromD.getTime()) / MS_PER_DAY) + 1;
  if (spanDays > MOVIE_BROWSE_SPAN_DAYS) {
    return { valid: false, spanDays, error: "Custom span must be \u226430 days" };
  }
  return { valid: true, spanDays };
}
