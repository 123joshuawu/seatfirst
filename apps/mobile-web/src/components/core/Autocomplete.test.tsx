import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AutocompletePopover } from "./Autocomplete";

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
