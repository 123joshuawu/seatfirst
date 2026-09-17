import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SearchForm } from "./SearchForm";
import { WhenPresetRow } from "./WhenPresetRow";
import { makeMockVm, setMockVm } from "../../../test/mockViewModels";

vi.mock("@/hooks/useTheatreSearch", () => ({ useTheatreSearch: () => ({ data: undefined }) }));
vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useWhereFieldViewModel", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@/hooks/viewModels/useWhereFieldViewModel")>();
  return {
    ...actual,
    useWhereFieldViewModel: vi.fn(() => ({
      whereFieldMode: "empty" as const,
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
      theatres: [],
      shouldShowLegacyConfirmed: false,
      showDropdown: false,
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
    })),
  };
});
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

function renderSearchForm(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(SearchForm, null));
  });
  return renderer;
}

describe("desktop CTA subtext (ADR 0044 amendment 2026-09-05)", () => {
  it("renders the guidance subtext on desktop before a match count is known", () => {
    setMockVm(
      makeMockVm({
        isMobile: false,
        theaterConfirmed: false,
        ctaSubtext: "Choose a theatre to see how many showtimes match.",
        matchingShowtimeCount: null,
      }),
    );
    const renderer = renderSearchForm();
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Choose a theatre to see how many showtimes match.");
    renderer.unmount();
  });

  it("hides the desktop subtext once a match count is known", () => {
    setMockVm(
      makeMockVm({
        isMobile: false,
        theaterConfirmed: true,
        ctaSubtext: "Seats for 2 · Fri 4 – Sun 6",
        matchingShowtimeCount: 12,
      }),
    );
    const renderer = renderSearchForm();
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("Seats for 2");
    renderer.unmount();
  });

  it("mobile keeps rendering the subtext once a match count is known", () => {
    setMockVm(
      makeMockVm({
        isMobile: true,
        theaterConfirmed: true,
        ctaSubtext: "Seats for 2 · Fri 4 – Sun 6",
        matchingShowtimeCount: 12,
      }),
    );
    const renderer = renderSearchForm();
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Seats for 2");
    renderer.unmount();
  });
});

describe("SearchForm hides the When read-out on desktop unconditionally (ADR 0044 amendment 2026-09-06)", () => {
  it("passes hideResolvedReadout=true on desktop once confirmed", () => {
    setMockVm(makeMockVm({ isMobile: false, leftIsConfirmation: true }));
    const renderer = renderSearchForm();
    expect(renderer.root.findByType(WhenPresetRow).props.hideResolvedReadout).toBe(true);
    renderer.unmount();
  });

  it("passes hideResolvedReadout=true on desktop before confirmation (ghost card state)", () => {
    setMockVm(makeMockVm({ isMobile: false, leftIsConfirmation: false }));
    const renderer = renderSearchForm();
    expect(renderer.root.findByType(WhenPresetRow).props.hideResolvedReadout).toBe(true);
    renderer.unmount();
  });

  it("passes hideResolvedReadout=false on mobile even once confirmed", () => {
    setMockVm(makeMockVm({ isMobile: true, leftIsConfirmation: true }));
    const renderer = renderSearchForm();
    expect(renderer.root.findByType(WhenPresetRow).props.hideResolvedReadout).toBe(false);
    renderer.unmount();
  });

  it("passes hideResolvedReadout=false on mobile before confirmation", () => {
    setMockVm(makeMockVm({ isMobile: true, leftIsConfirmation: false }));
    const renderer = renderSearchForm();
    expect(renderer.root.findByType(WhenPresetRow).props.hideResolvedReadout).toBe(false);
    renderer.unmount();
  });
});
