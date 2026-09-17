import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", async () => {
  const actual = await vi.importActual<
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import("@/hooks/viewModels/useSubmitSearchViewModel")
  >("@/hooks/viewModels/useSubmitSearchViewModel");
  return { useSubmitSearchViewModel: vi.fn(actual.useSubmitSearchViewModel) };
});
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", async () => {
  const actual = await vi.importActual<
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import("@/hooks/viewModels/useSearchProgressViewModel")
  >("@/hooks/viewModels/useSearchProgressViewModel");
  return { useSearchProgressViewModel: vi.fn(actual.useSearchProgressViewModel) };
});
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", async () => {
  const actual = await vi.importActual<
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import("@/hooks/viewModels/useSearchResultsViewModel")
  >("@/hooks/viewModels/useSearchResultsViewModel");
  return { useSearchResultsViewModel: vi.fn(actual.useSearchResultsViewModel) };
});
vi.mock("@/hooks/viewModels/useHandoffViewModel", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import("@/hooks/viewModels/useHandoffViewModel")>(
    "@/hooks/viewModels/useHandoffViewModel",
  );
  return { useHandoffViewModel: vi.fn(actual.useHandoffViewModel) };
});
import { makeMockVm, setMockVm } from "./mockViewModels";

vi.mock("@/lib/trpc", () => ({
  trpc: {},
  trpcClient: {},
  getTrpcUrl: () => "http://localhost:3000/trpc",
  queryClient: { clear: vi.fn() },
}));
vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

import { useSeatfirstDemo } from "./useSeatfirstDemo";
import { ResultScreen } from "@/components/result/ResultScreen";
import type { ScheduleSkeletonEntry } from "@seatfirst/core";

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...searchInitialState,
    ...flowInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    selectedTheatre: null,
    selectedTheatreMovies: null,
    searchId: null,
    status: null,
    resolved: 0,
    total: 0,
    groups: [],
    answer: null,
    scheduleSkeleton: [],
    terminalCause: null,
    phase: "idle",
    screen: "search",
  });
}

let lastHookRenderer: TestRenderer.ReactTestRenderer | null = null;
function renderHook<T>(hook: () => T): { result: { current: T } } {
  let result!: { current: T };
  function Wrapper() {
    result = { current: hook() };
    return null;
  }
  act(() => {
    if (lastHookRenderer) {
      lastHookRenderer.unmount();
    }
    lastHookRenderer = TestRenderer.create(React.createElement(Wrapper));
  });
  return { result };
}

