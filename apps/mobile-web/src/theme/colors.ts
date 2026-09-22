/**
 * Colors extracted verbatim from the inline styles in docs/Seatfirst.dc.html.
 * This file is the literal source of truth for fidelity — not the newer, broader
 * design-system token set, which uses different values (see ui-work-plan.md U1).
 */
export const colors = {
  pageBg: "#f7f5f1",

  textPrimary: "#1c1a17",
  textMuted: "#6b665f",
  textTertiary: "#766f64",
  textReplacementBody: "#4a463f",

  brand: "#c8752c",
  brandDark: "#a75f1f",
  // ADR-0060 narrow exception to the literal-mockup-extraction rule above: darker terracotta so PrimaryButton white text clears WCAG AA.
  brandContrast: "#a95e1c",
  brandSoft: "#f6e6d6",

  cardBg: "#ffffff",
  cardMutedBg: "#faf9f7",
  gateBg: "#f1efe9",

  theaterConfirmBg: "#fdf6ee",
  theaterConfirmBorder: "rgba(167,95,31,.45)",

  mapEmptyStart: "#e9e5dd",
  mapEmptyEnd: "#c9c2b4",
  posterStripe: "#ddd7cb",
  seatEmpty: "rgba(28,26,23,.14)",
  seatTaken: "#b9b3a6",
  seatAmber: "#c8752c",
  seatIndigo: "#4a5bc4",
  indigoTagBg: "#e6e8f9",
  indigoTagText: "#37409a",
  amberTagBg: "#f6e6d6",
  amberTagText: "#a75f1f",
  // ADR-0068: darker amber text for normal-size text on amberTagBg/brandSoft
  // (#974d0e on #f6e6d6 = 5.20:1, clears WCAG AA 4.5:1; amberTagText at 4.00:1
  // does not). amberTagText stays for large-text/dark-surface uses per the ADR.
  amberTagTextContrast: "#974d0e",

  statusGreen: "#3d8361",

  noExactBg: "#f6e6d6",
  noExactText: "#a75f1f",
  noValidBg: "#f7ece7",
  noValidText: "#a04b1f",

  replacementBg: "#f7ece7",
  replacementTitle: "#a75f1f",

  disabledBg: "#e9e5dd",
  disabledText: "#766f64",

  border: "rgba(28,26,23,.12)",
  borderStrong: "rgba(28,26,23,.16)",
  borderSoft: "rgba(28,26,23,.14)",
  borderHairline: "rgba(28,26,23,.08)",
  borderFooter: "rgba(28,26,23,.1)",
  ghostDashed: "rgba(28,26,23,.28)",
  radioOffBorder: "rgba(28,26,23,.25)",
  popoverBorder: "rgba(28,26,23,.14)",
  popoverShadow: "rgba(28,26,23,.1)",
  checkboxOffBorder: "rgba(28,26,23,.2)",

  white: "#ffffff",
} as const;

export type ColorToken = keyof typeof colors;
