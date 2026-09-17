import type { StateCreator } from "zustand";
import type { FormatPref, SeatPrefName } from "@/types/placement";
import type { SeatfirstStore } from "./seatfirstStore";
import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import {
  BAND_ORDER,
  resolveWhenPreset,
  validateCustomRange,
  expandIsos,
  matchesExistingPreset,
  toggleBandInSelection,
} from "@/lib/whenPresets";
import { canonicalizeCustomDates, localDateString } from "@/lib/dates";
/**
 * Form slice — owns the search form fields and their imperative setters.
 * See ADR 0025 Decision 4; split per UI1 Design so UI2 (theatre/movie
 * bootstrap) can land without touching the flow slice.
    selectPartySize: (n) => set({ partySize: n }),

    selectTod: (v) =>
      set(() => {
        // Editing time chip renames preset to Custom (ADR 0044 Design 7 Tier2)
        if (v === "All times" || v === "Any time") {
          return { timeOfDay: "All times", selectedBands: [], isCustom: true, whenPreset: "Custom" };
        }
        if ((BAND_ORDER as readonly string[]).includes(v)) {
          return { timeOfDay: v, selectedBands: [v], isCustom: true, whenPreset: "Custom" };
        }
        return { timeOfDay: v, selectedBands: [], isCustom: true, whenPreset: "Custom" };
      }),
 */

export type WhereMode = "none" | "device" | "place" | "theatres";
export type WhereFieldMode = "empty" | "place" | "theatres";

export interface WhereTheatreRef {
  id: string;
  providerId: string;
  /** Presentation metadata retained at selection time; never sent in SearchSpec. */
  name?: string;
  city?: string | null;
  distanceKm?: number | null;
}

function copyWhereTheatreRef(ref: WhereTheatreRef): WhereTheatreRef {
  return {
    id: ref.id,
    providerId: ref.providerId,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.city !== undefined ? { city: ref.city } : {}),
    ...(ref.distanceKm !== undefined ? { distanceKm: ref.distanceKm } : {}),
  };
}

export interface WherePlace {
  query: string;
  /** User-typed string plus radius, e.g. "Sunnyvale · 40 km around Sunnyvale" (never Mapbox name). */
  label: string;
  /**
   * Mapbox-resolved display name shown on the committed chip. Optional only
   * while pre-S52 hydrated state is being migrated; all new selections
   * written through `selectPlace` require it.
   */
  resolvedPlaceName?: string | null;
  radiusKm: number;
  limit: number;
}

export type ResolvedWherePlaceInput = Omit<WherePlace, "resolvedPlaceName"> & {
  resolvedPlaceName: string;
};

export interface DeviceCenter {
  lat: number;
  lng: number;
}

function clampRadiusKm(radiusKm: number): number {
  const max = DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm;
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return max;
  return Math.min(radiusKm, max);
}

function clampLimit(limit: number): number {
  const max = DEFAULT_SEARCH_LIMITS.maxTheatres;
  if (!Number.isFinite(limit) || limit <= 0) return max;
  return Math.min(Math.floor(limit), max);
}

export function hasWhereSelection(state: {
  deviceCenter: DeviceCenter | null;
  wherePlace: WherePlace | null;
  selectedTheatres: WhereTheatreRef[];
}): boolean {
  return (
    state.deviceCenter !== null || state.wherePlace !== null || state.selectedTheatres.length > 0
  );
}

export function getWhereMode(state: {
  deviceCenter: DeviceCenter | null;
  wherePlace: WherePlace | null;
  selectedTheatres: WhereTheatreRef[];
}): WhereMode {
  if (state.deviceCenter !== null) return "device";
  if (state.wherePlace !== null) return "place";
  if (state.selectedTheatres.length > 0) return "theatres";
  return "none";
}

export function getWhereFieldMode(state: {
  deviceCenter: DeviceCenter | null;
  wherePlace: WherePlace | null;
  selectedTheatres: WhereTheatreRef[];
}): WhereFieldMode {
  if (state.wherePlace !== null || state.deviceCenter !== null) return "place";
  if (state.selectedTheatres.length > 0) return "theatres";
  return "empty";
}

