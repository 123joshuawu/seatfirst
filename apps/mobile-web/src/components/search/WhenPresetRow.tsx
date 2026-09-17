import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { Chip } from "@/components/core/Chip";
import { useWhenFieldViewModel } from "@/hooks/viewModels/useWhenFieldViewModel";
export interface WhenPresetRowProps {
  isLocked?: boolean;
  /**
   * Desktop override — when explicitly `false`, renders the same rows with
   * tighter vertical rhythm so the form CTA clears ~900px viewports.
   * `undefined` keeps the long-standing mobile values.
   */
  isMobile?: boolean;
  /**
   * ADR 0044 amendment 2026-09-05: hide the Tier 2 resolved read-out once the
   * desktop left panel already shows the identical resolved window live.
   * Defaults to `false`, preserving the always-visible read-out elsewhere.
   */
  hideResolvedReadout?: boolean;
}
export function WhenPresetRow({
  isLocked = false,
  isMobile,
  hideResolvedReadout = false,
}: WhenPresetRowProps): ReactElement {
  const vm = useWhenFieldViewModel();
  const desktop = isMobile === false;

  return (
    <View style={{ marginBottom: desktop ? 12 : 20 }}>
      <EyebrowLabel marginBottom={desktop ? 6 : 8}>When</EyebrowLabel>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: desktop ? 6 : 8,
        }}
      >
        {vm.dedupedPresets.map((label) => (
          <Chip
            key={label}
            label={label}
            active={vm.activePreset === label}
            onPress={() => vm.actions.handlePresetPress(label)}
            disabled={isLocked}
          />
        ))}
      </View>
      {!hideResolvedReadout && (
        <View style={[styles.resolved, desktop && styles.resolvedDesktop]}>
          <AppText
            weight="500"
            style={{ fontSize: 13, color: "#374151" }}
            accessibilityLabel={`Resolved window: ${vm.readout}`}
          >
            {vm.readout}
          </AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  resolved: {
    paddingVertical: 12,
    paddingHorizontal: 13,
    gap: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.cardBg,
  },
  // Desktop (≥680px): tighter inner rhythm; horizontal padding unchanged.
  resolvedDesktop: {
    paddingVertical: 8,
    gap: 8,
  },
});
