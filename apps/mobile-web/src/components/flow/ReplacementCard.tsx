import { useState, type ReactElement } from "react";
import { StyleSheet, Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { PrimaryButton, SecondaryButton } from "@/components/core/Button";
import { FadeInView } from "@/components/core/FadeInView";
import type { RecoveryOption } from "@seatfirst/core";
import { formatPlacementLabel, formatShowtimeLocal } from "@/lib/presentation";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { openHandoff, resolveDeepLinkForShowtime } from "@/lib/handoff";

export interface ReplacementCardProps {
  /** Server-provided recovery ladder — rendered in strict returned order. */
  recovery?: readonly RecoveryOption[] | null;
  /** Optional external handoff handler — when omitted, resolves deepLink via groups. */
  onSelectOption?: (option: RecoveryOption) => void;
  /** Synchronizes the map preview without committing a handoff. */
  onFocusOption?: (option: RecoveryOption) => void;
  onSeeOtherOptions?: () => void;
}

function showtimeLabelForOption(
  option: RecoveryOption,
  groups: readonly {
    readonly showtimes: readonly {
      readonly showtimeId: string;
      readonly showDateTimeUtc: string;
      readonly timezone: string;
    }[];
  }[],
): string | null {
  for (const group of groups) {
    const st = group.showtimes.find((s) => s.showtimeId === option.showtimeId);
    if (st) return formatShowtimeLocal(st.showDateTimeUtc, st.timezone);
  }
  return null;
}

function relaxedLabel(option: RecoveryOption): string | null {
  for (const r of option.relaxed) {
    if ("label" in r && typeof r.label === "string" && r.label.length > 0) {
      return r.label;
    }
    // Known relaxations have no label — describe by kind fallback
    // but for Level 4 the server always provides label "Different showtime and seat"
    if (r.kind === "OUTSIDE_REGION") return "Outside preferred region";
    if (r.kind === "EARLIER_THAN_PREFERRED") return "Earlier than preferred";
    if (r.kind === "LATER_THAN_PREFERRED") return "Later than preferred";
    if (r.kind === "DIFFERENT_FORMAT") return "Different format";
    if (r.kind === "FEWER_SHOWTIMES") return "Fewer showtimes";
    if (typeof r.kind === "string") {
      // Unknown kind with no label — surface kind
      return r.kind;
    }
  }
  return null;
}
/**
 * Consumer-friendly badge for each recovery rung, faithful to the decided
 * semantics (arch §6: Level 1 = same showtime ±2 rows; ADR-0026: Level 2 =
 * same placement at another matching showtime, Level 3 = next-best placement
 * in the same showtime, Level 4 = relaxed config, both may differ).
 * Display-only: never drives `option.level` or any algorithm behavior.
 */
function recoveryLevelLabel(level: RecoveryOption["level"]): string {
  switch (level) {
    case 1:
      return "Closest seats nearby";
    case 2:
      return "Same seats, different showtime";
    case 3:
      return "Different seats, same showtime";
    case 4:
      return "A different showtime";
  }
}

export function ReplacementCard({
  recovery: recoveryProp,
  onSelectOption,
  onFocusOption,
  onSeeOtherOptions,
}: ReplacementCardProps): ReactElement {
  const storeRecovery = useSeatfirstStore((s) => {
    const r = s.recheckResult;
    if (r !== null && r.status === "GONE") return r.recovery;
    return null;
  });
  const groups = useSeatfirstStore((s) => s.groups);
  const recovery = recoveryProp ?? storeRecovery;
  const [consentedLevels, setConsentedLevels] = useState<Set<number>>(() => new Set());
  const [handoffError, setHandoffError] = useState<string | null>(null);

  if (recovery === null || recovery === undefined || recovery.length === 0) {
    return (
      <FadeInView style={styles.card}>
        <View style={styles.alert}>
          <AppText family="display" weight="700" style={styles.alertTitle}>
            Those seats were just taken
          </AppText>
          <AppText weight="400" style={styles.alertBody}>
            No alternatives available — try another search.
          </AppText>
        </View>
        {onSeeOtherOptions ? (
          <SecondaryButton label="See other options" onPress={onSeeOtherOptions} fullWidth />
        ) : null}
      </FadeInView>
    );
  }

  const toggleConsent = (level: number): void => {
    setConsentedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const handleSelect = async (option: RecoveryOption): Promise<void> => {
    // Level 4 consent gate — must be checked before proceeding
    if (
      option.level === 4 &&
      option.requiresConsent === true &&
      !consentedLevels.has(option.level)
    ) {
      return;
    }
    if (onSelectOption) {
      onSelectOption(option);
      return;
    }
    const deepLinkUrl = resolveDeepLinkForShowtime(option.showtimeId, groups);
    if (deepLinkUrl === null) {
      setHandoffError("Couldn't open AMC for that time — pick another alternative");
      return;
    }
    setHandoffError(null);
    await openHandoff(deepLinkUrl);
  };

  return (
    <FadeInView style={styles.card}>
      <View style={styles.alert}>
        <AppText family="display" weight="700" style={styles.alertTitle}>
          Those seats were just taken
        </AppText>
        <AppText weight="400" style={styles.alertBody}>
          Here are the closest alternatives we found.
        </AppText>
      </View>
      <View style={{ gap: 12 }}>
        {recovery.map((option) => {
          const placementLabel = formatPlacementLabel(option.placement);
          const timeLabel = showtimeLabelForOption(option, groups);
          const relaxed = relaxedLabel(option);
          const isLevel4 = option.level === 4;
          const requiresConsent = isLevel4 && option.requiresConsent === true;
          const consented = consentedLevels.has(option.level);
          const buttonDisabled = requiresConsent && !consented;

          return (
            <Pressable
              key={`${option.level}-${option.placement.placementKey}-${option.showtimeId}`}
              onHoverIn={() => onFocusOption?.(option)}
              onFocus={() => onFocusOption?.(option)}
              onPressIn={() => onFocusOption?.(option)}
              style={styles.optionCard}
            >
              <View style={styles.optionHeader}>
                <View style={styles.levelBadge}>
                  <AppText weight="700" style={styles.levelText}>
                    {recoveryLevelLabel(option.level)}
                  </AppText>
                </View>
                {requiresConsent ? (
                  <View style={styles.consentTag}>
                    <AppText weight="600" style={styles.consentTagText}>
                      Requires consent
                    </AppText>
                  </View>
                ) : null}
              </View>
              <AppText weight="600" style={styles.placementLabel}>
                {placementLabel}
              </AppText>
              {timeLabel ? (
                <AppText weight="400" style={styles.timeLabel}>
                  {timeLabel}
                </AppText>
              ) : null}
              {relaxed ? (
                <AppText weight="400" style={styles.relaxedLabel}>
                  {relaxed}
                </AppText>
              ) : null}
              {requiresConsent ? (
                <Pressable
                  onPress={() => toggleConsent(option.level)}
                  accessibilityRole="checkbox"
                  accessibilityLabel="I understand this is a different showtime and seat"
                  accessibilityState={{ checked: consented }}
                  accessibilityHint="Confirms consent for different showtime"
                  style={styles.consentRow}
                >
                  <View
                    style={[styles.checkbox, consented ? styles.checkboxChecked : null]}
                    accessible={false}
                    importantForAccessibility="no"
                  >
                    {consented ? (
                      <AppText weight="700" style={styles.checkmark}>
                        ✓
                      </AppText>
                    ) : null}
                  </View>
                  <AppText weight="400" style={styles.consentText}>
                    I understand this is a different showtime and seat
                  </AppText>
                </Pressable>
              ) : null}
              <View style={{ marginTop: 8 }}>
                <PrimaryButton
                  label={
                    requiresConsent && !consented
                      ? "Confirm to continue"
                      : "Continue with these seats"
                  }
                  onPress={() => void handleSelect(option)}
                  disabled={buttonDisabled}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
      {handoffError ? (
        <AppText weight="400" style={styles.handoffError}>
          {handoffError}
        </AppText>
      ) : null}
      {onSeeOtherOptions ? (
        <View style={{ marginTop: 12 }}>
          <SecondaryButton label="See other options" onPress={onSeeOtherOptions} fullWidth />
        </View>
      ) : null}
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 26,
  },
  alert: {
    backgroundColor: colors.replacementBg,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  alertTitle: {
    fontSize: 15,
    color: colors.replacementTitle,
    marginBottom: 4,
  },
  alertBody: {
    fontSize: 13,
    color: colors.textReplacementBody,
    lineHeight: 19.5,
  },
  optionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  optionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  levelBadge: {
    backgroundColor: colors.brandSoft,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  levelText: {
    fontSize: 11,
    color: colors.brandDark,
  },
  consentTag: {
    backgroundColor: colors.noValidBg,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  consentTagText: {
    fontSize: 11,
    color: colors.noValidText,
  },
  placementLabel: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  timeLabel: {
    fontSize: 13,
    color: colors.textMuted,
  },
  relaxedLabel: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.checkboxOffBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  checkmark: {
    fontSize: 11,
    color: colors.white,
  },
  consentText: {
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 1,
  },
  handoffError: {
    fontSize: 12,
    color: colors.noValidText,
    marginTop: 10,
    textAlign: "center",
  },
});
