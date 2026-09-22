import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import type { ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { TextInputProps } from "react-native";
import { breakpoints } from "@/theme/breakpoints";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { Sheet } from "./Sheet";
import { useCombobox } from "./useCombobox";
import type { ComboboxInputProps, ComboboxItemProps, ComboboxListProps } from "./useCombobox";
/**
 * Mobile breakpoint — mirrors `MOBILE_BREAKPOINT` in
 * `useSubmitSearchViewModel` (`vm.isMobile` is `width < 680`). Kept exported
 * for existing readers (`PopoverList` via `AutocompletePopover`); sourced
 * from the shared `breakpoints.mobile` token (ADR 0068) so the two never drift.
 */
export const AUTOCOMPLETE_MOBILE_BREAKPOINT: number = breakpoints.mobile;

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
  sheetSearchInput,
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
  /**
   * Optional search field rendered at the top of the mobile sheet, above the
   * option list. Mobile sheets trap focus (RNW `ModalFocusTrap` moves focus
   * inside on mount), so the opener input outside the sheet cannot stay the
   * typing surface — the caller binds this to the same query/filter state as
   * its field input. Desktop ignores it.
   */
  sheetSearchInput?: ReactNode;
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
    // Dialog naming: the visible header title carries `${id}-title`, referenced
    // from the dialog root via `aria-labelledby` (WAI-ARIA dialog pattern).
    // The inner scroller is the listbox/region/alert the caller's input names
    // in `aria-controls` (it carries the caller's exact `id`): previously the
    // mobile branch only stamped `${id}-panel` on the outer wrapper, leaving
    // `aria-controls="where-listbox"` (and `"where-place-panel"`) dangling.
    return (
      <Sheet
        open={true}
        onClose={handleClose}
        ariaLabel={`${ariaLabel} dialog`}
        labelledById={`${id}-title`}
        maxWidth={400}
      >
        <Sheet.Header title={header} onClose={handleClose} titleId={`${id}-title`} />
        <Sheet.Body scrollable={false}>
          <View
            ref={popoverRef}
            style={styles.sheetContent}
            {...(Platform.OS === "web"
              ? ({ role: "document", id: `${id}-panel` } as unknown as Record<string, unknown>)
              : {})}
          >
            {sheetSearchInput}
            <ScrollView
              style={[
                styles.sheetList,
                scrollMaxHeight !== undefined ? { maxHeight: scrollMaxHeight } : null,
              ]}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
              {...(Platform.OS === "web"
                ? ({
                    role: alert ? "alert" : role,
                    id,
                    "aria-label": ariaLabel,
                  } as unknown as Record<string, unknown>)
                : {})}
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
        {...(Platform.OS === "web"
          ? ({ role: "presentation" } as unknown as Record<string, unknown>)
          : {})}
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

/**
 * Compound `<Autocomplete>` family (UI37.2) — additive alongside the legacy
 * `AutocompleteFieldShell` / `AutocompletePopover` above, which stay exported
 * and behavior-identical for `PopoverList` (the WHEN date picker path).
 *
 * The root holds combobox state via `useCombobox` and shares it through
 * context; `Input` renders the text field, `Content` the responsive popup
 * (inline popover on desktop, shared `Sheet` modal on mobile), `Item` an
 * option row, `Group` a labelled section, and `Empty` / `Loading` the
 * semantic `role="status"` states. Nothing here is consumed yet — Step 2/3
 * migrate `MovieField` / `TheaterField` onto it.
 */
export interface AutocompleteProps<T> {
  items: readonly T[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: T) => void;
  getItemKey: (item: T) => string;
  /**
   * Default row label, used only when an `Autocomplete.Item` is rendered
   * without children. Rich rows (posters, facet counts, checkboxes) pass
   * explicit children instead.
   */
  getItemLabel?: ((item: T) => string) | undefined;
  /** Overrides the generated listbox id. */
  listId?: string | undefined;
  /** Accessible name for the listbox. */
  label?: string | undefined;
  /**
   * Close the popup on selection (single-select). Multi-select consumers
   * (theatre browsing with checkboxes, UI37.4) pass `false` so the list
   * stays open across toggles.
   */
  closeOnSelect?: boolean | undefined;
  /** Disables keyboard handling and applies the field's disabled treatment. */
  disabled?: boolean | undefined;
  children: ReactNode;
}

export interface AutocompleteContextValue {
  items: readonly unknown[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: unknown) => void;
  getItemLabel: ((item: unknown) => string) | undefined;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  handleKeyDown: (e: unknown) => void;
  inputRef: RefObject<TextInput | null>;
  inputProps: ComboboxInputProps;
  listProps: ComboboxListProps;
  getItemProps: (index: number) => ComboboxItemProps;
  listId: string;
  label: string;
  disabled: boolean;
}

const AutocompleteContext = createContext<AutocompleteContextValue | null>(null);

/**
 * Rich option rows can consume the root's active-index and ARIA helpers
 * without being forced through `Autocomplete.Item`'s simple Pressable shape.
 */
function useAutocompleteContext(): AutocompleteContextValue {
  const ctx = useContext(AutocompleteContext);
  if (!ctx) throw new Error("Autocomplete compound components must render inside <Autocomplete>.");
  return ctx;
}

function AutocompleteRoot<T>({
  items,
  isOpen,
  onOpenChange,
  onSelect,
  getItemKey,
  getItemLabel,
  listId: listIdProp,
  label = "Suggestions",
  closeOnSelect = true,
  disabled = false,
  children,
}: AutocompleteProps<T>): ReactElement {
  const inputRef = useRef<TextInput | null>(null);
  // Selection closes single-select popups; the query/submit path is the
  // caller's `onSelect` (it updates the query, Step 2/3 wiring).
  const handleSelect = useCallback(
    (item: T) => {
      onSelect(item);
      if (closeOnSelect) onOpenChange(false);
    },
    [onSelect, closeOnSelect, onOpenChange],
  );
  const combobox = useCombobox({
    items,
    isOpen,
    onOpenChange,
    onSelect: handleSelect,
    getItemKey,
    listId: listIdProp,
    label,
    inputRef,
    disabled,
  });
  const value = useMemo<AutocompleteContextValue>(
    () => ({
      items,
      isOpen,
      onOpenChange,
      onSelect: (item: unknown) => handleSelect(item as T),
      getItemLabel: getItemLabel ? (item: unknown) => getItemLabel(item as T) : undefined,
      activeIndex: combobox.activeIndex,
      setActiveIndex: combobox.setActiveIndex,
      handleKeyDown: combobox.handleKeyDown,
      inputRef,
      inputProps: combobox.inputProps,
      listProps: combobox.listProps,
      getItemProps: combobox.getItemProps,
      listId: combobox.listId,
      label,
      disabled,
    }),
    [items, isOpen, onOpenChange, handleSelect, getItemLabel, combobox, inputRef, label, disabled],
  );
  return (
    <AutocompleteContext.Provider value={value}>
      <View>{children}</View>
    </AutocompleteContext.Provider>
  );
}

export interface AutocompleteInputProps extends TextInputProps {
  /**
   * Keeps bespoke field adornments inside the shared shell. The underlying
   * TextInput and its styles remain caller-owned.
   */
  endAdornment?: ReactNode;
  inputContainerStyle?: StyleProp<ViewStyle> | undefined;
}

/**
 * Text input inside the styled field shell. Applies the focused border
 * (`colors.brandDark`) + focus shadow via `AutocompleteFieldShell`, spreads
 * the combobox ARIA props, and chains the consumer's `onKeyPress` after
 * keyboard navigation. Opening the popup stays caller-controlled (`isOpen`).
 */
function AutocompleteInput({
  onKeyPress: consumerKeyPress,
  endAdornment,
  inputContainerStyle,
  ...rest
}: AutocompleteInputProps): ReactElement {
  const ctx = useAutocompleteContext();
  const input = (
    <TextInput
      {...rest}
      // Web-only ARIA passthrough, same cast convention as the legacy
      // popover below (RN types carry no `aria-*` props; RNW forwards
      // unknown props to the underlying `<input>` on web).
      {...ctx.inputProps}
      ref={ctx.inputRef}
      onKeyPress={(e) => {
        ctx.handleKeyDown(e);
        consumerKeyPress?.(e);
      }}
    />
  );
  return (
    <AutocompleteFieldShell focused={ctx.isOpen} disabled={ctx.disabled}>
      {endAdornment ? (
        <View style={inputContainerStyle}>
          {input}
          {endAdornment}
        </View>
      ) : (
        input
      )}
    </AutocompleteFieldShell>
  );
}

export interface AutocompleteContentProps {
  /** Visible section title; doubles as the accessible name when set. */
  header?: string | undefined;
  /** Accessible name for the popup; defaults to `header`, then `label`. */
  ariaLabel?: string | undefined;
  /**
   * Mobile override — same convention as the legacy `AutocompletePopover`:
   * forces the Sheet branch in tests / for callers that already know
   * `vm.isMobile`. Defaults to `width < breakpoints.mobile`.
   */
  isMobile?: boolean | undefined;
  /** Dismiss handler; defaults to `onOpenChange(false)`. */
  onClose?: (() => void) | undefined;
  /** Max height of the option list; defaults to the legacy 360. */
  scrollMaxHeight?: number | undefined;
  /** Renders the popup itself as an alert instead of a listbox. */
  alert?: boolean | undefined;
  /**
   * Optional search field rendered at the top of the mobile sheet, above the
   * option list (same convention as the legacy `AutocompletePopover`).
   * Desktop ignores it.
   */
  sheetSearchInput?: ReactNode;
  children: ReactNode;
}

/**
 * Responsive popup. Desktop renders the in-flow popover (same chrome as the
 * legacy branch: `colors.popoverBorder` border, popover shadow, `zIndex`
 * 10, `keyboardShouldPersistTaps="handled"` list). Mobile composes the
 * shared `Sheet` primitive exactly as the legacy mobile branch does
 * (fixed header, non-scrolling body, `scrollMaxHeight`-capped inner list).
 * Outside-pointerdown dismiss is shared with the legacy hook above.
 */
function AutocompleteContent({
  header,
  ariaLabel,
  isMobile,
  onClose,
  scrollMaxHeight,
  alert = false,
  sheetSearchInput,
  children,
}: AutocompleteContentProps): ReactElement | null {
  const ctx = useAutocompleteContext();
  const { width } = useWindowDimensions();
  const showAsSheet = isMobile ?? width < breakpoints.mobile;
  const labelledBy = ariaLabel ?? header ?? ctx.label;
  const handleClose = onClose ?? (() => ctx.onOpenChange(false));
  const popoverRef = useRef<View | null>(null);
  const popoverDomId = showAsSheet ? `${ctx.listId}-panel` : ctx.listId;
  // Only armed while open: unlike the legacy popover (mounted only when
  // open), this component stays mounted and returns null when closed.
  useOutsidePointerDownDismiss(popoverRef, popoverDomId, ctx.isOpen ? handleClose : undefined);
  if (!ctx.isOpen) return null;
  if (showAsSheet) {
    return (
      <Sheet
        open={true}
        onClose={handleClose}
        ariaLabel={`${labelledBy} dialog`}
        labelledById={`${ctx.listId}-title`}
        maxWidth={400}
      >
        {header ? (
          <Sheet.Header title={header} onClose={handleClose} titleId={`${ctx.listId}-title`} />
        ) : null}
        <Sheet.Body scrollable={false}>
          <View
            ref={popoverRef}
            style={styles.sheetContent}
            {...(Platform.OS === "web"
              ? ({ role: "document", id: `${ctx.listId}-panel` } as unknown as Record<
                  string,
                  unknown
                >)
              : {})}
          >
            {sheetSearchInput}
            <ScrollView
              style={[
                styles.sheetList,
                scrollMaxHeight !== undefined ? { maxHeight: scrollMaxHeight } : null,
              ]}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
              {...(Platform.OS === "web"
                ? ({
                    role: alert ? "alert" : "listbox",
                    id: ctx.listId,
                    "aria-label": labelledBy,
                  } as unknown as Record<string, unknown>)
                : {})}
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
      accessibilityLabel={labelledBy}
      accessibilityRole={alert ? "alert" : undefined}
      {...(Platform.OS === "web"
        ? ({
            role: alert ? "alert" : "listbox",
            id: ctx.listId,
            "aria-label": labelledBy,
          } as unknown as Record<string, unknown>)
        : {})}
    >
      {header ? (
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
        {...(Platform.OS === "web"
          ? ({ role: "presentation" } as unknown as Record<string, unknown>)
          : {})}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** Escape hatch for rich, caller-owned option rows. */
function autocompleteUseContext(): AutocompleteContextValue {
  return useAutocompleteContext();
}
export interface AutocompleteItemProps {
  /** Index into the root `items` (the `useCombobox` active-index model). */
  index: number;
  /** Rich row content; falls back to the root `getItemLabel` when omitted. */
  children?: ReactNode;
  /** Extra press side effect; selection (`onSelect` + maybe-close) always runs. */
  onPress?: (() => void) | undefined;
}

/**
 * Option row: hover syncs the keyboard highlight, press selects. Active
 * highlight is `colors.brandSoft`; `aria-selected` tracks `activeIndex`.
 */
function AutocompleteItem({
  index,
  children,
  onPress: consumerOnPress,
}: AutocompleteItemProps): ReactElement | null {
  const ctx = useAutocompleteContext();
  const item = ctx.items[index];
  if (item === undefined) return null;
  const itemProps = ctx.getItemProps(index);
  const active = index === ctx.activeIndex;
  return (
    <Pressable
      onPress={() => {
        ctx.onSelect(item);
        consumerOnPress?.();
      }}
      onHoverIn={() => ctx.setActiveIndex(index)}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }: { pressed: boolean }) => [
        comboStyles.item,
        active && comboStyles.itemActive,
        pressed && comboStyles.itemPressed,
      ]}
      {...(Platform.OS === "web"
        ? ({
            role: "option",
            id: itemProps.id,
            "aria-selected": active,
          } as unknown as Record<string, unknown>)
        : {})}
    >
      {children ?? (ctx.getItemLabel ? <AppText>{ctx.getItemLabel(item)}</AppText> : null)}
    </Pressable>
  );
}

export interface AutocompleteGroupProps {
  label: string;
  children: ReactNode;
}

/** Labelled section (e.g. "NEARBY THEATRES", "CHOOSE A MOVIE"). */
function AutocompleteGroup({ label, children }: AutocompleteGroupProps): ReactElement {
  return (
    <View
      accessibilityLabel={label}
      {...(Platform.OS === "web"
        ? ({ role: "group", "aria-label": label } as unknown as Record<string, unknown>)
        : {})}
    >
      <AppText weight="700" style={styles.header}>
        {label}
      </AppText>
      {children}
    </View>
  );
}

export interface AutocompleteStatusProps {
  /** Defaults: "No results found" (Empty), "Loading…" (Loading). */
  message?: string | undefined;
  children?: ReactNode;
}

/** Semantic empty state (`role="status"`). */
function AutocompleteEmpty({
  message = "No results found",
  children,
}: AutocompleteStatusProps): ReactElement {
  return (
    <View
      style={comboStyles.status}
      {...(Platform.OS === "web" ? ({ role: "status" } as unknown as Record<string, unknown>) : {})}
    >
      {children ?? <AppText style={comboStyles.statusText}>{message}</AppText>}
    </View>
  );
}

/** Semantic loading state (`role="status"` + spinner). */
function AutocompleteLoading({
  message = "Loading…",
  children,
}: AutocompleteStatusProps): ReactElement {
  return (
    <View
      style={comboStyles.status}
      {...(Platform.OS === "web" ? ({ role: "status" } as unknown as Record<string, unknown>) : {})}
    >
      {children ?? (
        <View style={comboStyles.loadingRow}>
          <ActivityIndicator />
          <AppText style={comboStyles.statusText}>{message}</AppText>
        </View>
      )}
    </View>
  );
}

/** Compound component: `Autocomplete.Input`/`.Content`/`.Item`/`.Group`/
 * `.Empty`/`.Loading`/`.useContext` attached via `Object.assign` rather than
 * a TS `namespace` (ESLint `no-namespace`, ES2015 module syntax preferred) —
 * same runtime shape, generic root call signature, and call-site API. */
export const Autocomplete = Object.assign(AutocompleteRoot, {
  Input: AutocompleteInput,
  Content: AutocompleteContent,
  useContext: autocompleteUseContext,
  Item: AutocompleteItem,
  Group: AutocompleteGroup,
  Empty: AutocompleteEmpty,
  Loading: AutocompleteLoading,
});

const comboStyles = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  itemActive: {
    backgroundColor: colors.brandSoft,
  },
  itemPressed: {
    opacity: 0.7,
  },
  status: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  statusText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
