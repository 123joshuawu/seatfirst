import type { ReactElement } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { usePulseOpacity } from "@/theme/animations";

export interface ProgressBarProps {
  resolved: number;
  total: number;
  testID?: string;
}

export function ProgressBar({ resolved, total, testID }: ProgressBarProps): ReactElement {
  const isIndeterminate = total === 0;
  const pulse = usePulseOpacity(2000);
  const fraction = total > 0 ? Math.max(0, Math.min(1, resolved / total)) : 0;

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={isIndeterminate ? undefined : { min: 0, max: total, now: resolved }}
      style={styles.track}
    >
      {isIndeterminate ? (
        <Animated.View style={[styles.fill, styles.fillIndeterminate, { opacity: pulse }]} />
      ) : (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- percentage width is valid RN but typed as number in older RN types
        <View style={[styles.fill, { width: `${fraction * 100}%` } as any]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.mapEmptyStart,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    backgroundColor: colors.brand,
    borderRadius: 3,
  },
  fillIndeterminate: {
    width: "40%",
  },
});
