/**
 * Named store states for dev iteration — one per screen the FSM can reach.
 *
 * The expensive thing to reach by hand in this app is not a component, it's a *screen
 * state*: `flowSlice`'s `screen` FSM crossed with `searchSlice`'s status/answer/skeleton.
 * Each scenario below is the store snapshot that puts the real `app/index.tsx` into one
 * of those states, using contract-valid data from `contracts.ts`.
 *
 * Each entry is a factory, not a constant, so seeding twice never shares mutable arrays.
 */
import type { SeatfirstStore } from "@/store/seatfirstStore";
import {
  DEFAULT_SEARCH_LIMITS,
  TheatreIdSchema,
  type RecheckResult,
  type RecoveryOption,
} from "@seatfirst/core";
import type { ApiProfileName } from "./mockTransport";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import { searchFormInitialState, type WhereTheatreRef } from "@/store/searchFormSlice";
import { searchInitialState } from "@/store/searchSlice";
import {
  DEV_CAPTURED_AT,
  DEV_PROVIDER_ID,
  DEV_THEATRE_ID,
  devShowtimeId,
  makeConfidentAnswer,
  makeEmptyAnswer,
  makeHedgedAnswer,
  makeHitGroup,
  makePlacement,
  makeRecommendation,
  makeResolvedGroupShowtime,
  makeScheduleSkeleton,
  makeShowtimeOffer,
} from "./contracts";
import { devTheatreId } from "./apiFixtures";
import { buildSearchSpec } from "@/lib/buildSearchSpec";

export interface DevScenario {
  /** URL/CLI token, e.g. `?seed=result-confident`. */
  readonly id: string;
  readonly label: string;
  /** Store patch, applied on top of a full reset to every slice's initial state. */
  readonly state: () => Partial<SeatfirstStore>;
  /**
   * Mock API profile to install alongside the store patch, for the states react-query
   * owns rather than zustand. An explicit `?api=` in the URL overrides this.
   */
  readonly api?: ApiProfileName;
}

/**
 * Every slice's initial state, so a seed never inherits leftovers from the previous one.
 * `useSeatfirstStore.setState` merges, so this base has to be explicit.
 */
export function resetState(): Partial<SeatfirstStore> {
  return {
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
  };
}

/**
 * Bootstrap is faked so the dev seed renders without a backend — `BootstrapGate` in
 * `app/_layout.tsx` short-circuits on `bootstrapReady`. `limits` stays `null`: no
 * component reads it, and inventing rate-limit numbers here would be inventing policy.
 */
function seededSession(): Partial<SeatfirstStore> {
  return { bootstrapReady: true, bootstrapLoading: false, sessionId: "dev-seed-session" };
}

/** A filled-in form, so the quick-edit bar and collapsed bar have something to show. */
function filledForm(): Partial<SeatfirstStore> {
  return {
    movie: "Dune: Part Three",
    selectedMovieId: `${DEV_PROVIDER_ID}:movie:dune-part-three`,
    selectedTheatres: [
      {
        id: DEV_THEATRE_ID,
        providerId: DEV_PROVIDER_ID,
        name: "AMC Metreon 16",
        city: "San Francisco",
        distanceKm: 2.4,
      },
    ],
    partySize: 4,
  };
}

/**
 * The `SearchSpec` a real completed/running search seed must carry as
 * `serverCoverageSpec` — production sets this on every submission
 * (`useSearchSubscription.ts`'s `startSearch`), so a `screen: "checking"` or
 * `screen: "result"` scenario that omits it leaves `serverCoverageSpec: null`,
 * which makes the CTA behave as if no live search exists (UI31/ADR 0064: the
 * "Edit search" CTA disables until the draft diverges from this spec). Every
 * `checking`/`result`/`halted` scenario below passes the same movie/theatres/
 * partySize its `filledForm()` (or override) actually uses, so the seeded
 * `serverCoverageSpec` matches the live draft exactly and the CTA starts
 * correctly disabled.
 */
