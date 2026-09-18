import {
  DEFAULT_SEARCH_LIMITS,
  WeekdaySchema,
  type PerformancePredicate,
  type SearchSpec,
  type SeatRegion,
  type TheatreRef,
  type TheatreSelector,
  type Weekday,
} from "@seatfirst/core";
import type { FormatPref, SeatPrefName } from "@/types/placement";
import {
  localDateString,
  MOVIE_BROWSE_SPAN_DAYS,
  canonicalizeCustomDates,
  customDatesToRuns,
} from "@/lib/dates";

export interface EffectiveDateRange {
  from: string;
  to: string;
}

/**
 * Concrete `[from, to]` window helper. UI24: `buildSearchSpec` no longer
 * consumes it — the committed `selectedDates` set always emits the normalized
 * v2 date scope — but the preview-adjacent callers and its unit tests keep it
 * as the shared inclusive-span fallback definition. Returns `null` for an
 * inverted range — callers fail closed exactly like `buildSearchSpec` does.
 */
export function resolveEffectiveDateRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date,
): EffectiveDateRange | null {
  const resolvedFrom = from ?? localDateString(now);
  const resolvedTo =
    to ??
    from ??
    localDateString(new Date(now.getTime() + (MOVIE_BROWSE_SPAN_DAYS - 1) * 86_400_000));
  if (resolvedFrom > resolvedTo) return null;
  return { from: resolvedFrom, to: resolvedTo };
}

/** Fixed §3 emission: with date membership carried by the date scope, a
 * selected time band constrains wall-clock time over every weekday, so the
 * TIME_WINDOW carries all seven `WeekdaySchema` values (`days.min(1)`).
 * ADR 0052 §3 — no weekday-selection concept remains. */
const ALL_WEEKDAYS: Weekday[] = [...WeekdaySchema.options];

/**
 * Theatre-local time-of-day bounds per ADR 0043 §1 (inclusive-minute amendment).
 * All four bands have decided boundaries; "All times" is the cleared state.
 */
export function timeOfDayBounds(timeOfDay: string): { startLocal: string; endLocal: string } {
  if (timeOfDay === "Morning") return { startLocal: "00:00", endLocal: "11:59" };
  if (timeOfDay === "Afternoon") return { startLocal: "12:00", endLocal: "16:59" };
  if (timeOfDay === "Evening") return { startLocal: "17:00", endLocal: "20:59" };
  if (timeOfDay === "Late") return { startLocal: "21:00", endLocal: "23:59" };
  return { startLocal: "00:00", endLocal: "23:59" };
}

const BAND_ORDER_LOCAL = ["Morning", "Afternoon", "Evening", "Late"] as const;

/**
 * Contiguous-range helper — UI18.10 Phase 2. Merges selected bands into one
 * TIME_WINDOW spanning low.startLocal … high.endLocal via timeOfDayBounds.
 * Non-adjacent pick (Morning+Late) fills middle → 00:00–23:59. Empty => Any time (no window).
 */

export function getMergedTimeBounds(
  selectedBands: string[] | null | undefined,
): { startLocal: string; endLocal: string } | null {
  if (!selectedBands || selectedBands.length === 0) return null;
  const filtered = selectedBands.filter((b) => (BAND_ORDER_LOCAL as readonly string[]).includes(b));
  if (filtered.length === 0) return null;
  const indices = filtered
    .map((b) => BAND_ORDER_LOCAL.indexOf(b as (typeof BAND_ORDER_LOCAL)[number]))
    .filter((i) => i >= 0);
  if (indices.length === 0) return null;
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const lowBand = BAND_ORDER_LOCAL[lo]!;
  const highBand = BAND_ORDER_LOCAL[hi]!;
  return {
    startLocal: timeOfDayBounds(lowBand).startLocal,
    endLocal: timeOfDayBounds(highBand).endLocal,
  };
}
export { canonicalizeCustomDates, customDatesToRuns, canonicalizeDateRuns } from "@/lib/dates";

