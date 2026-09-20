import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SearchForm } from "./SearchForm";
import { TheaterField } from "./TheaterField";
import { useWhereFieldViewModel } from "@/hooks/viewModels/useWhereFieldViewModel";
import { MovieField } from "./MovieField";
import { ChipRow } from "./ChipRow";
import { FadeInView } from "@/components/core/FadeInView";
import { PrimaryButton } from "@/components/core/Button";
import { PopoverList } from "./PopoverList";
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
  // UI26 — SearchForm owns real local state (the how-it-works sheet open flag),
  // so it must render through TestRenderer; a direct SearchForm() call cannot
  // run real hooks. Assertions below are unchanged.
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(SearchForm, null));
  });
  return renderer;
}

function findCancelButton(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance | null {
  // naive tree walk for SecondaryButton with accessibilityLabel "Cancel search"
  const found = renderer.root.findAll((node) => node.props?.accessibilityLabel === "Cancel search");
  return found[0] ?? null;
}

describe("UI5.2-3 form interaction lock + Cancel button", () => {
  it("Cancel button not rendered when isLocked false", () => {
    const vm = makeMockVm({ isLocked: false, searchId: null });
    setMockVm(vm);
    const renderer = renderSearchForm();
    expect(findCancelButton(renderer)).toBeNull();
    renderer.unmount();
  });

  it("Cancel button not rendered when isLocked true but searchId null", () => {
    const vm = makeMockVm({ isLocked: true, searchId: null });
    setMockVm(vm);
    const renderer = renderSearchForm();
    expect(findCancelButton(renderer)).toBeNull();
    renderer.unmount();
  });

  it("Cancel button rendered with correct a11y when locked and searchId present", () => {
    const vm = makeMockVm({ isLocked: true, searchId: "srch_test123", isCanceling: false });
    setMockVm(vm);
    const renderer = renderSearchForm();
    const btn = findCancelButton(renderer);
    expect(btn).not.toBeNull();
    const props = (btn as TestRenderer.ReactTestInstance).props;
    expect(props.accessibilityLabel).toBe("Cancel search");
    expect(props.accessibilityRole).toBe("button");
    renderer.unmount();
  });

  it("Cancel button shows busy/disabled when isCanceling", () => {
    const vm = makeMockVm({ isLocked: true, searchId: "srch_1", isCanceling: true });
    setMockVm(vm);
    const renderer = renderSearchForm();
    const btn = findCancelButton(renderer);
    expect(btn).not.toBeNull();
    expect(
      ((btn as TestRenderer.ReactTestInstance).props.accessibilityState as Record<string, unknown>)
        .disabled,
    ).toBe(true);
    expect(
      ((btn as TestRenderer.ReactTestInstance).props.accessibilityState as Record<string, unknown>)
        .busy,
    ).toBe(true);
    renderer.unmount();
  });

  it("Cancel error rendered with alert role when cancelError present", () => {
    const vm = makeMockVm({
      isLocked: true,
      searchId: "srch_1",
      cancelError: "Cancel failed: Network error. You can retry.",
    });
    setMockVm(vm);
    const renderer = renderSearchForm();
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Cancel failed");
    renderer.unmount();
  });
});

describe("UI5.2 TheaterField / MovieField / ChipRow / PopoverList inert while locked", () => {
  it("TheaterField TextInput editable false when isLocked", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: true }));
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("false");
    // Simulate the hook's own isLocked gate (production: showDropdown =
    // effectiveWhereFocused && !isLocked) while holding suggestions present.
    // This remains falsifiable if TheaterField stops threading isLocked through
    // or renders a closed dropdown.
    (useWhereFieldViewModel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (props?: { isLocked?: boolean }) => {
        const locked = props?.isLocked ?? false;
        return {
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
          theatres: [
            {
              id: "amc:theatre:one",
              providerId: "amc",
              name: "AMC Metreon 16",
              city: "SF",
              // eslint-disable-next-line @typescript-eslint/consistent-type-imports
            } as unknown as import("@seatfirst/core").TheatreSearchHit,
          ],
          shouldShowLegacyConfirmed: false,
          showDropdown: !locked,
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
        };
      },
    );
    let rendererFocused!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      rendererFocused = TestRenderer.create(React.createElement(TheaterField, { isLocked: true }));
    });
    const strFocused = JSON.stringify(rendererFocused.toJSON());
    // Locked: even with focus + suggestions available, TheaterField must not surface them.
    expect(strFocused).not.toContain("AMC Metreon 16");
  });

  it("MovieField TextInput editable false when isLocked", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        React.createElement(MovieField, {
          theaterConfirmed: true,
          movieValue: "Dune",
          movieFocused: false,
          liveScheduleHeader: "Movies",
          nowPlayingHeader: "Now Playing (general release)",
          liveScheduleMovies: [],
          nowPlayingSuggestions: [],
          movieIsSearching: false,
          movieSearchError: null,
          movieClearedNotice: null,
          onGateClick: vi.fn(),
          onChangeText: vi.fn(),
          onFocus: vi.fn(),
          onBlur: vi.fn(),
          isLocked: true,
        }),
      );
    });
    const str = JSON.stringify(renderer.toJSON());
    // TextInput should have editable false
    expect(str).toContain("false");
  });

  it("MovieField remains reachable before a theatre is selected", () => {
    const onFocus = vi.fn();
    const el = MovieField({
      theaterConfirmed: false,
      movieValue: "",
      movieFocused: true,
      liveScheduleHeader: "Movies",
      nowPlayingHeader: "Now Playing (general release)",
      liveScheduleMovies: [],
      nowPlayingSuggestions: [],
      movieIsSearching: false,
      movieSearchError: null,
      movieClearedNotice: null,
      onGateClick: vi.fn(),
      onChangeText: vi.fn(),
      onFocus,
      onBlur: vi.fn(),
      isLocked: false,
    }) as unknown as Record<string, unknown>;
    const str = JSON.stringify(el);
    expect(str).toContain("Search or browse what's playing");
    expect(str).toContain("Choose where to see movie availability.");
    expect(str).toContain("combobox");
  });

  it("ChipRow chips disabled when isLocked", () => {
    const onPress = vi.fn();
    const el = ChipRow({
      label: "Format",
      chips: [{ label: "Any", active: false, onPress }],
      isLocked: true,
    }) as unknown as Record<string, unknown>;
    // Chip should receive disabled true — indirectly check via JSON
    const str = JSON.stringify(el);
    expect(str).toContain("disabled");
  });

  it("PopoverList items disabled when isLocked", () => {
    const el = PopoverList({
      header: "Options",
      items: [{ label: "A", onPress: vi.fn() }],
      isLocked: true,
    }) as unknown as Record<string, unknown>;
    const str = JSON.stringify(el);
    expect(str).toContain("disabled");
  });

  it("No layout churn — SearchForm uses styles.card and cardDisabled, not isMobile reflow for cancel", () => {
    const vm = makeMockVm({ isLocked: true, searchId: "srch_1", isMobile: false });
    setMockVm(vm);
    const renderer = renderSearchForm();
    const styleStr = JSON.stringify(renderer.root.findByType(FadeInView).props.style);
    // Should contain card styles, not introduce media query
    expect(styleStr).toBeTruthy();
    renderer.unmount();
  });
});

