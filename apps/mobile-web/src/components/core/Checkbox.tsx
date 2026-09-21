import type { ReactElement } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";

export interface CheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  standalone?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export function Checkbox({
  checked,
  onChange,
  disabled = false,
  size = "md",
  standalone = true,
  accessibilityLabel,
  accessibilityHint,
}: CheckboxProps): ReactElement {
  const isSm = size === "sm";
  const boxDimension = isSm ? 14 : 18;
  const borderRadius = isSm ? 4 : 5;

  const innerBox = (
    <View
      style={[
        styles.box,
        { width: boxDimension, height: boxDimension, borderRadius },
        checked ? styles.boxChecked : styles.boxUnchecked,
        disabled && styles.disabled,
      ]}
      accessible={false}
      importantForAccessibility="no"
    >
      {checked ? (
        <AppText weight="700" style={[styles.glyph, { fontSize: isSm ? 10 : 12 }]}>
          ✓
        </AppText>
      ) : null}
    </View>
  );

  if (!standalone) {
    return innerBox;
  }

  return (
    <Pressable
      onPress={disabled || !onChange ? undefined : () => onChange(!checked)}
      disabled={disabled}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={styles.touchTarget}
    >
      {innerBox}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  boxUnchecked: {
    borderColor: colors.checkboxOffBorder,
    backgroundColor: "transparent",
  },
  boxChecked: {
    backgroundColor: colors.brandDark,
    borderColor: colors.brandDark,
  },
  glyph: {
    color: colors.white,
  },
  disabled: {
    opacity: 0.5,
  },
  touchTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
