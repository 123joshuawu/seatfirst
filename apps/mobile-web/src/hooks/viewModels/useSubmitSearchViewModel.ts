import { useCallback, useEffect, useMemo, useRef } from "react";
import { useWindowDimensions } from "react-native";
import type { FormatPref, SeatPrefName } from "@/types/placement";
import type { ChipItem } from "@/types/ui";
import type { SearchSpec, TheatreAmenity } from "@seatfirst/core";
import { localDateString, MOVIE_BROWSE_SPAN_DAYS } from "@/lib/dates";
import {
  buildSearchSpec,
  showtimeMatchesWindow,
  summarizeMovieWindow,
} from "@/lib/buildSearchSpec";
import { isRecord, readTrpcErrorCode } from "@/lib/errorEnvelope";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { clearTheatreMovieCache, useTheatreMovieSet } from "../useTheatreMovieSet";
import { useFacetCounts } from "../useFacetCounts";
import { useMovieSearch } from "../useMovieSearch";
import { queryClient, trpcClient } from "@/lib/trpc";
import { CAPACITY_CEILING_EXCEEDED, DEFAULT_SEARCH_LIMITS, specHash } from "@seatfirst/core";
import {
  admissionRejectedLabel as formatAdmissionRejectedLabel,
  distanceLabel,
  runtimeLabel,
  tmdbPosterUrl,
} from "@/lib/presentation";
import { FORMAT_META } from "../demoData";
import { isWarmZero } from "@/lib/facetCounts";
import { resolveActiveDateScope, resolveQuickDayIsos, resolveWhenReadout } from "@/lib/whenPresets";

export interface MovieSuggestion {
  label: string;
  onPress: () => void;
  posterUrl?: string | null;
  releaseYear?: number | null;
  badge?: string | null; // "AMC Event" | "May not be playing here" | null
  seenAtAmc?: boolean;
}

const SEAT_PREF_NAMES: SeatPrefName[] = ["Centered", "Aisle", "Avoid front"];
const PARTY_SIZES = [1, 2, 3, 4, 5, 6];
/** Natural-language clause for each seat preference, used by the State-2 target-status
 * sentence — kept separate from `seatPrefsSummaryLabel`'s compact "Aisle · Avoid front"
 * chip-style summary, which reads fine as a label but not inline in a sentence. */
const SEAT_PREF_STATUS_PHRASES: Record<SeatPrefName, string> = {
  Centered: "centered",
  Aisle: "aisle",
  "Avoid front": "away from the front",
};