/**
 * Single source of truth for "does this showtime match the form's date/time
 * window" — the exact predicate `buildSearchSpec` encodes as the v2 date scope
 * + TIME_WINDOW. UI24 (ADR 0052 §§2–3): date membership comes only from the
 * committed `selectedDates` set on the theatre-local date; band filtering
 * constrains wall-clock time but never drops a selected date.
 *
 * Day/time-of-day/date comparison happens in the THEATRE's local time (`timezone` comes
 * off `TheatreMoviesResponseSchema`, packages/core/src/result-contracts.ts:456-463),
 * matching TIME_WINDOW's local-time semantics (startLocal/endLocal are local wall-clock
 * strings) and DATE_RANGE's inclusive local-date bounds
 * (server-side equivalent `packages/core/src/local-time.ts:192-195`).
 * `selectedDates` null keeps the unbounded-date behavior for pure time checks;
 * an empty array matches nothing (fail closed).
 *
 * UI18.10 Phase 2: accepts either the legacy `timeOfDay` string or contiguous `selectedBands`
 * array. When `selectedBands` is supplied, it takes precedence.
 */
export function showtimeMatchesWindow(
  showDateTimeUtc: string,
  timezone: string,
  selectedDates: readonly string[] | null,
  timeOfDay: string | string[] = "All times",
  selectedBands?: string[] | null,
): boolean {
  if (selectedDates !== null) {
    const localDate = localDateInTimezone(showDateTimeUtc, timezone);
    if (!selectedDates.includes(localDate)) return false;
  }
  const effectiveBands =
    selectedBands !== undefined && selectedBands !== null
      ? selectedBands
      : Array.isArray(timeOfDay)
        ? timeOfDay
        : timeOfDay !== "All times" && timeOfDay !== "Any time"
          ? [timeOfDay]
          : [];
  const merged = getMergedTimeBounds(effectiveBands);
  if (!merged) return true;
  const hhmm = localTimeInTimezone(showDateTimeUtc, timezone);
  return hhmm >= merged.startLocal && hhmm <= merged.endLocal;
}

/** Theatre-local "HH:mm" derived via Intl (no date library dependency).
 * Normalizes the `hourCycle` "24" midnight quirk to "00" so lexicographic bounds compare.
 * UI24: the weekday is gone — date membership comes from the date scope, so only
 * wall-clock time is derived here. */
