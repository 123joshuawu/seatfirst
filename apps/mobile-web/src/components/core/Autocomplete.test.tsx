import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { Autocomplete, AutocompleteFieldShell, AutocompletePopover } from "./Autocomplete";
import { Sheet } from "./Sheet";

// The popover only renders real DOM in a browser (react-native-web); under
// react-test-renderer no DOM node exists, so the outside-pointerdown handler
// resolves the popover element through the DOM id the node carries on web
// (the `id` / `${id}-panel` props below). These tests stand in for the real
// browser sequence — pointerdown (capture) → onClose unmounts the popover →
// the follow-on click dispatches to the element actually under the pointer —
// by inserting equivalent jsdom nodes and dispatching real pointerdown events
// that bubble to the document listener the component registers.

function renderPopover(props?: {
  id?: string;
  header?: string;
  isMobile?: boolean;
  onClose?: () => void;
}): { renderer: TestRenderer.ReactTestRenderer; onClose: ReturnType<typeof vi.fn> } {
  const onClose = props?.onClose ?? vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(AutocompletePopover, {
        id: props?.id ?? "test-popover",
        header: props?.header ?? "Test suggestions",
        ...(props?.isMobile === undefined ? {} : { isMobile: props.isMobile }),
        onClose,
        children: "option",
      }),
    );
  });
  return { renderer, onClose: onClose as ReturnType<typeof vi.fn> };
}

function addDesktopDom(popoverId: string): { inside: HTMLElement; outside: HTMLElement } {
  document.body.innerHTML =
    `<div id="${popoverId}"><button id="inside-btn">inside</button></div>` +
    `<button id="outside-btn">movie field</button>`;
  return {
    inside: document.getElementById("inside-btn")!,
    outside: document.getElementById("outside-btn")!,
  };
}

