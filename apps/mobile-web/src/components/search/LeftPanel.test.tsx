import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { LeftPanel } from "./LeftPanel";
import { GhostResultCard } from "./GhostResultCard";
import { CollapsedFormBar } from "./CollapsedFormBar";
import { makeMockVm, setMockVm } from "../../../test/mockViewModels";

interface FoundImage {
  source: { uri: string };
}

// Minimal DFS to find the first Image (or image-like) source in react-test-renderer tree.
function findImage(tree: Record<string, unknown> | null): FoundImage | null {
  if (!tree) return null;
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const props = (cur as Record<string, unknown>).props as Record<string, unknown> | undefined;
    const source = props?.source as { uri?: string } | undefined;
    if (source && typeof source.uri === "string") return cur as FoundImage;
    const children: unknown = props?.children;
    if (Array.isArray(children)) stack.push(...(children as unknown[]));
    else if (children && typeof children === "object") stack.push(children);
  }
  return null;
}

vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

describe("LeftPanel poster (confirmation card, State 2)", () => {
  it("renders an Image with the TMDB-resolved posterUrl when posterPath is present", () => {
    setMockVm(
      makeMockVm({
        leftIsConfirmation: true,
        movieTitleDisplay: "Dune: Part Three",
        theaterDisplay: "AMC Metreon 16 · San Francisco",
        posterUrl: "https://image.tmdb.org/t/p/w185/abc.jpg",
      }),
    );
    const el = LeftPanel() as unknown as Record<string, unknown>;
    const img = findImage(el);
    expect(img).not.toBeNull();
    expect((img as unknown as { props: { source: { uri: string } } }).props.source.uri).toBe(
      "https://image.tmdb.org/t/p/w185/abc.jpg",
    );
  });

  it("falls back to the decorative stripe (no Image) when posterUrl is null", () => {
    setMockVm(
      makeMockVm({
        leftIsConfirmation: true,
        movieTitleDisplay: "Dune: Part Three",
        theaterDisplay: "AMC Metreon 16 · San Francisco",
        posterUrl: null,
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    const el = renderer.toJSON() as unknown as Record<string, unknown>;
    expect(findImage(el)).toBeNull();
    expect(JSON.stringify(el)).toContain("Dune: Part Three");
  });
});

describe("LeftPanel State 2 enrichment (UI25)", () => {
  function renderConfirmation(overrides: Parameters<typeof makeMockVm>[0] = {}): string {
    setMockVm(
      makeMockVm({
        leftIsConfirmation: true,
        movieTitleDisplay: "Dune: Part Three",
        theaterDisplay: "AMC Metreon 16 · San Francisco",
        posterUrl: "https://image.tmdb.org/t/p/w185/abc.jpg",
        theaterDistanceLabel: null,
        movieRuntimeGenreLabel: null,
        quickPartyLabel: "4 together",
        quickWindowLabel: "This weekend · Evenings",
        quickFormatLabel: "Any format",
        seatPrefsSummaryLabel: "Recommended sweet spot",
        ...overrides,
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    return JSON.stringify(renderer.toJSON());
  }

  it("renders a distance line for a single-theatre fixture with a non-null distanceKm", () => {
    // Mirrors what the hook yields for one theatre with distanceKm 1.8: "1.1 mi".
    const str = renderConfirmation({ theaterDistanceLabel: "1.1 mi" });
    expect(str).toContain("1.1 mi away");
  });

  it("renders no distance line for a two-theatre fixture (hook yields null)", () => {
    const str = renderConfirmation({
      theaterDisplay: "2 theatres",
      theaterDistanceLabel: null,
    });
    expect(str).not.toContain("mi away");
  });

  it("renders no distance line for a single theatre with a null distanceKm", () => {
    const str = renderConfirmation({ theaterDistanceLabel: null });
    expect(str).not.toContain("mi away");
  });

  it("renders all four target-summary labeled rows", () => {
    const str = renderConfirmation({
      quickPartyLabel: "4 together",
      quickWindowLabel: "This weekend · Evenings",
      quickFormatLabel: "IMAX",
      seatPrefsSummaryLabel: "Centered · Aisle",
    });
    expect(str).toContain("SEARCH TARGET");
    for (const label of ["Party", "Window", "Format", "Placement"]) {
      expect(str).toContain(label);
    }
    expect(str).toContain("4 together");
    expect(str).toContain("This weekend · Evenings");
    expect(str).toContain("IMAX");
    expect(str).toContain("Centered · Aisle");
    expect(str).not.toContain("Preference");
  });

  it("covers seatPrefsSummaryLabel's zero/one/multiple states", () => {
    expect(renderConfirmation({ seatPrefsSummaryLabel: "Recommended sweet spot" })).toContain(
      "Recommended sweet spot",
    );
    expect(renderConfirmation({ seatPrefsSummaryLabel: "Centered" })).toContain("Centered");
    expect(renderConfirmation({ seatPrefsSummaryLabel: "Centered · Aisle" })).toContain(
      "Centered · Aisle",
    );
  });

  it("hides the summary block outside the confirmation state", () => {
    setMockVm(makeMockVm({ leftIsConfirmation: false, leftIsGhost: true }));
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Placement");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("SEARCH TARGET");
  });

  it("renders quickParty/ quickWindow/ quickFormat labels identically to CollapsedFormBar", () => {
    const shared = makeMockVm({
      leftIsConfirmation: true,
      theaterName: "AMC Metreon 16",
      theaterCity: "San Francisco",
      quickPartyLabel: "4 together",
      quickWindowLabel: "This weekend · Evenings",
      quickFormatLabel: "IMAX",
      seatPrefsSummaryLabel: "Centered",
      theaterDistanceLabel: "1.1 mi",
    });
    setMockVm(shared);
    let left!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      left = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    let bar!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      bar = TestRenderer.create(React.createElement(CollapsedFormBar, null));
    });
    const leftStr = JSON.stringify(left.toJSON());
    const barStr = JSON.stringify(bar.toJSON());
    for (const label of ["4 together", "This weekend · Evenings", "IMAX"]) {
      expect(leftStr).toContain(label);
      expect(barStr).toContain(label);
    }
  });

  it("renders the runtime/genre line only when movieRuntimeGenreLabel is non-null", () => {
    expect(renderConfirmation({ movieRuntimeGenreLabel: "2h 46m · Action, Adventure" })).toContain(
      "2h 46m · Action, Adventure",
    );
    expect(renderConfirmation({ movieRuntimeGenreLabel: null })).not.toContain("2h 46m");
  });

  it("renders the poster at 80px wide", () => {
    setMockVm(
      makeMockVm({
        leftIsConfirmation: true,
        posterUrl: "https://image.tmdb.org/t/p/w185/abc.jpg",
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    const images = renderer.root.findAll(
      (node) => (node.props as { source?: { uri?: unknown } }).source?.uri !== undefined,
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect((image.props as { style?: { width?: unknown } }).style?.width).toBe(80);
    }
  });

  it("renders a live mini seat-map whose active count matches partySize", () => {
    expect(renderConfirmation({ partySize: 2 })).toContain(
      "Seat map, 3 rows, 2 seats in indigo highlighted",
    );
    expect(renderConfirmation({ partySize: 5 })).toContain(
      "Seat map, 3 rows, 5 seats in indigo highlighted",
    );
  });

  it("renders the target mini-map with the screen bar (full variant)", () => {
    expect(renderConfirmation({})).toContain("SCREEN");
  });

  it("renders the status sentence exactly as the view model computes it", () => {
    const str = renderConfirmation({
      targetStatusLabel: "Scanning for centered, middle-third seats at AMC Metreon 16.",
    });
    expect(str).toContain("Scanning for centered, middle-third seats at AMC Metreon 16.");
  });

  it("renders the status sentence without a dangling at when no theatre is set", () => {
    const str = renderConfirmation({
      targetStatusLabel: "Scanning for centered, middle-third seats.",
    });
    expect(str).toContain("Scanning for centered, middle-third seats.");
    expect(str).not.toContain("seats at ");
  });

  it("reflects a chosen seat preference in the status sentence instead of the default", () => {
    const aisle = renderConfirmation({
      targetStatusLabel: "Scanning for aisle seats at AMC Metreon 16.",
    });
    expect(aisle).toContain("Scanning for aisle seats at AMC Metreon 16.");
    expect(aisle).not.toContain("centered, middle-third");

    const multiple = renderConfirmation({
      targetStatusLabel: "Scanning for aisle and away from the front seats at AMC Metreon 16.",
    });
    expect(multiple).toContain(
      "Scanning for aisle and away from the front seats at AMC Metreon 16.",
    );
  });

  it("renders the ghost card mini seat map and second tagline sentence", () => {
    setMockVm(makeMockVm({ leftIsConfirmation: false, leftIsGhost: true }));
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(LeftPanel, null));
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Example result");
    expect(str).toContain("Seat map, 4 rows, 4 seats in indigo highlighted");
    expect(str).toContain("One answer, not twelve seating charts.");
    expect(str).toContain("scans every showtime to find the best seats together");
    // UI26.1 — the ghost block renders through the shared component, not inline JSX.
    expect(renderer.root.findByType(GhostResultCard)).toBeDefined();
    // UI26.1 — the shared component's standalone output appears verbatim in LeftPanel's tree.
    let ghost!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      ghost = TestRenderer.create(React.createElement(GhostResultCard, null));
    });
    const panelJson = renderer.toJSON() as unknown as { children: unknown[] };
    const ghostJson = ghost.toJSON() as unknown[];
    expect(Array.isArray(ghostJson)).toBe(true);
    expect(panelJson.children).toEqual(expect.arrayContaining(ghostJson));
  });
});
