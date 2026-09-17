import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { ChipRow } from "@/components/search/ChipRow";
import type { PreferToggles } from "@/lib/preferSort";

export interface PreferBarProps {
  value: PreferToggles;
  onChange: (next: PreferToggles) => void;
  formats: string[];
}

const FORMAT_LABEL: Record<string, string> = {
  any: "Any",
  imax: "IMAX",
  dolby: "Dolby Cinema",
  standard: "Standard",
};

const ALL_FORMATS: PreferToggles["format"][] = ["imax", "dolby", "standard"];

export function PreferBar({ value, onChange, formats }: PreferBarProps): ReactElement {
  const offeredFormats: PreferToggles["format"][] = [
    "any",
    ...ALL_FORMATS.filter((f) => formats.includes(f)),
  ];

  const formatChips = offeredFormats.map((fmt) => ({
    label: FORMAT_LABEL[fmt] ?? fmt,
    active: value.format === fmt,
    onPress: () => {
      if (value.format !== fmt) {
        onChange({ ...value, format: fmt });
      }
    },
  }));

  return (
    <View style={styles.container} testID="prefer-bar">
      <ChipRow label="PREFER" chips={formatChips} marginBottom={8} />
      <AppText weight="400" style={styles.caption}>
        re-ranks instantly · no reload
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
    padding: 12,
    backgroundColor: colors.cardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  caption: {
    fontSize: 11,
    color: colors.textTertiary,
  },
});
