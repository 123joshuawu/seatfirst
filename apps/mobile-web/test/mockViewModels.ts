import { vi } from "vitest";
import {
  useSubmitSearchViewModel,
  type SubmitSearchViewModel,
} from "@/hooks/viewModels/useSubmitSearchViewModel";
import {
  useSearchProgressViewModel,
  type SearchProgressViewModel,
} from "@/hooks/viewModels/useSearchProgressViewModel";
import {
  useSearchResultsViewModel,
  type SearchResultsViewModel,
} from "@/hooks/viewModels/useSearchResultsViewModel";
import { useHandoffViewModel, type HandoffViewModel } from "@/hooks/viewModels/useHandoffViewModel";

/**
 * Shared shape for view-model test fixtures — the union of every domain hook, matching
 * how components merge them (e.g. `{ ...formVm, ...progressVm, ...resultsVm, ...handoffVm }`).
 * ADR 0047 / UI19: one fixture type instead of each test file re-declaring an `any`-typed vm.
 */
export type MockViewModel = SubmitSearchViewModel &
  SearchProgressViewModel &
  SearchResultsViewModel &
  HandoffViewModel;

/**
 * Points all four view-model hooks at the same mock object. Callers must `vi.mock(...)`
 * each hook module themselves first — vitest hoists `vi.mock` per file, so it can't be
 * done here on their behalf.
 */
export function setMockVm(vm: MockViewModel): void {
  vi.mocked(useSubmitSearchViewModel).mockReturnValue(vm);
  vi.mocked(useSearchProgressViewModel).mockReturnValue(vm);
  vi.mocked(useSearchResultsViewModel).mockReturnValue(vm);
  vi.mocked(useHandoffViewModel).mockReturnValue(vm);
}

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

function baseVm(): MockViewModel {
  return {
    // useSubmitSearchViewModel
    isMobile: false,
    isFormCollapsed: false,
    showLeftCol: true,
    leftIsGhost: false,
    leftIsConfirmation: false,
    movieTitleDisplay: "Choose a movie",
    theaterDisplay: "Choose where",
    showSearchForm: true,
    theaterConfirmed: false,
    theaterName: "",
    theatreNameById: new Map<string, string>(),
    theaterCity: "",
    theaterDistanceLabel: null,
    theatreAmenities: [],
    seatPrefsSummaryLabel: "Recommended sweet spot",
    targetStatusLabel: "Scanning for centered, middle-third seats.",
    movieRuntimeGenreLabel: null,
    movieValue: "",
    movieFocused: false,
    liveScheduleHeader: "",
    liveScheduleMovies: [],
    nowPlayingHeader: "",
    nowPlayingSuggestions: [],
    movieIsSearching: false,
    movieSearchError: null,
    movieClearedNotice: null,
    isWarm: true,
    isCheckingLiveSchedule: false,
    liveScheduleError: null,
    onCheckLiveSchedule: noop,
    formatOptions: [],
    partySizeChips: [],
    seatPrefChips: [],
    seatPrefDescription: "",
    detailsExpanded: false,
    detailsToggleLabel: "More filters",
    quickWindowLabel: "",
    quickFormatLabel: "",
    quickPartyLabel: "",
    searchDisabled: false,
    matchingShowtimeCount: null,
    warmTheatreCount: null,
    ctaAdvisoryLabel: null,
    capacityGateBusy: false,
    capacityBlockLabel: null,
    movieCounts: new Map(),
    theatreCounts: new Map(),
    formatCounts: new Map(),
    facetTotalTheatres: 0,
    warmZeroMovieIds: new Set(),
    warmZeroTheatreIds: new Set(),
    posterUrl: null,
    submitButtonLabel: "Find my seats",
    ctaSubtext: "",
    admissionRejected: null,
    admissionRejectedLabel: null,

    // useSearchProgressViewModel
    isChecking: false,
    etaLabel: null,
    checkedCount: 0,
    totalShowtimes: 0,
    isLocked: false,
    isScanRunning: false,
    isCanceling: false,
    cancelError: null,
    searchId: null,
    phase: "idle",
    phaseDetail: null,
    error: null,

    // useSearchResultsViewModel
    answer: null,
    answerMode: null,
    groups: [],
    searchStatus: null,
    terminalStatus: null,
    isTerminal: false,
    otherFormatsLabel: null,
    emptyCause: null,
    emptyCauseLabel: null,
    terminalBannerLabel: null,
    liveResolved: 0,
    liveTotal: 0,
    scheduleSkeleton: [],
    previewPlaceholderCount: null,
    terminalCause: null,
    // Shared by SubmitSearchViewModel.partySize and SearchResultsViewModel.partySize.
    partySize: 2,
    canCheckMore: false,
    handoffEligibleShowtimeIds: [],
    answerPlacementByShowtimeId: {},
    noValidActions: [],
    recheckingShowtimeId: null,
    recheckTargetShowtimeId: null,
    recheckInlineError: null,
    takenShowtimeIds: [],
    recoverySheetOpen: false,
    provenanceByShowtimeId: new Map(),
    displayRows: [],

    // useHandoffViewModel
    recheckStatus: "idle",
    isRechecking: false,
    recheckResult: null,
    recheckErrorCode: null,
    recheckErrorMessage: null,
    recheckErrorLabel: null,
    recheckStoreStatus: "idle",
    leftIsAuditorium: false,
    activePlacement: null,
    gridRows: [],

    actions: {
      // form
      onMovieGateClick: noop,
      onMovieChange: noop,
      onMovieFocus: noop,
      onMovieBlur: noop,
      onSelectCustomEvent: noop,
      toggleDetails: noop,
      startSearch: noop,
      setFormCollapsed: noop,
      toggleFormCollapsed: noop,
      widenWindow: noop,
      // progress
      cancelSearch: asyncNoop,
      clearSearchError: noop,
      // results
      backToSearch: noop,
      changeFormat: noop,
      seeOtherOptions: noop,
      restart: noop,
      startHandoff: noop,
      checkMore: noop,
      dismissRecovery: noop,
      // handoff
      recheck: asyncNoop,
      clearRecheck: noop,
      retryRecheck: asyncNoop,
      restoreRecommendation: noop,
      continueHandoff: noop,
      acceptReplacement: noop,
    },
  };
}

/**
 * Overrides accepted by `makeMockVm`: every top-level field is optional, and `actions`
 * (itself a required, fully-populated object on `MockViewModel`) may be partially
 * overridden too — a test overriding one handler shouldn't have to restate the rest.
 */
type MockViewModelOverrides = Partial<Omit<MockViewModel, "actions">> & {
  actions?: Partial<MockViewModel["actions"]>;
};

/**
 * Builds a full `MockViewModel` fixture with sane defaults, overridable per test.
 * `actions` overrides merge onto the defaults so a test overriding one handler doesn't
 * have to restate the other twenty.
 */
export function makeMockVm(overrides: MockViewModelOverrides = {}): MockViewModel {
  const { actions: actionOverrides, ...rest } = overrides;
  const base = baseVm();
  return {
    ...base,
    ...rest,
    actions: { ...base.actions, ...actionOverrides },
  };
}
