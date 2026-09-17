import type { ReactElement } from "react";
import { createElement } from "react";

type Props = Record<string, unknown> & { children?: unknown; style?: unknown };

function mockComponent(name: string) {
  return function Mock(props: Props): ReactElement {
    return createElement(
      name,
      props as never,
      (props as Record<string, unknown>).children as never,
    );
  };
}

export const View = mockComponent("View");
export const Text = mockComponent("Text");
export const Pressable = mockComponent("Pressable");
export const Animated = {
  View: mockComponent("Animated.View"),
  Text: mockComponent("Animated.Text"),
  createAnimatedComponent: (c: unknown) => c,
  loop: () => ({
    start: () => {},
    stop: () => {},
    reset: () => {},
  }),
  timing: () => ({
    start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
    stop: () => {},
    reset: () => {},
  }),
  sequence: () => ({
    start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
    stop: () => {},
    reset: () => {},
  }),
  Value: class {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- constructor signature must match RN Animated.Value; param is intentionally unused in mock
    constructor(_v: number) {}
    interpolate = () => "0deg";
    setValue = () => {};
  },
};
export const Easing = {
  linear: (v: number) => v,
  ease: (v: number) => v,
  inOut: (fn: (v: number) => number) => fn,
  out: (fn: (v: number) => number) => fn,
};
export const Platform = {
  OS: "web" as const,
  select: (obj: Record<string, unknown>) => obj.web ?? obj.default ?? obj.ios,
  isPad: false,
  isTV: false,
};
export const StyleSheet = {
  create: <T extends Record<string, unknown>>(s: T): T => s,
  flatten: (s: unknown) => s,
  hairlineWidth: 1,
};
export const Dimensions = {
  get: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
};
export const useWindowDimensions = () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 });
export const ScrollView = mockComponent("ScrollView");
export const FlatList = mockComponent("FlatList");
export const Image = mockComponent("Image");
export const Modal = mockComponent("Modal");
export const TextInput = mockComponent("TextInput");
export const ActivityIndicator = mockComponent("ActivityIndicator");
export const AppState = {
  currentState: "active" as string,
  addEventListener: (_type: string, handler: (state: string) => void) => {
    const g = globalThis as unknown as { __rntlAppStateHandlers?: Array<(s: string) => void> };
    if (!g.__rntlAppStateHandlers) g.__rntlAppStateHandlers = [];
    g.__rntlAppStateHandlers.push(handler);
    return {
      remove: () => {
        const arr = (
          globalThis as unknown as { __rntlAppStateHandlers?: Array<(s: string) => void> }
        ).__rntlAppStateHandlers;
        if (!arr) return;
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      },
    };
  },
};
export const AccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(false),
  isScreenReaderEnabled: () => Promise.resolve(false),
  addEventListener: () => ({ remove: () => {} }),
  announceForAccessibility: () => {},
  setAccessibilityFocus: () => {},
};
export const Linking = {
  openURL: () => Promise.resolve(),
  canOpenURL: () => Promise.resolve(true),
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
};
