import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { useIsReduceMotionEnabled } from "@/hooks/useReducedMotion";

/**
 * Ports the mockup's CSS keyframes (sf-spin, sf-pulse, sf-fade) to React Native's Animated
 * API rather than react-native-reanimated: these are simple looping/mount transitions with
 * no gesture or worklet involvement, and Animated avoids adding a babel/metro plugin to a
 * bare Expo Router app that has none configured yet (ui-work-plan.md §0.3 permits either).
 */

// Re-export so callers can import the hook from the animation module if they prefer
export { useIsReduceMotionEnabled } from "@/hooks/useReducedMotion";

/** `@keyframes sf-spin { to { transform: rotate(360deg) } }`, .8s linear infinite. */
export function useSpinValue(durationMs = 800) {
  const spin = useRef(new Animated.Value(0)).current;
  const reduceMotion = useIsReduceMotionEnabled();
  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin, durationMs, reduceMotion]);
  return spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
}

/** `@keyframes sf-pulse { 0%,100% { opacity:1 } 50% { opacity:.35 } }`, 2s ease infinite. */
export function usePulseOpacity(durationMs = 2000) {
  const pulse = useRef(new Animated.Value(1)).current;
  const reduceMotion = useIsReduceMotionEnabled();
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: durationMs / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: durationMs / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, durationMs, reduceMotion]);
  return pulse;
}

/**
 * `@keyframes sf-fade { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }`,
 * .3s ease, run once on mount.
 */
export function useFadeInStyle(durationMs = 300) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useIsReduceMotionEnabled();
  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [progress, durationMs, reduceMotion]);
  return {
    opacity: progress,
    transform: [
      {
        translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }),
      },
    ],
  };
}
