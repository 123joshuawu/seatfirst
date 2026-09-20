import { useEffect } from "react";
import type { ReactElement } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AppText } from "@/components/core/AppText";
import { GhostResultCard } from "./GhostResultCard";

export interface HowItWorksSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mobile-only bottom sheet reproducing the State-1 ghost card on demand.
 * Structure mirrors `AutocompletePopover`'s mobile sheet branch
 * (`styles.sheetScrim`/`styles.sheetPanel` in
 * `components/core/Autocomplete.tsx`): a full-screen overlay container with
 * an absolutely-positioned scrim `Pressable` behind a bottom-anchored panel,
 * so tapping the dark backdrop dismisses while the panel stays interactive.
 * Never auto-opened; open/closed state is local `useState` in `SearchForm`,
 * never persisted.
 */
export function HowItWorksSheet({ open, onClose }: HowItWorksSheetProps): ReactElement | null {
  // Web-only Escape-to-dismiss (matches the `Platform.OS === "web"` +
  // `document` guard convention in Autocomplete's
  // `useOutsidePointerDownDismiss`). Hooks stay above the `!open` early
  // return so hook order is stable across renders.
  useEffect(() => {
    if (!open) return;
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <View style={styles.overlay} accessible={true} accessibilityLabel="How Seatfirst works">
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close how it works dialog"
        style={styles.scrim}
      />
      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close how it works"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
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
    justifyContent: "flex-end",
    alignItems: "center",
    padding: 16,
    zIndex: 100,
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  panel: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    width: "100%",
    maxWidth: 400,
    // Size-to-content (UX-03): no `flex: 1` — the sheet used to stretch to
    // nearly full device height with ~500px of blank whitespace below the
    // ~250px ghost card. `maxHeight` caps it on small screens while the
    // ScrollView below still scrolls if content ever exceeds the cap.
    maxHeight: "80%",
    gap: 12,
  },
  body: {
    maxHeight: 420,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  closeButton: {
    // 44x44 minimum touch target (WCAG 2.5.5 / Apple HIG): the visual x
    // stays 18px but the tappable box plus hitSlop exceeds the minimum.
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  closeText: {
    fontSize: 18,
    color: "#6B7280",
  },
});