function liveServerCoverageSpec(overrides?: {
  selectedTheatres?: WhereTheatreRef[];
  partySize?: number;
}): SeatfirstStore["serverCoverageSpec"] {
  const filled = filledForm();
  const spec = buildSearchSpec({
    where: {
      deviceCenter: searchFormInitialState.deviceCenter,
      wherePlace: searchFormInitialState.wherePlace,
      selectedTheatres: overrides?.selectedTheatres ?? filled.selectedTheatres!,
      whereRadiusKm: searchFormInitialState.whereRadiusKm,
      whereLimit: searchFormInitialState.whereLimit,
      isHandEdited: searchFormInitialState.theatreListHandPruned,
    },
    movieId: filled.selectedMovieId!,
    selectedDates: searchFormInitialState.selectedDates,
    timeOfDay: searchFormInitialState.timeOfDay,
    selectedBands: searchFormInitialState.selectedBands,
    seatPrefs: searchFormInitialState.seatPrefs,
    partySize: overrides?.partySize ?? filled.partySize!,
    formatPref: searchFormInitialState.formatPref,
  });
  if (spec === null) throw new Error("liveServerCoverageSpec: buildSearchSpec returned null");
  return spec;
}

/**
 * The "where" autocomplete open with an optional typed query. `TheaterField` reads
 * `whereQuery`/`whereFocused` from the store, not the props `SearchForm` passes it.
 */
function whereFieldOpen(query = ""): Partial<SeatfirstStore> {
  return { whereQuery: query, whereFocused: true, theaterQuery: query, theaterFocused: true };
}

const DEV_WHERE_RADIUS_KM = 10 * 1.609344;

function hitGroups(): ReturnType<typeof makeHitGroup>[] {
  return [makeHitGroup("s1"), makeHitGroup("s2", { row: 4, startCol: 10 })];
}

const goneRecovery: () => RecoveryOption[] = () => [
  {
    level: 1,
    placement: makePlacement({ placementKey: "dev-recovery-1", startCol: 6 }),
    showtimeId: devShowtimeId("s1"),
    relaxed: [],
    requiresConsent: false,
  },
  {
    level: 3,
    placement: makePlacement({ placementKey: "dev-recovery-3", row: 3 }),
    // Level 3 is the next-best placement in the SAME showtime (ADR 0026) — it
    // never changes showtime and never relaxes a constraint.
    showtimeId: devShowtimeId("s1"),
    relaxed: [],
    requiresConsent: true,
  },
];

const availableRecheck: () => RecheckResult = () => ({
  status: "AVAILABLE",
  placement: makePlacement(),
  checkedAt: DEV_CAPTURED_AT,
});

