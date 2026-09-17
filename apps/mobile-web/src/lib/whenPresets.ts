import {
  localDateString,
  formatAbsoluteDate,
  formatClockTime12h,
  MOVIE_BROWSE_SPAN_DAYS,
  canonicalizeCustomDates,
  canonicalizeDateRuns,
  customDatesToRuns,
} from "./dates";
import { timeOfDayBounds } from "./buildSearchSpec";
import type { DateScope } from "@seatfirst/core";
/**
 * When presets — ADR 0044 Design 7 Tier1.
 * One-tap natural language, resolved against today (new Date()).
 *
 * Tier2 read-out uses absolute dates (formatAbsoluteDate) and real hours
 * via timeOfDayBounds. Tier3 Custom sheet handled via store state.
 */

export const BAND_ORDER = ["Morning", "Afternoon", "Evening", "Late"] as const;
export type BandName = (typeof BAND_ORDER)[number];

export interface WhenPresetResolution {
  /** Single band label for backward compat (primary band or "All times"). */
  timeOfDay: string;
  /** Contiguous bands — empty = Any time (no TIME_WINDOW). Non-empty = merged window. */
  selectedBands: string[];
  from: string; // YYYY-MM-DD local
  to: string; // YYYY-MM-DD local
  isCustom?: boolean;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function fromIso(s: string): Date {
  const parts = s.split("-").map(Number);
  return new Date(parts[0]!, parts[1]! - 1, parts[2]);
}

export function expandIsos(from: string, to: string): string[] {
  const a: string[] = [];
  let cur = fromIso(from);
  const end = fromIso(to);
  while (cur.getTime() <= end.getTime()) {
    a.push(localDateString(cur));
    cur = addDays(cur, 1);
  }
  return a;
}

/**
 * Resolve a single preset against now. Returns null for unknown preset.
 * Never returns bare weekday — callers must use formatAbsoluteDate for display.
 */
export function resolveWhenPreset(preset: string, now: Date): WhenPresetResolution | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = localDateString(today);
  const normalized = preset.trim();

  // Tonight — today Evening
  if (normalized === "Tonight") {
    return {
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      from: todayIso,
      to: todayIso,
    };
  }

  // Tomorrow evening — tomorrow Evening
  if (normalized === "Tomorrow evening") {
    const tomorrow = addDays(today, 1);
    const iso = localDateString(tomorrow);
    return {
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      from: iso,
      to: iso,
    };
  }

  // This weekend — Fri–Sun block filtered to >= today. Makes Saturday edge visible:
  // on Saturday (2026-08-29) => Sat 29 – Sun 30, Friday 28 omitted.
  if (normalized === "This weekend") {
    const dow = today.getDay();
    let friday: Date;
    if (dow === 5) {
      friday = new Date(today);
    } else if (dow === 6) {
      // Saturday => Friday was yesterday
      friday = addDays(today, -1);
    } else if (dow === 0) {
      // Sunday => Friday was two days ago
      friday = addDays(today, -2);
    } else {
      // Mon–Thu => upcoming Friday
      const diff = 5 - dow;
      friday = addDays(today, diff);
    }
    const saturday = addDays(friday, 1);
    const sunday = addDays(friday, 2);
    const candidates = [friday, saturday, sunday];
    const filtered = candidates.filter((d) => d.getTime() >= today.getTime());
    if (filtered.length === 0) {
      // Fallback — should not happen, but use today
      return {
        timeOfDay: "Evening",
        selectedBands: ["Evening"],
        from: todayIso,
        to: todayIso,
      };
    }
    const isos = filtered.map(localDateString);
    const from = isos[0]!;
    const to = isos[isos.length - 1]!;
    return {
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      from,
      to,
    };
  }

  // Custom — handled via the store's committed selectedDates; for dedupe comparisons, treat as unique
  if (normalized === "Custom") {
    const to = localDateString(addDays(today, 2));
    return {
      timeOfDay: "All times",
      selectedBands: [],
      from: todayIso,
      to,
      isCustom: true,
    };
  }

