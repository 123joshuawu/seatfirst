import React from "react";
import TestRenderer from "react-test-renderer";
import { Image } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { MovieField } from "./MovieField";
import { PopoverList } from "./PopoverList";

function createRenderer(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

function findImagesFromRenderer(
  renderer: TestRenderer.ReactTestRenderer,
): Array<{ props: { source: { uri: string }; style?: unknown; onError?: () => void } }> {
  return renderer.root.findAllByType(Image) as unknown as Array<{
    props: { source: { uri: string }; style?: unknown; onError?: () => void };
  }>;
}

describe("MovieField poster (picker suggestions)", () => {
  it("renders Image at poster dimensions when posterUrl is present (with counts branch)", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        movieSuggestionsHeader: "Now playing",
        movieSuggestions: [
          {
            label: "Dune: Part Three",
            onPress: vi.fn(),
            posterUrl: "https://image.tmdb.org/t/p/w185/abc.jpg",
          },
        ],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
        movieCounts: new Map([["Dune: Part Three", { count: 3, coldTheatreCount: 0 }]]),
      }),
    );
    const images = findImagesFromRenderer(renderer);
    expect(images.length).toBe(1);
    expect(images[0]!.props.source.uri).toBe("https://image.tmdb.org/t/p/w185/abc.jpg");
    const styleStr = JSON.stringify(images[0]!.props.style);
    expect(styleStr).toContain("34");
    expect(styleStr).toContain("50");
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Dune: Part Three");
    // accessibility preserved
    expect(jsonStr).toContain("menuitem");
    renderer.unmount();
  });

  it("renders Image when posterUrl is present (without counts branch)", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        movieSuggestionsHeader: "Now playing",
        movieSuggestions: [
          {
            label: "Interstellar",
            onPress: vi.fn(),
            posterUrl: "https://image.tmdb.org/t/p/w185/inter.jpg",
          },
        ],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
      }),
    );
    const images = findImagesFromRenderer(renderer);
    expect(images.length).toBe(1);
    expect(images[0]!.props.source.uri).toBe("https://image.tmdb.org/t/p/w185/inter.jpg");
    renderer.unmount();
  });

  it("renders neutral striped fallback when posterUrl is null (no Image, label preserved)", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        movieSuggestionsHeader: "Now playing",
        movieSuggestions: [{ label: "No Poster Film", onPress: vi.fn(), posterUrl: null }],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
      }),
    );
    const images = findImagesFromRenderer(renderer);
    expect(images.length).toBe(0);
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("No Poster Film");
    // neutral striped fallback uses LeftPanel's treatment colors (#e9e5dd / #ddd7cb)
    expect(jsonStr).toContain("e9e5dd");
    // accessibility still intact
    expect(jsonStr).toContain("menuitem");
    renderer.unmount();
  });

  it("falls back to neutral stripe when image load fails", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        movieSuggestionsHeader: "Now playing",
        movieSuggestions: [
          {
            label: "Broken Poster",
            onPress: vi.fn(),
            posterUrl: "https://image.tmdb.org/t/p/w185/broken.jpg",
          },
        ],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
      }),
    );
    let images = findImagesFromRenderer(renderer);
    expect(images.length).toBe(1);
    const onError = images[0]!.props.onError;
    expect(typeof onError).toBe("function");
    TestRenderer.act(() => {
      onError!();
    });
    images = findImagesFromRenderer(renderer);
    expect(images.length).toBe(0);
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Broken Poster");
    expect(jsonStr).toContain("e9e5dd");
    expect(jsonStr).toContain("menuitem");
    renderer.unmount();
  });

  it("preserves controls and accessibility when poster variations are shown", () => {
    const onPress = vi.fn();
    const renderer = createRenderer(
      React.createElement(MovieField, {
        theaterConfirmed: true,
        movieValue: "",
        movieFocused: true,
        movieSuggestionsHeader: "Now playing",
        movieSuggestions: [
          { label: "With Poster", onPress, posterUrl: "https://image.tmdb.org/t/p/w185/a.jpg" },
          { label: "Without Poster", onPress: vi.fn(), posterUrl: null },
        ],
        movieIsSearching: false,
        movieSearchError: null,
        movieClearedNotice: null,
        onGateClick: vi.fn(),
        onChangeText: vi.fn(),
        onFocus: vi.fn(),
        onBlur: vi.fn(),
        isLocked: false,
      }),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("With Poster");
    expect(jsonStr).toContain("Without Poster");
    // both items remain accessible menuitems
    const menuCount = (jsonStr.match(/menuitem/g) ?? []).length;
    expect(menuCount).toBeGreaterThanOrEqual(2);
    renderer.unmount();
  });
});

