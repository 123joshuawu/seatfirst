/**
 * Font loading aligns with ADR 0068:
 * - Archivo:wght@600;700;800
 * - IBM Plex Sans:wght@400;500;600;700
 * IBMPlexSans_700Bold is loaded explicitly (ADR 0068 Decision 3) to prevent
 * synthetic OS faux-bold rendering on iOS, Android, and Web.
 */
export const fontFamily = {
  bodyRegular: "IBMPlexSans_400Regular",
  bodyMedium: "IBMPlexSans_500Medium",
  bodySemibold: "IBMPlexSans_600SemiBold",
  bodyBold: "IBMPlexSans_700Bold",
  displaySemibold: "Archivo_600SemiBold",
  displayBold: "Archivo_700Bold",
  displayExtrabold: "Archivo_800ExtraBold",
} as const;

export type FontWeightValue = "400" | "500" | "600" | "700" | "800";
export type FontFamilyGroup = "body" | "display";

export const BODY_FAMILY_BY_WEIGHT: Record<FontWeightValue, string> = {
  "400": fontFamily.bodyRegular,
  "500": fontFamily.bodyMedium,
  "600": fontFamily.bodySemibold,
  "700": fontFamily.bodyBold,
  "800": fontFamily.bodyBold,
};

export const DISPLAY_FAMILY_BY_WEIGHT: Record<FontWeightValue, string> = {
  "400": fontFamily.displaySemibold,
  "500": fontFamily.displaySemibold,
  "600": fontFamily.displaySemibold,
  "700": fontFamily.displayBold,
  "800": fontFamily.displayExtrabold,
};

/** Monospace stack used for the "SCREEN" label and the Seatfirst wordmark eyebrow. */
export const monoFontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