export interface SearchFormState {
  /** UI24 (ADR 0052 §1): the single committed When date selection — canonical
   * sorted unique non-empty theatre-local YYYY-MM-DD strings, written for
   * presets and Custom alike. Replaces the legacy weekday-boolean triple and
   * the legacy committed Custom span/set fields. */
  selectedDates: string[];
  timeOfDay: string;
  seatPrefs: Record<SeatPrefName, boolean>;
  formatPref: FormatPref;
  partySize: number;
  movie: string;
  movieFocused: boolean;
  selectedMovieId: string | null;
  theaterQuery: string;
  theaterFocused: boolean;
  movieClearedNotice: string | null;
  detailsExpanded: boolean;
  // Where selection (UI18 Phase 1, ADR 0042/0044/0045)
  whereQuery: string;
  whereFocused: boolean;
  deviceCenter: DeviceCenter | null;
  wherePlace: WherePlace | null;
  selectedTheatres: WhereTheatreRef[];
  /** UI31 (ADR 0064 §1/ UI31.8): set when a theatre is hand-removed while an
   * area (device/place) selection is active — marks the draft as hand-edited so
   * buildSearchSpec emits LIST instead of AREA on the next in-situ update. */
  theatreListHandPruned: boolean;
  whereRadiusKm: number;
  whereLimit: number;
  wherePlaceError: string | null;
  wherePlaceErrorKind: "PLACE_NOT_FOUND" | "PLACE_RESOLUTION_UNAVAILABLE" | null;
  // When selection (UI18 Phase 2, ADR 0044 Design 7; UI24 date-scope cutover)
  whenPreset: string;
  selectedBands: string[];
  isCustom: boolean;
  whenSheetOpen: boolean;
}
export interface SearchFormActions {
  removeSelectedDate: (iso: string) => void;
  selectPartySize: (n: number) => void;
  selectTod: (v: string) => void;
  toggleSeatPref: (k: SeatPrefName) => void;
  selectFormat: (v: FormatPref) => void;
  toggleDetails: () => void;
  onMovieChange: (text: string) => void;
  onMovieFocus: () => void;
  onMovieBlur: () => void;
  selectMovie: (title: string, movieId: string) => void;
  onTheaterChange: (text: string) => void;
  onTheaterFocus: () => void;
  onTheaterBlur: () => void;
  onMovieGateClick: () => void;
  // Where actions (UI18.1-5)
  setWhereQuery: (query: string) => void;
  setWhereFocused: (focused: boolean) => void;
  onWhereFocus: () => void;
  onWhereBlur: () => void;
  selectDeviceLocation: (center: DeviceCenter) => void;
  selectPlace: (place: ResolvedWherePlaceInput) => void;
  setSelectedTheatres: (theatres: WhereTheatreRef[]) => void;
  selectTheatre: (ref: WhereTheatreRef) => void;
  deselectTheatre: (id: string) => void;
  toggleTheatre: (ref: WhereTheatreRef) => void;
  removeLastChip: () => void;
  clearWhere: () => void;
  convertWherePlaceToTheatres: () => void;
  setWhereRadiusKm: (radiusKm: number) => void;
  setWhereLimit: (limit: number) => void;
  // When actions (UI18.9-10)
  selectWhenPreset: (preset: string) => void;
  toggleBand: (band: string) => void;
  setSelectedBands: (bands: string[]) => void;
  setCustomRange: (from: string, to: string) => boolean;
  /** UI22: commit a canonical sorted unique date set */
  setCustomDates: (dates: readonly string[]) => boolean;
  /** Custom dialog Apply: commits a date set and a band set atomically in one
   * patch, so partial-commit states (dates applied, bands not, or vice versa)
   * are never observable. Reverse-canonicalizes exactly like setCustomDates. */
  applyCustomSelection: (dates: readonly string[], bands: readonly string[]) => boolean;
  /** ADR 0044 amendment: sheet Cancel reconciles the eager Custom flag back
   * to the matching named preset when the committed dates/bands still
   * resolve to one; otherwise just closes the sheet. */
  cancelCustomEdit: () => void;
  setWhenSheetOpen: (open: boolean) => void;
  setIsCustom: (isCustom: boolean) => void;
  // Derived helpers exposed as actions for convenience (pure, but callable)
  hasWhereSelection: () => boolean;
  getWhereMode: () => WhereMode;
}

export type SearchFormSlice = SearchFormState & SearchFormActions;

