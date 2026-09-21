import { describe, expect, it } from "vitest";
import { SeatDot } from "./SeatDot";
import { SeatDotGrid } from "./SeatDotGrid";
import type { RowDotGrid } from "@/lib/rowSummary";

function makeGrid(rows: number, columns: number): RowDotGrid {
  const cells = Array.from({ length: rows * columns }, () => ({ free: true, isSeat: true }));
  return { rows, columns, cells };
}

/** Collects the props of every SeatDot in the unrendered grid element tree. */
function findDots(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findDots(child, out);
    return out;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } & Record<string, unknown> };
  if (el.type === SeatDot && el.props) {
    out.push(el.props);
  }
  const children = el.props?.children;
  if (children !== undefined) findDots(children, out);
  return out;
}

/**
 * Recursively collects every `width` style value from a rendered element tree.
 * SeatDot children render through the SeatDot component (UI39) — resolve them one level
 * so the width regression still measures the actual dot sizes.
 */
function collectWidths(node: unknown, out: number[] = []): number[] {
  if (node === null || typeof node !== "object") return out;
  const el = node as { type?: unknown; props?: { style?: unknown; children?: unknown } };
  if (el.type === SeatDot && el.props) {
    return collectWidths(SeatDot(el.props as unknown as Parameters<typeof SeatDot>[0]), out);
  }
  const style = el.props?.style;
  const styles = Array.isArray(style) ? style : [style];
  for (const s of styles) {
    if (
      s &&
      typeof s === "object" &&
      "width" in s &&
      typeof (s as { width: unknown }).width === "number"
    ) {
      out.push((s as { width: number }).width);
    }
  }
  const children = el.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) collectWidths(child, out);
  } else if (children) {
    collectWidths(children, out);
  }
  return out;
}

describe("SeatDotGrid", () => {
  it("renders a narrow grid at full dot size (regression)", () => {
    // 10 columns is comfortably under the 96px cap at the un-scaled dot size and gap.
    const el = SeatDotGrid({ grid: makeGrid(8, 10) });
    const widths = collectWidths(el);
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeCloseTo(5, 5);
  });

  it("scales dots down so a wide auditorium never exceeds the grid column's width (regression)", () => {
    // A real auditorium can have far more than 10 columns. At the un-scaled 5px dot +
    // 3px gap, 22 columns would render ~173px wide — well past the 120px column in
    // ShowtimeRow, which used to bleed the grid past the card's own padding.
    const el = SeatDotGrid({ grid: makeGrid(10, 22) });
    const widths = collectWidths(el);
    expect(widths.length).toBeGreaterThan(0);
    const dotSize = Math.max(...widths);
    expect(dotSize).toBeLessThan(5);
    const totalWidth = 22 * dotSize + 21 * dotSize * (3 / 5);
    expect(totalWidth).toBeLessThanOrEqual(96 + 1e-6);
  });

  it("provides accessible role and summary label on the grid container", () => {
    const grid: RowDotGrid = {
      rows: 2,
      columns: 2,
      cells: [
        { isSeat: true, free: true },
        { isSeat: true, free: false },
        { isSeat: false, free: false },
        { isSeat: true, free: true },
      ],
    };
    const el = SeatDotGrid({ grid }) as unknown as { props: Record<string, unknown> };
    expect(el.props.accessible).toBe(true);
    expect(el.props.accessibilityRole).toBe("image");
    expect(el.props.accessibilityLabel).toBe("Seating map: 2 of 3 seats available");
  });

  it("renders free seats as available dots and taken seats as taken dots", () => {
    const grid: RowDotGrid = {
      rows: 1,
      columns: 2,
      cells: [
        { isSeat: true, free: true },
        { isSeat: true, free: false },
      ],
    };
    const dots = findDots(SeatDotGrid({ grid }));
    expect(dots).toHaveLength(2);
    expect(dots[0]).toMatchObject({ active: false, size: 5 });
    expect(dots[0]!.taken).toBeFalsy();
    expect(dots[1]).toMatchObject({ active: false, taken: true, size: 5 });
  });

  it("propagates the accessible flag down to SeatDot for free and taken seats", () => {
    const grid: RowDotGrid = {
      rows: 1,
      columns: 3,
      cells: [
        { isSeat: true, free: true, accessible: true },
        { isSeat: true, free: false, accessible: true },
        { isSeat: true, free: true },
      ],
    };
    const dots = findDots(SeatDotGrid({ grid }));
    expect(dots).toHaveLength(3);
    expect(dots[0]).toMatchObject({ active: false, isAccessible: true });
    expect(dots[1]).toMatchObject({ taken: true, isAccessible: true });
    expect(dots[2]).toMatchObject({ active: false });
    expect(dots[2]!.isAccessible).toBeFalsy();
  });

  it("renders highlighted seats as active prime dots with the accessible flag", () => {
    const grid: RowDotGrid = {
      rows: 1,
      columns: 3,
      cells: [
        { isSeat: true, free: true, accessible: true },
        { isSeat: true, free: true },
        { isSeat: true, free: false },
      ],
    };
    const dots = findDots(
      SeatDotGrid({ grid, highlightedRange: { row: 0, startCol: 0, endCol: 1 } }),
    );
    expect(dots).toHaveLength(3);
    expect(dots[0]).toMatchObject({ active: true, hue: "amber", isAccessible: true });
    expect(dots[1]).toMatchObject({ active: true, hue: "amber" });
    expect(dots[1]!.isAccessible).toBeFalsy();
    expect(dots[2]).toMatchObject({ taken: true });
  });

  it("keeps a mixed wide grid with accessible seats inside the width cap", () => {
    const columns = 22;
    const cells = Array.from({ length: columns }, (_, c) => ({
      isSeat: true,
      free: c % 3 !== 0,
      accessible: c % 5 === 0,
    }));
    const dots = findDots(SeatDotGrid({ grid: { rows: 1, columns, cells } }));
    expect(dots).toHaveLength(columns);
    const sizes = dots.map((props) => props.size as number);
    expect(Math.max(...sizes)).toBeLessThan(5);
    const dotSize = Math.max(...sizes);
    expect(columns * dotSize + (columns - 1) * dotSize * (3 / 5)).toBeLessThanOrEqual(96 + 1e-6);
    expect(dots.filter((props) => props.isAccessible)).toHaveLength(5);
    expect(dots.filter((props) => props.taken)).toHaveLength(8);
  });
});