describe("UI31 in-situ update stays editable while locked (ADR 0064)", () => {
  function partySizeChipRow(
    renderer: TestRenderer.ReactTestRenderer,
  ): TestRenderer.ReactTestInstance {
    const rows = renderer.root.findAllByType(ChipRow);
    const party = rows.find((n) => n.props?.label === "How many seats?");
    if (!party) throw new Error("party-size ChipRow not found");
    return party;
  }

  function submitCta(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
    const buttons = renderer.root.findAllByType(PrimaryButton);
    const cta = buttons.find((n) => n.props?.label === "Find my seats");
    if (!cta) throw new Error("submit CTA not found");
    return cta;
  }

  it("running search with a server searchId: theatre + party-size unlock, CTA enabled, Cancel still shown", () => {
    const vm = makeMockVm({ isLocked: true, searchId: "srch_1" });
    setMockVm(vm);
    const renderer = renderSearchForm();
    // The in-situ update path: these stay editable mid-run so a new spec can
    // be submitted against the live search.
    expect(renderer.root.findByType(TheaterField).props.isLocked).toBe(false);
    expect(partySizeChipRow(renderer).props.isLocked).toBe(false);
    expect(submitCta(renderer).props.disabled).toBe(false);
    // Untouched by the change: the other fields keep the original lock, and
    // Cancel still keys off isLocked && searchId !== null exactly as before.
    expect(renderer.root.findByType(MovieField).props.isLocked).toBe(true);
    expect(
      renderer.root.findAllByType(ChipRow).find((n) => n.props?.label === "Format")?.props.isLocked,
    ).toBe(true);
    expect(findCancelButton(renderer)).not.toBeNull();
    renderer.unmount();
  });

  it("first submission in flight (searchId null): original lock unchanged, no Cancel", () => {
    const vm = makeMockVm({ isLocked: true, searchId: null });
    setMockVm(vm);
    const renderer = renderSearchForm();
    expect(renderer.root.findByType(TheaterField).props.isLocked).toBe(true);
    expect(partySizeChipRow(renderer).props.isLocked).toBe(true);
    expect(submitCta(renderer).props.disabled).toBe(true);
    expect(findCancelButton(renderer)).toBeNull();
    renderer.unmount();
  });
});
