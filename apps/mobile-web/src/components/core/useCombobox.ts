import { useCallback, useEffect, useId, useState } from "react";
import type { RefObject } from "react";
import type { TextInput } from "react-native";

/**
 * Headless combobox state + keyboard navigation (UI37.1). Owns `activeIndex`
 * (`-1` = none), ArrowDown/ArrowUp/Enter/Escape handling, and the WAI-ARIA 1.2
 * attribute objects for the input/list/item roles. Presentation-agnostic: the
 * compound `<Autocomplete>` family in `Autocomplete.tsx` is the only consumer
 * today, but any list UI can wire these props by hand.
 *
 * Keyboard semantics deliberately mirror `useWhereFieldViewModel.handleKeyDown`
 * so Step 3 can migrate that view model onto this hook without changing its
 * tested behavior: ArrowDown/ArrowUp CLAMP at the ends (never loop),
 * ArrowUp from `-1` lands on the first item, Enter selects the active item or
 * falls back to submitting the query text, Escape closes + resets + blurs.
 * Where-only keys (Backspace chip removal, Tab-forward to the Movie field)
 * stay in the view model — they are not generic combobox behavior.
 */

export interface UseComboboxOptions<T> {
  items: readonly T[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: T) => void;
  getItemKey: (item: T) => string;
  /** Enter with no active item (or an empty list) submits the query text. */
  onSubmitQuery?: (() => void) | undefined;
  /** Overrides the generated listbox id (one per combobox on the page). */
  listId?: string | undefined;
  /** Accessible name for the listbox. */
  label?: string | undefined;
  /** Blurred on Escape, matching the Where field's dismiss path. */
  inputRef?: RefObject<TextInput | null> | undefined;
  /** When true, key handling is ignored (locked fields). */
  disabled?: boolean | undefined;
}

export interface ComboboxInputProps {
  role: "combobox";
  "aria-autocomplete": "list";
  "aria-expanded": boolean;
  "aria-controls": string;
  "aria-activedescendant"?: string | undefined;
}

export interface ComboboxListProps {
  role: "listbox";
  id: string;
  "aria-label": string;
}

export interface ComboboxItemProps {
  role: "option";
  id: string;
  "aria-selected": boolean;
}

export interface UseComboboxReturn {
  activeIndex: number;
  /** Clamps into `[-1, items.length - 1]`; never loops. */
  setActiveIndex: (index: number) => void;
  /** Id of the active option, for `aria-activedescendant`; null when none. */
  activeItemId: string | null;
  /**
   * Key handler for the input's `onKeyPress`. Accepts the same shapes as
   * `useWhereFieldViewModel.handleKeyDown`: a DOM-ish `{ key }` or an RN
   * `TextInput` `onKeyPress` `{ nativeEvent: { key } }` (native and web).
   */
  handleKeyDown: (e: unknown) => void;
  inputProps: ComboboxInputProps;
  listProps: ComboboxListProps;
  getItemProps: (index: number) => ComboboxItemProps;
  listId: string;
}

function extractKey(e: unknown): string | undefined {
  return (
    (e as { key?: string; nativeEvent?: { key?: string } }).key ??
    (e as { nativeEvent?: { key?: string } }).nativeEvent?.key
  );
}

function preventDefault(e: unknown): void {
  (e as { preventDefault?: () => void }).preventDefault?.();
}

export function useCombobox<T>(options: UseComboboxOptions<T>): UseComboboxReturn {
  const {
    items,
    isOpen,
    onOpenChange,
    onSelect,
    getItemKey,
    onSubmitQuery,
    listId: listIdOverride,
    label = "Suggestions",
    inputRef,
    disabled = false,
  } = options;

  const generatedId = useId();
  const listId = listIdOverride ?? `autocomplete-${generatedId.replace(/:/g, "")}`;

  const [activeIndex, setActiveIndexState] = useState(-1);

  const setActiveIndex = useCallback(
    (index: number) => {
      // Clamp, never loop: matches the Where field's tested ArrowDown
      // (`Math.min(activeIndex + 1, len - 1)`) / ArrowUp behavior.
      if (items.length === 0) {
        setActiveIndexState(-1);
        return;
      }
      setActiveIndexState(Math.max(-1, Math.min(index, items.length - 1)));
    },
    [items.length],
  );

  // A narrowed list invalidates the highlight, same as the Where field
  // resetting `activeKey` when it leaves the option set (or on query change).
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndexState(-1);
  }, [activeIndex, items.length]);

  const getItemId = useCallback(
    (index: number): string => {
      const item = items[index];
      return item === undefined ? `${listId}-option-${index}` : `${listId}--${getItemKey(item)}`;
    },
    [items, listId, getItemKey],
  );

  const activeItemId = activeIndex >= 0 && activeIndex < items.length ? getItemId(activeIndex) : null;

  const handleKeyDown = useCallback(
    (e: unknown) => {
      if (disabled) return;
      const key = extractKey(e);
      if (key === "ArrowDown") {
        preventDefault(e);
        if (items.length === 0) {
          setActiveIndexState(-1);
          return;
        }
        // From -1 this lands on 0; clamps at the last item (no looping).
        setActiveIndexState((prev) => Math.min(prev + 1, items.length - 1));
      } else if (key === "ArrowUp") {
        preventDefault(e);
        if (items.length === 0) {
          setActiveIndexState(-1);
          return;
        }
        // From -1 or 0 this lands on 0 (Where parity); otherwise steps up.
        setActiveIndexState((prev) => (prev <= 0 ? 0 : prev - 1));
      } else if (key === "Enter") {
        const item = activeIndex >= 0 ? items[activeIndex] : undefined;
        if (item !== undefined) {
          preventDefault(e);
          onSelect(item);
        } else {
          // No highlight (or an empty list): submit the raw query text. The
          // Where field resolves the typed place here; callers own the action.
          if (onSubmitQuery) preventDefault(e);
          onSubmitQuery?.();
        }
      } else if (key === "Escape") {
        onOpenChange(false);
        setActiveIndexState(-1);
        inputRef?.current?.blur();
      }
    },
    [disabled, items, activeIndex, onSelect, onSubmitQuery, onOpenChange, inputRef],
  );

  return {
    activeIndex,
    setActiveIndex,
    activeItemId,
    handleKeyDown,
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": isOpen,
      "aria-controls": listId,
      ...(activeItemId !== null ? { "aria-activedescendant": activeItemId } : {}),
    },
    listProps: { role: "listbox", id: listId, "aria-label": label },
    getItemProps: (index: number) => ({
      role: "option",
      id: getItemId(index),
      "aria-selected": index === activeIndex,
    }),
    listId,
  };
}