function localTimeInTimezone(showDateTimeUtc: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(showDateTimeUtc));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}`;
}

/** Theatre-local calendar date (`YYYY-MM-DD`) via Intl — the same derivation
 * `packages/core/src/local-time.ts`'s `toTheatreLocal` uses server-side, so a showtime's
 * DATE_RANGE membership never drifts between client preview and backend search. */
function localDateInTimezone(showDateTimeUtc: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(showDateTimeUtc));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type ConcreteFormatPref = Exclude<FormatPref, "any">;

/**
 * Map a contract `formatCode` (ADR 0008 canonical strings, lower-case:
 * `imax`/`imax70mm`/`imaxlaseratamc`/`dolbycinemaatamcprime`, else null/unknown
 * for Standard) onto `FORMAT_META.v`. Null or unknown codes read as Standard —
 * the same convention `hueForFormat` already applies.
 * S42.7 — fixed from the dead `"IMAX"`/`"DOLBY"` literals to the real vocabulary.
 */
export function formatCodeToPref(formatCode: string | null): ConcreteFormatPref {
  if (formatCode === "imax" || formatCode === "imax70mm" || formatCode === "imaxlaseratamc")
    return "imax";
  if (formatCode === "dolbycinemaatamcprime") return "dolby";
  return "standard";
}
export interface MovieWindowSummary {
  matchingCount: number;
  formatCounts: Record<ConcreteFormatPref, number>;
}

export function summarizeMovieWindow(
  group: { showtimes: { showDateTimeUtc: string; formatCode: string | null }[] } | null,
  timezone: string,
  selectedDates: readonly string[] | null,
  timeOfDay: string | string[] = "All times",
  formatPref?: FormatPref,
  selectedBands?: string[] | null,
): MovieWindowSummary | null {
  if (group === null) return null;
  const summary: MovieWindowSummary = {
    matchingCount: 0,
    formatCounts: { imax: 0, dolby: 0, standard: 0 },
  };
  // UI18.10: selectedBands takes precedence over timeOfDay
  const effectiveBands =
    selectedBands !== undefined && selectedBands !== null
      ? selectedBands
      : Array.isArray(timeOfDay)
        ? timeOfDay
        : undefined;
  const effectiveTod = effectiveBands !== undefined ? effectiveBands : timeOfDay;
  for (const st of group.showtimes) {
    const matches = showtimeMatchesWindow(
      st.showDateTimeUtc,
      timezone,
      selectedDates,
      effectiveTod,
      effectiveBands ?? null,
    );
    if (!matches) continue;
    const pref = formatCodeToPref(st.formatCode);
    summary.formatCounts[pref] += 1;
    if (formatPref !== undefined && formatPref !== "any" && pref !== formatPref) continue;
    summary.matchingCount += 1;
  }
  return summary;
}

export interface BuildSearchSpecWhereState {
  deviceCenter?: { lat: number; lng: number } | null;
  whereCenter?: { lat: number; lng: number } | null;
  place?: { theatres: TheatreRef[]; label: string; query?: string; radiusKm?: number } | null;
  wherePlace?: { query: string; label: string; radiusKm?: number; limit?: number } | null;
  selectedTheatres: Array<TheatreRef & { providerId?: string }>;
  radiusKm?: number;
  whereRadiusKm?: number;
  limit?: number;
  whereLimit?: number;
  isHandEdited?: boolean;
  hasHandEdit?: boolean;
  isHandEditedFlag?: boolean;
}

/**
 * BuildSearchSpecInput extended for UI18 Phase 1 Where field.
 *
 * - `where` / `whereState` carries the structured Where selection (device center vs
 *   resolved typed place vs hand-edited set). When present it takes precedence over the
 *   legacy single `theatre` field, which is kept for backward compatibility with existing
 *   callers and tests that haven't migrated yet.
 * - `providerId` may be supplied explicitly; otherwise it is derived from the first
 *   selected TheatreRef's namespaced id (e.g. "amc:theatre:123" → "amc"), falling back to
 *   the legacy theatre's providerId, then "amc".
 */
export interface BuildSearchSpecInput {
  theatre?: { id: string; providerId: string } | null;
  where?: BuildSearchSpecWhereState | null;
  whereState?: BuildSearchSpecWhereState | null;
  providerId?: string;
  movieId: string | null;
  /**
   * UI42 (ADR 0100 §Cold Mode): the confirmed movie/event title text. Read
   * from the store's `movie` field when `movieSelectionSource !== null`.
   * Carries the `titles` leg for custom (universal-search or free-typed)
   * selections; ignored for `library` picks, which stay ids-only.
   */
  movieTitle?: string | null;
  /**
   * UI42: which picker confirmed the title. `custom` emits `ids` + `titles`;
   * `library`/absent keeps the legacy ids-only predicate. Absent preserves
   * every existing caller exactly.
   */
  movieSelectionSource?: "library" | "custom" | null;
  /** UI24 (ADR 0052 §1): the single committed When date selection — canonical
   * sorted unique non-empty theatre-local YYYY-MM-DD strings. The only date
   * input; every submission emits the normalized v2 date scope from it. */
  selectedDates: readonly string[];
  timeOfDay: string;
  /** Contiguous band control — UI18.10 Phase 2. When present, takes precedence over timeOfDay. */
  selectedBands?: string[];
  seatPrefs: Record<SeatPrefName, boolean>;
  partySize: number;
  formatPref: FormatPref;
}

/**
 * UI42 (ADR 0100): deterministic synthetic movie id for a free-typed custom
 * event title, so a custom selection without a known provider id still emits
 * a schema-valid MOVIE predicate (`ids` is `min(1)` in `@seatfirst/core`).
 * The `titles` leg carries the real match key; the server canonicalizes `ids`
 * to a known AMC id at admission when a catalog mapping exists.
 */
export function customEventMovieId(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 80);
  return `custom:event:${slug || "untitled"}`;
}

function deriveProviderId(
  where: BuildSearchSpecWhereState | null | undefined,
  legacyTheatre: { id: string; providerId: string } | null | undefined,
  explicitProviderId: string | undefined,
): string | null {
  if (explicitProviderId) return explicitProviderId;
  const first = where?.selectedTheatres?.[0] as unknown as
    { id?: string; providerId?: string } | undefined;
  if (first?.providerId) return first.providerId;
  if (first?.id) {
    const id = first.id;
    const idx = id.indexOf(":");
    if (idx > 0) return id.slice(0, idx);
  }
  if (legacyTheatre?.providerId) return legacyTheatre.providerId;
  if (legacyTheatre?.id) {
    const idx = legacyTheatre.id.indexOf(":");
    if (idx > 0) return legacyTheatre.id.slice(0, idx);
  }
  return null;
}

function resolveEffectiveRadiusKm(where: BuildSearchSpecWhereState): number {
  const raw =
    where.radiusKm ??
    where.whereRadiusKm ??
    where.wherePlace?.radiusKm ??
    where.place?.radiusKm ??
    0;
  return raw;
}

function toTheatreRefs(refs: Array<TheatreRef & { providerId?: string }>): TheatreRef[] {
  return refs.map((r) => {
    const out: TheatreRef = { id: r.id };
    if ((r as TheatreRef).slugs !== undefined) {
      out.slugs = (r as TheatreRef).slugs;
    }
    return out;
  });
}

function resolveWhereState(input: BuildSearchSpecInput): BuildSearchSpecWhereState | null {
  const candidate = input.where ?? input.whereState ?? null;
  return candidate;
}

function shouldEmitArea(where: BuildSearchSpecWhereState): boolean {
  const deviceCenter = where.deviceCenter ?? where.whereCenter ?? null;
  const hasPlace = !!(where.place ?? where.wherePlace);
  const isHandEdited = !!(
    where.isHandEdited ??
    where.hasHandEdit ??
    (where as unknown as { isHandEditedFlag?: boolean }).isHandEditedFlag ??
    false
  );
  if (!deviceCenter) return false;
  if (hasPlace) return false;
  if (isHandEdited) return false;
  if (where.selectedTheatres.length === 0) return false;
  return true;
}

/**
 * Pure mapping from the search-form UI state to a `SearchSpec` (UI12.1). Fails closed —
 * returns null rather than a spec with a fabricated/missing id — when no real theatre or
 * resolved movie id is selected, matching UI12.2's requirement that free-typed movie text
 * with no matching live suggestion never reaches the backend.
 *
 * UI42 (ADR 0100 §Cold Mode): a confirmed custom title (`movieSelectionSource:
 * "custom"` with a non-blank `movieTitle`) emits `{ kind: "MOVIE", ids, titles:
 * [title] }` — the hit id when picked from universal search, else a synthetic
 * `custom:event:…` id — so the evaluator's title-fallback leg can match during
 * cold schedule resolution. Still fails closed when NEITHER a movieId NOR a
 * confirmed custom title is present (free-typed, unconfirmed text).
 *
 * UI18 Phase 1: When `where`/`whereState` is supplied, emits:
 * - `AREA {center, radiusKm, limit}` only for device location with no hand-edit,
 *   radiusKm clamped to DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm and limit set to
 *   DEFAULT_SEARCH_LIMITS.maxTheatres.
 * - `LIST {refs}` for typed-place (wherePlace/place present) or hand-edited selections.
 * Legacy single `theatre` path is preserved when `where` is absent.
 */
export function buildSearchSpec(input: BuildSearchSpecInput): SearchSpec | null {
  const { theatre, movieId, selectedDates, timeOfDay, seatPrefs, partySize, formatPref } = input;
  const whereState = resolveWhereState(input);
  const moviePredicate: PerformancePredicate | null = ((): PerformancePredicate | null => {
    if (input.movieSelectionSource === "custom") {
      const title = (input.movieTitle ?? "").trim();
      if (!title) return null;
      const ids =
        movieId !== null && movieId !== undefined ? [movieId] : [customEventMovieId(title)];
      return { kind: "MOVIE", ids, titles: [title] };
    }
    if (movieId === null) return null;
    return { kind: "MOVIE", ids: [movieId] };
  })();
  if (moviePredicate === null) return null;

  // Derive providerId and theatres selector
  let providerId: string | null;
  let theatres: TheatreSelector | null;

  if (whereState) {
    if (whereState.selectedTheatres.length === 0) return null;
    providerId = deriveProviderId(whereState, theatre ?? null, input.providerId);
    if (!providerId) return null;

    if (shouldEmitArea(whereState)) {
      const center = (whereState.deviceCenter ?? whereState.whereCenter)!;
      const rawRadiusKm = resolveEffectiveRadiusKm(whereState);
      const clampedRadiusKm = Math.min(rawRadiusKm, DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
      const limit = DEFAULT_SEARCH_LIMITS.maxTheatres;
      theatres = {
        kind: "AREA",
        center: { lat: center.lat, lng: center.lng },
        radiusKm: clampedRadiusKm,
        limit,
      };
    } else {
      theatres = { kind: "LIST", refs: toTheatreRefs(whereState.selectedTheatres) };
    }
  } else if (theatre !== null && theatre !== undefined) {
    providerId = deriveProviderId(null, theatre, input.providerId);
    if (!providerId) return null;
    theatres = { kind: "LIST", refs: [{ id: theatre.id }] };
  } else {
    return null;
  }

  if (!theatres || !providerId) return null;

  // UI24 (ADR 0052 §2): every mobile submission emits the normalized v2 date
  // scope from the committed `selectedDates` set, using the existing grammar:
  // one DATE_RANGE per contiguous run, or a direct-child OR of DATE_RANGE
  // leaves for separated runs — sorted/deduped/adjacent-merged to stay
  // byte-identical to the server's canonicalization. The v1 fallback is gone.
  const canonicalDates = canonicalizeCustomDates(selectedDates);
  if (canonicalDates.length === 0) return null;
  const runs = customDatesToRuns(canonicalDates);
  if (runs.length === 0) return null;
  const fromMin = runs[0]!.from;
  const toMax = runs[runs.length - 1]!.to;
  if (fromMin > toMax) return null;
  const spanDays =
    Math.round(
      (new Date(toMax + "T00:00:00").getTime() - new Date(fromMin + "T00:00:00").getTime()) /
        86_400_000,
    ) + 1;
  if (spanDays > MOVIE_BROWSE_SPAN_DAYS) return null;
  const specVersion = 2 as const;
  const datePredicates: PerformancePredicate[] =
    runs.length === 1
      ? [{ kind: "DATE_RANGE", from: runs[0]!.from, to: runs[0]!.to }]
      : [
          {
            kind: "OR",
            of: runs.map((r) => ({ kind: "DATE_RANGE" as const, from: r.from, to: r.to })),
          },
        ];

  const whereParts: PerformancePredicate[] = [moviePredicate, ...datePredicates];
  // UI18.10 contiguous-range: selectedBands takes precedence over legacy timeOfDay.
  // UI24 (ADR 0052 §3): Any time emits no TIME_WINDOW; selected bands emit one
  // TIME_WINDOW with the existing ADR 0043 bounds and all seven WeekdaySchema
  // values — date membership comes only from the date scope, never weekdays.
  const merged =
    input.selectedBands !== undefined
      ? getMergedTimeBounds(input.selectedBands)
      : timeOfDay !== "All times" && timeOfDay !== "Any time"
        ? getMergedTimeBounds([timeOfDay])
        : null;
  if (merged) {
    whereParts.push({
      kind: "TIME_WINDOW",
      days: [...ALL_WEEKDAYS],
      startLocal: merged.startLocal,
      endLocal: merged.endLocal,
    });
  }
  if (formatPref !== "any") {
    const code =
      formatPref === "imax"
        ? "imax"
        : formatPref === "dolby"
          ? "dolbycinemaatamcprime"
          : "STANDARD";
    // S42.6 — single-code FORMAT, with the documented IMAX-family gap: only the
    // canonical "imax" code is emitted for the "imax" chip; imax70mm/imaxlaseratamc
    // performances will not match until a future task widens this with an explicit
    // product decision (ADR 0035 Decision 3).
    whereParts.push({ kind: "FORMAT", code });
  }
  const where: PerformancePredicate = { kind: "AND", of: whereParts };

  const groupRegionParts: SeatRegion[] = [];
  if (seatPrefs.Centered) groupRegionParts.push({ kind: "PRESET", name: "CENTER_BLOCK" });
  if (seatPrefs.Aisle) groupRegionParts.push({ kind: "AISLE", want: "ADJACENT" });
  if (seatPrefs["Avoid front"]) groupRegionParts.push({ kind: "PRESET", name: "AVOID_FRONT" });
  const groupRegion: SeatRegion | undefined =
    groupRegionParts.length === 0
      ? undefined
      : groupRegionParts.length === 1
        ? groupRegionParts[0]
        : { kind: "AND", of: groupRegionParts };

  return {
    specVersion,
    providerId,
    theatres,
    where,
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    group: { kind: "RUN", count: partySize },
    ...(groupRegion !== undefined ? { groupRegion } : {}),
    groupStrict: false,
    rank: "SCORE",
  };
}
