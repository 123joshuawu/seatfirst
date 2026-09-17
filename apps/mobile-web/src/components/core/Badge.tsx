import type { ReactElement } from "react";
import { View } from "react-native";
import { AppText } from "./AppText";

export interface BadgeProps {
  label: string;
  background: string;
  color: string;
  /** Small format tag (12px) vs the larger eyebrow badges on the fallback cards (11px uppercase). */
  variant?: "tag" | "eyebrow";
}

export function Badge({ label, background, color, variant = "tag" }: BadgeProps): ReactElement {
  const isEyebrow = variant === "eyebrow";
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: background,
        borderRadius: isEyebrow ? 6 : 6,
        paddingVertical: isEyebrow ? 5 : 4,
        paddingHorizontal: isEyebrow ? 10 : 9,
      }}
    >
      <AppText
        weight="700"
        style={{
          fontSize: isEyebrow ? 11 : 12,
          color,
          textTransform: isEyebrow ? "uppercase" : "none",
          letterSpacing: isEyebrow ? 0.7 : 0,
        }}
      >
        {label}
      </AppText>
    </View>
  );
}
