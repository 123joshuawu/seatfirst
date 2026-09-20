import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { MovieField } from "./MovieField";
import { TheaterField } from "./TheaterField";

import { useSeatfirstStore } from "@/store/seatfirstStore";
import fs from "fs";
import path from "path";
import { makeMockVm } from "../../../test/mockViewModels";

vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({
    data: { theatres: [{ id: "amc:theatre:one", name: "AMC One", city: "SF", distanceKm: 1.1 }] },
    isFetching: false,
  }),
}));
vi.mock("@/lib/geocodeSeam", () => ({
  createGeocodeResolver: () => ({ resolvePlace: vi.fn() }),
}));

function jsonString(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON() ?? renderer.toTree());
}

function createRenderer(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useWhereFieldViewModel", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@/hooks/viewModels/useWhereFieldViewModel")>();
  return {
    ...actual,
    useWhereFieldViewModel: () => ({
      whereFieldMode: "theatres" as const,
      inputValue: "AMC",
      isSearching: false,
      isSuggesting: false,
      suggestCandidates: [],
      showPlaceSignpost: false,
      effectiveTheatreSearchError: null,
      showPlaceChip: false,
      showDeviceChip: false,
      showTheatreChips: false,
      placeChipLabel: "",
      deviceChipLabel: "",
      geolocationError: null,
      geolocationBusy: false,
      placeError: null,
      placeErrorKind: null,
      isResolvingPlace: false,
      activeDescendantId: null,
      activeIndex: -1,
      activeKey: null,
      theatres: [{ id: "amc:theatre:one", theatreId: "amc:theatre:one", name: "AMC One" }],
      shouldShowLegacyConfirmed: false,
      showDropdown: true,
      inputAriaProps: {},
      wherePlace: null,
      deviceCenter: null,
      selectedTheatres: [],
      whereRadiusKm: 10,
      actions: {
        handleChangeText: vi.fn(),
        handleFocus: vi.fn(),
        handleBlur: vi.fn(),
        handleSelectTheatre: vi.fn(),
        handleSelectCandidate: vi.fn(),
        handleClearWhere: vi.fn(),
        handleConvertWherePlaceToTheatres: vi.fn(),
        handleFollowPlaceSignpost: vi.fn(),
        handleRemovePlaceChip: vi.fn(),
        handleRemoveTheatreChip: vi.fn(),
        handleBackspaceRemoveLast: vi.fn(),
        handleUseLocation: vi.fn(),
        handleResolvePlace: vi.fn(),
        handleKeyDown: vi.fn(),
        setWhereRadiusKm: vi.fn(),
      },
    }),
  };
});
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

describe("UI18.7 dead-end forward action", () => {
  beforeEach(() => {
    useSeatfirstStore.setState({
      selectedTheatres: [{ id: "amc:theatre:one", providerId: "amc" }],
    });
  });

  it("warm-zero movie row shows forward action none · Try tomorrow →", () => {
    const widen = vi.fn();
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        liveScheduleHeader: "Now playing at AMC",
        nowPlayingHeader: "Now Playing (general release)",
        liveScheduleMovies: [{ label: "Dead Movie", onPress: vi.fn() }],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
        movieCounts: new Map([["Dead Movie", { count: 0, coldTheatreCount: 0 }]]),
        onWidenWindow: widen,
      }),
    );
    const str = jsonString(renderer);
    expect(str).toContain("none · Try tomorrow →");
    renderer.unmount();
  });

  it("cold zero movie row does NOT show forward action", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        liveScheduleHeader: "Now playing at AMC",
        nowPlayingHeader: "Now Playing (general release)",
        liveScheduleMovies: [{ label: "Cold Movie", onPress: vi.fn() }],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
        movieCounts: new Map([["Cold Movie", { count: 0, coldTheatreCount: 1 }]]),
        onWidenWindow: vi.fn(),
      }),
    );
    const str = jsonString(renderer);
    expect(str).not.toContain("Try tomorrow");
    renderer.unmount();
  });

  it("warm-zero movie row does not hide row", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        liveScheduleHeader: "Now playing at AMC",
        nowPlayingHeader: "Now Playing (general release)",
        liveScheduleMovies: [{ label: "Dead Movie", onPress: vi.fn() }],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
        movieCounts: new Map([["Dead Movie", { count: 0, coldTheatreCount: 0 }]]),
        onWidenWindow: vi.fn(),
      }),
    );
    const str = jsonString(renderer);
    expect(str).toContain("Dead Movie");
    expect(str).toContain("none · Try tomorrow →");
    renderer.unmount();
  });

  it("warm-zero theatre row shows Any time → via TheaterField", () => {
    const widen = vi.fn();
    const renderer = createRenderer(
      React.createElement(TheaterField, {
        theatreCounts: new Map([["amc:theatre:one", { count: 0, coldTheatreCount: 0 }]]),
        warmZeroTheatreIds: new Set(["amc:theatre:one"]),
        onWidenWindow: widen,
      }),
    );
    const str = jsonString(renderer);
    expect(str).toContain("Any time →");
    renderer.unmount();
  });

  it("tapping warm-zero calls widenWindow not new search", () => {
    const widen = vi.fn();
    const startSearch = vi.fn();
    const vm = makeMockVm({
      matchingShowtimeCount: 5,
      warmTheatreCount: 2,
      submitButtonLabel: "Search 5 showtimes across 2 theatres",
      actions: {
        backToSearch: vi.fn(),
        changeFormat: vi.fn(),
        widenWindow: widen,
        onMovieGateClick: vi.fn(),
        onMovieChange: vi.fn(),
        onMovieFocus: vi.fn(),
        onMovieBlur: vi.fn(),
        toggleDetails: vi.fn(),
        startSearch,
        restoreRecommendation: vi.fn(),
        continueHandoff: vi.fn(),
        acceptReplacement: vi.fn(),
        seeOtherOptions: vi.fn(),
        restart: vi.fn(),
        cancelSearch: vi.fn(),
        recheck: vi.fn(),
        startHandoff: vi.fn(),
        clearRecheck: vi.fn(),
        retryRecheck: vi.fn(),
        setFormCollapsed: vi.fn(),
        toggleFormCollapsed: vi.fn(),
        checkMore: vi.fn(),
      },
    });
    vm.actions.widenWindow();
    expect(widen).toHaveBeenCalled();
    expect(startSearch).not.toHaveBeenCalled();
  });
});

