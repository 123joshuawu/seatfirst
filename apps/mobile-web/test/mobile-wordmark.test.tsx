import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppText } from "@/components/core/AppText";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import SeatfirstScreen from "../app/index";

// Same branch-pinning strategy as index-breakpoint-landmark.test.tsx: stub the
// screen's child panels (except the real Wordmark under test) so this pins the
// mobile branding behavior of app/index.tsx itself, not children's rendering.
vi.mock("@/components/search/LeftPanel", () => ({ LeftPanel: () => null }));
vi.mock("@/components/search/SearchForm", () => ({ SearchForm: () => null }));
vi.mock("@/components/search/CollapsedFormBar", () => ({ CollapsedFormBar: () => null }));
vi.mock("@/components/flow/ReplacementCard", () => ({ ReplacementCard: () => null }));
vi.mock("@/components/result/ResultScreen", () => ({ ResultScreen: () => null }));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

const widthState = vi.hoisted(() => ({ width: 390 }));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    useWindowDimensions: () => ({
      width: widthState.width,
      height: 844,
      scale: 1,
      fontScale: 1,
    }),
  };
});

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    isFormCollapsed: false,
    isCanceling: false,
    cancelError: null,
  });
}

function renderScreen(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(<SeatfirstScreen />);
  });
  if (!renderer) throw new Error("failed to render SeatfirstScreen");
  return renderer;
}

/** The shared mobile branding header renders the "Seatfirst" wordmark text. */
function wordmarkNodes(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root
    .findAllByType(AppText)
    .filter((n) => n.props.children === "Seatfirst");
}

describe("SeatfirstScreen mobile branding header (QA: missing SEATFIRST wordmark)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows the wordmark above the mobile search-form screen (390px)", () => {
    widthState.width = 390;
    useSeatfirstStore.setState({ screen: "search" });
    const renderer = renderScreen();
    expect(wordmarkNodes(renderer.root)).toHaveLength(1);
    renderer.unmount();
  });

  it("shows the wordmark above the stacked mobile results screen (390px)", () => {
    widthState.width = 390;
    useSeatfirstStore.setState({ screen: "result" });
    const renderer = renderScreen();
    expect(wordmarkNodes(renderer.root)).toHaveLength(1);
    renderer.unmount();
  });

  it("does not render the standalone mobile header on desktop (LeftPanel owns the wordmark there)", () => {
    widthState.width = 1280;
    useSeatfirstStore.setState({ screen: "search" });
    const renderer = renderScreen();
    // LeftPanel is stubbed to null here, so zero wordmarks proves the mobile
    // header is purely additive on mobile viewports.
    expect(wordmarkNodes(renderer.root)).toHaveLength(0);
    renderer.unmount();
  });
});