// The approved prototype defaults to 10 mi; wire contracts remain kilometres.
const DEFAULT_WHERE_RADIUS_KM = 10 * 1.609344;
const DEFAULT_WHERE_LIMIT = DEFAULT_SEARCH_LIMITS.maxTheatres;

/**
 * UI24 (ADR 0052 §1): the initial This-weekend `selectedDates`/`whenPreset`,
 * populated through the same preset resolver and reverse-canonicalization
 * (ADR 0044 amendment 2026-09-05) as every preset write — never an
 * empty/null deferred sentinel, and never a preset label that
 * `getDedupedPresets` has collapsed out of the visible chip row (e.g. This
 * weekend on a Sunday resolves to just today, identical to Tonight — the
 * chip row shows Tonight, so the initial selection must say Tonight too).
 */
function initialWhenSelection(): { selectedDates: string[]; whenPreset: string } {
  const now = new Date();
  try {
    const resolved = resolveWhenPreset("This weekend", now);
    if (resolved) {
      const selectedDates = canonicalizeCustomDates(expandIsos(resolved.from, resolved.to));
      const matched = matchesExistingPreset(selectedDates, resolved.selectedBands, now);
      return { selectedDates, whenPreset: matched ?? "This weekend" };
    }
  } catch {
    // Fall through to the today fallback below.
  }
  return { selectedDates: [localDateString(now)], whenPreset: "Tonight" };
}
const initialWhen = initialWhenSelection();
/**
 * Reverse-canonicalization (ADR 0044 amendment 2026-09-05): given the
 * resulting dates/bands of a Custom-grid edit, return the canonical
 * named-preset patch when the result exactly equals a preset's live
 * resolution, else null (the caller falls back to the Custom patch).
 */
function matchedPresetPatch(
  selectedDates: readonly string[],
  selectedBands: readonly string[],
  now: Date,
): {
  whenPreset: string;
  selectedDates: string[];
  timeOfDay: string;
  selectedBands: string[];
  isCustom: boolean;
  whenSheetOpen: boolean;
} | null {
  const match = matchesExistingPreset(selectedDates, selectedBands, now);
  if (!match) return null;
  const resolved = resolveWhenPreset(match, now);
  if (!resolved) return null;
  return {
    whenPreset: match,
    selectedDates: canonicalizeCustomDates(expandIsos(resolved.from, resolved.to)),
    timeOfDay: resolved.timeOfDay,
    selectedBands: resolved.selectedBands,
    isCustom: false,
    whenSheetOpen: false,
  };
}

export const searchFormInitialState: SearchFormState = {
  selectedDates: initialWhen.selectedDates,
  timeOfDay: "Evening",
  seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
  formatPref: "any",
  partySize: 4,
  movie: "",
  movieFocused: false,
  selectedMovieId: null,
  theaterQuery: "",
  theaterFocused: false,
  movieClearedNotice: null,
  detailsExpanded: false,
  whereQuery: "",
  whereFocused: false,
  deviceCenter: null,
  wherePlace: null,
  selectedTheatres: [],
  theatreListHandPruned: false,
  whereRadiusKm: DEFAULT_WHERE_RADIUS_KM,
  whereLimit: DEFAULT_WHERE_LIMIT,
  wherePlaceError: null,
  wherePlaceErrorKind: null,
  whenPreset: initialWhen.whenPreset,
  selectedBands: ["Evening"],
  isCustom: false,
  whenSheetOpen: false,
};

