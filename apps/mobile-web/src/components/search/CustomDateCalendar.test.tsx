import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, View } from "react-native";
import { CustomDateCalendar } from "./CustomDateCalendar";
import { AppText } from "@/components/core/AppText";

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  const value = node as { children?: unknown; props?: { children?: unknown } };
  return textContent(value.children ?? value.props?.children);
}

function dayCells(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root
    .findAllByType(Pressable)
    .filter((n) => typeof (n.props as { onPress?: unknown }).onPress === "function");
}

function cellTexts(cell: TestRenderer.ReactTestInstance): string[] {
  return cell.findAllByType(AppText).map(textContent);
}

function styleOf(
  node: TestRenderer.ReactTestInstance,
): Record<string, string | number | undefined> {
  return (node.props as { style?: Record<string, string | number | undefined> }).style ?? {};
}

describe("CustomDateCalendar facet badges (UI23.4)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  it("renders a numeral badge for warm, `n+` for partial, and no badge for all-cold/missing", () => {
    const facetCounts = new Map([
      ["2026-08-03", { count: 5, coldTheatreCount: 0 }],
      ["2026-08-04", { count: 3, coldTheatreCount: 1 }],
      ["2026-08-05", { count: 0, coldTheatreCount: 2 }],
    ]);
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={[]}
          minIso="2026-08-03"
          maxIso="2026-08-06"
          onSelectDay={() => {}}
          facetCounts={facetCounts}
          totalTheatres={2}
        />,
      );
    });
    const cells = dayCells(renderer!.root);
    expect(cells).toHaveLength(4);
    // Day number first, badge second.
    expect(cellTexts(cells[0]!)).toEqual(["3", "5"]);
    expect(cellTexts(cells[1]!)).toEqual(["4", "3+"]);
    // All-cold: day number only, no badge.
    expect(cellTexts(cells[2]!)).toEqual(["5"]);
    // No entry at all: day number only, no badge.
    expect(cellTexts(cells[3]!)).toEqual(["6"]);
    // Compact copy only — never chip-style "not checked yet" text in a cell.
    const all = renderer!.root.findAllByType(AppText).map(textContent);
    expect(all.some((t) => t.includes("not checked yet"))).toBe(false);
  });

  it("dims a warm-zero day without disabling it", () => {
    const onSelectDay = vi.fn();
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={[]}
          minIso="2026-08-03"
          maxIso="2026-08-03"
          onSelectDay={onSelectDay}
          facetCounts={new Map([["2026-08-03", { count: 0, coldTheatreCount: 0 }]])}
          totalTheatres={2}
        />,
      );
    });
    const cells = dayCells(renderer!.root);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.props.style).toMatchObject({ opacity: 0.5 });
    expect(cell.props.disabled).toBeUndefined();
    expect(cell.props.accessibilityState).toEqual({ selected: false });
    act(() => {
      (cell.props.onPress as () => void)();
    });
    expect(onSelectDay).toHaveBeenCalledWith("2026-08-03");
  });

  it("keeps accessibilityState selected (never disabled) on a selected warm-zero day", () => {
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={["2026-08-03"]}
          minIso="2026-08-03"
          maxIso="2026-08-03"
          onSelectDay={() => {}}
          facetCounts={new Map([["2026-08-03", { count: 0, coldTheatreCount: 0 }]])}
          totalTheatres={2}
        />,
      );
    });
    const cell = dayCells(renderer!.root)[0]!;
    expect(cell.props.accessibilityState).toEqual({ selected: true });
    expect(cell.props.disabled).toBeUndefined();
    expect(cell.props.style).toMatchObject({ opacity: 0.5 });
  });

  it("renders the pre-existing cell shape when facetCounts is absent (no-regression guard)", () => {
    const onSelectDay = vi.fn();
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={["2026-08-04"]}
          minIso="2026-08-03"
          maxIso="2026-08-05"
          onSelectDay={onSelectDay}
        />,
      );
    });
    const cells = dayCells(renderer!.root);
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      // No badge node: exactly the day-number AppText.
      expect(cell.findAllByType(AppText)).toHaveLength(1);
      // No dimming.
      expect(cell.props.style).not.toMatchObject({ opacity: 0.5 });
      expect(cell.props.disabled).toBeUndefined();
    }
    // Untouched tap behavior and selection state.
    expect(cells[1]!.props.accessibilityState).toEqual({ selected: true });
    act(() => {
      (cells[0]!.props.onPress as () => void)();
    });
    expect(onSelectDay).toHaveBeenCalledWith("2026-08-03");
    expect(renderer!.toJSON()).toMatchSnapshot();
  });
});

