import { describe, expect, it } from "vitest";
import { AppText } from "./AppText";
import { SeatDot } from "./SeatDot";
import { SeatLegend } from "./SeatLegend";

type Node = { type?: unknown; props: Record<string, unknown> & { children?: unknown; style?: unknown } };

function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === "object") Object.assign(out, entry as Record<string, unknown>);
  }
  return out;
}

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function asEl(value: unknown): El | null {
  return !!value && typeof value === "object" && "props" in value ? (value as El) : null;
}
/** Breadth-first walk of the unrendered element tree (children may nest arrays). */
function walk(root: unknown, visit: (node: Record<string, unknown>, type: unknown) => void): void {
  const queue: { node: unknown; type: unknown }[] = [{ node: root, type: (root as Node)?.type }];
  const enqueue = (value: unknown): void => {
    const el = asEl(value);
    if (el) queue.push({ node: value, type: el.type });
    else if (Array.isArray(value)) {
      for (const nested of value) enqueue(nested);
    }
  };
  while (queue.length > 0) {
    const { node, type } = queue.shift()!;
    const el = asEl(node);
    if (!el) continue;
    visit(el.props, type);
    const children = el.props.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) enqueue(child);
  }
}

function findByType(root: unknown, type: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  walk(root, (props, nodeType) => {
    if (nodeType === type) found.push(props);
  });
  return found;
}

describe("SeatLegend", () => {
  it("exposes a summary role with the full seating-legend label", () => {
    const el = SeatLegend({}) as unknown as Node;
    expect(el.props.accessible).toBe(true);
    expect(el.props.accessibilityRole).toBe("summary");
    expect(el.props.accessibilityLabel).toBe(
      "Seating legend: Best placement, Available, Taken, Lost, and Accessible seating",
    );
  });

  it("renders all five entries with labels in vocabulary order", () => {
    const el = SeatLegend({});
    const labels = findByType(el, AppText).map((props) => props.children);
    expect(labels).toEqual(["Best placement", "Available", "Taken", "Lost", "Accessible"]);
  });

  it("drives each sample glyph through SeatDot with the matching seat state", () => {
    const el = SeatLegend({});
    const glyphs = findByType(el, SeatDot);
    expect(glyphs).toHaveLength(5);
    expect(glyphs.map((props) => props.size)).toEqual([10, 10, 10, 10, 10]);
    expect(glyphs.map((props) => props.hue)).toEqual(["amber", "amber", "amber", "amber", "amber"]);
    const [best, available, taken, lost, accessible] = glyphs;
    expect(best).toMatchObject({ active: true });
    expect(available).toMatchObject({ active: false });
    expect(taken).toMatchObject({ active: false, taken: true });
    expect(lost).toMatchObject({ active: false, lost: true });
    expect(accessible).toMatchObject({ active: false, isAccessible: true });
  });

  it("renders full-size glyphs and labels by default", () => {
    const el = SeatLegend({}) as unknown as Node;
    expect(flattenStyle(el.props.style).gap).toBe(10);
    const labels = findByType(el, AppText);
    expect(labels).toHaveLength(5);
    for (const props of labels) {
      expect(flattenStyle(props.style).fontSize).toBe(11);
    }
  });

  it("compact mode shrinks glyphs, labels, and gaps while keeping every entry", () => {
    const el = SeatLegend({ compact: true }) as unknown as Node;
    expect(flattenStyle(el.props.style).gap).toBe(8);
    const glyphs = findByType(el, SeatDot);
    expect(glyphs).toHaveLength(5);
    for (const props of glyphs) {
      expect(props.size).toBe(8);
    }
    const labels = findByType(el, AppText);
    expect(labels.map((props) => props.children)).toEqual([
      "Best placement",
      "Available",
      "Taken",
      "Lost",
      "Accessible",
    ]);
    for (const props of labels) {
      expect(flattenStyle(props.style).fontSize).toBe(10);
    }
  });
});
