import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import type { PlacementHue } from "@/types/placement";

export interface SeatDotProps {
  active: boolean;
  hue: PlacementHue;
  size: number;
  /** A seat from the original placement that is no longer available. */
  lost?: boolean;
}

/** A single seat in the auditorium grid: filled+colored when part of the active placement. */
export function SeatDot({ active, hue, size, lost = false }: SeatDotProps): ReactElement {
  const color = lost
    ? colors.seatTaken
    : active
      ? hue === "indigo"
        ? colors.seatIndigo
        : colors.seatAmber
      : colors.seatEmpty;
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
      ]}
    >
      {lost ? <View style={styles.lostStrike} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  lostStrike: {
    position: "absolute",
    width: "150%",
    height: 1,
    backgroundColor: colors.textMuted,
    transform: [{ rotate: "-45deg" }],
  },
});
