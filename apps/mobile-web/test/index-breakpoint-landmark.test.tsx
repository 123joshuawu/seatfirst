import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import SeatfirstScreen from "../app/index";

// The layout branch under test depends only on viewport width and store state;
// stub the screen's child panels so the test pins the breakpoint behavior of
// app/index.tsx itself, not the children's rendering.
vi.mock("@/components/search/LeftPanel", () => ({ LeftPanel: () => null }));
vi.mock("@/components/search/SearchForm", () => ({ SearchForm: () => null }));
vi.mock("@/components/search/CollapsedFormBar", () => ({ CollapsedFormBar: () => null }));
vi.mock("@/components/flow/ReplacementCard", () => ({ ReplacementCard: () => null }));
vi.mock("@/components/result/ResultScreen", () => ({ ResultScreen: () => null }));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

const widthState = vi.hoisted(() => ({ width: 1024 }));
vi.mock("react-native", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- typed importOriginal mirrors SearchForm.lock.test.tsx; keeps the RN mock's real exports while overriding only the width hook
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    useWindowDimensions: () => ({
      width: widthState.width,
      height: 800,
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

function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(style)) {
    for (const part of style) Object.assign(out, flattenStyle(part));
  } else if (style && typeof style === "object") {
    Object.assign(out, style);
  }
  return out;
}

function styleOf(node: ReactTestInstance): Record<string, unknown> {
  const props = (node.props ?? {}) as { style?: unknown };
  return flattenStyle(props.style);
}

/** The two-column desktop row is the only container with a row direction and a ~1000px maxWidth. */
function hasTwoColumnRow(root: ReactTestInstance): boolean {
  return (
    root.findAll((node) => {
      const style = styleOf(node);
      return style.flexDirection === "row" && (style.maxWidth === 1120 || style.maxWidth === 980);
    }).length > 0
  );
}

/** The stacked single-column container caps at 920px and is never a row. */
function hasStackedContainer(root: ReactTestInstance): boolean {
  return (
    root.findAll((node) => {
      const style = styleOf(node);
      return style.maxWidth === 920 && style.flexDirection !== "row";
    }).length > 0
  );
}

function scrollViewNode(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => (node.type as string) === "ScrollView");
}

describe("SeatfirstScreen responsive collapse + main landmark (QA findings 2/10)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("collapses to the stacked single-column layout at 768px tablet width", () => {
    widthState.width = 768;
    const renderer = renderScreen();
    expect(hasTwoColumnRow(renderer.root)).toBe(false);
    expect(hasStackedContainer(renderer.root)).toBe(true);
    renderer.unmount();
  });

  it("keeps the two-column desktop row on wide viewports", () => {
    widthState.width = 1280;
    const renderer = renderScreen();
    expect(hasTwoColumnRow(renderer.root)).toBe(true);
    expect(hasStackedContainer(renderer.root)).toBe(false);
    renderer.unmount();
  });

  it("marks the primary scroll region as a main landmark", () => {
    widthState.width = 1280;
    const renderer = renderScreen();
    expect(scrollViewNode(renderer.root).props.role).toBe("main");
    renderer.unmount();
  });
});