/** Oxford-comma join for the target-status sentence's seat-preference clause. */
function joinWithAnd(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
const MOBILE_BREAKPOINT = 680;

export type SubmitSearchStart = (spec: SearchSpec, continuesSearchId?: string) => Promise<void>;

export interface UseSubmitSearchViewModelOptions {
  startSearch?: SubmitSearchStart;
}

export interface SubmitSearchViewModel {
  isMobile: boolean;
  isFormCollapsed: boolean;
  showLeftCol: boolean;
  /** Mobile-only SEATFIRST branding header (app/index.tsx stacked layout). True whenever the LeftPanel — the wordmark's desktop home — is absent on a mobile viewport. */
  showMobileWordmark: boolean;
  leftIsGhost: boolean;
  leftIsConfirmation: boolean;
  movieTitleDisplay: string;
  theaterDisplay: string;
  showSearchForm: boolean;
  theaterConfirmed: boolean;
  theaterName: string;
  /** Per-theatre display name, keyed by theatreId — for result rows that each belong to one theatre out of a multi-theatre search. */
  theatreNameById: Map<string, string>;
  theaterCity: string;
  theaterDistanceLabel: string | null;
  /** S62 (ADR 0067): venue amenities of the primary (single-selected) theatre, for the State-2 confirmation card badges. */
  theatreAmenities: TheatreAmenity[];
  seatPrefsSummaryLabel: string;
  targetStatusLabel: string;
  movieRuntimeGenreLabel: string | null;
  movieValue: string;
  movieFocused: boolean;
  liveScheduleMovies: MovieSuggestion[];
  liveScheduleHeader: string;
  nowPlayingSuggestions: MovieSuggestion[];
  nowPlayingHeader: string;
  movieIsSearching: boolean;
  movieSearchError: string | null;
  movieClearedNotice: string | null;
  /** UI42.1 (ADR 0100): Cold vs Hot headline — true iff ≥1 cached movie group. */
  isWarm: boolean;
  /** UI42.6: on-demand live-schedule check in flight. */
  isCheckingLiveSchedule: boolean;
  /** UI42.6: generic failure state when refreshSchedule fails or rejects. */
  liveScheduleError: string | null;
  /** UI42.6: footer CTA — warms D+0 via refreshSchedule, then invalidates movies. */
  onCheckLiveSchedule: () => void;
  formatOptions: ChipItem[];
  partySize: number;
  partySizeChips: ChipItem[];
  seatPrefChips: ChipItem[];
  seatPrefDescription: string;
  detailsExpanded: boolean;
  detailsToggleLabel: string;
  quickWindowLabel: string;
  quickFormatLabel: string;
  quickPartyLabel: string;
  searchDisabled: boolean;
  matchingShowtimeCount: number | null;
  warmTheatreCount?: number | null;
  // QA follow-up (BUG-04): transient loading flag for the CTA's theatre count.
  // True while the FORMAT facet fetch for the current theatre selection is
  // still in flight on the branch that feeds the numeric
  // "Search N showtimes across M theatres" label. Layers a loading
  // affordance over the stale-while-revalidating counts; never changes the
  // settled counting semantics of warmTheatreCount/submitButtonLabel.
  theatreCountLoading: boolean;
  ctaAdvisoryLabel?: string | null;
  capacityGateBusy?: boolean;
  capacityBlockLabel?: string | null;
  movieCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  theatreCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  formatCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  dateCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  timeOfDayCounts?: Map<string, { count: number; coldTheatreCount: number }>;
  facetTotalTheatres?: number;
  warmZeroMovieIds?: Set<string>;
  warmZeroTheatreIds?: Set<string>;
  posterUrl: string | null;
  submitButtonLabel: string;
  ctaSubtext: string;
  zeroMatchDiagnosis?: string | null;
  admissionRejected: { retryAfterSeconds: number } | null;
  admissionRejectedLabel: string | null;
  actions: {
    onMovieGateClick: () => void;
    onMovieChange: (text: string) => void;
    onMovieFocus: () => void;
    onMovieBlur: () => void;
    /** UI42.5 plumbing: confirms the free-typed custom event title. */
    onSelectCustomEvent: (query: string) => void;
    toggleDetails: () => void;
    startSearch: () => void;
    setFormCollapsed: (collapsed: boolean) => void;
    toggleFormCollapsed: () => void;
    widenWindow: () => void;
  };
}

export function useSubmitSearchViewModel(
  options?: UseSubmitSearchViewModelOptions,
): SubmitSearchViewModel {
  const { width } = useWindowDimensions();
  const isMobile = width < MOBILE_BREAKPOINT;

  const store = useSeatfirstStore();
  const {
    screen: flowScreen,
    selectedDates,
    timeOfDay,
    selectedBands,
    whenPreset,
    seatPrefs,
    formatPref,
    partySize,
    movie,
    selectedMovieId,
    movieSelectionSource,
    selectCustomMovieTitle,
    isCheckingLiveSchedule,
    liveScheduleError,
    setCheckingLiveSchedule,
    setLiveScheduleError,
    movieFocused,
    movieClearedNotice,
    detailsExpanded,
    selectPartySize,
    toggleSeatPref,
    selectFormat,
    toggleDetails,
    onMovieChange,
    onMovieFocus,
    onMovieBlur,
    selectMovie,
    onMovieGateClick,
  } = store;

  const liveError = useSeatfirstStore((s) => s.error);
  const storedCollapsed = useSeatfirstStore((s) => s.isFormCollapsed);
  const setFormCollapsed = useSeatfirstStore((s) => s.setFormCollapsed);
  const toggleFormCollapsed = useSeatfirstStore((s) => s.toggleFormCollapsed);
  const isFormCollapsed = isMobile ? storedCollapsed : false;

  const seatPrefChips = SEAT_PREF_NAMES.map((k) => ({
    label: k,
    active: seatPrefs[k],
    onPress: () => toggleSeatPref(k),
  }));
  const selectedSeatPrefs = SEAT_PREF_NAMES.filter((k) => seatPrefs[k]);
  const seatPrefDescription =
    selectedSeatPrefs.length === 0
      ? "No preference — use Seatfirst’s recommended area"
      : `Prefer ${selectedSeatPrefs.join(", ").toLowerCase()} placements`;
  const seatPrefsSummaryLabel =
    selectedSeatPrefs.length === 0 ? "Recommended sweet spot" : selectedSeatPrefs.join(" · ");
  const partySizeChips = PARTY_SIZES.map((n) => ({
    label: String(n),
    active: partySize === n,
    onPress: () => selectPartySize(n),
  }));

  const legacyTheatre = store.selectedTheatre;
  const selectedTheatres = useMemo(
    () =>
      store.selectedTheatres.length > 0
        ? store.selectedTheatres
        : legacyTheatre
          ? [
              {
                id: legacyTheatre.id,
                providerId: legacyTheatre.providerId,
                name: legacyTheatre.name,
                city: legacyTheatre.city,
                distanceKm: legacyTheatre.distanceKm,
                amenities: legacyTheatre.amenities ?? [],
              },
            ]
          : [],
    [legacyTheatre, store.selectedTheatres],
  );
  const primaryTheatre = selectedTheatres[0] ?? null;
  const theaterConfirmed = selectedTheatres.length > 0;

  const admissionRejected =
    liveError?.code === "ADMISSION_REJECTED" && typeof liveError.retryAfterSeconds === "number"
      ? { retryAfterSeconds: liveError.retryAfterSeconds }
      : null;
  const admissionRejectedLabel = admissionRejected
    ? formatAdmissionRejectedLabel(admissionRejected.retryAfterSeconds)
    : null;

  const theaterDisplay =
    selectedTheatres.length === 1
      ? `${primaryTheatre?.name ?? "Selected theatre"}${primaryTheatre?.city ? ` · ${primaryTheatre.city}` : ""}`
      : selectedTheatres.length > 1
        ? `${selectedTheatres.length} theatres`
        : "Choose where";
  const theaterName =
    selectedTheatres.length === 1
      ? (primaryTheatre?.name ?? "Selected theatre")
      : selectedTheatres.length > 1
        ? `${selectedTheatres.length} theatres`
        : "";
  const theaterDistanceLabel =
    selectedTheatres.length === 1 ? distanceLabel(primaryTheatre?.distanceKm ?? null) : null;
  const movieTitleDisplay = movie.trim() || "Choose a movie";
  // The State-2 target-status sentence: reflects the live seat preference (default
  // "centered, middle-third" mirrors the ADR 0015 sweet-spot scoring `seatPrefsSummaryLabel`
  // falls back to) so toggling "Aisle"/"Avoid front" on the right updates the sentence
  // immediately, same live-render pattern as the party-size mini map above it.
  const targetStatusSeatPhrase =
    selectedSeatPrefs.length === 0
      ? "centered, middle-third seats"
      : `${joinWithAnd(selectedSeatPrefs.map((pref) => SEAT_PREF_STATUS_PHRASES[pref]))} seats`;
  const targetStatusLabel = `Scanning for ${targetStatusSeatPhrase}${theaterName ? ` at ${theaterName}` : ""}.`;

  const startRealSearch = options?.startSearch;

  const movieBrowseFrom = localDateString(new Date());
  const movieBrowseTo = localDateString(
    new Date(Date.now() + (MOVIE_BROWSE_SPAN_DAYS - 1) * 86_400_000),
  );
  const theatreMovieSet = useTheatreMovieSet({
    theatreIds: selectedTheatres.map((theatre) => theatre.id),
    from: movieBrowseFrom,
    to: movieBrowseTo,
  });
  // UI42.1 (ADR 0100): date-scoped warmth — the active scope is Hot iff the
  // cached set holds ≥1 movie group; zero groups (uncached, stale, or fresh
  // negative-cache) is Cold Mode with universal movie/event discovery.
  const isWarm = theatreMovieSet.movies.length > 0;
  // Universal discovery backing suggestions. The generic general-release slate
  // must not show by default: the hook's own debounced-query threshold (≥2
  // trimmed chars) decides when a typed query fires, so no `browse` option is
  // passed (defaults to false) and nothing fetches on mere focus.
  const movieSearch = useMovieSearch({
    query: movie,
  });
  // Both suggestion groups are now always shown, so loading/error can no
  // longer branch on isWarm to pick one source. Loading reflects either
  // source fetching while a theatre is confirmed (a spinner is honest while
  // either group is still populating); error prefers the theatre-confirmed
  // source since a stale/missing schedule is the more actionable failure.
  const movieIsSearching =
    theaterConfirmed && (theatreMovieSet.isFetching || movieSearch.isFetching);
  const movieSearchError = ((): string | null => {
    const err = theatreMovieSet.error ?? movieSearch.error;
    if (!err) return null;
    const code = readTrpcErrorCode(err);
    if (code === "NOT_FOUND") return "Theatre not found";
    return err instanceof Error
      ? err.message
      : isRecord(err) && typeof err.message === "string"
        ? err.message
        : "Unable to load movies";
  })();

  const selectedMovieGroup =
    theatreMovieSet.movies.find((group) => group.movieId === selectedMovieId) ?? null;
  useEffect(() => {
    // UI42: custom (universal-search / free-typed) picks are never in the
    // cached catalogue by construction — clearing them here would wipe every
    // Cold Mode selection the moment the set completes. Only library picks
    // that vanish from a complete set get cleared.
    if (movieSelectionSource === "custom") return;
    if (!theatreMovieSet.isComplete || selectedMovieId === null || selectedMovieGroup !== null) {
      return;
    }
    useSeatfirstStore.setState({
      movie: "",
      selectedMovieId: null,
      movieSelectionSource: null,
      movieFocused: false,
      movieClearedNotice: "That movie is not playing at the selected theatres, so it was cleared.",
    });
  }, [selectedMovieGroup, selectedMovieId, theatreMovieSet.isComplete, movieSelectionSource]);
  // UI24 (ADR 0052 §7): matchingShowtimeCount (which gates searchDisabled below)
  // consumes the identical committed `selectedDates` set that buildSearchSpec
  // submits — local count, facet, preview, and create can never disagree on
  // the date scope, and sparse Custom gaps stay excluded everywhere.
  const windowSummary = theatreMovieSet.isComplete
    ? (selectedMovieGroup?.entries.reduce(
        (total, entry) => {
          const next = summarizeMovieWindow(
            entry.group,
            entry.timezone,
            selectedDates,
            timeOfDay,
            formatPref,
            selectedBands,
          );
          if (!next) return total;
          total.matchingCount += next.matchingCount;
          total.formatCounts.imax += next.formatCounts.imax;
          total.formatCounts.dolby += next.formatCounts.dolby;
          total.formatCounts.standard += next.formatCounts.standard;
          return total;
        },
        { matchingCount: 0, formatCounts: { imax: 0, dolby: 0, standard: 0 } },
      ) ?? null)
    : null;
  const posterUrl = tmdbPosterUrl(selectedMovieGroup?.posterPath ?? null);
  const movieRuntimeGenreLabel: string | null = ((): string | null => {
    const runtimePart = runtimeLabel(selectedMovieGroup?.runtimeMinutes ?? null);
    const genrePart = (selectedMovieGroup?.genres ?? []).join(", ");
    if (runtimePart !== null && genrePart.length > 0) return `${runtimePart} · ${genrePart}`;
    if (runtimePart !== null) return runtimePart;
    return genrePart.length > 0 ? genrePart : null;
  })();
  const matchingShowtimeCount: number | null = windowSummary?.matchingCount ?? null;
  // UI31 (ADR 0064 §1): the live form draft as a SearchSpec, recomputed once per
  // render. Mirrors the argument object previously built inline in
  // wrappedStartSearch; wrappedStartSearch now reads this instead of rebuilding.
  // `isHandEdited` carries the Where slice's hand-prune flag so an in-situ update
  // submitted after a hand-prune converts AREA → LIST server-side.
  const candidateSpec = useMemo(
    () =>
      buildSearchSpec({
        where: {
          deviceCenter: store.deviceCenter,
          wherePlace: store.wherePlace,
          selectedTheatres,
          whereRadiusKm: store.whereRadiusKm,
          whereLimit: store.whereLimit,
          isHandEdited: store.theatreListHandPruned,
        },
        movieId: selectedMovieId,
        // UI42: the confirmed title + source let buildSearchSpec emit the
        // titles leg for custom picks; null title while typing keeps it
        // fail-closed (spec null) exactly like a cleared movieId.
        movieTitle: movieSelectionSource !== null ? movie : null,
        movieSelectionSource,
        selectedDates,
        timeOfDay,
        selectedBands,
        seatPrefs,
        partySize,
        formatPref,
      }),
    [
      store.deviceCenter,
      store.wherePlace,
      selectedTheatres,
      store.whereRadiusKm,
      store.whereLimit,
      store.theatreListHandPruned,
      selectedMovieId,
      movie,
      movieSelectionSource,
      selectedDates,
      timeOfDay,
      selectedBands,
      seatPrefs,
      partySize,
      formatPref,
    ],
  );

  // UI31 (ADR 0064 §1): keep the store's pendingSpec mirroring the live draft.
  useEffect(() => {
    useSeatfirstStore.getState().setPendingSpec(candidateSpec);
  }, [candidateSpec]);

  // UI31 (ADR 0064): true when the draft differs from the last server-covered
  // spec — i.e. submitting now would be a genuine in-situ diff-merge update.
  const isUpdateCandidate =
    candidateSpec !== null &&
    store.serverCoverageSpec !== null &&
    specHash(candidateSpec) !== specHash(store.serverCoverageSpec);

  const facetTheatreIds = selectedTheatres.map((theatre) => theatre.id);
  const facetTotalTheatres = facetTheatreIds.length;
  const movieIdsForFacet = theatreMovieSet.movies.map((group) => group.movieId);
  const formatCodeForPref = (pref: FormatPref): string | null => {
    if (pref === "any") return "ANY";
    if (pref === "imax") return "imax";
    if (pref === "dolby") return "dolbycinemaatamcprime";
    if (pref === "standard") return "STANDARD";
    return null;
  };
  const formatCandidates: string[] = [
    "ANY",
    ...FORMAT_META.map((m) => formatCodeForPref(m.v)!).filter((c): c is string => c !== null),
  ];
  // UI24 (ADR 0052 §6): DATE counts for the "Dates" chip row's resolved dates,
  // and every other axis scoped to the exact active date scope — Movie/Format
  // send `base.dateScope` (never `base.weekdays`); TIME_OF_DAY sends the exact
  // active scope on every path. No DATE_SCOPE-axis chip is rendered.
  const facetNow = new Date();
  const quickDayCandidates = resolveQuickDayIsos({ selectedDates, whenPreset, now: facetNow });
  // UI42.8 (ADR 0100 §Date Switching + ADR 0036): per-date warmth within the
  // active scope. A selected date is warm iff ≥1 cached showtime falls on it
  // (theatre-local date membership — filters deliberately ignored, this is
  // cache presence, not a filter match). Fully cold scope (or Cold Mode)
  // disables all four facet hooks so counts come back empty and ChipRow
  // renders neutral chips; partially cold scopes restrict the facet dateScope
  // (and DATE candidates) to warm dates so warm chips keep honest counts
  // while cold dates render neutral.
  const warmDateSet = useMemo(() => {
    const warm = new Set<string>();
    for (const date of selectedDates) {
      const hasCachedShowtime = theatreMovieSet.movies.some((group) =>
        group.entries.some((entry) =>
          entry.group.showtimes.some((showtime) =>
            showtimeMatchesWindow(showtime.showDateTimeUtc, entry.timezone, [date], "All times"),
          ),
        ),
      );
      if (hasCachedShowtime) warm.add(date);
    }
    return warm;
  }, [theatreMovieSet.movies, selectedDates]);
  const warmSelectedDates = useMemo(
    () => selectedDates.filter((date) => warmDateSet.has(date)),
    [selectedDates, warmDateSet],
  );
  // Cold-search fix: per-date confirmation for the zero-match gate. `isWarm`
  // above is whole-window (any movie group cached anywhere in 30 days, e.g.
  // from the single-theatre auto D+0 check) and cannot tell a confirmed zero
  // from a cold/uncrawled scope. A date is confirmed iff ≥1 cached showtime
  // for ANY movie falls on it (same warmth signal as facetDateScope above).
  const dateScopeConfirmed =
    selectedDates.length > 0 && selectedDates.every((date) => warmDateSet.has(date));
  // An unconfirmed `0` (no crawled data for the requested window) is unknown,
  // not a genuine zero — treat it as null for display/gating. Positive counts
  // are always trustworthy and pass through untouched. The raw
  // `matchingShowtimeCount` field on the returned view model stays unmodified.
  const confirmedMatchingShowtimeCount =
    matchingShowtimeCount === 0 && !dateScopeConfirmed ? null : matchingShowtimeCount;
  const facetDateScope =
    warmSelectedDates.length > 0
      ? resolveActiveDateScope({ selectedDates: warmSelectedDates, whenPreset, now: facetNow })
      : null;
  const warmDateCandidates = useMemo(
    () => quickDayCandidates.filter((iso) => warmDateSet.has(iso)),
    [quickDayCandidates, warmDateSet],
  );
  // Facet cross-axis bases (ADR 0036 Decision 1: each chip count depends on the
  // other selected filters). Every request carries all other active fields the
  // base schema supports while omitting its own varied axis. The wire schema
  // has no selected-format base field, so FORMAT is varied without one.
  const movieFacet = useFacetCounts(
    isWarm && facetTheatreIds.length > 0 && movieIdsForFacet.length > 0 && facetDateScope !== null
      ? {
          theatreIds: facetTheatreIds,
          dateScope: facetDateScope,
          timeOfDay,
          axes: [{ kind: "MOVIE", candidates: movieIdsForFacet }],
        }
      : null,
  );
  const formatFacet = useFacetCounts(
    isWarm &&
      facetTheatreIds.length > 0 &&
      formatCandidates.length > 0 &&
      selectedMovieId !== null &&
      facetDateScope !== null
      ? {
          theatreIds: facetTheatreIds,
          dateScope: facetDateScope,
          timeOfDay,
          movieId: selectedMovieId,
          axes: [{ kind: "FORMAT", candidates: formatCandidates }],
        }
      : null,
  );
  const dateFacet = useFacetCounts(
    isWarm &&
      facetTheatreIds.length > 0 &&
      selectedMovieId !== null &&
      warmDateCandidates.length > 0
      ? {
          theatreIds: facetTheatreIds,
          movieId: selectedMovieId,
          timeOfDay,
          axes: [{ kind: "DATE", candidates: warmDateCandidates }],
        }
      : null,
  );
  const timeOfDayFacet = useFacetCounts(
    isWarm && facetTheatreIds.length > 0 && facetDateScope !== null && selectedMovieId !== null
      ? {
          theatreIds: facetTheatreIds,
          movieId: selectedMovieId,
          axes: [{ kind: "TIME_OF_DAY", candidates: ["morning", "afternoon", "evening", "late"] }],
          dateScope: facetDateScope,
        }
      : null,
  );
  const dateCounts = dateFacet.countsMap;
  const timeOfDayCounts = timeOfDayFacet.countsMap;

  const movieTitleById = new Map<string, string>();
  for (const group of theatreMovieSet.movies) {
    movieTitleById.set(group.movieId, group.title);
  }
  const movieCountsByTitle = new Map<string, { count: number; coldTheatreCount: number }>();
  const movieCountsById = movieFacet.countsMap;
  movieCountsById.forEach((entry, candidate) => {
    const title = movieTitleById.get(candidate) ?? candidate;
    movieCountsByTitle.set(title, entry);
    movieCountsByTitle.set(candidate, entry);
  });
  const warmZeroMovieIds = new Set<string>();
  movieCountsByTitle.forEach((e, k) => {
    if (e.count === 0 && e.coldTheatreCount === 0) warmZeroMovieIds.add(k);
  });
  const formatCountsByPref = new Map<string, { count: number; coldTheatreCount: number }>();
  const formatPrefByCode = new Map<string, FormatPref>();
  for (const m of FORMAT_META) {
    const code = formatCodeForPref(m.v);
    if (code) formatPrefByCode.set(code, m.v);
  }
  // The "any" pref has no FORMAT_META row, so register its reserved "ANY"
  // candidate explicitly — same alias mechanism as imax/dolby/standard above.
  formatPrefByCode.set("ANY", "any");
  formatFacet.countsMap.forEach((entry, candidate) => {
    const pref = formatPrefByCode.get(candidate);
    if (pref) {
      formatCountsByPref.set(pref, entry);
      // Label-keyed aliases (mirroring movieCountsByTitle's title+id keys) so
      // ChipRow's label-based lookup resolves every format chip — "Dolby
      // Cinema" has no lowercase-pref fallback unlike IMAX/Standard.
      const meta = FORMAT_META.find((m) => m.v === pref);
      if (meta) {
        formatCountsByPref.set(meta.label, entry);
        formatCountsByPref.set(meta.label.toLowerCase(), entry);
      } else if (pref === "any") {
        // "any" has no FORMAT_META row: alias the "Any format" chip label
        // directly so ChipRow's label-based lookup resolves it.
        formatCountsByPref.set("Any format", entry);
      }
    }
    formatCountsByPref.set(candidate, entry);
  });
  const warmZeroTheatreIds = new Set<string>();
  const theatreCounts = new Map<string, { count: number; coldTheatreCount: number }>();

  const formatChipDefs = [
    { v: "any" as FormatPref, label: "Any format" },
    ...FORMAT_META.map((m) => ({ v: m.v, label: m.label })),
  ];
  // Every chip — including "Any format" — returns a bare label: ChipRow appends
  // the shared `(count)` suffix from formatCounts (ADR 0051 amendment) via
  // getFacetDisplay, so "Any format" renders (N)/(N+)/bare through the same
  // tri-state path as IMAX/Dolby/Standard. The "ANY" facet entry lands in
  // formatCountsByPref under "any" via the formatPrefByCode alias above.
  const formatOptions = formatChipDefs.map((o) => {
    return {
      label: o.label,
      active: formatPref === o.v,
      onPress: () => selectFormat(o.v),
    };
  });

  // UI31 (ADR 0064): while editing an already-covered live search, the CTA
  // stays disabled until the draft actually diverges from serverCoverageSpec
  // — resubmitting an unedited form would create a redundant duplicate search
  // instead of the in-situ update this button is for.
  // UI42.2 (ADR 0100): a confirmed movie/event selection is either a resolved
  // library id or a confirmed custom title (universal-search hit or free-typed
  // event). Still-typing text (source null) keeps the CTA blocked.
  const hasMovieSelection =
    selectedMovieId !== null || (movieSelectionSource === "custom" && movie.trim().length > 0);
  const searchDisabled =
    !movie.trim() ||
    !theaterConfirmed ||
    !hasMovieSelection ||
    admissionRejected !== null ||
    // In Cold Mode client-side window counting is meaningless (no cached
    // schedule), so the zero-match gate is bypassed once Theatre + Movie/Event
    // + Date Scope are present. Hot Mode keeps the existing behavior — but only
    // for a CONFIRMED zero: `confirmedMatchingShowtimeCount` already folds the
    // per-date crawl confirmation in, so an unconfirmed (cold-scope) `0` reads
    // as null here and never blocks the CTA.
    confirmedMatchingShowtimeCount === 0 ||
    (store.serverCoverageSpec !== null && !isUpdateCandidate);
  const hasSelections = !!movie.trim() || theaterConfirmed;

  // ADR 0054: capacity state derives reactively from the store — the create-direct
  // path surfaces CAPACITY_CEILING_EXCEEDED through the same error pipe as every
  // other create rejection (set by useSearchSubscription's catch block).
  const capacityBlock =
    liveError?.code === CAPACITY_CEILING_EXCEEDED && typeof liveError.matchedCount === "number"
      ? { kind: "exceeded" as const, matchedCount: liveError.matchedCount }
      : null;
  // Busy while the injected create round trip is in flight: useSearchSubscription's
  // startSearch sets phase:"creating" before the mutation and resolves it to idle
  // (error) or reconciling/streaming (success) itself, so no manual flag is needed.
  const capacityGateBusy = useSeatfirstStore((s) => s.phase) === "creating";

  const wrappedStartSearch = useCallback(() => {
    const spec = candidateSpec;
    if (spec === null) return;

    const placeholderCount =
      matchingShowtimeCount !== null && matchingShowtimeCount > 0 ? matchingShowtimeCount : null;
    useSeatfirstStore.getState().setPreviewPlaceholderCount(placeholderCount);
    // Pre-submit side effects only (timer clear + selection reset) — no screen
    // transition. screen:"checking" arrives via setSearchId after create succeeds;
    // a rejected create never leaves screen:"search", so there is nothing to revert.
    useSeatfirstStore.getState().prepareSubmit();
    if (isMobile) {
      useSeatfirstStore.getState().setFormCollapsed(true);
    }
    // ADR 0054: call create directly — no capacityPreview pre-flight. Any rejection
    // (capacity or otherwise) surfaces through store.error above.
    // UI31 (ADR 0064): when the draft differs from the server-covered spec, submit
    // as an in-situ diff-merge update continuing the live search.
    const continuesSearchId =
      isUpdateCandidate && store.searchId !== null ? store.searchId : undefined;
    if (startRealSearch) void startRealSearch(spec, continuesSearchId);
  }, [
    candidateSpec,
    isUpdateCandidate,
    store.searchId,
    startRealSearch,
    isMobile,
    matchingShowtimeCount,
  ]);

  // UI18.8: the CTA's theatre count uses warm counts only. The active format
  // selection always has a formatCountsByPref entry once facet data lands
  // (including the "any" alias), so total - cold is the real warm subset —
  // never the raw selected-theatre count. While facet data is unavailable
  // (Cold Mode gates the facet hooks off, or the response is still in flight)
  // degrade to the full selected count rather than blocking the CTA.
  const activeFormatEntry = formatCountsByPref.get(formatPref);
  const warmTheatreCount =
    activeFormatEntry !== undefined && facetTheatreIds.length > 0
      ? facetTheatreIds.length - activeFormatEntry.coldTheatreCount
      : confirmedMatchingShowtimeCount !== null && selectedTheatres.length > 0
        ? selectedTheatres.length
        : null;
  // QA follow-up (BUG-04): transient loading flag for the CTA's theatre
  // count. While the FORMAT facet fetch for the CURRENT selection is still
  // resolving, formatCountsByPref still holds the previous response
  // (stale-while-revalidating), so the numeric CTA could transiently
  // undercount newly-added theatres. Gated to exactly the branch that feeds
  // that numeric label — confirmed theatre(s) + movie selection + live (not
  // update-candidate) CTA — so the "Choose where to look"/"Choose a movie"/
  // "Update search" labels never flicker into a spinner.
  const theatreCountLoading =
    theaterConfirmed && hasMovieSelection && !isUpdateCandidate && formatFacet.isLoading === true;
  const submitButtonLabel = !theaterConfirmed
    ? "Choose where to look"
    : !movie.trim() || !hasMovieSelection
      ? "Choose a movie"
      : isUpdateCandidate
        ? "Update search"
        : confirmedMatchingShowtimeCount !== null && warmTheatreCount !== null
          ? confirmedMatchingShowtimeCount === 0
            ? "No showtimes match"
            : `Search ${confirmedMatchingShowtimeCount} ${confirmedMatchingShowtimeCount === 1 ? "showtime" : "showtimes"} across ${warmTheatreCount} ${warmTheatreCount === 1 ? "theatre" : "theatres"}`
          : confirmedMatchingShowtimeCount !== null
            ? confirmedMatchingShowtimeCount === 0
              ? "No showtimes match"
              : `Search ${confirmedMatchingShowtimeCount} ${confirmedMatchingShowtimeCount === 1 ? "showtime" : "showtimes"}`
            : "Find my seats";
  const ctaAdvisoryLabel: string | null =
    capacityBlock === null &&
    confirmedMatchingShowtimeCount !== null &&
    confirmedMatchingShowtimeCount > DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes
      ? "Broad selection — consider narrowing theatre or time"
      : null;
  // UI24 (ADR 0052 §5): the CTA summary is the resolved-runs absolute-date
  // readout (`Fri 28`, `Sat 29 – Sun 30`, sparse-run list) — the stale
  // weekday-triple summary is deleted.
  const quickWindowLabel = resolveWhenReadout({ selectedDates, selectedBands });
  // ADR 0044 Change 06 ("the button states the cost"): a line under the CTA that
  // explains the current gate (where/movie still needed) or, once a count is known,
  // restates the party size and resolved window so the button's cost is legible
  // before the scan runs.
  const ctaSubtext = !theaterConfirmed
    ? "Choose a theatre to see how many showtimes match."
    : !movie.trim() || !hasMovieSelection
      ? `${selectedTheatres.length} ${selectedTheatres.length === 1 ? "theatre" : "theatres"} selected · choose a movie to see showtimes`
      : confirmedMatchingShowtimeCount !== null
        ? `Seats for ${partySize} · ${quickWindowLabel}`
        : "";
  // ADR 0044 amendment §A (2026-09-04): one-line zero-match diagnosis naming the
  // single filter most likely responsible. Reuses each axis's own already-computed
  // warm-zero state (the same isWarmZero check that dims that axis's chip row)
  // against each currently-active, non-default axis in fixed priority order
  // Format → Time of day → Date scope. Plain text only — no actions.
  const zeroMatchDiagnosis: string | null = ((): string | null => {
    if (confirmedMatchingShowtimeCount !== 0) return null;
    if (formatPref !== "any") {
      const formatMeta = FORMAT_META.find((m) => m.v === formatPref);
      if (formatMeta && isWarmZero(formatCountsByPref.get(formatPref))) {
        return `"${formatMeta.label}" filters out every match. Adjust it to search again.`;
      }
    }
    if (selectedBands.length > 0) {
      const bandOrder = ["Morning", "Afternoon", "Evening", "Late"];
      const activeBands = [...selectedBands].sort(
        (a, b) => bandOrder.indexOf(a) - bandOrder.indexOf(b),
      );
      if (
        activeBands.length > 0 &&
        activeBands.every((band) => isWarmZero(timeOfDayCounts.get(band.toLowerCase())))
      ) {
        return `"${activeBands.join(" · ")}" filters out every match. Adjust it to search again.`;
      }
    }
    if (
      quickDayCandidates.length > 0 &&
      quickDayCandidates.every((iso) => isWarmZero(dateCounts.get(iso)))
    ) {
      return `"${quickWindowLabel}" filters out every match. Adjust it to search again.`;
    }
    return "No combination of your filters has any matches yet.";
  })();
  const formatMetaSel = FORMAT_META.find((f) => f.v === formatPref);
  const quickFormatLabel =
    formatPref === "any" ? "Any format" : formatMetaSel ? formatMetaSel.label : "Format";
  const quickPartyLabel = `${partySize} together`;

  // UI42.5 plumbing: the combobox's free-typed fallback row
  // (`🔍 Search for event: "[typed text]"`, rendered by MovieField) confirms
  // whatever text is currently in the field as a custom event title.
  const onSelectCustomEvent = useCallback(
    (query: string) => {
      selectCustomMovieTitle(query);
    },
    [selectCustomMovieTitle],
  );

  // UI42.6: explicit on-demand D+0 warm for the dropdown CTA
  // ("Check today's live schedule"). Bounded server-side (~20s); the client
  // holds a loading state while in flight and surfaces a generic failure
  // state when the status is FAILED or the mutation rejects. RESOLVED/EMPTY
  // drops the cached movies snapshot (module cache + query cache, the same
  // pair `fixtures/devSeed` clears) so the newly warmed — or
  // confirmed-still-cold — schedule flows through on the next read.
  // Checking flag + failure message live in the store (not hook-local) so
  // they survive re-renders and stay test-observable. Shared by the manual
  // callback and the single-theatre auto-trigger below.
  const triggerLiveScheduleCheck = useCallback(
    (theatreId: string) => {
      if (useSeatfirstStore.getState().isCheckingLiveSchedule) return;
      const mutate = (
        trpcClient.theatres as
          | {
              refreshSchedule?: {
                mutate: (input: { theatreId: string }) => Promise<{ status: string }>;
              };
            }
          | undefined
      )?.refreshSchedule?.mutate;
      if (!mutate) {
        setLiveScheduleError("Live schedule check is unavailable. Please try again.");
        return;
      }
      setCheckingLiveSchedule(true);
      setLiveScheduleError(null);
      void mutate({ theatreId })
        .then(
          (result) => {
            if (result?.status === "FAILED") {
              setLiveScheduleError("Live schedule check failed. Please try again.");
              return;
            }
            clearTheatreMovieCache();
            queryClient.clear();
          },
          () => {
            setLiveScheduleError("Live schedule check failed. Please try again.");
          },
        )
        .finally(() => {
          setCheckingLiveSchedule(false);
        });
    },
    [setCheckingLiveSchedule, setLiveScheduleError],
  );
  const onCheckLiveSchedule = useCallback(() => {
    const theatreId = selectedTheatres[0]?.id ?? null;
    if (theatreId === null) return;
    triggerLiveScheduleCheck(theatreId);
  }, [selectedTheatres, triggerLiveScheduleCheck]);
  // ADR 0100 amendment (2026-09-20): single-theatre auto D+0 check. When
  // exactly one theatre is selected, fire the same refresh once per theatre
  // per session. The id is recorded synchronously with firing (not on
  // success) so FAILED/EMPTY never retry-loop; the ref only suppresses the
  // automatic effect — the manual callback above stays usable as a retry.
  const autoCheckedTheatreIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (selectedTheatres.length !== 1) return;
    const theatreId = selectedTheatres[0]?.id ?? null;
    if (theatreId === null || autoCheckedTheatreIdsRef.current.has(theatreId)) return;
    if (isCheckingLiveSchedule) return;
    autoCheckedTheatreIdsRef.current.add(theatreId);
    triggerLiveScheduleCheck(theatreId);
  }, [selectedTheatres, triggerLiveScheduleCheck, isCheckingLiveSchedule]);
  const showSearchForm = flowScreen === "search" || flowScreen === "checking";
  const showLeftCol = !(isMobile && showSearchForm);
  // QA mobile branding: on mobile viewports the LeftPanel (the wordmark's
  // desktop home) never visibly renders — the search-form screen hides it via
  // showLeftCol, and the stacked results branch doesn't mount it at all — so
  // the standalone mobile header renders on every mobile screen. Desktop
  // always mounts a visible LeftPanel, so this stays false there.
  const showMobileWordmark = isMobile;
  const leftIsGhost = flowScreen === "search" && !hasSelections;
  const leftIsConfirmation = showSearchForm && hasSelections;

  return {
    isMobile,
    isFormCollapsed,
    showLeftCol,
    showMobileWordmark,
    leftIsGhost,
    leftIsConfirmation,
    movieTitleDisplay,
    theaterDisplay,
    showSearchForm,
    theaterConfirmed,
    theaterName,
    theatreNameById: new Map(
      selectedTheatres
        .filter((theatre) => theatre.name)
        .map((theatre) => [theatre.id, theatre.name as string]),
    ),
    theaterCity: selectedTheatres.length === 1 ? (primaryTheatre?.city ?? "") : "",
    theaterDistanceLabel,
    theatreAmenities: primaryTheatre?.amenities ?? [],
    seatPrefsSummaryLabel,
    targetStatusLabel,
    movieRuntimeGenreLabel,
    movieValue: movie,
    movieFocused,
    liveScheduleMovies: ((): MovieSuggestion[] => {
      // Confirmed, theatre-specific schedule data. Empty when cold, still
      // loading, or the refresh returned EMPTY — never mixed with guesses.
      const query = movie.trim().toLocaleLowerCase();
      return theatreMovieSet.movies
        .filter((group) => query.length === 0 || group.title.toLocaleLowerCase().includes(query))
        .map((group) => ({
          label: group.title,
          onPress: () => selectMovie(group.title, group.movieId),
          posterUrl: tmdbPosterUrl(group.posterPath),
        }));
    })(),
    liveScheduleHeader:
      selectedTheatres.length === 1
        ? `Now playing at ${primaryTheatre?.name ?? "selected theatre"}`
        : selectedTheatres.length > 1
          ? "Now playing nearby"
          : "Choose where to see what is playing",
    // Generic TMDB/AMC-catalog slate. The movieSearch hook already owns
    // query-awareness (browse vs. debounced typed query), so its
    // suggestions pass through unfiltered, exactly as the old Cold Mode
    // branch did — no client-side double-filtering.
    nowPlayingSuggestions: movieSearch.suggestions,
    nowPlayingHeader: "Now Playing (general release)",
    movieIsSearching,
    movieSearchError,
    movieClearedNotice,
    isWarm,
    isCheckingLiveSchedule,
    liveScheduleError,
    onCheckLiveSchedule,
    formatOptions,
    partySize,
    partySizeChips,
    seatPrefChips,
    seatPrefDescription,
    detailsExpanded,
    detailsToggleLabel: detailsExpanded ? "Hide filters" : "More filters",
    quickWindowLabel,
    quickFormatLabel,
    quickPartyLabel,
    searchDisabled,
    matchingShowtimeCount,
    warmTheatreCount,
    theatreCountLoading,
    ctaAdvisoryLabel,
    capacityGateBusy,
    capacityBlockLabel:
      capacityBlock === null
        ? null
        : `${capacityBlock.matchedCount} showtimes match — above the ${DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes} limit. Narrow your filters to continue.`,
    movieCounts: movieCountsByTitle,
    theatreCounts,
    formatCounts: formatCountsByPref,
    dateCounts,
    timeOfDayCounts,
    facetTotalTheatres,
    warmZeroMovieIds,
    warmZeroTheatreIds,
    posterUrl,
    submitButtonLabel,
    ctaSubtext,
    zeroMatchDiagnosis,
    admissionRejected,
    admissionRejectedLabel,
    actions: {
      onMovieGateClick,
      onMovieChange,
      onMovieFocus,
      onMovieBlur,
      onSelectCustomEvent,
      toggleDetails,
      startSearch: wrappedStartSearch,
      setFormCollapsed,
      toggleFormCollapsed,
      widenWindow: store.widenWindow,
    },
  };
}
