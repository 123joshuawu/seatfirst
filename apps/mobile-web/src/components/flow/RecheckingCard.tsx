import { type ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { FadeInView } from "@/components/core/FadeInView";
import { LoadingSpinner } from "@/components/core/LoadingSpinner";
import { SecondaryButton } from "@/components/core/Button";
import { useHandoffViewModel } from "@/hooks/viewModels/useHandoffViewModel";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { formatPlacementLabel } from "@/lib/presentation";

export interface RecheckingCardProps {
  placementLabel?: string | null;
}

export function RecheckingCard({ placementLabel }: RecheckingCardProps): ReactElement {
  const vm = useHandoffViewModel();
  const answer = useSeatfirstStore((s) => s.answer);

  if (vm.recheckErrorLabel) {
    return (
      <View style={styles.errorCard}>
        <AppText weight="600" style={styles.errorText}>
          {vm.recheckErrorLabel}
        </AppText>
        {vm.recheckResult !== null && vm.recheckResult.status === "UNAVAILABLE" ? (
          <AppText weight="400" style={styles.errorSubText}>
            {vm.recheckResult.lastKnown
              ? `Last known: ${vm.recheckResult.lastKnown.placement.seatNames.join(", ")}`
              : ""}
          </AppText>
        ) : null}
        <View style={styles.errorActions}>
          <SecondaryButton label="Try again" onPress={() => void vm.actions.retryRecheck()} />
          <SecondaryButton label="Back to results" onPress={() => vm.actions.clearRecheck()} />
        </View>
      </View>
    );
  }

  let label = placementLabel ?? null;
  if (label === null || label.length === 0) {
    if (answer !== null && answer.mode === "CONFIDENT") {
      label = formatPlacementLabel(answer.primary.placement);
    } else if (answer !== null && answer.mode === "HEDGED" && answer.alternatives[0]) {
      label = formatPlacementLabel(answer.alternatives[0].placement);
    } else {
      label = "your seats";
    }
  }

  return (
    <FadeInView style={styles.card}>
      <LoadingSpinner />
      <AppText
        family="display"
        weight="700"
        style={styles.title}
        accessibilityRole="progressbar"
        accessibilityLabel={`Rechecking ${label}`}
        accessibilityHint="Confirming seats before handoff"
      >
        Rechecking {label}
      </AppText>
      <AppText weight="400" style={styles.body}>
        Confirming your seats are still there before handing off to AMC.
      </AppText>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingVertical: 40,
    paddingHorizontal: 28,
    alignItems: "center",
    gap: 18,
  },
  title: {
    fontSize: 15,
    color: colors.textPrimary,
    textAlign: "center",
  },
  body: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: "center",
  },
  errorCard: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 26,
    gap: 12,
    alignItems: "center" as const,
  },
  errorText: {
    fontSize: 14,
    color: colors.textPrimary,
    textAlign: "center" as const,
  },
  errorSubText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center" as const,
  },
  errorActions: {
    flexDirection: "row" as const,
    gap: 10,
    marginTop: 8,
  },
});
