import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useCombobox, type UseComboboxReturn } from "./useCombobox";

const ITEMS = ["alpha", "bravo", "charlie"] as const;

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  onSelect: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
  onSubmitQuery: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  latest: () => UseComboboxReturn;
  rerender: (items: readonly string[], isOpen: boolean) => void;
  /** Fires handleKeyDown in either the DOM `{ key }` or RN `onKeyPress` shape. */
  keyDown: (key: string, shape?: "dom" | "native", extra?: Record<string, unknown>) => void;
}

function renderCombobox(initial?: {
  items?: readonly string[];
  isOpen?: boolean;
  listId?: string;
  label?: string;
  disabled?: boolean;
}): Harness {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const onSubmitQuery = vi.fn();
  const blur = vi.fn();
  const inputRef = { current: { blur } } as unknown as React.RefObject<
    import("react-native").TextInput | null
  >;
  let api!: UseComboboxReturn;

  function Probe(props: { items: readonly string[]; isOpen: boolean }): null {
    api = useCombobox({
      items: props.items,
      isOpen: props.isOpen,
      onOpenChange,
      onSelect,
      getItemKey: (s: string) => s,
      onSubmitQuery,
      listId: initial?.listId,
      label: initial?.label ?? "Movies",
      inputRef,
      disabled: initial?.disabled,
    });
    return null;
  }

  // `.test.ts` (not `.tsx`, per the UI37 spec filename) cannot hold JSX, so
  // the probe mounts via `createElement` — identical semantics.
  const probeElement = (items: readonly string[], isOpen: boolean): React.ReactElement =>
    React.createElement(Probe, { items, isOpen });
  const initialItems = [...(initial?.items ?? ITEMS)];
  const initialOpen = initial?.isOpen ?? true;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(probeElement(initialItems, initialOpen));
  });

  return {
    renderer,
    onSelect,
    onOpenChange,
    onSubmitQuery,
    blur,
    latest: () => api,
    rerender: (items: readonly string[], isOpen: boolean) => {
      act(() => {
        renderer.update(probeElement(items, isOpen));
      });
    },
    keyDown: (key: string, shape = "dom", extra = {}) => {
      const event =
        shape === "dom" ? { key, ...extra } : { nativeEvent: { key }, ...extra };
      act(() => {
        api.handleKeyDown(event);
      });
    },
  };
}

let mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  vi.restoreAllMocks();
});

function track(h: Harness): Harness {
  mounted.push(h.renderer);
  return h;
}

describe("useCombobox", () => {
  it("starts with no highlight and exposes the WAI-ARIA 1.2 attribute objects", () => {
    const h = track(renderCombobox({ listId: "movies" }));
    const api = h.latest();
    expect(api.activeIndex).toBe(-1);
    expect(api.activeItemId).toBeNull();
    expect(api.listId).toBe("movies");
    expect(api.inputProps).toEqual({
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": true,
      "aria-controls": "movies",
    });
    expect(api.listProps).toEqual({ role: "listbox", id: "movies", "aria-label": "Movies" });
    expect(api.getItemProps(0)).toEqual({
      role: "option",
      id: "movies--alpha",
      "aria-selected": false,
    });
  });

  it("reflects closed state in aria-expanded and generates a stable id by default", () => {
    const h = track(renderCombobox({ isOpen: false }));
    const api = h.latest();
    expect(api.inputProps["aria-expanded"]).toBe(false);
    expect(api.listId).toMatch(/^autocomplete-/);
    expect(api.listProps.id).toBe(api.listId);
  });

  it("ArrowDown increments and clamps at the last item (never loops)", () => {
    const h = track(renderCombobox());
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(0);
    h.keyDown("ArrowDown");
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(2);
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(2);
    // aria-activedescendant tracks the highlight; the item reports selected.
    expect(h.latest().inputProps["aria-activedescendant"]).toBe(`${h.latest().listId}--charlie`);
    expect(h.latest().getItemProps(2)["aria-selected"]).toBe(true);
    expect(h.latest().getItemProps(0)["aria-selected"]).toBe(false);
  });

  it("ArrowUp decrements and clamps at the first item", () => {
    const h = track(renderCombobox());
    // Where parity: ArrowUp from -1 lands on the first item, not the last.
    h.keyDown("ArrowUp");
    expect(h.latest().activeIndex).toBe(0);
    h.keyDown("ArrowDown");
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(2);
    h.keyDown("ArrowUp");
    expect(h.latest().activeIndex).toBe(1);
    h.keyDown("ArrowUp");
    h.keyDown("ArrowUp");
    expect(h.latest().activeIndex).toBe(0);
  });

  it("accepts the React Native TextInput onKeyPress shape on both platforms", () => {
    const h = track(renderCombobox());
    h.keyDown("ArrowDown", "native");
    h.keyDown("ArrowDown", "native");
    expect(h.latest().activeIndex).toBe(1);
    h.keyDown("ArrowUp", "native");
    expect(h.latest().activeIndex).toBe(0);
  });

  it("ignores arrow keys on an empty list and Enter submits the query", () => {
    const h = track(renderCombobox({ items: [] }));
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(-1);
    h.keyDown("Enter");
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onSubmitQuery).toHaveBeenCalledTimes(1);
  });

  it("Enter with a highlight selects the active item instead of submitting", () => {
    const h = track(renderCombobox());
    h.keyDown("ArrowDown", "native");
    h.keyDown("ArrowDown", "native");
    const preventDefault = vi.fn();
    h.keyDown("Enter", "native", { preventDefault });
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onSelect).toHaveBeenCalledWith("bravo");
    expect(h.onSubmitQuery).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("Enter with no highlight submits the query text (the Where place-resolve path)", () => {
    const h = track(renderCombobox());
    h.keyDown("Enter");
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onSubmitQuery).toHaveBeenCalledTimes(1);
  });

  it("Escape closes, resets the highlight, and blurs the input", () => {
    const h = track(renderCombobox());
    h.keyDown("ArrowDown");
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(1);
    h.keyDown("Escape", "native");
    expect(h.onOpenChange).toHaveBeenCalledWith(false);
    expect(h.latest().activeIndex).toBe(-1);
    expect(h.blur).toHaveBeenCalledTimes(1);
    expect(h.latest().inputProps["aria-activedescendant"]).toBeUndefined();
  });

  it("prevents default scrolling on arrow navigation", () => {
    const h = track(renderCombobox());
    const preventDefault = vi.fn();
    h.keyDown("ArrowDown", "dom", { preventDefault });
    h.keyDown("ArrowUp", "dom", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("resets the highlight when the list narrows past it", () => {
    const h = track(renderCombobox());
    h.keyDown("ArrowDown");
    h.keyDown("ArrowDown");
    expect(h.latest().activeIndex).toBe(1);
    h.rerender(["alpha"], true);
    expect(h.latest().activeIndex).toBe(-1);
  });

  it("setActiveIndex clamps instead of looping", () => {
    const h = track(renderCombobox());
    act(() => {
      h.latest().setActiveIndex(99);
    });
    expect(h.latest().activeIndex).toBe(2);
    act(() => {
      h.latest().setActiveIndex(-99);
    });
    expect(h.latest().activeIndex).toBe(-1);
  });

  it("ignores keys when disabled (locked fields)", () => {
    const h = track(renderCombobox({ disabled: true }));
    h.keyDown("ArrowDown");
    h.keyDown("Enter");
    h.keyDown("Escape");
    expect(h.latest().activeIndex).toBe(-1);
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onSubmitQuery).not.toHaveBeenCalled();
    expect(h.onOpenChange).not.toHaveBeenCalled();
  });
});
