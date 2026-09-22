import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";

/**
 * The SEATFIRST branding row (dot + wordmark). Extracted verbatim from
 * LeftPanel's wordmark block so the mobile-only header in app/index.tsx and
 * the desktop LeftPanel share one implementation — same markup, same styles.
 */
export function Wordmark(): ReactElement {
  return (
    <View style={styles.wordmarkRow}>
      <View style={styles.wordmarkDot} />
      <AppText weight="700" style={styles.wordmark}>
        Seatfirst
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wordmarkDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.brand,
  },
  wordmark: {
    fontSize: 12,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
});
