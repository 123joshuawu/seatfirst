import { useMemo } from "react";
import { motion, type MotionDuration } from "@/theme/motion";
import { useIsReduceMotionEnabled } from "./useReducedMotion";

/** UI40.3 reduced-motion hook: wraps the shared native/web preference read
 * and collapses motion durations to 0 when reduced motion is enabled. */
export function usePrefersReducedMotion(): {
  prefersReducedMotion: boolean;
  getDuration: (key: MotionDuration) => number;
} {
  const prefersReducedMotion = useIsReduceMotionEnabled();
  const getDuration = useMemo(
    () =>
      (key: MotionDuration): number =>
        prefersReducedMotion ? 0 : motion.duration[key],
    [prefersReducedMotion],
  );
  return { prefersReducedMotion, getDuration };
}
