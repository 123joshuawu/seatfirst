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
  /** Wheelchair or companion accessible seat per ADR 0011. */
  isAccessible?: boolean;
  /** Whether the seat is taken/occupied by another patron. */
  taken?: boolean;
}

/** Dots at or above this size render the prime center pip; smaller dots use an outline instead. */
const PIP_THRESHOLD = 8;

/**
 * A single seat in the auditorium grid, encoded by shape as well as color (UI39 / ADR 0069,
 * WCAG 1.4.1 — never color alone):
 * - prime (active): solid filled circle + white center pip (large) or white outline (small);
 * - available: hollow ring; taken: flat recessed disk; lost: diagonal strike (ADR 0059);
 * - accessible: diamond silhouette layered over whichever base state applies.
 *
 * State precedence when flags combine (states are otherwise mutually exclusive):
 * lost > taken > active-prime > available. Accessible is a modifier, never a base state.
 */
export function SeatDot({
  active,
  hue,
  size,
  lost = false,
  isAccessible = false,
  taken = false,
}: SeatDotProps): ReactElement {
  const isLost = lost;
  const isTaken = !isLost && taken;
  const isPrime = !isLost && !isTaken && active;
  const backgroundColor =
    isLost || isTaken
      ? colors.seatTaken
      : isPrime
        ? hue === "indigo"
          ? colors.seatIndigo
          : colors.seatAmber
        : "transparent";
  const showPip = isPrime && size >= PIP_THRESHOLD;
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: isAccessible ? 1.5 : size / 2,
          backgroundColor,
        },
        isAccessible ? styles.diamond : null,
        // Hollow ring for plain available seats — the non-color "open" signal.
        !isPrime && !isLost && !isTaken
          ? { borderWidth: 1.5, borderColor: colors.borderStrong }
          : null,
        // Taken seats sit flatter and dimmer than any live state.
        isTaken ? { opacity: 0.45 } : null,
        // Small prime dots can't fit the inner pip — a crisp white outline instead.
        isPrime && !showPip ? { borderWidth: 1.5, borderColor: colors.white } : null,
      ]}
    >
      {showPip ? (
        <View
          style={{
            width: size * 0.35,
            height: size * 0.35,
            borderRadius: 9999,
            backgroundColor: colors.white,
          }}
        />
      ) : null}
      {isLost ? <View style={styles.lostStrike} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  /** Accessible silhouette modifier: 45-degree diamond over the base state. */
  diamond: {
    transform: [{ rotate: "45deg" }],
  },
  lostStrike: {
    position: "absolute",
    width: "150%",
    height: 1,
    backgroundColor: colors.textMuted,
    transform: [{ rotate: "-45deg" }],
  },
});