describe("CustomDateCalendar 7-column grid (UX audit P0)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  const expectedColumnWidth = `${100 / 7}%`;

  // 2026-08-03 is a Monday, so the range opens with exactly one filler cell.
  function renderWeek(): TestRenderer.ReactTestInstance {
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={["2026-08-04"]}
          minIso="2026-08-03"
          maxIso="2026-08-09"
          onSelectDay={vi.fn()}
        />,
      );
    });
    return renderer!.root;
  }

  it("header and date columns share one exact 1/7 width that sums to 100%", () => {
    const root = renderWeek();
    // Header columns are the only Views with vertical label padding.
    const headerCells = root.findAll(
      (node) =>
        node.type === View &&
        (node.props as { style?: { paddingVertical?: number } }).style?.paddingVertical === 4,
    );
    expect(headerCells).toHaveLength(7);
    for (const cell of headerCells) {
      expect((cell.props as { style?: { width?: string } }).style?.width).toBe(expectedColumnWidth);
    }
    expect(7 * parseFloat(expectedColumnWidth)).toBeCloseTo(100, 10);
  });
  it("renders no flex gap on the date grids, so 7 columns never wrap", () => {
    const root = renderWeek();
    const grids = root.findAllByType(View).filter((v) => styleOf(v).flexWrap === "wrap");
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(styleOf(grid).gap).toBeUndefined();
      expect(styleOf(grid).columnGap).toBeUndefined();
    }
  });

  it("each date cell sits in a 1/7 column matching the header width", () => {
    const root = renderWeek();
    const cells = dayCells(root);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      // Each day Pressable is inset inside a fixed 1/7 column wrapper (padding,
      // never gap), so the wrapper width must equal the header column width.
      expect(cell.parent ? styleOf(cell.parent).width : undefined).toBe(expectedColumnWidth);
    }
  });
});

describe("CustomDateCalendar month dividers (UX audit P2)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  function renderRange(minIso: string, maxIso: string): TestRenderer.ReactTestInstance {
    act(() => {
      renderer = TestRenderer.create(
        <CustomDateCalendar
          selectedDates={[]}
          minIso={minIso}
          maxIso={maxIso}
          onSelectDay={vi.fn()}
        />,
      );
    });
    return renderer!.root;
  }

  function wrapGrids(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
    return root.findAllByType(View).filter((v) => styleOf(v).flexWrap === "wrap");
  }

  it("labels each calendar month when the range crosses a boundary", () => {
    // 2026-08-30 is a Sunday; 2026-09-01 is a Tuesday.
    const root = renderRange("2026-08-30", "2026-09-02");
    const labels = root.findAllByType(AppText).map(textContent);
    expect(labels).toContain("August 2026");
    expect(labels).toContain("September 2026");
  });

  it("a single-month range renders exactly one month label", () => {
    const root = renderRange("2026-08-03", "2026-08-05");
    const labels = root
      .findAllByType(AppText)
      .map(textContent)
      .filter((t) => t.includes("2026"));
    expect(labels).toEqual(["August 2026"]);
  });

  it("each month section restarts weekday alignment from its own first day", () => {
    const root = renderRange("2026-08-30", "2026-09-02");
    const grids = wrapGrids(root);
    expect(grids).toHaveLength(2);
    // Column wrappers are the 1/7-wide Views two levels below their section grid
    // (grid composite → host element → wrapper composite).
    const columnsOf = (grid: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] =>
      root.findAll(
        (node) =>
          node.type === View &&
          styleOf(node).width === `${100 / 7}%` &&
          node.parent?.parent === grid,
      );
    const columnLabels = (wrappers: TestRenderer.ReactTestInstance[]): (string | undefined)[] =>
      wrappers.map((w) => {
        const found = w.findAllByType(Pressable);
        if (found.length === 0) return undefined;
        return (found[0]!.props as { accessibilityLabel?: string }).accessibilityLabel;
      });
    // August section: Aug 30 is a Sunday, so no fillers — both columns are days.
    expect(columnLabels(columnsOf(grids[0]!))).toEqual(["Sunday, August 30", "Monday, August 31"]);
    // September section: Sep 1 is a Tuesday, so two blank fillers precede Sep 1–2.
    expect(columnLabels(columnsOf(grids[1]!))).toEqual([
      undefined,
      undefined,
      "Tuesday, September 1",
      "Wednesday, September 2",
    ]);
  });
});