  return null;
}
/**
 * Reverse-canonicalization (ADR 0044 amendment 2026-09-05): check an edited
 * date/band selection against the three named presets' live resolution.
 * Returns the matching preset name ("Tonight" | "Tomorrow evening" |
 * "This weekend", checked in that order) on an exact match — same date set
 * (order-insensitive; `selectedDates` is canonically sorted) and same band
 * array — or null when the selection is genuinely custom.
 */
export function matchesExistingPreset(
  selectedDates: readonly string[],
  selectedBands: readonly string[],
  now: Date,
): string | null {
  const sortedDates = [...selectedDates].sort();
  const presets = ["Tonight", "Tomorrow evening", "This weekend"] as const;
  for (const preset of presets) {
    const resolved = resolveWhenPreset(preset, now);
    if (!resolved) continue;
    const presetDates = expandIsos(resolved.from, resolved.to);
    if (presetDates.length !== sortedDates.length) continue;
    if (!presetDates.every((d, i) => d === sortedDates[i])) continue;
    const bands = resolved.selectedBands;
    if (bands.length !== selectedBands.length) continue;
    if (!bands.every((b, i) => b === selectedBands[i])) continue;
    return preset;
  }
  return null;
}
/**
 * Pure contiguous-range band toggle — ADR 0044 Custom dialog relocation.
 * Extracted verbatim from `searchFormSlice.toggleBand`'s selection math so the
 * store action and the Custom dialog draft share one implementation:
 * "Any time"/"All times" clears to []; tapping the sole active band clears to
 * []; tapping a band already inside the active contiguous span narrows to just
 * that band; tapping a band outside the span extends the span to include it
 * (BAND_ORDER order). Unknown bands leave the selection unchanged.
 */
export function toggleBandInSelection(
  current: readonly string[],
  band: string,
): { bands: string[]; timeOfDay: string } {
  if (band === "Any time" || band === "All times") {
    return { bands: [], timeOfDay: "All times" };
  }
  const order = BAND_ORDER as readonly string[];
  if (!order.includes(band)) {
    return { bands: [...current], timeOfDay: current[0] ?? "All times" };
  }
  if (current.length === 0) {
    return { bands: [band], timeOfDay: band };
  }
  const indices = current.map((b) => order.indexOf(b)).filter((i) => i >= 0);
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const idx = order.indexOf(band);
  const isActive = idx >= lo && idx <= hi;
  if (current.length === 1 && current[0] === band) {
    return { bands: [], timeOfDay: "All times" };
  }
  if (isActive) {
    return { bands: [band], timeOfDay: band };
  }
  const newLo = Math.min(lo, idx);
  const newHi = Math.max(hi, idx);
  const newBands = (order as string[]).slice(newLo, newHi + 1);
  return { bands: newBands, timeOfDay: newBands[0] ?? "All times" };
}
/**
 * Resolve the "Dates" chip row's ISO dates — UI24: the committed `selectedDates`
 * set verbatim (canonical sorted unique); a Tier 1 preset (or an empty commit,
 * which the store guard prevents) expands its resolved [from, to] span.
 */
export function resolveQuickDayIsos(opts: {
  selectedDates?: readonly string[] | null;
  whenPreset: string;
  now: Date;
}): string[] {
  const { selectedDates, whenPreset, now } = opts;
  if (selectedDates && selectedDates.length > 0) {
    return canonicalizeCustomDates(selectedDates);
  }
  const resolved = resolveWhenPreset(whenPreset, now);
  if (!resolved) return [localDateString(now)];
  return expandIsos(resolved.from, resolved.to);
}

/**
 * Resolve the DateScope scoping facet requests (UI24, ADR 0052 §6): the
 * committed `selectedDates` set via customDatesToRuns (one DATE_RANGE per run,
 * mirroring buildSearchSpec), or the active preset's resolved from/to.
 * Returns null when nothing resolves.
 */
