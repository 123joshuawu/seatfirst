import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Reads the OS reduce-motion preference and keeps it in sync.
 * - React Native: `AccessibilityInfo.isReduceMotionEnabled()` + `reduceMotionChanged` event.
 * - Web: `window.matchMedia('(prefers-reduced-motion: reduce)')` change event, OR'd with the native flag.
 */
export function useIsReduceMotionEnabled(): boolean {
  const [nativeReduce, setNativeReduce] = useState(false);
  const [webReduce, setWebReduce] = useState(() => {
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
    ) {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    return false;
  });

  useEffect(() => {
    let mounted = true;

    // Initial async read from AccessibilityInfo
    const maybePromise = AccessibilityInfo.isReduceMotionEnabled?.();
    if (maybePromise instanceof Promise) {
      maybePromise
        .then((value) => {
          if (mounted) setNativeReduce(value);
        })
        .catch(() => {
          // ignore — leave as false
        });
    }

    // Subscribe to native reduceMotionChanged
    let nativeSub: { remove: () => void } | undefined;

    const handler = (value: boolean): void => {
      setNativeReduce(value);
    };

    // RN returns a subscription with .remove(); keep reference for cleanup
    const maybeSub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", handler);

    if (maybeSub && typeof maybeSub.remove === "function") {
      nativeSub = maybeSub;
    }

    // Web matchMedia subscription (OR'd)
    let mql: MediaQueryList | undefined;
    let mqlListener: ((e: MediaQueryListEvent) => void) | undefined;
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
    ) {
      mql = window.matchMedia("(prefers-reduced-motion: reduce)");
      mqlListener = (e: MediaQueryListEvent): void => {
        setWebReduce(e.matches);
      };
      mql.addEventListener("change", mqlListener);
    }

    return () => {
      mounted = false;
      if (nativeSub) nativeSub.remove();
      if (mql && mqlListener) {
        mql.removeEventListener("change", mqlListener);
      }
    };
  }, []);

  return nativeReduce || webReduce;
}
