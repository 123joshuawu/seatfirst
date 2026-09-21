import { useState, type ReactElement, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { focusRings } from "@/theme/tokens";
import { AppText } from "./AppText";
import { LoadingSpinner } from "./LoadingSpinner";

export type ButtonVariant = "primary" | "secondary" | "link";
export type ButtonSize = "default" | "compact";
export type ButtonShape = "rect" | "pill";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  /** Visual treatment. Defaults to "primary". */
  variant?: ButtonVariant;
  /** "compact" shrinks touch-adjacent padding AND widens the touch target via
   * hitSlop (UI35.4). Defaults to "default". */
  size?: ButtonSize;
  /** Secondary-variant geometry: 'rect' = 12px radius action buttons,
   * 'pill' = 999px radius chips. Ignored by the primary/link variants, whose
   * geometry is fixed. Defaults to "rect". */
  shape?: ButtonShape;
  disabled?: boolean;
  /** Renders an inline spinner before the label and forces disabled +
   * `accessibilityState.busy`. */
  loading?: boolean;
  /** Optional adornments flanking the label (new-Button-only; the legacy
   * shims never pass icons, so their rendered structure is unchanged). */
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  /** Stretches the button to its container width. Primary is full-width by
   * default; this only has an effect on secondary/compact layouts. */
  fullWidth?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/**
 * Web-only interaction state shared by the polymorphic Button and the
 * TextLinkButton shim (which renders its own Pressable+AppText because its
 * numeric font-size / arbitrary color / boolean underline props cannot be
 * expressed through ButtonProps without polluting the new public type).
 */
interface ButtonInteraction {
  /** True between web focus and blur; drives the UI35.3 focus ring. */
  focused: boolean;
  /** Link-variant text state; drives underline on hover/press (UI35.2). The
   * container-level dim for the same states lives in the Pressable style
   * callback, which cannot reach the nested AppText. */
  linkHovered: boolean;
  linkPressed: boolean;
  handleFocus: () => void;
  handleBlur: () => void;
  handleLinkHoverIn: () => void;
  handleLinkHoverOut: () => void;
  handleLinkPressIn: () => void;
  handleLinkPressOut: () => void;
}

function useButtonInteraction(): ButtonInteraction {
  const [focused, setFocused] = useState(false);
  const [linkHovered, setLinkHovered] = useState(false);
  const [linkPressed, setLinkPressed] = useState(false);
  return {
    focused,
    linkHovered,
    linkPressed,
    handleFocus: () => {
      if (Platform.OS === "web") setFocused(true);
    },
    handleBlur: () => {
      if (Platform.OS === "web") setFocused(false);
    },
    handleLinkHoverIn: () => setLinkHovered(true),
    handleLinkHoverOut: () => setLinkHovered(false),
    handleLinkPressIn: () => setLinkPressed(true),
    handleLinkPressOut: () => setLinkPressed(false),
  };
}

/** UI35.4: minimum touch-target expansion for link/compact controls. */
const LINK_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

/** Internal superset of ButtonProps: the legacy shims' extra knobs
 * (background/suffix/busy/testID) ride the same renderer without leaking
 * into the new Button's public type. */
interface ButtonCoreOptions {
  label: string;
  onPress: () => void;
  variant: ButtonVariant;
  size: ButtonSize;
  shape: ButtonShape;
  disabled: boolean;
  loading: boolean;
  /** SecondaryButton's `busy`: surfaces in accessibilityState WITHOUT gating
   * interaction (unlike `loading`, which forces disabled). */
  busy: boolean;
  leftIcon?: ReactNode | undefined;
  rightIcon?: ReactNode | undefined;
  fullWidth: boolean;
  accessibilityLabel?: string | undefined;
  accessibilityHint?: string | undefined;
  testID?: string | undefined;
  /** SecondaryButton's background; the polymorphic Button always uses "white"
   * for its secondary variant (UI35.2 normal state). */
  background: "white" | "muted" | "none";
  /** SecondaryButton's trailing glyph. */
  suffix?: string | undefined;
}

type PressableState = { pressed: boolean; hovered?: boolean };

/** UI35.3 keyboard focus ring (web only; react-native-web passes raw CSS
 * outline properties through), sourced from the UI40.2 focusRings.standard
 * token. Shown on keyboard focus only, never on mouse-click focus. */
function focusRingStyle(focused: boolean): Record<string, unknown> | null {
  return focused && Platform.OS === "web" ? styles.focusRing : null;
}

function renderButton(o: ButtonCoreOptions, ix: ButtonInteraction): ReactElement {
  const effectiveDisabled = o.disabled || o.loading;
  const interactive = !effectiveDisabled;
  const busyState = o.loading || o.busy;
  const showHitSlop = o.variant === "link" || o.size === "compact";

  if (o.variant === "link") {
    const linkActive = ix.linkHovered || ix.linkPressed;
    return (
      <Pressable
        onPress={effectiveDisabled ? undefined : o.onPress}
        disabled={effectiveDisabled}
        accessibilityRole="button"
        accessibilityLabel={o.accessibilityLabel ?? o.label}
        accessibilityState={{ disabled: !!effectiveDisabled, busy: !!busyState }}
        accessibilityHint={o.accessibilityHint}
        focusable={!effectiveDisabled}
        testID={o.testID}
        hitSlop={showHitSlop ? LINK_HIT_SLOP : undefined}
        onFocus={ix.handleFocus}
        onBlur={ix.handleBlur}
        onHoverIn={ix.handleLinkHoverIn}
        onHoverOut={ix.handleLinkHoverOut}
        onPressIn={ix.handleLinkPressIn}
        onPressOut={ix.handleLinkPressOut}
        style={({ pressed, hovered }: PressableState) => [
          styles.textLinkBase,
          (pressed || hovered) && interactive ? styles.linkActive : null,
          focusRingStyle(ix.focused),
        ]}
      >
        {o.loading ? (
          <View style={styles.primaryLoadingRow}>
            <LoadingSpinner size={14} accessibilityLabel="Loading…" />
            <AppText
              weight="600"
              style={{
                fontSize: 13,
                color: colors.disabledText,
                textDecorationLine: linkActive ? "underline" : "none",
              }}
            >
              {o.label}
            </AppText>
          </View>
        ) : (
          <AppText
            weight="600"
            style={{
              fontSize: 13,
              color: effectiveDisabled ? colors.disabledText : colors.brandDark,
              textDecorationLine: linkActive ? "underline" : "none",
            }}
          >
            {o.label}
          </AppText>
        )}
      </Pressable>
    );
  }

  const isPill = o.variant === "secondary" && o.shape === "pill";
  return (
    <Pressable
      onPress={effectiveDisabled ? undefined : o.onPress}
      disabled={effectiveDisabled}
      accessibilityRole="button"
      accessibilityLabel={o.accessibilityLabel ?? o.label}
      accessibilityState={{ disabled: !!effectiveDisabled, busy: !!busyState }}
      accessibilityHint={o.accessibilityHint}
      focusable={!effectiveDisabled}
      testID={o.testID}
      hitSlop={showHitSlop ? LINK_HIT_SLOP : undefined}
      onFocus={ix.handleFocus}
      onBlur={ix.handleBlur}
      style={({ pressed, hovered }: PressableState) => [
        o.variant === "primary"
          ? styles.primaryBase
          : isPill
            ? styles.pillBase
            : styles.rectBase,
        o.variant === "primary" && o.size === "compact" ? styles.primaryCompact : null,
        o.variant === "secondary" && o.background === "white" ? styles.bgWhite : null,
        o.variant === "secondary" && o.background === "muted" ? styles.bgMuted : null,
        o.fullWidth ? styles.fullWidth : null,
        (pressed || hovered) && interactive
          ? o.variant === "primary"
            ? styles.primaryInteractive
            : styles.secondaryInteractive
          : null,
        // Normal-state (idle) fill: identical to the pre-consolidation output.
        // The interactive wash above overrides it only while pressed/hovered.
        o.variant === "primary" && !((pressed || hovered) && interactive)
          ? effectiveDisabled
            ? styles.primaryDisabled
            : styles.primaryEnabled
          : null,
        o.variant === "secondary" && effectiveDisabled ? styles.disabledBase : null,
        focusRingStyle(ix.focused),
      ]}
    >
      {renderButtonLabel(o)}
    </Pressable>
  );
}

function renderButtonLabel(o: ButtonCoreOptions): ReactElement {
  const effectiveDisabled = o.disabled || o.loading;
  const labelEl =
    o.variant === "primary" ? (
      <AppText
        family="display"
        weight="700"
        style={[
          styles.primaryLabel,
          o.size === "compact" ? styles.primaryLabelCompact : null,
          { color: effectiveDisabled ? colors.disabledText : colors.white },
        ]}
      >
        {o.label}
      </AppText>
    ) : (
      <AppText weight="600" style={o.shape === "pill" ? styles.pillLabel : styles.rectLabel}>
        {o.label}
        {o.suffix ? ` ${o.suffix}` : ""}
      </AppText>
    );
  if (o.loading) {
    return (
      <View style={styles.primaryLoadingRow}>
        <LoadingSpinner size={14} accessibilityLabel="Loading…" />
        {labelEl}
      </View>
    );
  }
  if (o.leftIcon != null || o.rightIcon != null) {
    return (
      <View style={styles.iconRow}>
        {o.leftIcon}
        {labelEl}
        {o.rightIcon}
      </View>
    );
  }
  return labelEl;
}

/** Polymorphic button: `variant="primary" | "secondary" | "link"`. */
export function Button({
  label,
  onPress,
  variant = "primary",
  size = "default",
  shape = "rect",
  disabled = false,
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth = false,
  accessibilityLabel,
  accessibilityHint,
}: ButtonProps): ReactElement {
  const ix = useButtonInteraction();
  return renderButton(
    {
      label,
      onPress,
      variant,
      size,
      shape,
      disabled,
      loading,
      busy: false,
      leftIcon,
      rightIcon,
      fullWidth,
      accessibilityLabel,
      accessibilityHint,
      testID: undefined,
      background: "white",
      suffix: undefined,
    },
    ix,
  );
}

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
  const ix = useButtonInteraction();
  return renderButton(
    {
      label,
      onPress,
      variant: "primary",
      size,
      shape: "rect",
      disabled,
      loading,
      busy: false,
      leftIcon: undefined,
      rightIcon: undefined,
      fullWidth: false,
      accessibilityLabel: label,
      accessibilityHint,
      testID,
      background: "white",
      suffix: undefined,
    },
    ix,
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
  const ix = useButtonInteraction();
  return renderButton(
    {
      label,
      onPress,
      variant: "secondary",
      size: "default",
      shape,
      disabled,
      loading: false,
      busy,
      leftIcon: undefined,
      rightIcon: undefined,
      fullWidth,
      accessibilityLabel,
      accessibilityHint,
      testID: undefined,
      background,
      suffix,
    },
    ix,
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
  const ix = useButtonInteraction();
  const emphasized = underline || ix.linkHovered || ix.linkPressed;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityHint={accessibilityHint}
      focusable={!disabled}
      hitSlop={LINK_HIT_SLOP}
      onFocus={ix.handleFocus}
      onBlur={ix.handleBlur}
      onHoverIn={ix.handleLinkHoverIn}
      onHoverOut={ix.handleLinkHoverOut}
      onPressIn={ix.handleLinkPressIn}
      onPressOut={ix.handleLinkPressOut}
      style={({ pressed, hovered }: PressableState) => [
        styles.textLinkBase,
        (pressed || hovered) && !disabled ? styles.linkActive : null,
        focusRingStyle(ix.focused),
      ]}
    >
      <AppText
        weight={weight}
        style={{
          fontSize: size,
          color: disabled ? colors.disabledText : color,
          textDecorationLine: emphasized ? "underline" : "none",
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
  /** UI35.2 pressed/hovered wash for the primary variant. */
  primaryInteractive: {
    backgroundColor: colors.brandDark,
  },
  /** UI35.2 pressed/hovered wash for the secondary variant: a soft overlay
   * that overrides the white/muted/none normal background (later in the
   * style array). Previously secondary buttons had no visual press state. */
  secondaryInteractive: {
    backgroundColor: colors.borderSoft,
  },
  /** UI35.2 pressed/hovered state for the link variant (container-level dim;
   * the underline for the same states is applied to the nested AppText via
   * hover/press tracking, which the style callback cannot reach). */
  linkActive: {
    opacity: 0.7,
  },
  /** UI35.3 keyboard focus ring (web only), sourced from the UI40.2
   * focusRings.standard token (brandContrast for canvas contrast). */
  focusRing: {
    ...focusRings.standard,
  },
  /** UI35.1 icon adornment row (new-Button-only; legacy shims never pass
   * icons, so their rendered structure is unchanged). */
  iconRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
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
