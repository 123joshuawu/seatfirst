import React from "react";
import TestRenderer from "react-test-renderer";
import { Image, TextInput } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { MovieField } from "./MovieField";
import { AppText } from "@/components/core/AppText";
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
    // monogram glyph: title initial ("N") centered over the stripe via AppText,
    // in the stripe's muted palette (#766f64) — exactly one such node.
    const monograms = renderer.root.findAllByType(AppText).filter((n) => n.props.children === "N");
    expect(monograms).toHaveLength(1);
    expect(JSON.stringify(monograms[0]!.props.style)).toContain("766f64");
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

function ui42Props(overrides: Record<string, unknown> = {}) {
  return {
    theaterConfirmed: true,
    movieValue: "",
    movieFocused: true,
    movieSuggestionsHeader: "Movies",
    movieSuggestions: [],
    movieIsSearching: false,
    movieSearchError: null,
    movieClearedNotice: null,
    onGateClick: vi.fn(),
    onChangeText: vi.fn(),
    onFocus: vi.fn(),
    onBlur: vi.fn(),
    ...overrides,
  };
}

describe("MovieField UI42.4 badging", () => {
  it("renders title with year and AMC Event badge", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Nos",
          movieSuggestions: [
            {
              label: "Nosferatu",
              onPress: vi.fn(),
              posterUrl: null,
              releaseYear: 2024,
              badge: "AMC Event",
            },
          ],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Nosferatu (2024)");
    expect(jsonStr).toContain("AMC Event");
    renderer.unmount();
  });

  it("renders the unverified badge without a year suffix when releaseYear is null", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Loc",
          movieSuggestions: [
            {
              label: "Local Premiere",
              onPress: vi.fn(),
              posterUrl: null,
              releaseYear: null,
              badge: "May not be playing here",
            },
          ],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Local Premiere");
    expect(jsonStr).toContain("May not be playing here");
    expect(jsonStr).not.toContain("Local Premiere (");
    renderer.unmount();
  });

  it("renders no badge for wide theatrical releases", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [
            { label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null, badge: null },
          ],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Dune: Part Three");
    expect(jsonStr).not.toContain("AMC Event");
    expect(jsonStr).not.toContain("May not be playing here");
    renderer.unmount();
  });

  it("does not double the year when the label already includes it", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Nos",
          movieSuggestions: [
            {
              label: "Nosferatu (2024)",
              onPress: vi.fn(),
              posterUrl: null,
              releaseYear: 2024,
              badge: null,
            },
          ],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Nosferatu (2024)");
    expect(jsonStr).not.toContain("(2024) (2024)");
    renderer.unmount();
  });

  it("renders badges in the counts branch and includes them in the accessibility label", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Nos",
          movieSuggestions: [
            {
              label: "Nosferatu",
              onPress: vi.fn(),
              posterUrl: null,
              releaseYear: 2024,
              badge: "AMC Event",
            },
          ],
          movieCounts: new Map([["Nosferatu", { count: 2, coldTheatreCount: 0 }]]),
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Nosferatu (2024)");
    expect(jsonStr).toContain("AMC Event");
    const option = renderer.root.find(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.includes("Nosferatu (2024)") &&
        node.props.accessibilityLabel.includes("AMC Event"),
    );
    expect(option).toBeTruthy();
    renderer.unmount();
  });
});

describe("MovieField UI42.5 custom event row", () => {
  it("renders at the bottom of the list and fires onSelectCustomEvent with trimmed text", () => {
    const onSelectCustomEvent = vi.fn();
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "  Fathom Event  ",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onSelectCustomEvent,
        }),
      ),
    );
    const row = renderer.root.find(
      (node) => node.props.accessibilityLabel === '🔍 Search for event: "Fathom Event"',
    );
    expect(row).toBeTruthy();
    TestRenderer.act(() => {
      (row.props as unknown as { onPress: () => void }).onPress();
    });
    expect(onSelectCustomEvent).toHaveBeenCalledTimes(1);
    expect(onSelectCustomEvent).toHaveBeenCalledWith("Fathom Event");
    // Bottom of the list: renders after the regular suggestions.
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr.indexOf("Dune: Part Three")).toBeLessThan(jsonStr.indexOf("Search for event:"));
    renderer.unmount();
  });

  it("is hidden when the input is blank", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "   ",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onSelectCustomEvent: vi.fn(),
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).not.toContain("Search for event:");
    renderer.unmount();
  });

  it("is hidden when onSelectCustomEvent is not provided", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Fathom Event",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).not.toContain("Search for event:");
    renderer.unmount();
  });
});

describe("MovieField UI42.6 live schedule footer", () => {
  it("renders the footer sentence and fires onCheckLiveSchedule", () => {
    const onCheckLiveSchedule = vi.fn();
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onCheckLiveSchedule,
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Looking for a special event or Fathom screening?");
    expect(jsonStr).toContain("Check today's live schedule");
    const cta = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Check today's live schedule",
    );
    TestRenderer.act(() => {
      (cta.props as unknown as { onPress: () => void }).onPress();
    });
    expect(onCheckLiveSchedule).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("shows a disabled loading state when isCheckingLiveSchedule is true", () => {
    const onCheckLiveSchedule = vi.fn();
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onCheckLiveSchedule,
          isCheckingLiveSchedule: true,
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Checking…");
    const cta = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Checking today's live schedule",
    );
    expect(cta.props.disabled).toBe(true);
    expect((cta.props as unknown as { onPress?: () => void }).onPress).toBeUndefined();
    expect(onCheckLiveSchedule).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("is hidden when onCheckLiveSchedule is not provided", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).not.toContain("Check today's live schedule");
    renderer.unmount();
  });
});

describe("MovieField UI42.6 live schedule error", () => {
  it("renders the failure line above the footer CTA when liveScheduleError is set", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onCheckLiveSchedule: vi.fn(),
          liveScheduleError: "Couldn't check the live schedule. Please try again.",
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).toContain("Couldn't check the live schedule. Please try again.");
    expect(jsonStr).toContain("Check today's live schedule");
    // Adjacent to the trigger button, not below the fold: the alert precedes
    // the footer CTA in tree order so it is visible without scrolling.
    expect(jsonStr.indexOf("Couldn't check the live schedule. Please try again.")).toBeLessThan(
      jsonStr.indexOf("Check today's live schedule"),
    );
    const alert = renderer.root.find((node) => node.props.accessibilityRole === "alert");
    expect(alert).toBeTruthy();
    renderer.unmount();
  });

  it("hides the failure line when liveScheduleError is null", () => {
    const renderer = createRenderer(
      React.createElement(
        MovieField,
        ui42Props({
          movieValue: "Dun",
          movieSuggestions: [{ label: "Dune: Part Three", onPress: vi.fn(), posterUrl: null }],
          onCheckLiveSchedule: vi.fn(),
          liveScheduleError: null,
        }),
      ),
    );
    const jsonStr = JSON.stringify(renderer.toJSON());
    expect(jsonStr).not.toContain("Couldn't check the live schedule");
    renderer.unmount();
  });
});

describe("MovieField movie input identity (audit finding 10)", () => {
  it("exposes id and name on the search input without colliding with the listbox id", () => {
    const renderer = createRenderer(React.createElement(MovieField, ui42Props()));
    const input = renderer.root.findByType(TextInput);
    expect(input.props.id).toBe("seatfirst-movie");
    expect(input.props.name).toBe("movie");
    expect(input.props["aria-controls"]).toBe("movie-listbox");
    expect(input.props.id).not.toBe("movie-listbox");
    renderer.unmount();
  });
});
