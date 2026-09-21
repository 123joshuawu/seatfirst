import { useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
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

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  maxWidth?: number;
  children: ReactNode;
}

/**
 * Viewport-height breakpoint distinguishing small phones (e.g. 667px-tall
 * iPhone SE) from regular phones (844px iPhone 14 and up). No height-based
 * distinction existed elsewhere in the codebase (only the shared 680px width
 * breakpoint), so this is a UI36 judgment call: below 740px the panel caps
 * at 85% of the viewport so the fixed header + footer never squeeze the
 * scrollable body to zero; at/above it caps at 90%.
 */
export const SMALL_SHEET_VIEWPORT_HEIGHT = 740;

export function sheetMaxHeightForViewport(viewportHeight: number): "85%" | "90%" {
  return viewportHeight < SMALL_SHEET_VIEWPORT_HEIGHT ? "85%" : "90%";
}

/**
 * Shared mobile bottom-sheet primitive consolidating the three
 * independently-implemented overlays (HowItWorksSheet, WhenCustomSheet,
 * AutocompletePopover's mobile branch). Strict 3-part layout: fixed header
 * (`flexShrink: 0`), scrollable body (`flex: 1, minHeight: 0`), fixed footer
 * (`flexShrink: 0`) — so footer actions stay pinned regardless of body
 * content height (the WhenCustomSheet P0: its 2-month calendar grid pushed
 * Clear/Cancel/Apply below the 844px fold).
 *
 * `Modal` portals to the document body, escaping the transformed RNW
 * ancestors that would otherwise trap `fixed` (and clip absolutely-positioned
 * popovers against the card). Dismissal: scrim tap, header Close button,
 * Escape on web, and `onRequestClose` (Android hardware back) on native.
 */
function SheetBase({
  open,
  onClose,
  ariaLabel,
  maxWidth = 440,
  children,
}: SheetProps): ReactElement | null {
  // Hooks stay above the `!open` early return so hook order is stable across
  // renders (same convention as the sheets this consolidates).
  const { height } = useWindowDimensions();
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
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View
        style={styles.overlay}
        {...(Platform.OS === "web"
          ? ({ role: "dialog", "aria-modal": "true", "aria-label": ariaLabel } as unknown as Record<
              string,
              unknown
            >)
          : {})}
      >
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close dialog"
        />
        <View
          style={[styles.panel, { maxWidth }, { maxHeight: sheetMaxHeightForViewport(height) }]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}

function SheetHeader({
  title,
  onClose,
  subtitle,
}: {
  title: string;
  onClose: () => void;
  subtitle?: string;
}): ReactElement {
  return (
    <View style={styles.headerRow}>
      <View style={styles.headerTextWrap}>
        <AppText family="display" weight="700" style={styles.title}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText weight="400" style={styles.subtitle}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={`Close ${title}`}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={styles.closeButton}
      >
        <AppText weight="600" style={styles.closeText}>
          Close
        </AppText>
      </Pressable>
    </View>
  );
}

function SheetBody({
  children,
  scrollable = true,
}: {
  children: ReactNode;
  scrollable?: boolean;
}): ReactElement {
  if (!scrollable) return <View style={styles.body}>{children}</View>;
  return (
    <ScrollView
      style={styles.bodyScroll}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {children}
    </ScrollView>
  );
}

function SheetFooter({ children }: { children: ReactNode }): ReactElement {
  return <View style={styles.footer}>{children}</View>;
}

/** Compound component: `Sheet.Header`/`Sheet.Body`/`Sheet.Footer` attached via
 * `Object.assign` rather than a TS `namespace` (ESLint `no-namespace`, ES2015
 * module syntax preferred) — same runtime shape and call-site API. */
export const Sheet = Object.assign(SheetBase, {
  Header: SheetHeader,
  Body: SheetBody,
  Footer: SheetFooter,
});

const styles = StyleSheet.create({
  overlay: {
    // `fixed` only exists on web: on native it must be `absolute` (a bare
    // `position: "fixed"` literal is invalid in React Native). The Modal
    // already portals to the document body, so `fixed` here only guards
    // against transformed RNW ancestors in non-portal usages.
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
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  // Size-to-content (no `flex`): the panel wraps short content and caps at
  // 85/90% of the viewport for tall content, at which point the Body (flex: 1,
  // minHeight: 0) becomes the bounded scroller while header/footer stay
  // pinned. Visual values (card bg, 12px radius, 16px padding, 12px gap)
  // match the established Autocomplete sheet panel.
  panel: {
    backgroundColor: colors.cardBg,
    borderRadius: 12,
    padding: 16,
    width: "100%",
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  headerTextWrap: {
    flex: 1,
  },
  title: {
    fontSize: 16,
  },
  // Literal gray preserves WhenCustomSheet's established subtitle color
  // exactly (colors.textMuted is a nearby but different token).
  subtitle: {
    fontSize: 13,
    color: "#6B7280",
  },
  closeButton: {
    // 44x44 minimum touch target (WCAG 2.5.5 / Apple HIG), carried over from
    // HowItWorksSheet: the visual label stays 14px but the tappable box plus
    // hitSlop exceeds the minimum.
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  closeText: {
    fontSize: 14,
    color: colors.brandDark,
  },
  bodyScroll: {
    flex: 1,
    minHeight: 0,
  },
  bodyContent: {},
  body: {
    flex: 1,
    minHeight: 0,
  },
  footer: {
    flexShrink: 0,
  },
});
