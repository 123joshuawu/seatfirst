import { describe, expect, it } from "vitest";
import { SeatDotGrid } from "./SeatDotGrid";
import type { RowDotGrid } from "@/lib/rowSummary";

function makeGrid(rows: number, columns: number): RowDotGrid {
  const cells = Array.from({ length: rows * columns }, () => ({ free: true, isSeat: true }));
  return { rows, columns, cells };
}

/** Recursively collects every `width` style value from a rendered element tree. */
function collectWidths(node: unknown, out: number[] = []): number[] {
  if (node === null || typeof node !== "object") return out;
  const el = node as { props?: { style?: unknown; children?: unknown } };
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
});