describe("UI18.8 CTA warm-count scope", () => {
  it("button shows Search N showtimes across M theatres using warm counts", () => {
    const vm = makeMockVm({
      matchingShowtimeCount: 34,
      warmTheatreCount: 3,
      submitButtonLabel: "Search 34 showtimes across 3 theatres",
    });
    expect(vm.submitButtonLabel).toContain("Search 34 showtimes across 3 theatres");
  });
  it("CTA advisory hint appears when obviously too broad", () => {
    const vm = makeMockVm({
      matchingShowtimeCount: 999,
      warmTheatreCount: 5,
      ctaAdvisoryLabel: "Broad selection — consider narrowing theatre or time",
      submitButtonLabel: "Search 999 showtimes across 5 theatres",
    });
    expect(vm.ctaAdvisoryLabel).toContain("Broad selection");
  });
  it("authoritative block via the create-rejection path", () => {
    const vm = makeMockVm({
      capacityBlockLabel:
        "237 showtimes match — above the 200 limit. Narrow your filters to continue.",
    });
    expect(vm.capacityBlockLabel).toContain("237 showtimes match");
  });
  it("no 200 literal in dead-end/CTA logic — uses constant", () => {
    const root = process.cwd();
    const widenPath = fs.existsSync(path.join(root, "src/store/flowSlice.ts"))
      ? path.join(root, "src/store/flowSlice.ts")
      : path.join(root, "apps/mobile-web/src/store/flowSlice.ts");
    const ctaPath = fs.existsSync(
      path.join(root, "src/hooks/viewModels/useSubmitSearchViewModel.ts"),
    )
      ? path.join(root, "src/hooks/viewModels/useSubmitSearchViewModel.ts")
      : path.join(root, "apps/mobile-web/src/hooks/viewModels/useSubmitSearchViewModel.ts");
    const searchFormPath = fs.existsSync(path.join(root, "src/components/search/SearchForm.tsx"))
      ? path.join(root, "src/components/search/SearchForm.tsx")
      : path.join(root, "apps/mobile-web/src/components/search/SearchForm.tsx");
    const widenSrc = fs.readFileSync(widenPath, "utf8");
    const ctaSrc = fs.readFileSync(ctaPath, "utf8");
    const searchFormSrc = fs.readFileSync(searchFormPath, "utf8");
    expect(ctaSrc).toContain("DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes");
    const logic = searchFormSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(logic).not.toMatch(/\b200\b/);
    expect(widenSrc).not.toMatch(/\b200\b/);
  });
  it("CTA disabled gate remains no-guess plus capacity busy", () => {
    const vm = makeMockVm({ searchDisabled: true, capacityGateBusy: true });
    expect(vm.searchDisabled).toBe(true);
    expect(vm.capacityGateBusy).toBe(true);
  });
});
