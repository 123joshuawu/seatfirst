import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import type { ReactElement } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { Sheet } from "./Sheet";
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
/**
 * Dismiss-on-outside-`pointerdown` for an open popover/sheet.
 *
 * WHY this exists: dismissal used to ride only on the target field's `onBlur`.
 * On web a blur fires in response to the *next* element's mousedown, so by the
 * time React commits the popover-closed re-render the browser has already
 * dispatched that same click against the still-mounted (overlapping, higher
 * z-index) popover instead of the element under the pointer. Reproduced live:
 * with the WHERE popover open, clicking the MOVIE combobox closed WHERE but
 * never focused MOVIE — the user had to click a second time.
 *
 * A `document`-level `pointerdown` listener in the capture phase runs BEFORE
 * the click is dispatched, so `onClose` unmounts the popover first and the
 * real click lands on whatever is actually under the pointer (the MOVIE
 * input, the search CTA, …). `pointerdown` — not `click` — is the event that
 * still precedes focus change and click dispatch.
 *
 * Two carve-outs keep this from over-dismissing:
 * - Targets *inside* the popover node (options, radius chips, …) are ignored
 *   so in-popover presses still complete their click.
 * - A `pointerdown` on the currently-focused element never blurs it, so e.g.
 *   repositioning the caret in the WHERE input while its own popover is open
 *   must not dismiss; any other target will move focus and may dismiss.
 * Web-only (`Platform.OS === 'web'` + `document` guard): native has no DOM
 * and already dismisses via the sheet scrim / Close Pressables, which stay
 * wired to `onClose` untouched — as do Escape/tab/explicit-close paths.
 * When the popover DOM node can't be resolved (native, test renderers without
 * a DOM mount) the handler no-ops and the pre-existing blur path decides.
 */
function useOutsidePointerDownDismiss(
  popoverRef: RefObject<View | null>,
  popoverDomId: string,
  onClose: (() => void) | undefined,
): void {
  // Latest-handler ref so the document listener subscribes once per popover
  // node instead of churning on every parent re-render (callers pass inline
  // `vm.actions.handleBlur`, whose identity is stable, but cheap either way).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const doc = document;
    const handlePointerDown = (event: Event): void => {
      const target = event.target as Element | null;
      if (!target) return;
      // Clicking the focused element cannot blur it — never dismiss for that.
      if (target === doc.activeElement) return;
      // Prefer the live node; react-native-web forwards View refs to the
      // underlying div. Fall back to the id the node carries on web, which
      // also covers mounts where the ref never attached.
      const refNode = popoverRef.current as unknown as Element | null;
      const popoverEl =
        refNode && typeof refNode.contains === "function"
          ? refNode
          : doc.getElementById(popoverDomId);
      if (!popoverEl) return;
      if (popoverEl.contains(target)) return;
      onCloseRef.current?.();
    };
    // Capture phase: must run before the click dispatches to the page.
    doc.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      doc.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [popoverDomId, popoverRef]);
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
  /** Dismiss handler: sheet scrim + Close button, Escape (via `Sheet`), and outside-pointerdown. */
  onClose?: (() => void) | undefined;
}): ReactElement {
  const { width } = useWindowDimensions();
  const showAsSheet = isMobile ?? width < AUTOCOMPLETE_MOBILE_BREAKPOINT;
  // Live node for the outside-pointerdown check: the inline popover itself on
  // desktop, the sheet *content wrapper* on mobile so a scrim tap dismisses
  // up front and the follow-on click passes through to the element behind
  // the sheet instead of being swallowed by the scrim.
  const popoverRef = useRef<View | null>(null);
  // Mirrors the DOM id the tracked node carries on web (see the `id` props
  // below); the hook falls back to it when the ref never attached.
  const popoverDomId = showAsSheet ? `${id}-panel` : id;
  useOutsidePointerDownDismiss(popoverRef, popoverDomId, onClose);
  if (showAsSheet) {
    // Mobile bottom sheet on the shared `Sheet` primitive (overlay/scrim/
    // panel, Escape-to-dismiss, and ARIA dialog wiring all live there now).
    // `Sheet`'s `Modal` portals to the document body, escaping the
    // transformed RNW ancestors that would otherwise trap `fixed` (and clip
    // the absolutely-positioned inline popover against the card).
    // Selection/keyboard behavior is unchanged: `children` render as-is.
    //
    // The tracked dismiss node is the content wrapper (`${id}-panel`) inside
    // the body, so a scrim tap dismisses up front and the follow-on click
    // passes through to the element behind the sheet — same as before, when
    // the panel itself was the tracked node. Taps on the fixed header
    // dismiss at pointerdown like scrim taps; `onClose` handlers are
    // idempotent state updates so that race is harmless.
    //
    // `scrollMaxHeight` keeps its exact meaning via the inner list scroller:
    // the sheet body itself is non-scrolling, so the cap still bounds the
    // option list (desktop behavior untouched).
    const handleClose = onClose ?? (() => {});
    return (
      <Sheet open={true} onClose={handleClose} ariaLabel={`${ariaLabel} dialog`} maxWidth={400}>
        <Sheet.Header title={header} onClose={handleClose} />
        <Sheet.Body scrollable={false}>
          <View
            ref={popoverRef}
            style={styles.sheetContent}
            {...(Platform.OS === "web"
              ? ({ role: "document", id: `${id}-panel` } as unknown as Record<string, unknown>)
              : {})}
          >
            <ScrollView
              style={[
                styles.sheetList,
                scrollMaxHeight !== undefined ? { maxHeight: scrollMaxHeight } : null,
              ]}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>
          </View>
        </Sheet.Body>
      </Sheet>
    );
  }
  return (
    <View
      ref={popoverRef}
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
  // Desktop inline popover — BUG-01: this used to be an absolutely-positioned
  // overlay (`position: "absolute", top: "100%", left: 0, right: 0`), whose
  // bounding box (scroll region up to 360px tall plus header chrome) always
  // extended over the next sibling field (MOVIE input / FORMAT pills) on the
  // tight desktop rhythm, trapping pointer events: a click aimed at the
  // covered field landed ON the popover and the outside-dismiss hook
  // correctly treated it as inside. Rendered in-flow instead, the open list
  // pushes the fields below it down, so nothing is ever occluded and a real
  // click lands on its visible target first try. The 150ms-deferred blur
  // close (searchFormSlice onWhereBlur/onMovieBlur) keeps layout stable
  // through press/release, so option selection and the capture-phase dismiss
  // below both still win their races unchanged. Mobile is untouched (sheet).
  popover: {
    marginTop: 4,
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
  // Mobile sheet content wrapper (the outside-pointerdown tracked node) and
  // inner option-list scroller. Overlay/scrim/panel/header chrome now comes
  // from the shared `Sheet` primitive; only the dismiss-tracking wrapper and
  // the `scrollMaxHeight`-capped list remain local.
  sheetContent: {
    flex: 1,
    minHeight: 0,
  },
  sheetList: {
    flex: 1,
    minHeight: 0,
  },
});