export const DEV_SCENARIOS: readonly DevScenario[] = [
  {
    id: "search",
    label: "Search form",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    id: "search-empty",
    label: "Search form (blank)",
    state: () => ({ ...seededSession(), screen: "search" }),
  },
  // --- Form states driven by the mock transport (fixtures/mockTransport.ts) ---
  // These are the states the store cannot reach: they live in react-query and in the
  // bare `trpcClient` calls the form view model makes.
  {
    id: "form-theatre-browse",
    label: "Where — browse list",
    api: "happy",
    state: () => ({ ...seededSession(), ...whereFieldOpen(), screen: "search" }),
  },
  {
    id: "where-suggestions-happy",
    label: "Where — place suggestions",
    api: "happy",
    state: () => ({ ...seededSession(), ...whereFieldOpen("san"), screen: "search" }),
  },
  {
    id: "where-chip-resolved-name",
    label: "Where — resolved place chip",
    api: "happy",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "search",
      wherePlace: {
        query: "san fran",
        label: "san fran · 10 mi around san fran",
        resolvedPlaceName: "San Francisco, CA, United States",
        radiusKm: DEV_WHERE_RADIUS_KM,
        limit: DEFAULT_SEARCH_LIMITS.maxTheatres,
      },
      // A resolved broad place matches multiple theatres (same list as
      // `where-place-selected-open`), not just the `filledForm()` default.
      selectedTheatres: [
        {
          id: DEV_THEATRE_ID,
          providerId: DEV_PROVIDER_ID,
          name: "AMC Metreon 16",
          city: "San Francisco",
          distanceKm: 2.4,
        },
        {
          id: devTheatreId("kabuki"),
          providerId: DEV_PROVIDER_ID,
          name: "AMC Kabuki 8",
          city: "San Francisco",
          distanceKm: 3.8,
        },
        {
          id: devTheatreId("bay-street"),
          providerId: DEV_PROVIDER_ID,
          name: "AMC Bay Street 16",
          city: "Emeryville",
          distanceKm: 14.2,
        },
      ],
      whereRadiusKm: DEV_WHERE_RADIUS_KM,
    }),
  },
  {
    id: "where-place-selected-open",
    label: "Where — place panel open",
    api: "happy",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      ...whereFieldOpen(),
      screen: "search",
      wherePlace: {
        query: "san fran",
        label: "san fran · 10 mi around san fran",
        resolvedPlaceName: "San Francisco, CA, United States",
        radiusKm: DEV_WHERE_RADIUS_KM,
        limit: DEFAULT_SEARCH_LIMITS.maxTheatres,
      },
      selectedTheatres: [
        {
          id: DEV_THEATRE_ID,
          providerId: DEV_PROVIDER_ID,
          name: "AMC Metreon 16",
          city: "San Francisco",
          distanceKm: 2.4,
        },
        {
          id: devTheatreId("kabuki"),
          providerId: DEV_PROVIDER_ID,
          name: "AMC Kabuki 8",
          city: "San Francisco",
          distanceKm: 3.8,
        },
        {
          id: devTheatreId("bay-street"),
          providerId: DEV_PROVIDER_ID,
          name: "AMC Bay Street 16",
          city: "Emeryville",
          distanceKm: 14.2,
        },
      ],
      whereRadiusKm: DEV_WHERE_RADIUS_KM,
    }),
  },
  {
    id: "where-theatres-selected-open",
    label: "Where — theatres selected open",
    api: "happy",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      ...whereFieldOpen(),
      screen: "search",
      wherePlace: null,
      deviceCenter: null,
      selectedTheatres: [
        {
          id: DEV_THEATRE_ID,
          providerId: DEV_PROVIDER_ID,
          name: "AMC Metreon 16",
          city: "San Francisco",
          distanceKm: 2.4,
        },
        {
          id: devTheatreId("kabuki"),
          providerId: DEV_PROVIDER_ID,
          name: "AMC Kabuki 8",
          city: "San Francisco",
          distanceKm: 3.8,
        },
      ],
    }),
  },
  {
    id: "form-theatre-loading",
    label: "Where — loading",
    api: "theatre-search-loading",
    state: () => ({ ...seededSession(), ...whereFieldOpen("metr"), screen: "search" }),
  },
  {
    id: "form-theatre-empty",
    label: "Where — no matches",
    api: "theatre-search-empty",
    state: () => ({ ...seededSession(), ...whereFieldOpen("zzzz"), screen: "search" }),
  },
  {
    id: "form-theatre-error",
    label: "Where — search failed",
    api: "theatre-search-error",
    state: () => ({ ...seededSession(), ...whereFieldOpen("metr"), screen: "search" }),
  },
  {
    id: "where-place-not-found",
    label: "Where — place not found",
    api: "place-not-found",
    state: () => ({
      ...seededSession(),
      ...whereFieldOpen("Atlantis"),
      // `TheaterField` appends its own "Try a different..." hint for
      // PLACE_NOT_FOUND, so the store message keeps only the core sentence.
      wherePlaceError: "We couldn't find that place.",
      wherePlaceErrorKind: "PLACE_NOT_FOUND",
      screen: "search",
    }),
  },
  {
    id: "where-place-unavailable",
    label: "Where — place resolution unavailable",
    api: "place-unavailable",
    state: () => ({
      ...seededSession(),
      ...whereFieldOpen("Nowhere"),
      wherePlaceError: "Place lookup is temporarily unavailable. Please try again.",
      wherePlaceErrorKind: "PLACE_RESOLUTION_UNAVAILABLE",
      screen: "search",
    }),
  },
  {
    id: "form-movies-loading",
    label: "Movie — loading",
    api: "movies-loading",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      movie: "",
      selectedMovieId: null,
      movieFocused: true,
      screen: "search",
    }),
  },
  {
    id: "form-movies-empty",
    label: "Movie — nothing playing",
    api: "movies-empty",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      movie: "",
      selectedMovieId: null,
      movieFocused: true,
      screen: "search",
    }),
  },
  {
    id: "form-movies-error",
    label: "Movie — load failed",
    api: "movies-error",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      movie: "",
      selectedMovieId: null,
      movieFocused: true,
      screen: "search",
    }),
  },
  {
    id: "form-facets-warm",
    label: "Facets — exact counts",
    api: "happy",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    id: "form-facets-partial",
    label: "Facets — partial (N+)",
    api: "facets-partial",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    id: "form-facets-cold",
    label: "Facets — not checked yet",
    api: "facets-cold",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    id: "form-facets-warm-zero",
    label: "Facets — warm zero (dead end)",
    api: "facets-warm-zero",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    // Multi-step: press "Find my seats" and `create` rejects with
    // CAPACITY_CEILING_EXCEEDED — the banner derives from store.error (ADR 0054).
    id: "form-capacity-blocked",
    label: "Submit — capacity exceeded",
    api: "capacity-blocked",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    // Pre-seeds the rejection error and installs the rejected transport profile so both
    // the initial screen state and a fresh re-submit render the admission banner.
    id: "form-admission-rejected",
    label: "Submit — admission rejected",
    api: "admission-rejected",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      error: {
        code: "ADMISSION_REJECTED",
        message: "Too many searches in flight",
        retryAfterSeconds: 30,
      },
      screen: "search",
    }),
  },
  {
    id: "backend-offline",
    label: "Backend — offline",
    api: "offline",
    state: () => ({
      ...seededSession(),
      ...whereFieldOpen("metr"),
      screen: "search",
    }),
  },
  {
    id: "checking",
    label: "Checking (streaming)",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "checking",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "RUNNING",
      phase: "streaming",
      scheduleSkeleton: makeScheduleSkeleton(6, 2),
      groups: hitGroups(),
      resolved: 2,
      total: 6,
    }),
  },
  {
    id: "checking-reconnect",
    label: "Checking (polling fallback)",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "checking",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "RUNNING",
      phase: "polling",
      scheduleSkeleton: makeScheduleSkeleton(6, 1),
      resolved: 1,
      total: 6,
    }),
  },
  {
    id: "result-confident",
    label: "Result — CONFIDENT",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    id: "result-hedged",
    label: "Result — HEDGED",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeHedgedAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    id: "result-empty",
    label: "Result — EMPTY (sold out)",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      // COMPLETE + EMPTY needs a complete-coverage cause (ADR 0003 §6 / ADR 0009).
      // A genuine sold-out EMPTY result has no hits; the skeleton entries render
      // as misses instead of phantom hit cards.
      answer: makeEmptyAnswer("SOLD_OUT"),
      groups: [],
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    id: "result-deferred",
    label: "Result — batch deferred (check more)",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(9, 4, 4),
      resolved: 4,
      total: 9,
      terminalCause: "BATCH_DEFERRED",
    }),
  },
  {
    id: "partial",
    label: "Partial",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "partial",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      // PARTIAL admits HEDGED or EMPTY:{HALTED,NO_SHAPE_MATCH,PARTIAL_SCHEDULE}.
      status: "PARTIAL",
      phase: "terminal",
      answer: makeHedgedAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(9, 4),
      resolved: 4,
      total: 9,
    }),
  },
  {
    id: "halted",
    label: "Halted (capacity)",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "halted",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      // HALTED admits only EMPTY:HALTED or EMPTY:CAPACITY.
      status: "HALTED",
      phase: "terminal",
      terminalCause: "CAPACITY",
      answer: makeEmptyAnswer("CAPACITY", []),
      // HALTED admits no actionable hits; the skeleton renders the queued/miss rows.
      groups: [],
      scheduleSkeleton: makeScheduleSkeleton(9, 1),
      resolved: 1,
      total: 9,
    }),
  },
  {
    // UI30 inline recheck in flight: `screen` stays "result"; the targeted row
    // renders its spinner via `recheckingShowtimeId` (see `ShowtimeList`).
    id: "recheck",
    label: "Recheck in flight",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "rechecking",
      recheckingShowtimeId: devShowtimeId("s1"),
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckAttemptedNonce: "dev-nonce-s1",
    }),
  },
  {
    // UI30 inline GONE: `screen` stays "result"; the targeted row renders the
    // recovery panel in place from `recheckResult.recovery` (see `ShowtimeRow`).
    id: "replacement",
    label: "Seats gone — recovery options",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "gone",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckResult: { status: "GONE", recovery: goneRecovery() },
    }),
  },
  {
    // UI30 inline error: `screen` stays "result"; the targeted row renders the
    // canonical TIMEOUT copy derived from `recheckErrorCode` (see `useSearchResultsViewModel`).
    id: "recheck-unavailable",
    label: "Recheck unavailable",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "unavailable",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckErrorCode: "TIMEOUT",
      // ADR 0024 amendment (2026-09-03): production never stores a raw/generic message for
      // TIMEOUT (see `useRecheck.ts`/`useSearchResultsViewModel.ts`), so `recheckErrorLabel`
      // falls through to its code branch and shows the canonical reassurance copy. `null`
      // here matches that, instead of masking it with a fixture-only fallback string.
      recheckErrorMessage: null,
    }),
  },
  {
    // UI30 inline AVAILABLE: `screen` stays "result"; the targeted row's status text
    // reflects `recheckResult`, and its "Go to AMC" CTA opens the deep link directly
    // instead of re-running the recheck (see `ShowtimeRow`).
    id: "confirmed",
    label: "Recheck — seats available",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "available",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckResult: availableRecheck(),
    }),
  },
  {
    // Custom calendar sheet open with the facet request still cold, so date cells
    // render the base 7-column layout with no badges (Group 5's full-height/scroll
    // panel change is what this state visually exercises).
    id: "when-custom-open",
    label: "When — custom sheet open (no facets)",
    api: "facets-cold",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "search",
      whenPreset: "Custom",
      isCustom: true,
      whenSheetOpen: true,
    }),
  },
  {
    // Same sheet with the facet request warm, so live count badges populate on the
    // date cells. `WhenCustomSheet` only fires its facet query while the sheet is
    // open with selected theatres (see `useWhenCustomSheetViewModel`).
    id: "when-custom-with-facets",
    label: "When — custom sheet open (facet badges)",
    api: "happy",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "search",
      whenPreset: "Custom",
      isCustom: true,
      whenSheetOpen: true,
    }),
  },
  {
    // Host screen for the mobile "See how it works" bottom sheet (ADR 0056/UI26).
    // `HowItWorksSheet`'s open flag is local `useState` in `SearchForm`, not store
    // state, so this seeds the filled search screen and one tap on
    // "See how it works →" opens the sheet.
    id: "how-it-works-open",
    label: "How it works sheet (search)",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    // CONFIDENT whose primary spans two showtimes at the same theatre, so both
    // hit rows render with a price and a Hold-seats action (the eligibility fix
    // covers the non-Top-Pick row).
    id: "result-non-primary-expanded",
    label: "Result — CONFIDENT, two showtimes same theatre",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer({
        primary: makeRecommendation("s1", {
          showtimes: [makeShowtimeOffer("s1"), makeShowtimeOffer("s2")],
        }),
      }),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    // CONFIDENT with hits (s1/s2) plus resolved misses (s3/s4), so the
    // "N didn't fit · show them" disclosure renders. The toggle is local
    // `useState` in `ShowtimeList` (default closed) — tap it to reveal the misses.
    id: "result-misses-revealed",
    label: "Result — CONFIDENT with misses disclosable",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    // Results screen with the Quick Edit bar populated. `QuickEditBar` always
    // renders on `ResultScreen` (no open/closed state) — the filled form is what
    // gives the bar its movie/theatre/breadcrumb content.
    id: "quick-edit-open",
    label: "Result — Quick Edit bar",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    // CONFIDENT spanning two theatres: hits at Metreon (s1) and Kabuki (s3), so
    // the per-theatre progress chips and per-row theatre names both render.
    // `theatreNameById` derives from `selectedTheatres`, hence the second entry.
    id: "result-multi-theatre",
    label: "Result — CONFIDENT spanning 2 theatres",
    state: () => {
      const kabukiTheatreId = TheatreIdSchema.parse(`${DEV_PROVIDER_ID}:theatre:kabuki`);
      const skeleton = makeScheduleSkeleton(4).map((entry, index) =>
        index < 2 ? entry : { ...entry, theatreId: kabukiTheatreId },
      );
      const theatres: WhereTheatreRef[] = [
        {
          id: DEV_THEATRE_ID,
          providerId: DEV_PROVIDER_ID,
          name: "AMC Metreon 16",
          city: "San Francisco",
          distanceKm: 2.4,
        },
        {
          id: `${DEV_PROVIDER_ID}:theatre:kabuki`,
          providerId: DEV_PROVIDER_ID,
          name: "AMC Kabuki 8",
          city: "San Francisco",
          distanceKm: 3.8,
        },
      ];
      return {
        ...seededSession(),
        ...filledForm(),
        selectedTheatres: theatres,
        screen: "result",
        searchId: "dev-search-1",
        serverCoverageSpec: liveServerCoverageSpec({ selectedTheatres: theatres }),
        status: "COMPLETE",
        phase: "terminal",
        answer: makeConfidentAnswer({
          primary: makeRecommendation("s1", {
            showtimes: [
              makeShowtimeOffer("s1"),
              makeShowtimeOffer("s3", { theatreId: kabukiTheatreId }),
            ],
          }),
        }),
        groups: [
          makeHitGroup("s1"),
          makeHitGroup("s3", {
            over: {
              theatreId: kabukiTheatreId,
              showtimes: [makeResolvedGroupShowtime("s3", { theatreId: kabukiTheatreId })],
            },
          }),
        ],
        scheduleSkeleton: skeleton,
        resolved: 4,
        total: 4,
      };
    },
  },
  {
    // Recheck flow in an upstream rate-limit error state. `TOO_MANY_REQUESTS` is the
    // canonical recheck rate-limit code in `recheckErrorLabel` (`lib/presentation.ts`),
    // mirroring the `recheck-unavailable` (TIMEOUT) scenario's inline store-error
    // shape: `screen` stays "result" and the targeted row renders the error in place.
    id: "recheck-rate-limited",
    label: "Recheck rate-limited",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "unavailable",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckErrorCode: "TOO_MANY_REQUESTS",
      recheckErrorMessage: "Too many requests — try again shortly",
    }),
  },
  {
    id: "search-zero-match-recovery",
    label: "Search — zero-match recovery",
    api: "facets-warm-zero",
    state: () => ({ ...seededSession(), ...filledForm(), screen: "search" }),
  },
  {
    // UI30 inline AVAILABLE with an S59 price change: the offer ($21.50) and the
    // group showtime ($24) carry differing minPrice amounts; `screen` stays
    // "result" and the targeted row renders the success state in place.
    id: "recheck-price-changed",
    label: "Recheck — ticket price changed",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer({
        primary: makeRecommendation("s1", {
          showtimes: [
            makeShowtimeOffer("s1", {
              minPrice: { amount: 21.5, currency: "USD", basis: "TICKET_ONLY" },
            }),
          ],
        }),
      }),
      groups: [
        makeHitGroup("s1", {
          over: {
            showtimes: [
              makeResolvedGroupShowtime("s1", {
                minPrice: { amount: 24, currency: "USD", basis: "TICKET_ONLY" },
              }),
            ],
          },
        }),
      ],
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "available",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckResult: availableRecheck(),
    }),
  },
  {
    id: "result-single-seat-orphan",
    label: "Result — single edge seat orphan",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      partySize: 3,
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec({ partySize: 3 }),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer({
        primary: makeRecommendation("s1", {
          placement: makePlacement({
            placementKey: "dev-placement-orphan",
            startCol: 10,
            count: 3,
          }),
        }),
      }),
      groups: [makeHitGroup("s1", { startCol: 10 })],
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
    }),
  },
  {
    // Mock transport profiles cannot drop an already-open SSE stream; polling models its resume state.
    id: "streaming-network-disconnect",
    label: "Checking — network reconnect",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "checking",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "RUNNING",
      phase: "polling",
      scheduleSkeleton: makeScheduleSkeleton(8, 3),
      groups: hitGroups(),
      resolved: 3,
      total: 8,
    }),
  },
  {
    // UI30 inline GONE driving the recovery-option hover map preview: `screen`
    // stays "result" and the targeted row renders the recovery panel in place.
    id: "replacement-hover-map-preview",
    label: "Seats gone — hover map preview",
    state: () => ({
      ...seededSession(),
      ...filledForm(),
      screen: "result",
      searchId: "dev-search-1",
      serverCoverageSpec: liveServerCoverageSpec(),
      status: "COMPLETE",
      phase: "terminal",
      answer: makeConfidentAnswer(),
      groups: hitGroups(),
      scheduleSkeleton: makeScheduleSkeleton(4),
      resolved: 4,
      total: 4,
      recheckStatus: "gone",
      recheckingShowtimeId: null,
      recheckSelectedShowtimeId: devShowtimeId("s1"),
      recheckSelectedPlacementKey: "dev-placement-1",
      recheckResult: { status: "GONE", recovery: goneRecovery() },
    }),
  },
];

export function findScenario(id: string | null | undefined): DevScenario | null {
  if (id === null || id === undefined || id.length === 0) return null;
  return DEV_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
