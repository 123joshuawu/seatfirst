import { afterEach, describe, expect, it } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable } from "react-native";
import { focusRings } from "@/theme/tokens";
import { Button, PrimaryButton, SecondaryButton, TextLinkButton } from "./Button";

let mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
});

function render(el: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(el);
  });
  mounted.push(renderer);
  return renderer;
}

/** The single logical Pressable (composite; the RN mock also renders a host
 * "Pressable" string node with identical props — filtered out here). */
function singlePressable(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance {
  const nodes = renderer.root.findAllByType(Pressable);
  const logical = nodes.filter((n) => typeof n.type !== "string");
  expect(logical).toHaveLength(1);
  return logical[0]!;
}

/** Merges an RN style array into one object (mock StyleSheet is a passthrough). */
function flatStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const arr = Array.isArray(style) ? style : [style];
  for (const entry of arr) {
    if (entry && typeof entry === "object") Object.assign(out, entry);
  }
  return out;
}

/** Resolves a Pressable `style` prop — static object/array or the style-callback
 * form — in the given interaction state, then flattens it. */
function pressableStyle(
  node: TestRenderer.ReactTestInstance,
  state: { pressed: boolean; hovered?: boolean } = { pressed: false },
): Record<string, unknown> {
  const style = node.props.style;
  const resolved = typeof style === "function" ? style(state) : style;
  return flatStyle(resolved);
}

function expectStandardRing(style: Record<string, unknown>): void {
  expect(style.outlineColor).toBe(focusRings.standard.outlineColor);
  expect(style.outlineWidth).toBe(focusRings.standard.outlineWidth);
  expect(style.outlineStyle).toBe(focusRings.standard.outlineStyle);
  expect(style.outlineOffset).toBe(focusRings.standard.outlineOffset);
}

function focus(node: TestRenderer.ReactTestInstance): void {
  act(() => {
    (node.props.onFocus as () => void)();
  });
}

function blur(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    (singlePressable(renderer).props.onBlur as () => void)();
  });
}

describe("Button focus ring (UI40.2 focusRings.standard)", () => {
  it("PrimaryButton shows the token ring only while focused", () => {
    const renderer = render(<PrimaryButton label="Go to AMC" onPress={() => {}} />);
    const btn = singlePressable(renderer);
    expect(pressableStyle(btn).outlineColor).toBeUndefined();
    focus(btn);
    expectStandardRing(pressableStyle(singlePressable(renderer)));
    blur(renderer);
    expect(pressableStyle(singlePressable(renderer)).outlineColor).toBeUndefined();
  });

  it("SecondaryButton shows the token ring only while focused", () => {
    const renderer = render(
      <SecondaryButton label="Change format" onPress={() => {}} shape="pill" />,
    );
    const btn = singlePressable(renderer);
    expect(pressableStyle(btn).outlineColor).toBeUndefined();
    focus(btn);
    expectStandardRing(pressableStyle(singlePressable(renderer)));
    blur(renderer);
    expect(pressableStyle(singlePressable(renderer)).outlineColor).toBeUndefined();
  });

  it("Button link variant shows the token ring only while focused", () => {
    const renderer = render(
      <Button label="Restore recommendation" variant="link" onPress={() => {}} />,
    );
    const btn = singlePressable(renderer);
    expect(pressableStyle(btn).outlineColor).toBeUndefined();
    focus(btn);
    expectStandardRing(pressableStyle(singlePressable(renderer)));
    blur(renderer);
    expect(pressableStyle(singlePressable(renderer)).outlineColor).toBeUndefined();
  });

  it("TextLinkButton shim shows the token ring only while focused", () => {
    const renderer = render(<TextLinkButton label="Change" onPress={() => {}} />);
    const btn = singlePressable(renderer);
    expect(pressableStyle(btn).outlineColor).toBeUndefined();
    focus(btn);
    expectStandardRing(pressableStyle(singlePressable(renderer)));
    blur(renderer);
    expect(pressableStyle(singlePressable(renderer)).outlineColor).toBeUndefined();
  });

  it("sources the ring color from focusRings.standard, not the UI35 brandDark", () => {
    const renderer = render(<PrimaryButton label="Go to AMC" onPress={() => {}} />);
    focus(singlePressable(renderer));
    const style = pressableStyle(singlePressable(renderer));
    expect(style.outlineColor).toBe(focusRings.standard.outlineColor);
    expect(focusRings.standard.outlineColor).not.toBe(undefined);
  });
});
