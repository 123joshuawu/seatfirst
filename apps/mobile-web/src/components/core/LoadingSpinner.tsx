import type { ReactElement } from "react";
import { Animated } from "react-native";
import { colors } from "@/theme/colors";
import { useSpinValue } from "@/theme/animations";

/**
 * Replicates the mockup's rechecking spinner:
 * `width:34px;height:34px;border-radius:50%;border:3px solid #f0e5d8;border-top-color:#c8752c;
 * animation:sf-spin .8s linear infinite`.
 */
export interface LoadingSpinnerProps {
  /** Accessible announcement for assistive tech. Defaults to 'Loading…'. */
  accessibilityLabel?: string;
  /** Diameter in px. Defaults to 34 (the mockup's rechecking spinner size). */
  size?: number;
}

export function LoadingSpinner({
  accessibilityLabel = "Loading…",
  size = 34,
}: LoadingSpinnerProps = {}): ReactElement {
  const rotate = useSpinValue(800);
  const radius = size / 2;
  const borderWidth = Math.max(2, Math.round((size * 3) / 34));
  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        borderWidth,
        borderColor: "#f0e5d8",
        borderTopColor: colors.brand,
        transform: [{ rotate }],
      }}
    />
  );
}