describe("MovieField mobile bottom sheet (P1 audit fix)", () => {
  function sheetProps(overrides: Record<string, unknown> = {}) {
    return {
      theaterConfirmed: true,
      movieValue: "",
      movieFocused: true,
      movieSuggestionsHeader: "Now playing",
      movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
      movieIsSearching: false,
      movieSearchError: null,
      movieClearedNotice: null,
      onGateClick: vi.fn(),
      onChangeText: vi.fn(),
      onFocus: vi.fn(),
      onBlur: vi.fn(),
      isLocked: false,
      ...overrides,
    };
  }

  it("desktop renders the unchanged inline popover (no sheet chrome)", () => {
    const renderer = createRenderer(React.createElement(MovieField, sheetProps()));
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Dune: Part Three");
    // No bottom-sheet chrome on desktop: no dialog label, scrim, or Close button.
    expect(jsonStr).not.toContain("dialog");
    expect(jsonStr).not.toContain("rgba(0,0,0,0.4)");
    expect(jsonStr).not.toContain("Close Now playing");
    renderer.unmount();
  });

  it("mobile renders the suggestion list as a bottom-sheet modal", () => {
    const renderer = createRenderer(
      React.createElement(MovieField, sheetProps({ isMobile: true })),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Dune: Part Three");
    // Sheet chrome: dialog label, fixed overlay, scrim, and close affordance.
    expect(jsonStr).toContain("Now playing dialog");
    expect(jsonStr).toContain("fixed");
    expect(jsonStr).toContain("rgba(0,0,0,0.4)");
    expect(jsonStr).toContain("Close Now playing");
    renderer.unmount();
  });

  it("selection still works through the sheet", () => {
    const onSelect = vi.fn();
    const renderer = createRenderer(
      React.createElement(MovieField, {
        ...sheetProps({ isMobile: true }),
        movieSuggestions: [{ label: "Dune: Part Three", onPress: onSelect, posterUrl: null }],
      }),
    );
    const option = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Dune: Part Three",
    );
    TestRenderer.act(() => {
      (option.props as unknown as { onPress: () => void }).onPress();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("sheet Close button dismisses through onBlur", () => {
    const onBlur = vi.fn();
    const renderer = createRenderer(
      React.createElement(MovieField, sheetProps({ isMobile: true, onBlur })),
    );
    const closeButtons = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === "Close Now playing",
    );
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
    TestRenderer.act(() => {
      (closeButtons[0]!.props as unknown as { onPress: () => void }).onPress();
    });
    expect(onBlur).toHaveBeenCalled();
    renderer.unmount();
  });
});

describe("PopoverList mobile bottom sheet passthrough", () => {
  it("desktop renders the inline listbox without sheet chrome", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        React.createElement(PopoverList, {
          header: "Options",
          items: [{ label: "A", onPress: vi.fn() }],
        }),
      );
    });
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Options");
    expect(jsonStr).not.toContain("dialog");
    expect(jsonStr).not.toContain("Close Options");
    renderer.unmount();
  });

  it("mobile renders the sheet variant and selection still works", () => {
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        React.createElement(PopoverList, {
          header: "Options",
          items: [{ label: "A", onPress: onSelect }],
          isMobile: true,
        }),
      );
    });
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Options dialog");
    expect(jsonStr).toContain("rgba(0,0,0,0.4)");
    expect(jsonStr).toContain("Close Options");
    const option = renderer.root.find((node) => node.props.accessibilityLabel === "A");
    TestRenderer.act(() => {
      (option.props as unknown as { onPress: () => void }).onPress();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
