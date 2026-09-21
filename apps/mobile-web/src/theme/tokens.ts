import { colors } from "./colors";

/** UI40.1 Tier-2 semantic tokens: functional intent namespaces decoupling
 * components from raw hex strings in colors.ts. */
export const tokens = {
  surface: {
    canvas: colors.pageBg,
    card: colors.cardBg,
    cardMuted: colors.cardMutedBg,
    elevated: colors.cardBg,
    sunken: colors.gateBg,
  },
  text: {
    primary: colors.textPrimary,
    secondary: colors.textMuted,
    tertiary: colors.textTertiary,
    brand: colors.brandContrast,
    inverse: colors.white,
    // UI40: spec cites colors.statusRed, which does not exist in this palette;
    // error copy throughout the app uses colors.noValidText — use it here.
    error: colors.noValidText,
  },
  border: {
    subtle: colors.borderHairline,
    default: colors.border,
    strong: colors.borderStrong,
    focus: colors.brandContrast,
  },
  interactive: {
    primary: colors.brandContrast,
    primaryHover: colors.brand,
    primaryActive: colors.brandDark,
    disabledBg: colors.disabledBg,
    disabledText: colors.disabledText,
  },
} as const;

export type SurfaceToken = keyof typeof tokens.surface;
export type TextToken = keyof typeof tokens.text;
export type BorderToken = keyof typeof tokens.border;
export type InteractiveToken = keyof typeof tokens.interactive;

/** UI40.2 high-contrast focus rings (web only): 2px solid outline in
 * colors.brandContrast, clearing WCAG 2.4.11's 3.0:1 threshold on canvas. */
export const focusRings = {
  standard: {
    outlineColor: colors.brandContrast,
    outlineWidth: 2,
    outlineStyle: "solid" as const,
    outlineOffset: 2,
  },
  inset: {
    outlineColor: colors.brandContrast,
    outlineWidth: 2,
    outlineStyle: "solid" as const,
    outlineOffset: -2,
  },
} as const;
