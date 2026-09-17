import { useSubmitSearchViewModel } from "@/hooks/viewModels/useSubmitSearchViewModel";
import type { ReactElement } from "react";
import { StyleSheet, Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";

export function CollapsedFormBar(): ReactElement {
  const vm = useSubmitSearchViewModel();
  const parts: string[] = [];
  if (vm.theaterName) parts.push(vm.theaterName);
  else if (vm.theaterCity) parts.push(vm.theaterCity);
  if (vm.quickWindowLabel) parts.push(vm.quickWindowLabel);
  if (vm.quickFormatLabel) parts.push(vm.quickFormatLabel);
  if (vm.quickPartyLabel) parts.push(vm.quickPartyLabel);
  const summary = parts.join(" · ") || "Search details";

  return (
    <Pressable
      onPress={() => vm.actions.setFormCollapsed(false)}
      accessibilityRole="button"
      accessibilityLabel={`${summary}, Edit search`}
      accessibilityHint="Expands search form"
      style={styles.bar}
    >
      <View style={styles.content}>
        <AppText weight="600" style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
          {summary}
        </AppText>
        <AppText weight="600" style={styles.editLabel}>
          Edit search
        </AppText>
      </View>
      <AppText
        weight="600"
        style={styles.chevron}
        accessible={false}
        importantForAccessibility="no"
      >
        ›
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.cardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  content: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  summary: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
  },
  editLabel: {
    fontSize: 13,
    color: colors.textPrimary,
    flexShrink: 0,
  },
  chevron: {
    fontSize: 18,
    color: colors.textMuted,
    marginLeft: 4,
  },
});
