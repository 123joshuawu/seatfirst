import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, ScrollView } from "react-native";
import { HowItWorksSheet } from "./HowItWorksSheet";

/**
 * BUG-02 dismiss paths + UX-03 size-to-content contract for HowItWorksSheet.
 * Mirrors the Pressable-by-accessibilityLabel convention in
 * `WhenCustomSheet.sheet.test.tsx`.
 */
describe("HowItWorksSheet dismiss + size-to-content (BUG-02 / UX-03)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  function renderSheet(onClose: () => void): TestRenderer.ReactTestInstance {
    act(() => {
      renderer = TestRenderer.create(<HowItWorksSheet open={true} onClose={onClose} />);
    });
    return renderer!.root;
  }

  function pressByLabel(root: TestRenderer.ReactTestInstance, label: string): void {
    const btn = root
      .findAllByType(Pressable)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
    expect(btn, `"${label}" pressable exists`).toBeDefined();
    act(() => {
      (btn!.props as { onPress: () => void }).onPress();
    });
  }

  it("Escape calls onClose; non-Escape keys do not", () => {
    const onClose = vi.fn();
    renderSheet(onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closed sheet subscribes to nothing: Escape does not call onClose", () => {
    const onClose = vi.fn();
    act(() => {
      renderer = TestRenderer.create(<HowItWorksSheet open={false} onClose={onClose} />);
    });
    expect(renderer!.toJSON()).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tapping the scrim calls onClose; tapping the panel does not", () => {
    const onClose = vi.fn();
    const root = renderSheet(onClose);
    pressByLabel(root, "Close how it works dialog");
    expect(onClose).toHaveBeenCalledTimes(1);
    // The panel is a sibling rendered above the scrim, not inside it: its
    // subtree contains no scrim press handler, so interacting with panel
    // content cannot dismiss the sheet.
    const panel = root.findAllByType(Pressable).filter(
      (n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel !==
        "Close how it works dialog",
    );
    expect(panel.length).toBeGreaterThan(0);
    for (const node of panel) {
      const label = (node.props as { accessibilityLabel?: string }).accessibilityLabel;
      if (label === "Close how it works") continue; // the explicit close action
      expect((node.props as { onPress?: unknown }).onPress).toBeUndefined();
    }
  });

  it("close button meets the 44x44 touch target", () => {
    const root = renderSheet(vi.fn());
    const btn = root
      .findAllByType(Pressable)
      .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === "Close how it works");
    expect(btn).toBeDefined();
    const style = btn!.props.style as {
      minWidth?: number;
      minHeight?: number;
      paddingVertical?: number;
      paddingHorizontal?: number;
    };
    const hitSlop = btn!.props.hitSlop as
      | { top?: number; bottom?: number; left?: number; right?: number }
      | undefined;
    const width = (style.minWidth ?? 0) + (hitSlop?.left ?? 0) + (hitSlop?.right ?? 0);
    const height = (style.minHeight ?? 0) + (hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  });

  it("panel sizes to content: no flex stretch, capped maxHeight with scrolling body", () => {
    const root = renderSheet(vi.fn());
    const body = root.findByType(ScrollView);
    const panelStyle = (body.parent!.props as { style: Record<string, unknown> }).style;
    expect(panelStyle.flex).toBeUndefined();
    expect(panelStyle.maxHeight).toBeDefined();
    const bodyStyle = body.props.style as { maxHeight?: number };
    expect(bodyStyle.maxHeight).toBeDefined();
  });
});
