import { describe, expect, it, vi } from "vitest";
import { Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { Checkbox } from "./Checkbox";

type Props = Record<string, unknown> & { children?: unknown; style?: unknown };
type El = { type: unknown; props: Props };

/** Merges a RN style array (as produced by the mocked StyleSheet) into one object. */
function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === "object") Object.assign(out, entry as Record<string, unknown>);
  }
  return out;
}

function boxOf(el: El): El {
  // Standalone wraps the inner box in a Pressable; non-standalone returns it directly.
  if (el.type === Pressable) return el.props.children as El;
  return el;
}

describe("Checkbox", () => {
  it("renders unchecked with the off-border style and no glyph", () => {
    const el = Checkbox({ checked: false }) as unknown as El;
    expect(el.type).toBe(Pressable);
    const box = boxOf(el);
    expect(box.type).toBe(View);
    const style = flattenStyle(box.props.style);
    expect(style.borderColor).toBe(colors.checkboxOffBorder);
    expect(box.props.children).toBeNull();
  });

  it("renders checked with brandDark fill and a white glyph", () => {
    const el = Checkbox({ checked: true }) as unknown as El;
    const box = boxOf(el);
    const style = flattenStyle(box.props.style);
    expect(style.backgroundColor).toBe(colors.brandDark);
    expect(style.borderColor).toBe(colors.brandDark);
    const glyph = box.props.children as El;
    expect(glyph.type).toBe(AppText);
    expect(glyph.props.children).toBe("✓");
    expect(flattenStyle(glyph.props.style).color).toBe(colors.white);
  });

  it("applies reduced opacity and blocks presses when disabled", () => {
    const onChange = vi.fn();
    const el = Checkbox({ checked: false, onChange, disabled: true }) as unknown as El;
    expect(el.props.disabled).toBe(true);
    expect(el.props.onPress).toBeUndefined();
    const box = boxOf(el);
    expect(flattenStyle(box.props.style).opacity).toBe(0.5);
    expect(el.props.accessibilityState).toEqual({ checked: false, disabled: true });
  });

  it("sizes sm to 14x14 with 4px radius and 10pt glyph", () => {
    const el = Checkbox({ checked: true, size: "sm" }) as unknown as El;
    const box = boxOf(el);
    const style = flattenStyle(box.props.style);
    expect(style.width).toBe(14);
    expect(style.height).toBe(14);
    expect(style.borderRadius).toBe(4);
    const glyph = box.props.children as El;
    expect(flattenStyle(glyph.props.style).fontSize).toBe(10);
  });

  it("sizes md to 18x18 with 5px radius and 12pt glyph", () => {
    const el = Checkbox({ checked: true, size: "md" }) as unknown as El;
    const box = boxOf(el);
    const style = flattenStyle(box.props.style);
    expect(style.width).toBe(18);
    expect(style.height).toBe(18);
    expect(style.borderRadius).toBe(5);
    const glyph = box.props.children as El;
    expect(flattenStyle(glyph.props.style).fontSize).toBe(12);
  });

  it("standalone exposes checkbox role, state, label, hint, and a 44px touch target", () => {
    const el = Checkbox({
      checked: true,
      onChange: () => {},
      accessibilityLabel: "I understand this is a different showtime and seat",
      accessibilityHint: "Confirms consent",
    }) as unknown as El;
    expect(el.type).toBe(Pressable);
    expect(el.props.accessibilityRole).toBe("checkbox");
    expect(el.props.accessibilityState).toEqual({ checked: true, disabled: false });
    expect(el.props.accessibilityLabel).toBe("I understand this is a different showtime and seat");
    expect(el.props.accessibilityHint).toBe("Confirms consent");
    const target = flattenStyle(el.props.style);
    expect(target.minWidth).toBe(44);
    expect(target.minHeight).toBe(44);
    expect(el.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
  });

  it("non-standalone returns the bare box with no accessibility props", () => {
    const el = Checkbox({ checked: true, size: "sm", standalone: false }) as unknown as El;
    expect(el.type).toBe(View);
    expect(el.props.accessibilityRole).toBeUndefined();
    expect(el.props.accessibilityState).toBeUndefined();
    expect(el.props.accessible).toBe(false);
  });

  it("fires onChange with the toggled value on press when standalone", () => {
    const onChange = vi.fn();
    const off = Checkbox({ checked: false, onChange }) as unknown as El;
    (off.props.onPress as () => void)();
    expect(onChange).toHaveBeenCalledWith(true);
    const on = Checkbox({ checked: true, onChange }) as unknown as El;
    (on.props.onPress as () => void)();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("has no press handler without onChange", () => {
    const el = Checkbox({ checked: false }) as unknown as El;
    expect(el.props.onPress).toBeUndefined();
  });
});
