import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { View } from "react-native";
import { WhenPresetRow } from "./WhenPresetRow";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { useSeatfirstStore } from "@/store/seatfirstStore";

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  const value = node as { children?: unknown; props?: { children?: unknown } };
  return textContent(value.children ?? value.props?.children);
}

describe("WhenPresetRow resolved read-out", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Exercise the local-calendar boundary where UTC date formatting would roll
    // a Saturday read-out into Sunday in America/Los_Angeles.
    vi.setSystemTime(new Date(2026, 7, 29, 23, 30));
    useSeatfirstStore.setState({
      ...searchFormInitialState,
      selectedDates: ["2026-08-29", "2026-08-30"],
    });
    act(() => {
      renderer = TestRenderer.create(React.createElement(WhenPresetRow));
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.useRealTimers();
  });

  it("renders one canonical Tier-2 line without a fabricated warm percentage", () => {
    const text = textContent(renderer?.toJSON());
    const readout = "Sat 29 – Sun 30 · 5 PM–9 PM";

    expect(text).toContain(readout);
    expect(text.indexOf(readout)).toBe(text.lastIndexOf(readout));
    expect(text).not.toContain("warm 80%");
  });

  it("an unknown preset still renders the committed dates, never a fallback guess", () => {
    act(() => {
      useSeatfirstStore.setState({
        whenPreset: "Unknown preset",
        isCustom: false,
        selectedDates: ["2026-08-29"],
      });
    });

    expect(textContent(renderer?.toJSON())).toContain("Sat 29 · 5 PM–9 PM");
  });
});

describe("WhenPresetRow grid removal (ADR 0044 amendment 2026-09-05)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.useRealTimers();
  });

  it("collapses the Dates/Time-of-day grid for a canned preset, leaving only the readout", () => {
    // ADR 0044 amendment 2026-09-05: for Tonight/Tomorrow evening/This weekend
    // the presets row plus the one-line readout is the entire visible field.
    // Today is Wednesday Sep 2 2026 — "Tonight" is that single Wednesday, and
    // the grid that used to show its chip here now stays hidden.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 10, 0));
    useSeatfirstStore.setState({
      ...searchFormInitialState,
      whenPreset: "Tonight",
      isCustom: false,
      selectedDates: ["2026-09-02"],
    });
    act(() => {
      renderer = TestRenderer.create(React.createElement(WhenPresetRow));
    });

    const text = textContent(renderer?.toJSON());
    // The always-visible Tier-2 readout still names the resolved date.
    expect(text).toContain("Wed 2");
    // But the inline grid is hidden: no row labels, no band chips, and no
    // leaked weekend dates.
    expect(text).not.toContain("Dates");
    expect(text).not.toContain("Time of day");
    expect(text).not.toContain("Morning");
    expect(text).not.toContain("Fri 4");
    expect(text).not.toContain("Sat 5");
    expect(text).not.toContain("Sun 6");
  });

  it("renders no Dates/Time-of-day grid for Custom either — the dialog owns both axes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1, 10, 0));
    useSeatfirstStore.setState({
      ...searchFormInitialState,
      whenPreset: "Custom",
      isCustom: true,
      selectedDates: ["2026-09-04", "2026-09-08"],
      selectedBands: ["Evening"],
    });
    act(() => {
      renderer = TestRenderer.create(React.createElement(WhenPresetRow));
    });

    const text = textContent(renderer?.toJSON());
    // The readout still names exactly the committed dates, gap excluded…
    expect(text).toContain("Fri 4, Tue 8");
    expect(text).not.toContain("Sat 5");
    expect(text).not.toContain("Sun 6");
    expect(text).not.toContain("Mon 7");
    // …but the inline grid is gone on Custom too: no row labels, no band chips.
    expect(text).not.toContain("Dates");
    expect(text).not.toContain("Time of day");
    expect(text).not.toContain("Morning");
    expect(text).not.toContain("Any time");
  });
});

describe("WhenPresetRow hideResolvedReadout (ADR 0044 amendment 2026-09-05)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 10, 0));
    useSeatfirstStore.setState({
      ...searchFormInitialState,
      whenPreset: "Tonight",
      isCustom: false,
      selectedDates: ["2026-09-02"],
      selectedBands: ["Evening"],
    });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.useRealTimers();
  });

  it("renders the readout by default", () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(WhenPresetRow));
    });
    expect(textContent(renderer?.toJSON())).toContain("Wed 2 · 5 PM–9 PM");
  });

  it("renders the readout when explicitly false", () => {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(WhenPresetRow, { hideResolvedReadout: false }),
      );
    });
    expect(textContent(renderer?.toJSON())).toContain("Wed 2 · 5 PM–9 PM");
  });

  it("renders no readout text when true, keeping the preset chips", () => {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(WhenPresetRow, { hideResolvedReadout: true }),
      );
    });
    const text = textContent(renderer?.toJSON());
    expect(text).not.toContain("Wed 2");
    expect(text).not.toContain("5 PM–9 PM");
    // The preset row itself is untouched — only the read-out slot is hidden.
    expect(text).toContain("Tonight");
    expect(text).toContain("Custom");
  });
});

describe("WhenPresetRow mobile 2-up grid fits the row gap (390px overflow)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.useRealTimers();
  });

  it("two cells plus the 8px gap never exceed the row content box", () => {
    // Friday keeps all four presets (nothing deduped), so the row holds two
    // full 2-up lines — the shape that overflowed at 390px viewports.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 28, 12, 0));
    useSeatfirstStore.setState({ ...searchFormInitialState });
    act(() => {
      renderer = TestRenderer.create(React.createElement(WhenPresetRow));
    });
    const cells = renderer!.root
      .findAllByType(View)
      .filter(
        (n) =>
          !!n.props.style &&
          typeof n.props.style === "object" &&
          typeof (n.props.style as { flexBasis?: unknown }).flexBasis === "string",
      );
    // Mobile default (no isMobile override) wraps every preset in a cell.
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      const style = cell.props.style as {
        flexBasis: string;
        flexGrow?: number;
        flexShrink?: number;
      };
      const match = /^([\d.]+)%$/.exec(style.flexBasis);
      expect(match, `cell basis is a row-relative percentage (${style.flexBasis})`).not.toBeNull();
      const basis = Number(match![1]);
      // Two cells share one row with an 8px gap: at a 280px reference content
      // width (below what any 320px+ phone leaves the card) the leftover
      // slack must strictly cover the gap, or the row overflows the card and
      // slides under the sticky CTA.
      expect((1 - basis / 50) * 280).toBeGreaterThan(8);
      // And content pressure compresses the cell instead of overflowing it.
      expect(style.flexShrink).toBe(1);
    }
  });
});
