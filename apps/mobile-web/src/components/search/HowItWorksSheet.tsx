import type { ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AppText } from "@/components/core/AppText";
import { GhostResultCard } from "./GhostResultCard";

export interface HowItWorksSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile-only bottom sheet reproducing the State-1 ghost card on demand.
 * Structure follows `WhenCustomSheet`'s full-screen-overlay-plus-panel pattern
 * (absolute `rgba(0,0,0,0.4)` scrim) but anchors the panel to the bottom
 * (`justifyContent: "flex-end"`) so it reads as a bottom sheet, distinct from
 * `WhenCustomSheet`'s centered dialog. Never auto-opened; open/closed state is
 * local `useState` in `SearchForm`, never persisted.
 */
export function HowItWorksSheet({ open, onClose }: HowItWorksSheetProps): ReactElement | null {
  if (!open) return null;

  return (
    <View style={styles.overlay} accessible={true} accessibilityLabel="How Seatfirst works">
      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close how it works"
            style={styles.closeButton}
          >
            <AppText weight="600" style={styles.closeText}>
              ×
            </AppText>
          </Pressable>
        </View>
        <ScrollView style={styles.body} showsVerticalScrollIndicator={true}>
          <GhostResultCard />
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
    alignItems: "center",
    padding: 16,
    zIndex: 100,
  },
  panel: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    width: "100%",
    maxWidth: 400,
    flex: 1,
    gap: 12,
  },
  body: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  closeButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  closeText: {
    fontSize: 18,
    color: "#6B7280",
  },
});
