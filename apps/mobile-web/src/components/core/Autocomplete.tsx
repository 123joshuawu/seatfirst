import type { ReactNode } from "react";
import type { ReactElement } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";

/**
 * Mobile breakpoint — mirrors `MOBILE_BREAKPOINT` in
 * `useSubmitSearchViewModel` (`vm.isMobile` is `width < 680`). Kept as a local
 * const so this presentational shell stays dependency-free; callers that already
 * know `vm.isMobile` may pass it explicitly via the `isMobile` prop instead.
 */
export const AUTOCOMPLETE_MOBILE_BREAKPOINT = 680;

export function AutocompleteFieldShell({
  children,
  focused = false,
  disabled = false,
}: {
  children: ReactNode;
  focused?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <View
      style={[
        styles.field,
        focused && styles.fieldFocused,
        focused && popoverShadow,
        disabled && styles.disabled,
      ]}
    >
      {children}
    </View>
  );
}

export function AutocompletePopover({
  id,
  header,
  ariaLabel = header,
  renderHeader = true,
  children,
  alert = false,
  role = "listbox",
  scrollMaxHeight,
  isMobile,
  onClose,
}: {
  id: string;
  header: string;
  /** Accessible name for the whole popup; defaults to the visible header. */
  ariaLabel?: string;
  /** Set false when callers render labelled option groups inside the popup. */
  renderHeader?: boolean;
  children: ReactNode;
  alert?: boolean;
  role?: "listbox" | "menu" | "region";
  /** Optional maxHeight for inner ScrollView; defaults to 360 to preserve existing consumers. */
  scrollMaxHeight?: number;
  /**
   * Mobile override. When true the suggestion list renders as a bottom-sheet
   * modal instead of the inline popover. Defaults to the shared viewport check
   * (`width < 680`, same as `vm.isMobile`).
   */
  isMobile?: boolean | undefined;
  /** Dismiss handler for the sheet scrim and Close button (mobile only). */
  onClose?: (() => void) | undefined;
}): ReactElement {
  const { width } = useWindowDimensions();
  const showAsSheet = isMobile ?? width < AUTOCOMPLETE_MOBILE_BREAKPOINT;
  if (showAsSheet) {
    // Mobile bottom sheet — mirrors the established sheet convention
    // (HowItWorksSheet/WhenCustomSheet): rgba(0,0,0,0.4) scrim with a
    // bottom-anchored panel. `Modal` portals to the document body, escaping
    // the transformed RNW ancestors that would otherwise trap `fixed` (and
    // clip the absolutely-positioned inline popover against the card).
    // Selection/keyboard behavior is unchanged: `children` render as-is.
    return (
      <Modal visible transparent animationType="none" onRequestClose={onClose}>
        <View
          style={styles.sheetOverlay}
          accessibilityLabel={`${ariaLabel} dialog`}
          {...(Platform.OS === "web"
            ? ({
                role: "dialog",
                id,
                "aria-label": ariaLabel,
                "aria-modal": "true",
              } as unknown as Record<string, unknown>)
            : {})}
        >
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={`Close ${header}`}
            style={styles.sheetScrim}
          />
          <View
            style={styles.sheetPanel}
            {...(Platform.OS === "web"
              ? ({ role: "document" } as unknown as Record<string, unknown>)
              : {})}
          >
            <View style={styles.sheetHeaderRow}>
              <AppText weight="700" style={styles.sheetTitle}>
                {header}
              </AppText>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={`Close ${header}`}
                accessibilityHint="Closes the suggestions"
                style={styles.sheetClose}
              >
                <AppText weight="600" style={styles.sheetCloseText}>
                  Close
                </AppText>
              </Pressable>
            </View>
            <ScrollView
              style={scrollMaxHeight !== undefined ? { maxHeight: scrollMaxHeight } : null}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }
  return (
    <View
      style={[styles.popover, popoverShadow]}
      accessibilityLabel={ariaLabel}
      accessibilityRole={alert ? "alert" : undefined}
      {...(Platform.OS === "web"
        ? ({
            role: alert ? "alert" : role,
            id,
            "aria-label": ariaLabel,
          } as unknown as Record<string, unknown>)
        : {})}
    >
      {renderHeader ? (
        <AppText weight="700" style={styles.header}>
          {header}
        </AppText>
      ) : null}
      <ScrollView
        style={[
          styles.scroll,
          scrollMaxHeight !== undefined ? { maxHeight: scrollMaxHeight } : null,
        ]}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        {children}
      </ScrollView>
    </View>
  );
}

const popoverShadow =
  Platform.OS === "web" ? { boxShadow: `0 8px 20px ${colors.popoverShadow}` } : {};

const styles = StyleSheet.create({
  field: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.cardMutedBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  fieldFocused: {
    borderColor: colors.brandDark,
  },
  disabled: {
    opacity: 0.5,
  },
  popover: {
    position: "absolute",
    top: "100%",
    marginTop: 4,
    left: 0,
    right: 0,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.popoverBorder,
    borderRadius: 10,
    overflow: "hidden",
    zIndex: 10,
  },
  header: {
    paddingTop: 8,
    paddingHorizontal: 14,
    paddingBottom: 4,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.textTertiary,
  },
  scroll: {
    maxHeight: 360,
  },
  sheetOverlay: {
    position: Platform.OS === "web" ? ("fixed" as unknown as "absolute") : "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: 16,
    zIndex: 100,
  },
  sheetScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheetPanel: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    width: "100%",
    maxWidth: 400,
    maxHeight: "80%",
    gap: 12,
  },
  sheetHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: {
    fontSize: 16,
  },
  sheetClose: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  sheetCloseText: {
    fontSize: 14,
    color: colors.brandDark,
  },
});
