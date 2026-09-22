import type { ReactElement } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { PrimaryButton, SecondaryButton } from "@/components/core/Button";
import { Checkbox } from "@/components/core/Checkbox";
import { useRecoverySheetViewModel } from "@/hooks/viewModels/useRecoverySheetViewModel";

/** Accessibility hint for an alternative handoff CTA (never implies a hold). */
const HANDOFF_A11Y_HINT = "Confirms seat availability and opens showtime on AMC";
const CONSENT_LABEL = "I understand this is a different showtime and seat";

/**
 * UI41 (ADR 0071): recovery overlay for `status: "GONE"` recheck results.
 * Consumes `useRecoverySheetViewModel` (never the store directly, matching
 * this codebase's viewmodel-hook convention) and renders nothing unless the
 * sheet is open on a GONE result. Mobile (`width < 680`) renders a slide-up
 * Bottom Sheet; desktop renders a centered Modal Popover.
 */
export function RecoverySheet(): ReactElement | null {
  const vm = useRecoverySheetViewModel();
  if (!vm.open) return null;

  const subtitle =
    vm.originalShowtimeLabel !== null
      ? `Closest alternatives for ${vm.movieTitle} · ${vm.originalShowtimeLabel}`
      : `Closest alternatives for ${vm.movieTitle}`;

  return (
    <View
      style={[styles.overlay, vm.isMobile ? styles.overlayBottom : styles.overlayCenter]}
      accessible={true}
      accessibilityLabel="Seat recovery options"
      testID="recovery-sheet"
      {...(Platform.OS === "web"
        ? ({
            role: "dialog",
            "aria-label": "Seat recovery options",
            "aria-labelledby": "recovery-sheet-title",
            "aria-modal": "true",
          } as unknown as Record<string, unknown>)
        : {})}
    >
      <Pressable
        onPress={vm.actions.dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss recovery options"
        style={styles.scrim}
        testID="recovery-sheet-backdrop"
      />
      <View style={vm.isMobile ? styles.sheetPanel : styles.modalPanel}>
        <View style={styles.headerRow}>
          <AppText
            family="display"
            weight="700"
            style={styles.title}
            {...(Platform.OS === "web" ? { id: "recovery-sheet-title" } : {})}
          >
            Those seats were just taken
          </AppText>
          <Pressable
            onPress={vm.actions.dismiss}
            accessibilityRole="button"
            accessibilityLabel="Close recovery options"
            accessibilityHint="Returns to the results list"
            style={styles.closeButton}
            testID="recovery-sheet-close"
          >
            <AppText weight="600" style={styles.closeGlyph}>
              ×
            </AppText>
          </Pressable>
        </View>
        <AppText weight="400" style={styles.subtitle}>
          {subtitle}
        </AppText>
        <ScrollView
          style={styles.optionsScroll}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {vm.options.map((item) => (
            <View
              key={`${item.option.level}-${item.option.showtimeId}`}
              style={styles.optionCard}
              testID={`recovery-option-${item.option.level}`}
            >
              <AppText weight="700" style={styles.optionHeader}>
                {item.header}
              </AppText>
              <AppText weight="600" style={styles.optionPlacement}>
                {item.placementLabel}
              </AppText>
              {item.timeLabel ? (
                <AppText weight="400" style={styles.optionMeta}>
                  {item.timeLabel}
                </AppText>
              ) : null}
              {item.relaxed ? (
                <AppText weight="400" style={styles.optionMeta}>
                  {item.relaxed}
                </AppText>
              ) : null}
              {item.requiresConsent ? (
                <View style={styles.consentRow}>
                  <Checkbox
                    size="md"
                    standalone={true}
                    checked={item.consented}
                    onChange={() => vm.actions.toggleConsent(item.option.level)}
                    accessibilityLabel={CONSENT_LABEL}
                    accessibilityHint="Confirms consent for different showtime"
                  />
                  <AppText weight="400" style={styles.consentText}>
                    {CONSENT_LABEL}
                  </AppText>
                </View>
              ) : null}
              <View style={styles.optionCTA}>
                <PrimaryButton
                  label="Go to AMC"
                  onPress={() => vm.actions.selectOption(item.option)}
                  disabled={!item.ctaEnabled}
                  accessibilityHint={HANDOFF_A11Y_HINT}
                  size="compact"
                />
              </View>
            </View>
          ))}
        </ScrollView>
        {vm.handoffError ? (
          <AppText weight="400" style={styles.handoffErrorText} testID="recovery-handoff-error">
            {vm.handoffError}
          </AppText>
        ) : null}
        <SecondaryButton
          label="Back to results"
          onPress={vm.actions.dismiss}
          accessibilityHint="Closes the alternatives and returns to the results list"
          fullWidth
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  // Mobile: slide-up Bottom Sheet anchored to the bottom edge.
  overlayBottom: {
    justifyContent: "flex-end",
  },
  // Desktop: centered Modal Popover.
  overlayCenter: {
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheetPanel: {
    backgroundColor: colors.cardBg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 10,
    width: "100%",
    maxHeight: "80%",
  },
  modalPanel: {
    backgroundColor: colors.cardBg,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 10,
    width: "100%",
    maxWidth: 480,
    maxHeight: "80%",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    fontSize: 16,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  closeGlyph: {
    fontSize: 24,
    color: colors.textMuted,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
  },
  optionsScroll: {
    gap: 10,
  },
  optionCard: {
    backgroundColor: colors.cardMutedBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderHairline,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
    marginBottom: 10,
  },
  optionHeader: {
    fontSize: 12,
    color: colors.replacementTitle,
  },
  optionPlacement: {
    fontSize: 13.5,
    color: colors.textPrimary,
  },
  optionMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  optionCTA: {
    marginTop: 4,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  consentText: {
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 1,
  },
  handoffErrorText: {
    fontSize: 12,
    color: colors.noValidText,
  },
});