function dispatchPointerdown(target: EventTarget): void {
  // jsdom has no PointerEvent constructor on older versions; the component
  // only reads event.target, so a bubbling Event of the right type suffices.
  target.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AutocompletePopover outside-pointerdown dismiss", () => {
  it("desktop: registers a capture-phase document pointerdown listener while open", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { renderer } = renderPopover();
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    const handler = addSpy.mock.calls.find((call) => call[0] === "pointerdown")?.[1] as (
      event: Event,
    ) => void;
    expect(typeof handler).toBe("function");
    act(() => {
      renderer.unmount();
    });
    expect(removeSpy).toHaveBeenCalledWith("pointerdown", handler, true);
  });

  it("desktop: outside pointerdown closes the popover (the MOVIE-field click-through)", () => {
    const { renderer, onClose } = renderPopover({ id: "where-listbox" });
    const { outside } = addDesktopDom("where-listbox");
    dispatchPointerdown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("desktop: pointerdown inside the popover does not close (option press still completes)", () => {
    const { renderer, onClose } = renderPopover({ id: "where-listbox" });
    const { inside } = addDesktopDom("where-listbox");
    dispatchPointerdown(inside);
    expect(onClose).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("desktop: pointerdown on the already-focused element does not close (no blur will occur)", () => {
    const { renderer, onClose } = renderPopover({ id: "where-listbox" });
    document.body.innerHTML = `<input id="where-input" />`;
    const input = document.getElementById("where-input")!;
    input.focus();
    expect(document.activeElement).toBe(input);
    dispatchPointerdown(input);
    // Same-field click (e.g. caret repositioning) must leave the popover open.
    expect(onClose).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("desktop: no-ops when the popover node cannot be resolved", () => {
    const { renderer, onClose } = renderPopover({ id: "missing-popover" });
    // No element with this id in the document: the pre-existing blur path
    // stays responsible, so the handler must not fire onClose blindly.
    document.body.innerHTML = `<button id="outside-btn">movie field</button>`;
    dispatchPointerdown(document.getElementById("outside-btn")!);
    expect(onClose).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("sheet: scrim-area pointerdown closes up front so the click passes through", () => {
    const onClose = vi.fn();
    const { renderer } = renderPopover({ id: "where-listbox", isMobile: true, onClose });
    // The tracked node in sheet mode is the panel (`${id}-panel`); the scrim
    // sits outside it, so a scrim tap dismisses before click dispatch and the
    // click lands on the element behind the sheet.
    document.body.innerHTML =
      `<div id="where-listbox"><div id="scrim"></div>` +
      `<div id="where-listbox-panel"><button id="panel-btn">Close</button></div></div>` +
      `<button id="behind-btn">search cta</button>`;
    dispatchPointerdown(document.getElementById("scrim")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    dispatchPointerdown(document.getElementById("panel-btn")!);
    expect(onClose).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("sheet: existing scrim and Close dismissal paths still call onClose", () => {
    const { renderer, onClose } = renderPopover({
      id: "where-listbox",
      header: "Places and theatres",
      isMobile: true,
    });
    // Scrim Pressable (shared "Close dialog" label from `Sheet`) + header
    // Close button Pressable (`Close ${header}` from `Sheet.Header`).
    const dismisssers = renderer.root.findAll(
      (node) =>
        (node.props.accessibilityLabel === "Close dialog" ||
          node.props.accessibilityLabel === "Close Places and theatres") &&
        typeof node.props.onPress === "function",
    );
    expect(dismisssers.length).toBeGreaterThanOrEqual(2);
    for (const node of dismisssers) {
      act(() => {
        (node.props as { onPress: () => void }).onPress();
      });
    }
    expect(onClose.mock.calls.length).toBeGreaterThanOrEqual(2);
    renderer.unmount();
  });
});

// UI37 Step 1: compound `<Autocomplete>` family. The mocked viewport is
// 1024px wide (desktop), so the mobile Sheet branch is exercised through the
// explicit `isMobile` override — the same convention as the legacy popover.

interface ComboMovie {
  id: string;
  title: string;
}

const COMBO_MOVIES: ComboMovie[] = [
  { id: "m1", title: "Dune" },
  { id: "m2", title: "Dune: Part Two" },
];

function renderCombo(options?: {
  isOpen?: boolean;
  isMobile?: boolean;
  closeOnSelect?: boolean;
  items?: ComboMovie[];
}): {
  renderer: TestRenderer.ReactTestRenderer;
  onSelect: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  const items = options?.items ?? COMBO_MOVIES;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <Autocomplete
        items={items}
        isOpen={options?.isOpen ?? true}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        getItemKey={(m) => m.id}
        getItemLabel={(m) => m.title}
        label="Choose a movie"
        listId="combo-movies"
        {...(options?.closeOnSelect === undefined ? {} : { closeOnSelect: options.closeOnSelect })}
      >
        <Autocomplete.Input value="" onChangeText={() => {}} placeholder="Search movies" />
        <Autocomplete.Content
          header="CHOOSE A MOVIE"
          {...(options?.isMobile === undefined ? {} : { isMobile: options.isMobile })}
        >
          {items.map((m, index) => (
            <Autocomplete.Item key={m.id} index={index}>
              <AppText>{m.title}</AppText>
            </Autocomplete.Item>
          ))}
        </Autocomplete.Content>
      </Autocomplete>,
    );
  });
  return { renderer, onSelect, onOpenChange };
}

function nodesWithRole(
  root: TestRenderer.ReactTestInstance,
  role: string,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((node) => (node.props as { role?: unknown }).role === role);
}

function comboPressables(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance[] {
  // Composite Pressables only; the RN mock also renders a host "Pressable"
  // string node with identical props (Button.test.tsx convention).
  return renderer.root.findAllByType(Pressable).filter((n) => typeof n.type !== "string");
}

function comboTextInput(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const nodes = renderer.root.findAllByType(TextInput).filter((n) => typeof n.type !== "string");
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function flatStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === "object") Object.assign(out, entry);
  }
  return out;
}

describe("Autocomplete compound components", () => {
  const mounted: TestRenderer.ReactTestRenderer[] = [];
  afterEach(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });

  it("desktop renders the inline popover with listbox semantics and combobox input wiring", () => {
    const { renderer } = renderCombo();
    mounted.push(renderer);
    const popovers = nodesWithRole(renderer.root, "listbox");
    expect(popovers.length).toBeGreaterThanOrEqual(1);
    expect(popovers[0]!.props.id).toBe("combo-movies");
    expect(popovers[0]!.props["aria-label"]).toBe("CHOOSE A MOVIE");
    expect(renderer.root.findAllByType(Sheet)).toHaveLength(0);
    const input = comboTextInput(renderer);
    expect(input.props.role).toBe("combobox");
    expect(input.props["aria-autocomplete"]).toBe("list");
    expect(input.props["aria-expanded"]).toBe(true);
    expect(input.props["aria-controls"]).toBe("combo-movies");
    expect(input.props["aria-activedescendant"]).toBeUndefined();
    // The input sits in the styled field shell with the focused border
    // (`findByType` returns the composite, whose props are `{ focused, … }` —
    // the style lives on the host View it renders).
    const shell = renderer.root.findByType(AutocompleteFieldShell);
    const shellView = shell.findAllByType(View)[0]!;
    expect(flatStyle(shellView.props.style).borderColor).toBe(colors.brandDark);
  });

  it("closed renders no popup on either branch", () => {
    const { renderer } = renderCombo({ isOpen: false });
    mounted.push(renderer);
    expect(nodesWithRole(renderer.root, "listbox")).toHaveLength(0);
    expect(renderer.root.findAllByType(Sheet)).toHaveLength(0);
    expect(comboTextInput(renderer).props["aria-expanded"]).toBe(false);
  });

  it("mobile renders the shared Sheet modal with the option list inside", () => {
    const { renderer } = renderCombo({ isMobile: true });
    mounted.push(renderer);
    const sheets = renderer.root.findAllByType(Sheet);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.props.open).toBe(true);
    expect(sheets[0]!.props.ariaLabel).toBe("CHOOSE A MOVIE dialog");
    // Header Close button from `Sheet.Header` is wired.
    const close = renderer.root
      .findAllByType(Pressable)
      .find((n) => n.props.accessibilityLabel === "Close CHOOSE A MOVIE");
    expect(close).toBeDefined();
    // Options keep their option semantics inside the sheet list. Each row
    // appears twice (composite Pressable + host node, Button.test.tsx
    // convention), so assert on ids rather than count.
    const optionIds = nodesWithRole(renderer.root, "option").map(
      (n) => (n.props as { id?: unknown }).id,
    );
    expect(optionIds).toContain("combo-movies--m1");
    expect(optionIds).toContain("combo-movies--m2");
  });

  it("pressing an item selects it and closes the popup", () => {
    const { renderer, onSelect, onOpenChange } = renderCombo();
    mounted.push(renderer);
    const rows = comboPressables(renderer);
    expect(rows).toHaveLength(2);
    act(() => {
      (rows[0]!.props as { onPress: () => void }).onPress();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(COMBO_MOVIES[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closeOnSelect=false keeps multi-select lists open across toggles", () => {
    const { renderer, onSelect, onOpenChange } = renderCombo({ closeOnSelect: false });
    mounted.push(renderer);
    const rows = comboPressables(renderer);
    act(() => {
      (rows[1]!.props as { onPress: () => void }).onPress();
    });
    expect(onSelect).toHaveBeenCalledWith(COMBO_MOVIES[1]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keyboard: ArrowDown highlights, hover syncs, Enter selects, Escape closes", () => {
    const { renderer, onSelect, onOpenChange } = renderCombo();
    mounted.push(renderer);
    const press = (key: string): void => {
      act(() => {
        (comboTextInput(renderer).props as { onKeyPress: (e: unknown) => void }).onKeyPress({
          nativeEvent: { key },
        });
      });
    };
    press("ArrowDown");
    expect(comboTextInput(renderer).props["aria-activedescendant"]).toBe("combo-movies--m1");
    const firstOption = nodesWithRole(renderer.root, "option").find(
      (n) => n.props.id === "combo-movies--m1",
    );
    expect(firstOption?.props["aria-selected"]).toBe(true);
    // Hover syncs the keyboard highlight to the hovered row.
    const rows = comboPressables(renderer);
    act(() => {
      (rows[1]!.props as { onHoverIn: () => void }).onHoverIn();
    });
    expect(comboTextInput(renderer).props["aria-activedescendant"]).toBe("combo-movies--m2");
    press("Enter");
    expect(onSelect).toHaveBeenCalledWith(COMBO_MOVIES[1]);
    press("Escape");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(comboTextInput(renderer).props["aria-activedescendant"]).toBeUndefined();
  });

  it("Item falls back to the root getItemLabel without children", () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <Autocomplete
          items={COMBO_MOVIES}
          isOpen={true}
          onOpenChange={onOpenChange}
          onSelect={onSelect}
          getItemKey={(m) => m.id}
          getItemLabel={(m) => m.title}
          listId="combo-labels"
        >
          <Autocomplete.Input value="" onChangeText={() => {}} />
          <Autocomplete.Content header="Movies">
            <Autocomplete.Item index={0} />
          </Autocomplete.Content>
        </Autocomplete>,
      );
    });
    mounted.push(renderer);
    const label = renderer.root.findAllByType(AppText).find((n) => n.props.children === "Dune");
    expect(label).toBeDefined();
  });

  it("Group/Empty/Loading render labelled sections and status states", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <Autocomplete
          items={[]}
          isOpen={true}
          onOpenChange={() => {}}
          onSelect={() => {}}
          getItemKey={(m: string) => m}
          listId="combo-status"
        >
          <Autocomplete.Input value="" onChangeText={() => {}} />
          <Autocomplete.Content header="Movies">
            <Autocomplete.Group label="NEARBY THEATRES">
              <Autocomplete.Empty />
            </Autocomplete.Group>
            <Autocomplete.Loading />
          </Autocomplete.Content>
        </Autocomplete>,
      );
    });
    mounted.push(renderer);
    const groupLabels = nodesWithRole(renderer.root, "group").map(
      (n) => (n.props as { "aria-label"?: unknown })["aria-label"],
    );
    expect(groupLabels).toContain("NEARBY THEATRES");
    expect(nodesWithRole(renderer.root, "status").length).toBeGreaterThanOrEqual(2);
    const copy = renderer.root.findAllByType(AppText).map((n) => n.props.children as unknown);
    expect(copy).toContain("No results found");
    expect(copy).toContain("Loading…");
    // …and the loading state pairs its copy with a spinner.
    expect(renderer.root.findAllByType(ActivityIndicator).length).toBeGreaterThanOrEqual(1);
  });
});