describe("provisional-200 guard — no invented total before skeleton truth", () => {
  beforeEach(() => {
    if (lastHookRenderer) {
      act(() => {
        lastHookRenderer!.unmount();
      });
      lastHookRenderer = null;
    }
    resetStore();
  });

  it("when RUNNING with liveTotal=200 but skeleton empty, totalShowtimes is 0 (indeterminate), not 200", () => {
    useSeatfirstStore.setState({
      status: "RUNNING",
      resolved: 0,
      total: 200,
      scheduleSkeleton: [],
      searchId: "srch_test",
      phase: "streaming",
      screen: "checking",
    });
    const { result } = renderHook(() => useSeatfirstDemo());
    expect(result.current.totalShowtimes).toBe(0);
    expect(result.current.checkedCount).toBe(0);
  });

  it("when skeleton has 11 admitted entries, totalShowtimes prefers 11 over provisional 200", () => {
    const skeleton: ScheduleSkeletonEntry[] = Array.from({ length: 11 }, (_, i) => ({
      showtimeId: `amc:showtime:${1000 + i}`,
      theatreId: "amc:theatre:2325",
      showDateTimeLocal: "2026-08-26T19:00:00",
      formatCode: "STANDARD",
      distanceKm: null,
      rank: i,
      admitted: true,
      resolved: false,
    })) as unknown as ScheduleSkeletonEntry[];
    useSeatfirstStore.setState({
      status: "RUNNING",
      resolved: 3,
      total: 200,
      scheduleSkeleton: skeleton,
      searchId: "srch_test2",
      phase: "streaming",
      screen: "checking",
    });
    const { result } = renderHook(() => useSeatfirstDemo());
    expect(result.current.totalShowtimes).toBe(11);
    expect(result.current.checkedCount).toBe(3);
  });

  it("when RUNNING with liveTotal=11 (non-provisional) but skeleton empty, totalShowtimes preserves 11", () => {
    useSeatfirstStore.setState({
      status: "RUNNING",
      resolved: 2,
      total: 11,
      scheduleSkeleton: [],
      searchId: "srch_test3",
      phase: "streaming",
      screen: "checking",
    });
    const { result } = renderHook(() => useSeatfirstDemo());
    expect(result.current.totalShowtimes).toBe(11);
    expect(result.current.checkedCount).toBe(2);
  });

  it("when terminal COMPLETE with liveTotal=200 and skeleton empty, totalShowtimes preserves 200 (not indeterminate)", () => {
    useSeatfirstStore.setState({
      status: "COMPLETE",
      resolved: 200,
      total: 200,
      scheduleSkeleton: [],
      searchId: "srch_test4",
      phase: "terminal",
      screen: "result",
    });
    const { result } = renderHook(() => useSeatfirstDemo());
    expect(result.current.totalShowtimes).toBe(200);
    expect(result.current.checkedCount).toBe(200);
  });

  it("ResultScreen with skeleton-empty RUNNING does not render 'of 200' (shows indeterminate)", () => {
    const vm = makeMockVm({
      isMobile: false,
      isFormCollapsed: false,
      showLeftCol: true,
      leftIsGhost: false,
      leftIsConfirmation: false,
      leftIsAuditorium: false,
      isChecking: true,
      isTerminal: false,
      checkedCount: 0,
      totalShowtimes: 0,
      movieTitleDisplay: "Dune",
      theaterDisplay: "AMC Metreon 16",
      activePlacement: null,
      gridRows: [],
      showSearchForm: false,
      theaterConfirmed: true,
      theaterName: "AMC Metreon 16",
      theaterCity: "SF",
      movieValue: "Dune",
      movieFocused: false,
      movieSuggestionsHeader: "",
      movieSuggestions: [],
      movieIsSearching: false,
      movieSearchError: null,
      movieClearedNotice: null,
      formatOptions: [],
      partySizeChips: [],
      seatPrefChips: [],
      seatPrefDescription: "",
      detailsExpanded: false,
      detailsToggleLabel: "More filters",
      quickWindowLabel: "This weekend · Evenings",
      quickFormatLabel: "Any format",
      quickPartyLabel: "4 together",
      searchDisabled: false,
      matchingShowtimeCount: 11,
      posterUrl: null,
      isLocked: true,
      isScanRunning: true,
      isCanceling: false,
      cancelError: null,
      searchId: "srch_test",
      handoffEligibleShowtimeIds: [],
      noValidActions: [],
      answer: null,
      answerMode: null,
      groups: [],
      searchStatus: "RUNNING" as const,
      terminalStatus: null,
      otherFormatsLabel: null,
      emptyCause: null,
      emptyCauseLabel: null,
      terminalBannerLabel: null,
      admissionRejected: null,
      admissionRejectedLabel: null,
      liveResolved: 0,
      liveTotal: 200,
      recheckStatus: "idle" as const,
      isRechecking: false,
      recheckResult: null,
      recheckErrorCode: null,
      recheckErrorMessage: null,
      recheckErrorLabel: null,
      recheckStoreStatus: "idle" as const,
      scheduleSkeleton: [],
      terminalCause: null,
      phase: "streaming" as const,
      partySize: 4,
      submitButtonLabel: "Search 11 showtimes",
      phaseDetail: null,
      canCheckMore: false,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      setMockVm(vm);
      renderer = TestRenderer.create(React.createElement(ResultScreen, null));
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Evaluating adjacent seats for party of 4…");
    expect(str).not.toContain("of 200");
  });
});
