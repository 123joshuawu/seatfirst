import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AccessibilityInfo } from "react-native";
import { motion } from "./motion";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

let mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  vi.restoreAllMocks();
});

function renderHook(): { current: ReturnType<typeof usePrefersReducedMotion> } {
  const ref: { current: ReturnType<typeof usePrefersReducedMotion> | null } = {
    current: null,
  };
  function Probe(): null {
    ref.current = usePrefersReducedMotion();
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  mounted.push(renderer);
  if (!ref.current) throw new Error("hook did not render");
  return ref as { current: ReturnType<typeof usePrefersReducedMotion> };
}

async function renderHookFlushed(): Promise<
  ReturnType<typeof usePrefersReducedMotion>
> {
  const ref: { current: ReturnType<typeof usePrefersReducedMotion> | null } = {
    current: null,
  };
  function Probe(): null {
    ref.current = usePrefersReducedMotion();
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  renderer.unmount();
  if (!ref.current) throw new Error("hook did not render");
  return ref.current;
}

describe("motion", () => {
  it("defines duration constants in ms", () => {
    expect(motion.duration).toEqual({ instant: 0, fast: 150, base: 250, slow: 350 });
  });

  it("defines standard/enter/exit easing curves", () => {
    expect(motion.easing).toEqual({
      standard: "cubic-bezier(0.2, 0, 0, 1)",
      enter: "cubic-bezier(0, 0, 0.2, 1)",
      exit: "cubic-bezier(0.4, 0, 1, 1)",
    });
  });
});

describe("usePrefersReducedMotion", () => {
  it("returns token durations when reduced motion is off", async () => {
    vi.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const hook = await renderHookFlushed();
    expect(hook.prefersReducedMotion).toBe(false);
    expect(hook.getDuration("instant")).toBe(0);
    expect(hook.getDuration("fast")).toBe(150);
    expect(hook.getDuration("base")).toBe(250);
    expect(hook.getDuration("slow")).toBe(350);
  });

  it("collapses every duration to 0 when reduced motion is on", async () => {
    vi.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const hook = await renderHookFlushed();
    expect(hook.prefersReducedMotion).toBe(true);
    expect(hook.getDuration("fast")).toBe(0);
    expect(hook.getDuration("base")).toBe(0);
    expect(hook.getDuration("slow")).toBe(0);
  });

  it("exposes the synchronous initial value without suspension", () => {
    const hook = renderHook();
    expect(typeof hook.current.prefersReducedMotion).toBe("boolean");
    expect(typeof hook.current.getDuration("base")).toBe("number");
  });
});
