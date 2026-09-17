import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Pressable } from "react-native";
import fs from "fs";
import path from "path";
import { SearchForm } from "./SearchForm";
import { HowItWorksSheet } from "./HowItWorksSheet";
import { PrimaryButton } from "@/components/core/Button";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { makeMockVm, setMockVm } from "../../../test/mockViewModels";

vi.mock("@/hooks/useTheatreSearch", () => ({ useTheatreSearch: () => ({ data: undefined }) }));
vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useWhereFieldViewModel", () => ({
  useWhereFieldViewModel: () => ({
    whereFieldMode: "empty" as const,
    inputValue: "",
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
  }),
}));
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

const MOBILE_SUBTITLE =
  "One answer, not twelve seating charts. We scan every showtime to find the best seats together.";
const DESKTOP_SUBTITLE = "Choose where to sit before choosing when to go.";
const TRIGGER_LABEL = "See how it works →";

function createRenderer(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(el);
  });
  return renderer;
}

function press(node: TestRenderer.ReactTestInstance): void {
  const onPress = (node.props as { onPress: () => void }).onPress;
  TestRenderer.act(() => {
    onPress();
  });
}
function renderSearchForm(isMobile: boolean): TestRenderer.ReactTestRenderer {
  setMockVm(
    makeMockVm({
      isMobile,
      submitButtonLabel: "Find my seats",
    }),
  );
  return createRenderer(React.createElement(SearchForm, null));
}

