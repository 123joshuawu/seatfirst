import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SearchForm } from "./SearchForm";
import { PrimaryButton } from "@/components/core/Button";
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

describe("SearchForm theatre-count loading affordance (QA BUG-04 follow-up)", () => {
  it("mobile sticky CTA shows the loading affordance (disabled) instead of a possibly-stale numeric label", () => {
    // While the FORMAT facet fetch for the current selection is in flight,
    // the settled label below would transiently undercount newly-added
    // theatres — the button must show a spinner + non-numeric text instead.
    setMockVm(
      makeMockVm({
        isMobile: true,
        theatreCountLoading: true,
        searchDisabled: false,
        submitButtonLabel: "Search 5 showtimes across 1 theatre",
      }),
    );
    const renderer = renderSearchForm();
    const button = renderer.root.findByType(PrimaryButton);
    expect(button.props.label).toBe("Checking more theatres…");
    expect(button.props.loading).toBe(true);
    expect(button.props.disabled).toBe(true);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Checking more theatres…");
    expect(str).not.toContain("Search 5 showtimes across 1 theatre");
    renderer.unmount();
  });

  it("desktop CTA passes the settled numeric label through once facet data resolves", () => {
    setMockVm(
      makeMockVm({
        isMobile: false,
        theatreCountLoading: false,
        searchDisabled: false,
        submitButtonLabel: "Search 5 showtimes across 1 theatre",
      }),
    );
    const renderer = renderSearchForm();
    const button = renderer.root.findByType(PrimaryButton);
    expect(button.props.label).toBe("Search 5 showtimes across 1 theatre");
    expect(button.props.loading).toBe(false);
    expect(button.props.disabled).toBe(false);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Search 5 showtimes across 1 theatre");
    expect(str).not.toContain("Checking more theatres");
    renderer.unmount();
  });
});
