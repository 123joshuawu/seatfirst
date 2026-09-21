import type { ReactElement, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { PrimaryButton, SecondaryButton } from "./Button";

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  testID?: string;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  testID?: string;
}

// UI38.1: renders one action slot. The `action` slot defaults to primary,
// the `secondaryAction` slot defaults to secondary; explicit variant wins.
// SecondaryButton drops testID (UI35), so a secondary action with a testID
// rides in a View carrying it instead of threading a prop Button ignores.
function renderSlot(slot: EmptyStateAction, defaultVariant: "primary" | "secondary"): ReactElement {
  const variant = slot.variant ?? defaultVariant;
  if (variant === "secondary") {
    const button = (
      <SecondaryButton
        label={slot.label}
        onPress={slot.onPress}
        accessibilityHint={slot.label}
      />
    );
    return slot.testID ? <View testID={slot.testID}>{button}</View> : button;
  }
  return (
    <PrimaryButton label={slot.label} onPress={slot.onPress} {...(slot.testID ? { testID: slot.testID } : {})} />
  );
}

/**
 * UI38.1 (ADR 0025 item 6, ADR 0068): standardized zero-result presentation —
 * centered icon circle, title, description, then stacked recovery actions.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  testID,
}: EmptyStateProps): ReactElement {
  return (
    <View style={styles.container} accessible={true} accessibilityRole="summary" testID={testID}>
      {icon ? <View style={styles.iconCircle}>{icon}</View> : null}
      <AppText weight="700" style={styles.title} accessibilityRole="header">
        {title}
      </AppText>
      <AppText weight="400" style={styles.description}>
        {description}
      </AppText>
      {action || secondaryAction ? (
        <View style={styles.actions}>
          {action ? renderSlot(action, "primary") : null}
          {secondaryAction ? renderSlot(secondaryAction, "secondary") : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    paddingVertical: 32,
    paddingHorizontal: 20,
    gap: 12,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.cardMutedBg,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 18,
    color: colors.textPrimary,
    textAlign: "center",
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    textAlign: "center",
  },
  actions: {
    alignItems: "center",
    gap: 8,
  },
});
