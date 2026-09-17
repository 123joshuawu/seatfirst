import { describe, expect, it, vi } from "vitest";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { PrimaryButton, TextLinkButton } from "./Button";
import { LoadingSpinner } from "./LoadingSpinner";

describe("Button core primitives", () => {
  describe("TextLinkButton", () => {
    it("uses colors.brandContrast as default color for WCAG AA compliance (ADR 0068)", () => {
      const onPress = vi.fn();
      const el = TextLinkButton({ label: "← Edit search", onPress }) as unknown as {
        props: { children: { props: { style: { color: string } } } };
      };
      // Child AppText has the color style
      const textChild = el.props.children;
      expect(textChild.props.style.color).toBe(colors.brandContrast);
    });

    it("has hitSlop applied for comfortable touch target size", () => {
      const onPress = vi.fn();
      const el = TextLinkButton({ label: "Change", onPress }) as unknown as {
        props: Record<string, unknown>;
      };
      expect(el.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
      expect(el.props.accessibilityRole).toBe("button");
      expect(el.props.accessibilityLabel).toBe("Change");
    });
  });
  describe("PrimaryButton", () => {
    it("loading renders a spinner inside the button and blocks interaction", () => {
      const onPress = vi.fn();
      const el = PrimaryButton({
        label: "Confirming seats…",
        onPress,
        loading: true,
      }) as unknown as {
        props: {
          onPress?: () => void;
          disabled: boolean;
          accessibilityState: Record<string, unknown>;
          testID?: string;
          children: { type: unknown; props: { children: Array<{ type: unknown }> } };
        };
      };
      expect(el.props.onPress).toBeUndefined();
      expect(el.props.disabled).toBe(true);
      expect(el.props.accessibilityState).toEqual({ disabled: true, busy: true });
      const kids = el.props.children.props.children;
      expect(kids.length).toBe(2);
      expect(kids[0]?.type).toBe(LoadingSpinner);
    });

    it("forwards testID to the pressable root", () => {
      const el = PrimaryButton({
        label: "Confirming seats…",
        onPress: () => {},
        loading: true,
        testID: "rechecking-collapsed-sh_hit",
      }) as unknown as { props: { testID?: string } };
      expect(el.props.testID).toBe("rechecking-collapsed-sh_hit");
    });

    it("plain button renders just the label with no spinner", () => {
      const onPress = vi.fn();
      const el = PrimaryButton({ label: "Go to AMC", onPress }) as unknown as {
        props: {
          onPress?: () => void;
          disabled: boolean;
          accessibilityState: Record<string, unknown>;
          children: { type: unknown };
        };
      };
      expect(el.props.onPress).toBe(onPress);
      expect(el.props.disabled).toBe(false);
      expect(el.props.accessibilityState).toEqual({ disabled: false, busy: false });
      expect(el.props.children.type).toBe(AppText);
    });
  });
});
