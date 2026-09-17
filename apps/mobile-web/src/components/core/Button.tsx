import type { ReactElement } from "react";
import { StyleSheet, Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { LoadingSpinner } from "./LoadingSpinner";

export interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
  /** "compact" scales down padding/font for reuse as a per-row action (e.g. showtime row
   * "Go to AMC"), distinct from the full-screen "default" primary CTA. */
  size?: "default" | "compact";
  /** When true, renders a small spinner inline before the label and blocks interaction.
   * Distinct from plain `disabled` in the accessibility state (`busy: true`). */
  loading?: boolean;
  testID?: string;
}

/** The "Find my seats" / "Continue with…" / "Choose these seats" call-to-action button. */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  accessibilityHint,
  size = "default",
  loading = false,
  testID,
}: PrimaryButtonProps): ReactElement {
  const effectiveDisabled = disabled || loading;
  return (
    <Pressable
      onPress={effectiveDisabled ? undefined : onPress}
      disabled={effectiveDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!effectiveDisabled, busy: !!loading }}
      focusable={!effectiveDisabled}
      testID={testID}
      style={[
        styles.primaryBase,
        size === "compact" ? styles.primaryCompact : null,
        effectiveDisabled ? styles.primaryDisabled : styles.primaryEnabled,
      ]}
    >
      {loading ? (
        <View style={styles.primaryLoadingRow}>
          <LoadingSpinner size={14} accessibilityLabel="Loading…" />
          <AppText
            family="display"
            weight="700"
            style={[
              styles.primaryLabel,
              size === "compact" ? styles.primaryLabelCompact : null,
              { color: colors.disabledText },
            ]}
          >
            {label}
          </AppText>
        </View>
      ) : (
        <AppText
          family="display"
          weight="700"
          style={[
            styles.primaryLabel,
            size === "compact" ? styles.primaryLabelCompact : null,
            { color: disabled ? colors.disabledText : colors.white },
          ]}
        >
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

export interface SecondaryButtonProps {
  label: string;
  onPress: () => void;
  /** 'rect' = 12px radius (default action buttons). 'pill' = 999px radius (footer/quick-edit chips). */
  shape?: "rect" | "pill";
  background?: "white" | "muted" | "none";
  fullWidth?: boolean;
  /** Trailing glyph, e.g. the down-caret on quick-edit chips. */
  suffix?: string;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/** Bordered, non-primary action buttons: "Change format", "See other options", quick-edit chips, etc. */
export function SecondaryButton({
  label,
  onPress,
  shape = "rect",
  background = "none",
  fullWidth = false,
  suffix,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
}: SecondaryButtonProps): ReactElement {
  const isPill = shape === "pill";
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy }}
      accessibilityHint={accessibilityHint}
      focusable={!disabled}
      style={[
        isPill ? styles.pillBase : styles.rectBase,
        background === "white" && styles.bgWhite,
        background === "muted" && styles.bgMuted,
        fullWidth && styles.fullWidth,
        disabled && styles.disabledBase,
      ]}
    >
      <AppText weight="600" style={isPill ? styles.pillLabel : styles.rectLabel}>
        {label}
        {suffix ? ` ${suffix}` : ""}
      </AppText>
    </Pressable>
  );
}

export interface TextLinkButtonProps {
  label: string;
  onPress: () => void;
  size?: 12 | 13;
  weight?: "600" | "700";
  color?: string;
  underline?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}

/** Bare text buttons with no border or background: "← Edit search", "Change", "Restore recommendation". */
export function TextLinkButton({
  label,
  onPress,
  size = 12,
  weight = "600",
  color = colors.brandContrast,
  underline = false,
  disabled = false,
  accessibilityHint,
}: TextLinkButtonProps): ReactElement {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityHint={accessibilityHint}
      focusable={!disabled}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={styles.textLinkBase}
    >
      <AppText
        weight={weight}
        style={{
          fontSize: size,
          color: disabled ? colors.disabledText : color,
          textDecorationLine: underline ? "underline" : "none",
        }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primaryBase: {
    width: "100%",
    paddingVertical: 15,
    borderRadius: 12,
  },
  primaryEnabled: {
    backgroundColor: colors.brandContrast,
  },
  primaryDisabled: {
    backgroundColor: colors.disabledBg,
  },
  primaryLabel: {
    fontSize: 15,
    textAlign: "center",
  },
  primaryCompact: {
    width: "auto",
    alignSelf: "flex-end",
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  primaryLabelCompact: {
    fontSize: 13,
  },
  primaryLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  rectBase: {
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
  },
  pillBase: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  bgWhite: {
    backgroundColor: colors.white,
  },
  bgMuted: {
    backgroundColor: colors.cardMutedBg,
  },
  fullWidth: {
    width: "100%",
  },
  rectLabel: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  pillLabel: {
    fontSize: 12,
    color: colors.textPrimary,
  },
  textLinkBase: {
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  disabledBase: {
    opacity: 0.5,
  },
});