function findTrigger(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance | null {
  const found = renderer.root.findAllByType(Pressable);
  return found.find((node) => node.props.accessibilityLabel === "See how it works") ?? null;
}

function findClose(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance | null {
  const found = renderer.root.findAllByType(Pressable);
  return found.find((node) => node.props.accessibilityLabel === "Close how it works") ?? null;
}

describe("UI26.2 header subtitle is platform-conditional", () => {
  it("mobile renders the value-prop subtitle, not the desktop tagline", () => {
    const renderer = renderSearchForm(true);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain(MOBILE_SUBTITLE);
    expect(str).not.toContain(DESKTOP_SUBTITLE);
    renderer.unmount();
  });

  it("desktop renders the unchanged tagline, not the mobile subtitle", () => {
    const renderer = renderSearchForm(false);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain(DESKTOP_SUBTITLE);
    expect(str).not.toContain(MOBILE_SUBTITLE);
    renderer.unmount();
  });
});

describe("UI26.3 trigger is mobile-only and sits below the subtitle", () => {
  it("mobile renders the trigger below the subtitle and above the submit button", () => {
    const renderer = renderSearchForm(true);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain(TRIGGER_LABEL);
    expect(str.indexOf(MOBILE_SUBTITLE)).toBeLessThan(str.indexOf(TRIGGER_LABEL));
    expect(str.indexOf(TRIGGER_LABEL)).toBeLessThan(str.indexOf("Find my seats"));
    renderer.unmount();
  });

  it("desktop renders no trigger", () => {
    const renderer = renderSearchForm(false);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain(TRIGGER_LABEL);
    expect(findTrigger(renderer)).toBeNull();
    renderer.unmount();
  });
});

describe("UI26.4 sheet opens on tap, closes on ×, starts closed", () => {
  it("sheet starts closed and opens on trigger tap showing the ghost card", () => {
    const renderer = renderSearchForm(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Example result");
    const trigger = findTrigger(renderer);
    expect(trigger).not.toBeNull();
    press(trigger as TestRenderer.ReactTestInstance);
    const open = JSON.stringify(renderer.toJSON());
    expect(open).toContain("Example result");
    expect(open).toContain("Row G, Seats 8–11");
    renderer.unmount();
  });

  it("pressing the × close control hides the sheet again", () => {
    const renderer = renderSearchForm(true);
    press(findTrigger(renderer) as TestRenderer.ReactTestInstance);
    expect(JSON.stringify(renderer.toJSON())).toContain("Example result");
    const close = findClose(renderer);
    expect(close).not.toBeNull();
    press(close as TestRenderer.ReactTestInstance);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Example result");
    renderer.unmount();
  });

  it("HowItWorksSheet renders null when closed", () => {
    const renderer = createRenderer(
      React.createElement(HowItWorksSheet, { open: false, onClose: vi.fn() }),
    );
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});

describe("UI26.5 sheet never mounts open on desktop", () => {
  it("desktop SearchForm shows no ghost-card surface of its own", () => {
    const renderer = renderSearchForm(false);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain(TRIGGER_LABEL);
    expect(str).not.toContain("Example result");
    expect(findClose(renderer)).toBeNull();
    renderer.unmount();
  });
});

describe("UI26.4/UI26.6 no visit persistence", () => {
  it("this task's components use no storage or visit-detection mechanism", () => {
    const root = process.cwd().endsWith("apps/mobile-web")
      ? process.cwd()
      : path.join(process.cwd(), "apps/mobile-web");
    const searchDir = fs.existsSync(path.join(root, "src/components/search"))
      ? path.join(root, "src/components/search")
      : path.join(process.cwd(), "src/components/search");
    for (const file of ["SearchForm.tsx", "HowItWorksSheet.tsx", "GhostResultCard.tsx"]) {
      const src = fs.readFileSync(path.join(searchDir, file), "utf8");
      expect(src).not.toContain("localStorage");
      expect(src).not.toContain("AsyncStorage");
      expect(src.toLowerCase()).not.toContain("hasvisited");
      expect(src.toLowerCase()).not.toContain("firstvisit");
    }
  });
});

describe("UX audit P0: mobile sticky submit bar", () => {
  function findStickyBar(
    renderer: TestRenderer.ReactTestRenderer,
  ): TestRenderer.ReactTestInstance | null {
    const found = renderer.root.findAll(
      (node) => (node.props as { testID?: string })?.testID === "mobile-sticky-cta",
    );
    return found[0] ?? null;
  }

  it("mobile anchors the single submit button in a sticky bottom bar", () => {
    const renderer = renderSearchForm(true);
    const bar = findStickyBar(renderer);
    expect(bar).not.toBeNull();
    const barStyle = (bar!.props as { style?: { position?: string; bottom?: number } }).style;
    expect(barStyle?.position).toBe("sticky");
    expect(barStyle?.bottom).toBe(0);
    const buttons = renderer.root.findAllByType(PrimaryButton);
    // One button, unchanged label — wrapped, never duplicated.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.label).toBe("Find my seats");
    expect(buttons[0]!.parent?.props.testID).toBe("mobile-sticky-cta");
    renderer.unmount();
  });

  it("desktop renders the plain submit button with no sticky bar", () => {
    const renderer = renderSearchForm(false);
    expect(findStickyBar(renderer)).toBeNull();
    const buttons = renderer.root.findAllByType(PrimaryButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.label).toBe("Find my seats");
    renderer.unmount();
  });
});

describe("UX audit P2: custom sheet header distinguishes count from span", () => {
  function renderWithDraft(dates: string[]): string {
    const before = useSeatfirstStore.getState().selectedDates;
    useSeatfirstStore.setState({
      whenSheetOpen: true,
      selectedDates: dates,
    });
    const renderer = renderSearchForm(false);
    const str = JSON.stringify(renderer.toJSON());
    renderer.unmount();
    useSeatfirstStore.setState({ whenSheetOpen: false, selectedDates: before });
    return str;
  }

  it("shows the selected-day count and the calendar span as separate values", () => {
    // Three scattered days across a five-day span: count and span differ on screen.
    const str = renderWithDraft(["2026-09-03", "2026-09-05", "2026-09-07"]);
    expect(str).toContain("3 days selected · 5-day span (max 30)");
  });

  it("uses singular grammar for a single selected day", () => {
    const str = renderWithDraft(["2026-09-03"]);
    expect(str).toContain("1 day selected · 1-day span (max 30)");
  });
});