export function resolveActiveDateScope(opts: {
  selectedDates?: readonly string[] | null;
  whenPreset: string;
  now: Date;
}): DateScope | null {
  const { selectedDates, whenPreset, now } = opts;
  if (selectedDates && selectedDates.length > 0) {
    const runs = customDatesToRuns(canonicalizeCustomDates(selectedDates));
    if (runs.length === 1) {
      return { kind: "DATE_RANGE", from: runs[0]!.from, to: runs[0]!.to };
    }
    if (runs.length > 1) {
      return {
        kind: "OR",
        of: runs.map((r) => ({ kind: "DATE_RANGE" as const, from: r.from, to: r.to })),
      };
    }
    return null;
  }
  const resolved = resolveWhenPreset(whenPreset, now);
  if (!resolved) return null;
  return { kind: "DATE_RANGE", from: resolved.from, to: resolved.to };
}

/**
 * Dedupe Tier1 presets against today (retained for future presets; the
 * current four — Tonight, Tomorrow evening, This weekend, Custom — never
 * collide, since Tonight/Tomorrow evening are always exactly one day apart
 * and This weekend is always a multi-day range).
 * Custom is always kept (never deduped against non-custom).
 */
export function getDedupedPresets(now: Date): string[] {
  const all = ["Tonight", "Tomorrow evening", "This weekend", "Custom"];
  const seen = new Map<string, true>();
  const result: string[] = [];
  for (const label of all) {
    if (label === "Custom") {
      result.push(label);
      continue;
    }
    const r = resolveWhenPreset(label, now);
    if (!r) continue;
    // Key is DATE_RANGE + TIME_WINDOW (from/to + merged time bounds).
    // UI24 (ADR 0052 §5): rekeyed on the resolved date set — the weekday-keyed
    // dedupe is gone with the days triple. Custom excluded above.
    const bandsKey = r.selectedBands.slice().sort().join(",");
    const key = `${r.from}|${r.to}|${bandsKey}|${r.timeOfDay}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(label);
    }
  }
  return result;
}

/**
 * Contiguous-range band control — ADR 0043 four bands via S50 timeOfDayBounds.
 * Picking a second band extends through middle and emits ONE TIME_WINDOW spanning
 * low.startLocal … high.endLocal via timeOfDayBounds. Non-adjacent pick fills middle.
 * Any time (empty array) clears (no TIME_WINDOW).
 */
export function getMergedTimeBounds(
  selectedBands: string[],
): { startLocal: string; endLocal: string } | null {
  if (selectedBands.length === 0) return null;
  // Normalize: filter to known bands, deduplicate
  const normalized = Array.from(
    new Set(selectedBands.filter((b) => (BAND_ORDER as readonly string[]).includes(b))),
  );
  if (normalized.length === 0) return null;
  const indices = normalized.map((b) => BAND_ORDER.indexOf(b as BandName)).filter((i) => i >= 0);
  if (indices.length === 0) return null;
  const low = Math.min(...indices);
  const high = Math.max(...indices);
  const lowBand = BAND_ORDER[low]!;
  const highBand = BAND_ORDER[high]!;
  const lowBounds = timeOfDayBounds(lowBand);
  const highBounds = timeOfDayBounds(highBand);
  return { startLocal: lowBounds.startLocal, endLocal: highBounds.endLocal };
}

// Re-export canonical helpers for consumers
export { canonicalizeCustomDates, customDatesToRuns, canonicalizeDateRuns } from "./dates";

function formatRun(run: { from: string; to: string }): string {
  const fromDate = fromIso(run.from);
  const toDate = fromIso(run.to);
  const fromLabel = formatAbsoluteDate(fromDate);
  const toLabel = formatAbsoluteDate(toDate);
  return run.from === run.to ? fromLabel : `${fromLabel} – ${toLabel}`;
}

/**
 * Tier2 read-out: always visible line showing resolved real dates (absolute dates)
 * and real hours (timeOfDayBounds). Example: "Sat 29 – Sun 30 · 5:00 PM–8:59 PM".
 * Uses formatAbsoluteDate ("Fri 28", never "Friday").
 *
 * UI22: supports single run (from/to), multiple runs (runs), or date sets (dates).
 * - One run renders as "Fri 28" or "Fri 28 – Sun 30"
 * - Multiple runs render in ascending order comma-separated: "Fri 4, Tue 8" or "Fri 4 – Sat 5, Tue 8"
 */
export function formatWhenReadout(
  opts:
    | { from: string; to: string; selectedBands: string[] }
    | { runs: readonly { from: string; to: string }[]; selectedBands: string[] }
    | { dates: readonly string[]; selectedBands: string[] },
): string {
  let runs: Array<{ from: string; to: string }>;
  if ("dates" in opts) {
    runs = customDatesToRuns(opts.dates);
  } else if ("runs" in opts) {
    runs = canonicalizeDateRuns(opts.runs);
  } else {
    if (opts.from === opts.to) runs = [{ from: opts.from, to: opts.to }];
    else runs = [{ from: opts.from, to: opts.to }];
    // Ensure canonical sort for single run edge (already single)
  }
  // Fallback: empty dates -> empty runs, render nothing? Handle as single today placeholder upstream.
  // For display, if runs empty (should not happen), fallback to empty datePart.
  let datePart: string;
  if (runs.length === 0) {
    datePart = "";
  } else if (runs.length === 1) {
    datePart = formatRun(runs[0]!);
  } else {
    datePart = runs.map(formatRun).join(", ");
  }

  let timePart: string;
  if (opts.selectedBands.length === 0) {
    timePart = "Any time";
  } else {
    const merged = getMergedTimeBounds(opts.selectedBands);
    if (!merged) timePart = "Any time";
    else
      timePart = `${formatClockTime12h(merged.startLocal)}–${formatClockTime12h(merged.endLocal)}`;
  }

  if (datePart === "") return timePart;
  return `${datePart} · ${timePart}`;
}

/**
 * Tier3 validation: arbitrary date spans ≤30 days (ADR 0016 Decision 4).
 * Returns { valid, spanDays, error }. Span is inclusive day count between earliest and latest.
 * Uses MOVIE_BROWSE_SPAN_DAYS (30) without re-typing the literal.
 */
export function validateCustomRange(
  from: string,
  to: string,
): { valid: boolean; spanDays: number; error?: string } {
  const fromD = fromIso(from);
  const toD = fromIso(to);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
    return { valid: false, spanDays: 0, error: "Invalid date" };
  }
  if (toD.getTime() < fromD.getTime()) {
    return { valid: false, spanDays: 0, error: "End must not be before start" };
  }
  const spanDays = Math.round((toD.getTime() - fromD.getTime()) / 86_400_000) + 1;
  if (spanDays > MOVIE_BROWSE_SPAN_DAYS) {
    return { valid: false, spanDays, error: "Custom span must be \u226430 days" };
  }
  return { valid: true, spanDays };
}

/**
 * Validate a custom date set by earliest-to-latest span (UI22.5).
 * Reuses validateCustomRange semantics over the sorted set's min/max.
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
  return validateCustomRange(from, to);
}

/**
 * Warm-horizon placeholder label (how much of theatre set is cached for that day).
 * Task-spec detail, not ADR. Returns e.g. "warm 80%".
 * If no theatre data, returns "—".
 */
export function warmHorizonLabel(warmCount: number, totalCount: number): string {
  if (totalCount === 0) return "—";
  const pct = Math.round((warmCount / totalCount) * 100);
  return `warm ${pct}%`;
}

/**
 * Resolve the Tier2 readout string from store state (S46 / UI14.8).
 * UI24 (ADR 0052 §5): the committed `selectedDates` set renders as its
 * resolved runs ("Fri 28", "Sat 29 – Sun 30", sparse-run list) via the single
 * shared formatWhenReadout path — the weekday summaries are gone.
 */
export function resolveWhenReadout(opts: {
  selectedDates: readonly string[];
  selectedBands: string[];
}): string {
  return formatWhenReadout({ dates: opts.selectedDates, selectedBands: opts.selectedBands });
}

export const WHEN_PRESET_LABELS = [
  "Tonight",
  "Tomorrow evening",
  "This weekend",
  "Custom",
] as const;
