/** UI40.3 standardized motion scales: durations in ms plus easing curves. */
export const motion = {
  duration: {
    instant: 0,
    fast: 150,
    base: 250,
    slow: 350,
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    enter: "cubic-bezier(0, 0, 0.2, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
} as const;

export type MotionDuration = keyof typeof motion.duration;
export type MotionEasing = keyof typeof motion.easing;
