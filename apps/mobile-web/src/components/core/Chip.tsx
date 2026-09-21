import { useState, type ReactElement } from "react";
import { Platform, Pressable, StyleSheet } from "react-native";
import { colors } from "@/theme/colors";
import { focusRings } from "@/theme/tokens";
import { AppText } from "./AppText";
import { Checkbox } from "./Checkbox";

export interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  /** 'pill' covers Format/Dates/Time of day/Seat location chips. 'square' is the party-size picker. */
  shape?: "pill" | "square";
  /** Renders the checkbox glyph used by the seat-location preference chips. */
  checkbox?: boolean;
  disabled?: boolean;
}

export function Chip({
  label,
  active,
  onPress,
  shape = "pill",
  checkbox = false,
  disabled = false,
}: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const isSquare = shape === "square";
  const role: "button" | "checkbox" = checkbox ? "checkbox" : "button";
  const state = checkbox
    ? { checked: active, disabled: !!disabled }
    : { selected: active, disabled: !!disabled };
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={state}
      focusable={!disabled}
      onFocus={() => {
        if (Platform.OS === "web") setFocused(true);
      }}
      onBlur={() => {
        if (Platform.OS === "web") setFocused(false);
      }}
      style={[
        isSquare ? styles.squareBase : styles.pillBase,
        active ? styles.activeBase : styles.inactiveBase,
        disabled && styles.disabled,
        // UI40.2 keyboard focus ring (web only), mirroring Button.tsx's
        // onFocus/onBlur-driven focus-visible convention.
        focused && Platform.OS === "web" ? styles.focusRing : null,
      ]}
    >
      {checkbox ? <Checkbox size="sm" checked={active} standalone={false} /> : null}
      <AppText
        weight={isSquare ? (active ? "700" : "600") : active ? "600" : "500"}
        style={[
          isSquare ? styles.squareLabel : styles.pillLabel,
          { color: active ? colors.amberTagText : colors.textPrimary },
        ]}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pillBase: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  squareBase: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  activeBase: {
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
  },
  inactiveBase: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.cardMutedBg,
  },
  pillLabel: {
    fontSize: 13,
  },
  squareLabel: {
    fontSize: 14,
  },
  disabled: {
    opacity: 0.5,
  },
  /** UI40.2 keyboard focus ring (web only), sourced from
   * focusRings.standard — identical to Button.tsx's ring. */
  focusRing: {
    ...focusRings.standard,
  },
});
