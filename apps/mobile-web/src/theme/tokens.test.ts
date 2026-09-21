import { describe, expect, it } from "vitest";
import { colors } from "./colors";
import { focusRings, tokens } from "./tokens";

/** Relative luminance per WCAG 2.x (sRGB linearization). */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channel = (i: number): number => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const COLOR_RE = /^(#[0-9a-f]{6}|rgba?\([^)]+\))$/i;

function allValues(obj: Record<string, unknown>): string[] {
  return Object.values(obj).flatMap((v) =>
    typeof v === "object" && v !== null ? allValues(v as Record<string, unknown>) : [v as string],
  );
}

describe("tokens", () => {
  it("maps every semantic token to a valid color string", () => {
    for (const value of allValues(tokens)) {
      expect(value, `token value ${value}`).toMatch(COLOR_RE);
    }
  });

  it("wires surface tokens to the canvas/card palette", () => {
    expect(tokens.surface.canvas).toBe(colors.pageBg);
    expect(tokens.surface.card).toBe(colors.cardBg);
    expect(tokens.surface.cardMuted).toBe(colors.cardMutedBg);
    expect(tokens.surface.elevated).toBe(colors.cardBg);
    expect(tokens.surface.sunken).toBe(colors.gateBg);
  });

  it("wires text tokens to legible palette entries (error uses noValidText)", () => {
    expect(tokens.text.primary).toBe(colors.textPrimary);
    expect(tokens.text.secondary).toBe(colors.textMuted);
    expect(tokens.text.tertiary).toBe(colors.textTertiary);
    expect(tokens.text.brand).toBe(colors.brandContrast);
    expect(tokens.text.inverse).toBe(colors.white);
    // UI40: colors.statusRed does not exist in this palette; error copy uses noValidText.
    expect(tokens.text.error).toBe(colors.noValidText);
  });

  it("wires border and interactive tokens to the palette", () => {
    expect(tokens.border.subtle).toBe(colors.borderHairline);
    expect(tokens.border.default).toBe(colors.border);
    expect(tokens.border.strong).toBe(colors.borderStrong);
    expect(tokens.border.focus).toBe(colors.brandContrast);
    expect(tokens.interactive.primary).toBe(colors.brandContrast);
    expect(tokens.interactive.primaryHover).toBe(colors.brand);
    expect(tokens.interactive.primaryActive).toBe(colors.brandDark);
    expect(tokens.interactive.disabledBg).toBe(colors.disabledBg);
    expect(tokens.interactive.disabledText).toBe(colors.disabledText);
  });

  it("clears WCAG AA (4.5:1) for body copy on canvas", () => {
    expect(contrast(tokens.text.primary, tokens.surface.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.text.secondary, tokens.surface.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.text.tertiary, tokens.surface.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.text.error, tokens.surface.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("clears WCAG AA (4.5:1) for inverse text on the primary fill", () => {
    expect(contrast(tokens.text.inverse, tokens.interactive.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("clears the 3:1 threshold for brand text and the focus border on canvas", () => {
    // Brand text is the ADR-0068-authorized link color; the focus border must
    // clear WCAG 2.4.11's 3.0:1 non-text threshold.
    expect(contrast(tokens.text.brand, tokens.surface.canvas)).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens.border.focus, tokens.surface.canvas)).toBeGreaterThanOrEqual(3);
  });
});

describe("focusRings", () => {
  it("defines a 2px solid standard ring in the contrast-verified brand color", () => {
    expect(focusRings.standard).toEqual({
      outlineColor: colors.brandContrast,
      outlineWidth: 2,
      outlineStyle: "solid",
      outlineOffset: 2,
    });
  });

  it("defines an inset variant differing only in offset", () => {
    expect(focusRings.inset).toEqual({ ...focusRings.standard, outlineOffset: -2 });
  });

  it("clears WCAG 2.4.11 (3.0:1) for the standard ring on canvas", () => {
    expect(
      contrast(focusRings.standard.outlineColor, tokens.surface.canvas),
    ).toBeGreaterThanOrEqual(3);
  });
});