export const createSearchFormSlice: StateCreator<SeatfirstStore, [], [], SearchFormSlice> = (
  set,
  get,
) => {
  let movieBlurTimeout: ReturnType<typeof setTimeout> | null = null;
  let theaterBlurTimeout: ReturnType<typeof setTimeout> | null = null;
  let whereBlurTimeout: ReturnType<typeof setTimeout> | null = null;

  return {
    ...searchFormInitialState,

    removeSelectedDate: (iso) =>
      set((s) => {
        // Sole-date press is a no-op: membership and preset/Custom label unchanged.
        // Multi-date press removes the exact date, then reverse-canonicalizes
        // (ADR 0044 amendment 2026-09-05): landing exactly on a named preset
        // auto-selects it instead of staying in Custom.
        if (s.selectedDates.length < 2) return s;
        if (!s.selectedDates.includes(iso)) return s;
        const selectedDates = s.selectedDates.filter((d) => d !== iso);
        return (
          matchedPresetPatch(selectedDates, s.selectedBands, new Date()) ?? {
            selectedDates,
            isCustom: true,
            whenPreset: "Custom",
          }
        );
      }),

    selectPartySize: (n) => set({ partySize: n }),

    selectTod: (v) =>
      set(() => {
        // Editing time chip renames preset to Custom (ADR 0044 Design 7 Tier2)
        if (v === "All times" || v === "Any time") {
          return {
            timeOfDay: "All times",
            selectedBands: [],
            isCustom: true,
            whenPreset: "Custom",
          };
        }
        if ((BAND_ORDER as readonly string[]).includes(v)) {
          return { timeOfDay: v, selectedBands: [v], isCustom: true, whenPreset: "Custom" };
        }
        return { timeOfDay: v, selectedBands: [], isCustom: true, whenPreset: "Custom" };
      }),
    toggleSeatPref: (k) => set((s) => ({ seatPrefs: { ...s.seatPrefs, [k]: !s.seatPrefs[k] } })),

    selectFormat: (v) => set({ formatPref: v }),

    toggleDetails: () => set((s) => ({ detailsExpanded: !s.detailsExpanded })),

    onMovieChange: (text) =>
      // Free-typing always invalidates any prior real suggestion pick (fail-closed;
      // UI12.2). Re-picking from the dropdown restores selectedMovieId via selectMovie.
      set({ movie: text, selectedMovieId: null }),

    onMovieFocus: () => set({ movieFocused: true, movieClearedNotice: null }),

    onMovieBlur: () => {
      // Deferred so a tap on a suggestion row (which also sets movieFocused false)
      // always wins the race against the input's own blur, regardless of exact
      // browser event ordering. Mirrors useSeatfirstDemo.ts:187-193.
      movieBlurTimeout = setTimeout(() => {
        set((s) => (s.movieFocused ? { movieFocused: false } : s));
      }, 150);
    },

    selectMovie: (title, movieId) => {
      if (movieBlurTimeout) clearTimeout(movieBlurTimeout);
      set({
        movie: title,
        selectedMovieId: movieId,
        movieFocused: false,
        movieClearedNotice: null,
      });
    },

    onTheaterChange: (text) => set({ theaterQuery: text }),

    onTheaterFocus: () => {
      if (theaterBlurTimeout) clearTimeout(theaterBlurTimeout);
      set({ theaterFocused: true });
    },

    onTheaterBlur: () => {
      theaterBlurTimeout = setTimeout(() => {
        set((s) => (s.theaterFocused ? { theaterFocused: false } : s));
      }, 150);
    },

    onMovieGateClick: () => {
      // No longer auto-confirms a theatre. With no default selection, the
      // gated movie placeholder should direct the user to the theatre picker.
      if (theaterBlurTimeout) clearTimeout(theaterBlurTimeout);
      set({ theaterFocused: true });
    },

    // Where actions
    setWhereQuery: (query) => set({ whereQuery: query }),

    setWhereFocused: (focused) => set({ whereFocused: focused }),

    onWhereFocus: () => {
      if (whereBlurTimeout) clearTimeout(whereBlurTimeout);
      set({ whereFocused: true });
    },

    onWhereBlur: () => {
      whereBlurTimeout = setTimeout(() => {
        set((s) => (s.whereFocused ? { whereFocused: false } : s));
      }, 150);
    },

    selectDeviceLocation: (center) =>
      set({
        deviceCenter: { lat: center.lat, lng: center.lng },
        wherePlace: null,
        // Starting a new area selection cannot retain an unrelated hand-picked LIST.
        // The caller may atomically replace this with resolved refs via setSelectedTheatres.
        selectedTheatres: [],
        theatreListHandPruned: false,
      }),
    selectPlace: (place) =>
      set({
        wherePlace: {
          query: place.query,
          label: place.label,
          resolvedPlaceName: place.resolvedPlaceName,
          radiusKm: clampRadiusKm(place.radiusKm),
          limit: clampLimit(place.limit),
        },
        deviceCenter: null,
        whereRadiusKm: clampRadiusKm(place.radiusKm),
        whereLimit: clampLimit(place.limit),
        // Starting a new area selection cannot retain an unrelated hand-picked LIST.
        // The caller may atomically replace this with resolved refs via setSelectedTheatres.
        selectedTheatres: [],
        theatreListHandPruned: false,
      }),
    setSelectedTheatres: (theatres) =>
      set(() => ({
        selectedTheatres: theatres.map(copyWhereTheatreRef),
        theatreListHandPruned: false,
      })),

    selectTheatre: (ref) =>
      set((s) => {
        if (s.deviceCenter !== null || s.wherePlace !== null) return s;
        if (s.selectedTheatres.some((t) => t.id === ref.id)) return s;
        return {
          selectedTheatres: [...s.selectedTheatres, copyWhereTheatreRef(ref)],
        };
      }),
    deselectTheatre: (id) =>
      set((s) => {
        if (!s.selectedTheatres.some((t) => t.id === id)) return s;
        const selectedTheatres = s.selectedTheatres.filter((t) => t.id !== id);
        // UI31.8: hand-removal while an area selection is active marks the draft
        // hand-edited (buildSearchSpec then emits LIST instead of AREA).
        if (s.deviceCenter !== null || s.wherePlace !== null) {
          return { selectedTheatres, theatreListHandPruned: true };
        }
        return { selectedTheatres };
      }),

    toggleTheatre: (ref) =>
      set((s) => {
        const exists = s.selectedTheatres.some((t) => t.id === ref.id);
        if (exists) {
          // UI31.8: removal proceeds even while an area selection is active, and
          // marks the draft hand-edited in that case (buildSearchSpec: LIST).
          const selectedTheatres = s.selectedTheatres.filter((t) => t.id !== ref.id);
          if (s.deviceCenter !== null || s.wherePlace !== null) {
            return { selectedTheatres, theatreListHandPruned: true };
          }
          return { selectedTheatres };
        }
        if (s.deviceCenter !== null || s.wherePlace !== null) return s;
        return { selectedTheatres: [...s.selectedTheatres, copyWhereTheatreRef(ref)] };
      }),

    removeLastChip: () =>
      set((s) => {
        if (s.wherePlace !== null) {
          return { wherePlace: null, selectedTheatres: [], theatreListHandPruned: false };
        }
        if (s.deviceCenter !== null) {
          return { deviceCenter: null, selectedTheatres: [], theatreListHandPruned: false };
        }
        if (s.selectedTheatres.length > 0) {
          return { selectedTheatres: s.selectedTheatres.slice(0, -1) };
        }
        return s;
      }),

    clearWhere: () =>
      set({
        whereQuery: "",
        whereFocused: false,
        deviceCenter: null,
        wherePlace: null,
        selectedTheatres: [],
        theatreListHandPruned: false,
        whereRadiusKm: DEFAULT_WHERE_RADIUS_KM,
        whereLimit: DEFAULT_WHERE_LIMIT,
        wherePlaceError: null,
        wherePlaceErrorKind: null,
      }),

    convertWherePlaceToTheatres: () =>
      set((s) => {
        if (s.deviceCenter === null && s.wherePlace === null) return s;
        return { deviceCenter: null, wherePlace: null, theatreListHandPruned: false };
      }),

    setWhereRadiusKm: (radiusKm) =>
      set((s) => {
        const clamped = clampRadiusKm(radiusKm);
        if (s.wherePlace !== null) {
          return {
            whereRadiusKm: clamped,
            wherePlace: { ...s.wherePlace, radiusKm: clamped },
          };
        }
        return { whereRadiusKm: clamped };
      }),

    setWhereLimit: (limit) =>
      set((s) => {
        const clamped = clampLimit(limit);
        if (s.wherePlace !== null) {
          return {
            whereLimit: clamped,
            wherePlace: { ...s.wherePlace, limit: clamped },
          };
        }
        return { whereLimit: clamped };
      }),

    // When actions (UI18.9-10)
    selectWhenPreset: (preset) =>
      set(() => {
        const now = new Date();
        const resolved = resolveWhenPreset(preset, now);
        if (!resolved) {
          if (preset === "Custom") {
            return { whenPreset: "Custom", isCustom: true, whenSheetOpen: true };
          }
          return {};
        }
        if (preset === "Custom") {
          return { whenPreset: "Custom", isCustom: true, whenSheetOpen: true };
        }
        const dates = canonicalizeCustomDates(expandIsos(resolved.from, resolved.to));
        return {
          whenPreset: preset,
          selectedDates: dates,
          timeOfDay: resolved.timeOfDay,
          selectedBands: resolved.selectedBands,
          isCustom: false,
          whenSheetOpen: false,
        };
      }),

    toggleBand: (band) =>
      set((s) => {
        const now = new Date();
        // Every band edit reverse-canonicalizes (ADR 0044 amendment
        // 2026-09-05): landing exactly on a named preset auto-selects it.
        const toCustom = (selectedBands: string[], timeOfDay: string) =>
          matchedPresetPatch(s.selectedDates, selectedBands, now) ?? {
            selectedBands,
            timeOfDay,
            isCustom: true,
            whenPreset: "Custom",
          };
        if (band === "Any time" || band === "All times") {
          return toCustom([], "All times");
        }
        if (!(BAND_ORDER as readonly string[]).includes(band)) return s;
        const { bands: newBands, timeOfDay } = toggleBandInSelection(s.selectedBands, band);
        return toCustom(newBands, timeOfDay);
      }),

    setSelectedBands: (bands) =>
      set((s) => {
        const now = new Date();
        // Same reverse-canonicalization as toggleBand (ADR 0044 amendment 2026-09-05).
        const toCustom = (selectedBands: string[], timeOfDay: string) =>
          matchedPresetPatch(s.selectedDates, selectedBands, now) ?? {
            selectedBands,
            timeOfDay,
            isCustom: true,
            whenPreset: "Custom",
          };
        if (bands.length === 0) {
          return toCustom([], "All times");
        }
        const filtered = bands.filter((b) => (BAND_ORDER as readonly string[]).includes(b));
        const order = BAND_ORDER as readonly string[];
        const indices = filtered.map((b) => order.indexOf(b)).filter((i) => i >= 0);
        if (indices.length === 0) {
          return toCustom([], "All times");
        }
        const lo = Math.min(...indices);
        const hi = Math.max(...indices);
        const contiguous = (order as string[]).slice(lo, hi + 1);
        return toCustom(contiguous, contiguous[0] ?? "All times");
      }),

    setCustomRange: (from, to) => {
      const check = validateCustomRange(from, to);
      if (!check.valid) return false;
      const dates = canonicalizeCustomDates(expandIsos(from, to));
      const s = get();
      set(
        matchedPresetPatch(dates, s.selectedBands, new Date()) ?? {
          selectedDates: dates,
          isCustom: true,
          whenPreset: "Custom",
        },
      );
      return true;
    },

    setCustomDates: (dates) => {
      const canonical = canonicalizeCustomDates(dates);
      if (canonical.length === 0) return false;
      const from = canonical[0]!;
      const to = canonical[canonical.length - 1]!;
      const check = validateCustomRange(from, to);
      if (!check.valid) return false;
      const s = get();
      set(
        matchedPresetPatch(canonical, s.selectedBands, new Date()) ?? {
          selectedDates: canonical,
          isCustom: true,
          whenPreset: "Custom",
        },
      );
      return true;
    },
    applyCustomSelection: (dates, bands) => {
      const canonical = canonicalizeCustomDates(dates);
      if (canonical.length === 0) return false;
      const from = canonical[0]!;
      const to = canonical[canonical.length - 1]!;
      const check = validateCustomRange(from, to);
      if (!check.valid) return false;
      const normalizedBands = bands.filter((b) => (BAND_ORDER as readonly string[]).includes(b));
      const timeOfDay = normalizedBands[0] ?? "All times";
      set(
        matchedPresetPatch(canonical, normalizedBands, new Date()) ?? {
          selectedDates: canonical,
          selectedBands: normalizedBands,
          timeOfDay,
          isCustom: true,
          whenPreset: "Custom",
        },
      );
      return true;
    },
    cancelCustomEdit: () => {
      const s = get();
      set(
        matchedPresetPatch(s.selectedDates, s.selectedBands, new Date()) ?? {
          whenSheetOpen: false,
        },
      );
    },

    setWhenSheetOpen: (open) => set({ whenSheetOpen: open }),

    setIsCustom: (isCustom) => set({ isCustom }),

    hasWhereSelection: () => {
      const s = get();
      return hasWhereSelection(s);
    },

    getWhereMode: () => {
      const s = get();
      return getWhereMode(s);
    },
  };
};
