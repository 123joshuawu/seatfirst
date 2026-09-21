import { describe, expect, it } from "vitest";
import { SeatDot } from "./SeatDot";
import { colors } from "@/theme/colors";

type Props = { style?: unknown; children?: unknown };
type El = { props: Props };

/** Merges a RN style array (as produced by the mocked StyleSheet) into one object. */
function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === "object") Object.assign(out, entry as Record<string, unknown>);
  }
  return out;
}

function rootStyle(el: unknown): Record<string, unknown> {
  return flattenStyle((el as El).props.style);
}

/** Flattened styles of every non-null rendered child View. */
function childStyles(el: unknown): Record<string, unknown>[] {
  const children = (el as El).props.children;
  const list = Array.isArray(children) ? children : [children];
  return list
    .filter(
      (child): child is { props: Props } =>
        !!child && typeof child === "object" && "props" in child,
    )
    .map((child) => flattenStyle(child.props.style));
}

describe("SeatDot", () => {
  it("renders an available seat as a hollow ring (no fill, no pip, no strike)", () => {
    const el = SeatDot({ active: false, hue: "amber", size: 10 });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBe(1.5);
    expect(style.borderColor).toBe(colors.borderStrong);
    expect(style.borderRadius).toBe(10 / 2);
    expect(style.opacity).toBeUndefined();
    expect(childStyles(el)).toHaveLength(0);
  });

  it("renders a large prime seat as a solid dot with a white center pip", () => {
    const el = SeatDot({ active: true, hue: "amber", size: 10 });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe(colors.seatAmber);
    expect(style.borderWidth).toBeUndefined();
    const kids = childStyles(el);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.backgroundColor).toBe(colors.white);
    expect(kids[0]!.width).toBeCloseTo(10 * 0.35, 5);
    expect(kids[0]!.height).toBeCloseTo(10 * 0.35, 5);
  });

  it("renders an indigo prime seat in the indigo hue", () => {
    const el = SeatDot({ active: true, hue: "indigo", size: 12 });
    expect(rootStyle(el).backgroundColor).toBe(colors.seatIndigo);
    expect(childStyles(el)).toHaveLength(1);
  });

  it("renders a small prime seat with a white outline instead of the pip", () => {
    const el = SeatDot({ active: true, hue: "amber", size: 5 });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe(colors.seatAmber);
    expect(style.borderWidth).toBe(1.5);
    expect(style.borderColor).toBe(colors.white);
    expect(childStyles(el)).toHaveLength(0);
  });

  it("renders a taken seat as a dimmed flat disk with no strike", () => {
    const el = SeatDot({ active: false, hue: "amber", size: 10, taken: true });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe(colors.seatTaken);
    expect(style.opacity).toBe(0.45);
    expect(style.borderWidth).toBeUndefined();
    expect(childStyles(el)).toHaveLength(0);
  });

  it("retains the lost diagonal strike (ADR 0059 behavior unchanged)", () => {
    const el = SeatDot({ active: false, hue: "amber", size: 10, lost: true });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe(colors.seatTaken);
    const kids = childStyles(el);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.backgroundColor).toBe(colors.textMuted);
    expect(kids[0]!.width).toBe("150%");
    expect(kids[0]!.transform).toEqual([{ rotate: "-45deg" }]);
  });

  it("renders an accessible seat as a diamond layered over the available ring", () => {
    const el = SeatDot({ active: false, hue: "amber", size: 10, isAccessible: true });
    const style = rootStyle(el);
    expect(style.transform).toEqual([{ rotate: "45deg" }]);
    expect(style.borderRadius).toBe(1.5);
    // Base state still applies underneath the silhouette modifier.
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBe(1.5);
  });

  it("layers the accessible diamond over a prime dot without losing the pip", () => {
    const el = SeatDot({ active: true, hue: "indigo", size: 10, isAccessible: true });
    const style = rootStyle(el);
    expect(style.transform).toEqual([{ rotate: "45deg" }]);
    expect(style.backgroundColor).toBe(colors.seatIndigo);
    const kids = childStyles(el);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.backgroundColor).toBe(colors.white);
  });

  it("gives lost precedence over taken (most specific state wins)", () => {
    const el = SeatDot({ active: false, hue: "amber", size: 10, lost: true, taken: true });
    const kids = childStyles(el);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.width).toBe("150%");
    expect(rootStyle(el).opacity).toBeUndefined();
  });

  it("gives taken precedence over active (an occupied seat is never prime)", () => {
    const el = SeatDot({ active: true, hue: "amber", size: 10, taken: true });
    const style = rootStyle(el);
    expect(style.backgroundColor).toBe(colors.seatTaken);
    expect(style.opacity).toBe(0.45);
    expect(childStyles(el)).toHaveLength(0);
  });
});
