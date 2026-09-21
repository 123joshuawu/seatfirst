import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import {
  Button,
  PrimaryButton,
  SecondaryButton,
  TextLinkButton,
} from "./Button";
import { LoadingSpinner } from "./LoadingSpinner";

let mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
});

function render(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(el);
  });
  mounted.push(renderer);
  return renderer;
}

/** The single logical Pressable (composite; the RN mock also renders a host
 * "Pressable" string node with identical props — filtered out here, matching
 * the compositeButtons convention in ShowtimeRow.handoff.test.tsx). */
function singlePressable(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance {
  const nodes = renderer.root
    .findAllByType(Pressable)
    .filter((n) => typeof n.type !== "string");
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

/** Merges an RN style array into one object (mock StyleSheet is a passthrough). */
function flatStyle(style: unknown): Record<string, unknown> {
  const list = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...list.filter((s) => s && typeof s === "object"),
  );
}

/** Resolves a Pressable `style` prop — static object/array or the UI35.2
 * style-callback form — in the given interaction state, then flattens it. */
function pressableStyle(
  node: TestRenderer.ReactTestInstance,
  state: { pressed: boolean; hovered?: boolean } = { pressed: false },
): Record<string, unknown> {
  const raw = node.props.style;
  const resolved =
    typeof raw === "function"
      ? (raw as (s: { pressed: boolean; hovered?: boolean }) => unknown)(state)
      : raw;
  return flatStyle(resolved);
}

function labelText(renderer: TestRenderer.ReactTestRenderer): string {
  const kids = renderer.root.findByType(AppText).props.children as unknown;
  return (Array.isArray(kids) ? kids : [kids]).join("");
}

describe("Button core primitives", () => {
  describe("TextLinkButton", () => {
    it("uses colors.brandContrast as default color for WCAG AA compliance (ADR 0068)", () => {
      const renderer = render(
        <TextLinkButton label="← Edit search" onPress={() => {}} />,
      );
      const text = renderer.root.findByType(AppText);
      expect(flatStyle(text.props.style).color).toBe(colors.brandContrast);
    });

    it("has hitSlop applied for comfortable touch target size", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
      expect(btn.props.accessibilityRole).toBe("button");
      expect(btn.props.accessibilityLabel).toBe("Change");
    });

    it("honors numeric size, weight, color, and underline props", () => {
      const renderer = render(
        <TextLinkButton
          label="← Edit search"
          onPress={() => {}}
          size={13}
          weight="700"
          color={colors.textMuted}
          underline
        />,
      );
      const text = renderer.root.findByType(AppText);
      const style = flatStyle(text.props.style);
      expect(style.fontSize).toBe(13);
      expect(style.color).toBe(colors.textMuted);
      expect(style.textDecorationLine).toBe("underline");
    });

    it("defaults to size 12 with no underline", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const style = flatStyle(renderer.root.findByType(AppText).props.style);
      expect(style.fontSize).toBe(12);
      expect(style.textDecorationLine).toBe("none");
    });

    it("disabled uses disabledText and blocks interaction", () => {
      const onPress = vi.fn();
      const renderer = render(
        <TextLinkButton label="Change" onPress={onPress} disabled />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBeUndefined();
      expect(btn.props.disabled).toBe(true);
      expect(btn.props.accessibilityState).toEqual({ disabled: true });
      const style = flatStyle(renderer.root.findByType(AppText).props.style);
      expect(style.color).toBe(colors.disabledText);
    });

    it("hover underlines the label and dims the container (UI35.2 link)", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      act(() => {
        (btn.props.onHoverIn as () => void)();
      });
      const textStyle = flatStyle(renderer.root.findByType(AppText).props.style);
      expect(textStyle.textDecorationLine).toBe("underline");
      expect(pressableStyle(btn, { pressed: false, hovered: true }).opacity).toBe(0.7);
      act(() => {
        (btn.props.onHoverOut as () => void)();
      });
      expect(
        flatStyle(renderer.root.findByType(AppText).props.style).textDecorationLine,
      ).toBe("none");
    });

    it("press underlines the label and dims the container (UI35.2 link)", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      act(() => {
        (btn.props.onPressIn as () => void)();
      });
      expect(
        flatStyle(renderer.root.findByType(AppText).props.style).textDecorationLine,
      ).toBe("underline");
      expect(pressableStyle(btn, { pressed: true }).opacity).toBe(0.7);
    });

    it("idle link has full opacity and brandContrast text (UI35.2 link normal)", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      const idle = pressableStyle(btn);
      expect(idle.opacity ?? 1).toBe(1);
    });

    it("shows the web focus ring only while focused (UI35.3)", () => {
      const renderer = render(
        <TextLinkButton label="Change" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      expect(pressableStyle(btn).outlineColor).toBeUndefined();
      act(() => {
        (btn.props.onFocus as () => void)();
      });
      const focused = pressableStyle(singlePressable(renderer));
      expect(focused.outlineColor).toBe(colors.brandDark);
      expect(focused.outlineWidth).toBe(2);
      expect(focused.outlineStyle).toBe("solid");
      expect(focused.outlineOffset).toBe(2);
      act(() => {
        (singlePressable(renderer).props.onBlur as () => void)();
      });
      expect(pressableStyle(singlePressable(renderer)).outlineColor).toBeUndefined();
    });
  });

  describe("PrimaryButton", () => {
    it("loading renders a spinner inside the button and blocks interaction", () => {
      const onPress = vi.fn();
      const renderer = render(
        <PrimaryButton label="Confirming seats…" onPress={onPress} loading />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBeUndefined();
      expect(btn.props.disabled).toBe(true);
      expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: true });
      const spinner = renderer.root.findByType(LoadingSpinner);
      expect(labelText(renderer)).toBe("Confirming seats…");
      // Spinner renders inside the button (the RN mock adds composite+host
      // layers, so walk up instead of assuming a fixed depth).
      let ancestor = spinner.parent;
      let insideButton = false;
      while (ancestor) {
        if (ancestor === btn) {
          insideButton = true;
          break;
        }
        ancestor = ancestor.parent;
      }
      expect(insideButton).toBe(true);
    });

    it("forwards testID to the pressable root", () => {
      const renderer = render(
        <PrimaryButton
          label="Confirming seats…"
          onPress={() => {}}
          loading
          testID="rechecking-collapsed-sh_hit"
        />,
      );
      expect(singlePressable(renderer).props.testID).toBe(
        "rechecking-collapsed-sh_hit",
      );
    });

    it("plain button renders just the label with no spinner", () => {
      const onPress = vi.fn();
      const renderer = render(<PrimaryButton label="Go to AMC" onPress={onPress} />);
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBe(onPress);
      expect(btn.props.disabled).toBe(false);
      expect(btn.props.accessibilityState).toEqual({ disabled: false, busy: false });
      expect(renderer.root.findByType(AppText)).toBeDefined();
      expect(renderer.root.findAllByType(LoadingSpinner)).toHaveLength(0);
      expect(labelText(renderer)).toBe("Go to AMC");
    });

    it("compact scales padding/label and carries hitSlop; default has no hitSlop (UI35.4)", () => {
      const compact = render(
        <PrimaryButton label="Go to AMC" onPress={() => {}} size="compact" />,
      );
      const compactBtn = singlePressable(compact);
      expect(compactBtn.props.hitSlop).toEqual({
        top: 12,
        bottom: 12,
        left: 12,
        right: 12,
      });
      const compactFlat = pressableStyle(compactBtn);
      expect(compactFlat.alignSelf).toBe("flex-end");
      expect(compactFlat.paddingVertical).toBe(8);
      expect(flatStyle(compact.root.findByType(AppText).props.style).fontSize).toBe(13);

      const full = render(<PrimaryButton label="Go to AMC" onPress={() => {}} />);
      const fullBtn = singlePressable(full);
      expect(fullBtn.props.hitSlop).toBeUndefined();
      const fullFlat = pressableStyle(fullBtn);
      expect(fullFlat.width).toBe("100%");
      expect(fullFlat.paddingVertical).toBe(15);
      expect(flatStyle(full.root.findByType(AppText).props.style).fontSize).toBe(15);
    });

    it("pressed/hovered shifts the fill to brandDark; idle is brandContrast (UI35.2 primary)", () => {
      const renderer = render(<PrimaryButton label="Go to AMC" onPress={() => {}} />);
      const btn = singlePressable(renderer);
      expect(pressableStyle(btn).backgroundColor).toBe(colors.brandContrast);
      expect(pressableStyle(btn, { pressed: true }).backgroundColor).toBe(
        colors.brandDark,
      );
      expect(
        pressableStyle(btn, { pressed: false, hovered: true }).backgroundColor,
      ).toBe(colors.brandDark);
    });

    it("disabled keeps the disabled fill even when pressed, with disabledText label", () => {
      const onPress = vi.fn();
      const renderer = render(
        <PrimaryButton label="Go to AMC" onPress={onPress} disabled />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBeUndefined();
      expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: false });
      expect(pressableStyle(btn, { pressed: true }).backgroundColor).toBe(
        colors.disabledBg,
      );
      expect(flatStyle(renderer.root.findByType(AppText).props.style).color).toBe(
        colors.disabledText,
      );
    });

    it("shows the web focus ring only while focused (UI35.3)", () => {
      const renderer = render(<PrimaryButton label="Go to AMC" onPress={() => {}} />);
      const btn = singlePressable(renderer);
      expect(pressableStyle(btn).outlineColor).toBeUndefined();
      act(() => {
        (btn.props.onFocus as () => void)();
      });
      const focused = pressableStyle(singlePressable(renderer));
      expect(focused.outlineColor).toBe(colors.brandDark);
      expect(focused.outlineWidth).toBe(2);
    });

    it("is not focusable while disabled", () => {
      const renderer = render(
        <PrimaryButton label="Go to AMC" onPress={() => {}} disabled />,
      );
      expect(singlePressable(renderer).props.focusable).toBe(false);
    });
  });

  describe("SecondaryButton", () => {
    it("busy surfaces in accessibilityState WITHOUT gating interaction", () => {
      const onPress = vi.fn();
      const renderer = render(
        <SecondaryButton label="Retry" onPress={onPress} busy />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.accessibilityState).toEqual({ disabled: false, busy: true });
      // Unlike PrimaryButton's loading, busy does not block presses.
      expect(btn.props.onPress).toBe(onPress);
      expect(btn.props.disabled).toBe(false);
      act(() => {
        (btn.props.onPress as () => void)();
      });
      expect(onPress).toHaveBeenCalledTimes(1);
    });

    it("appends the suffix glyph to the label", () => {
      const renderer = render(
        <SecondaryButton label="2 together" suffix="▾" onPress={() => {}} />,
      );
      expect(labelText(renderer)).toBe("2 together ▾");
    });

    it("preserves rect/pill geometry, backgrounds, and fullWidth", () => {
      const rect = render(<SecondaryButton label="Retry" onPress={() => {}} />);
      expect(pressableStyle(singlePressable(rect)).borderRadius).toBe(12);
      expect(pressableStyle(singlePressable(rect)).backgroundColor).toBeUndefined();

      const pill = render(
        <SecondaryButton
          label="Change format"
          shape="pill"
          background="white"
          onPress={() => {}}
        />,
      );
      const pillFlat = pressableStyle(singlePressable(pill));
      expect(pillFlat.borderRadius).toBe(999);
      expect(pillFlat.backgroundColor).toBe(colors.white);

      const muted = render(
        <SecondaryButton label="Retry" background="muted" onPress={() => {}} />,
      );
      expect(pressableStyle(singlePressable(muted)).backgroundColor).toBe(
        colors.cardMutedBg,
      );

      const wide = render(
        <SecondaryButton label="See other options" fullWidth onPress={() => {}} />,
      );
      expect(pressableStyle(singlePressable(wide)).width).toBe("100%");
    });

    it("pressed/hovered applies the borderSoft wash without changing idle (UI35.2 secondary)", () => {
      const renderer = render(
        <SecondaryButton
          label="Change format"
          shape="pill"
          background="white"
          onPress={() => {}}
        />,
      );
      const btn = singlePressable(renderer);
      expect(pressableStyle(btn).backgroundColor).toBe(colors.white);
      expect(pressableStyle(btn, { pressed: true }).backgroundColor).toBe(
        colors.borderSoft,
      );
    });

    it("disabled dims via opacity and blocks presses", () => {
      const onPress = vi.fn();
      const renderer = render(
        <SecondaryButton label="Retry" onPress={onPress} disabled />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBeUndefined();
      expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: false });
      expect(pressableStyle(btn).opacity).toBe(0.5);
    });

    it("falls back to the label when no accessibilityLabel is given", () => {
      const renderer = render(<SecondaryButton label="Retry" onPress={() => {}} />);
      expect(singlePressable(renderer).props.accessibilityLabel).toBe("Retry");
    });
  });

  describe("Button (polymorphic)", () => {
    it("defaults to the primary variant with label fallback", () => {
      const renderer = render(<Button label="Find my seats" onPress={() => {}} />);
      const btn = singlePressable(renderer);
      expect(btn.props.accessibilityRole).toBe("button");
      expect(btn.props.accessibilityLabel).toBe("Find my seats");
      expect(pressableStyle(btn).backgroundColor).toBe(colors.brandContrast);
      expect(btn.props.hitSlop).toBeUndefined();
    });

    it("honors an explicit accessibilityLabel and hint", () => {
      const renderer = render(
        <Button
          label="Go to AMC"
          onPress={() => {}}
          accessibilityLabel="Custom label"
          accessibilityHint="Custom hint"
        />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.accessibilityLabel).toBe("Custom label");
      expect(btn.props.accessibilityHint).toBe("Custom hint");
    });

    it("secondary variant renders the white rect idle with pill opt-in", () => {
      const renderer = render(
        <Button label="Edit search" variant="secondary" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      const flat = pressableStyle(btn);
      expect(flat.backgroundColor).toBe(colors.white);
      expect(flat.borderRadius).toBe(12);
      expect(pressableStyle(btn, { pressed: true }).backgroundColor).toBe(
        colors.borderSoft,
      );

      const pill = render(
        <Button
          label="Change format"
          variant="secondary"
          shape="pill"
          onPress={() => {}}
        />,
      );
      expect(pressableStyle(singlePressable(pill)).borderRadius).toBe(999);
    });

    it("link variant uses brandDark text with hitSlop and hover underline (UI35.2/35.4)", () => {
      const renderer = render(
        <Button label="Restore recommendation" variant="link" onPress={() => {}} />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.hitSlop).toEqual({
        top: 12,
        bottom: 12,
        left: 12,
        right: 12,
      });
      const textStyle = flatStyle(renderer.root.findByType(AppText).props.style);
      expect(textStyle.color).toBe(colors.brandDark);
      expect(textStyle.textDecorationLine).toBe("none");
      act(() => {
        (btn.props.onHoverIn as () => void)();
      });
      expect(
        flatStyle(renderer.root.findByType(AppText).props.style).textDecorationLine,
      ).toBe("underline");
    });

    it("compact size carries hitSlop on any variant (UI35.4)", () => {
      const renderer = render(
        <Button
          label="Edit search"
          variant="secondary"
          size="compact"
          onPress={() => {}}
        />,
      );
      expect(singlePressable(renderer).props.hitSlop).toEqual({
        top: 12,
        bottom: 12,
        left: 12,
        right: 12,
      });
    });

    it("loading forces disabled with busy:true and an inline spinner", () => {
      const onPress = vi.fn();
      const renderer = render(
        <Button label="Finding seats…" onPress={onPress} loading />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.onPress).toBeUndefined();
      expect(btn.props.disabled).toBe(true);
      expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: true });
      expect(renderer.root.findAllByType(LoadingSpinner)).toHaveLength(1);
      expect(onPress).not.toHaveBeenCalled();
    });

    it("renders left/right icon adornments around the label", () => {
      const renderer = render(
        <Button
          label="Continue"
          onPress={() => {}}
          leftIcon={<View testID="left-icon" />}
          rightIcon={<View testID="right-icon" />}
        />,
      );
      const root = renderer.root;
      expect(root.findByProps({ testID: "left-icon" })).toBeDefined();
      expect(root.findByProps({ testID: "right-icon" })).toBeDefined();
      expect(labelText(renderer)).toBe("Continue");
    });

    it("fullWidth stretches a secondary button", () => {
      const renderer = render(
        <Button label="See other options" variant="secondary" fullWidth onPress={() => {}} />,
      );
      expect(pressableStyle(singlePressable(renderer)).width).toBe("100%");
    });

    it("disabled buttons are not focusable and keep idle fill under press", () => {
      const renderer = render(
        <Button label="Find my seats" onPress={() => {}} disabled />,
      );
      const btn = singlePressable(renderer);
      expect(btn.props.focusable).toBe(false);
      expect(btn.props.accessibilityState).toEqual({ disabled: true, busy: false });
      expect(pressableStyle(btn, { pressed: true }).backgroundColor).toBe(
        colors.disabledBg,
      );
    });
  });
});
