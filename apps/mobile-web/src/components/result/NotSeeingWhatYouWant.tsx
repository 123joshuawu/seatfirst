import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { SecondaryButton } from "@/components/core/Button";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";

export interface NotSeeingWhatYouWantProps {
  actions: {
    changeFormat: () => void;
    widenWindow: () => void;
    backToSearch: () => void;
  };
}

export function NotSeeingWhatYouWant({ actions }: NotSeeingWhatYouWantProps): ReactElement {
  return (
    <View style={styles.panel}>
      <EyebrowLabel marginBottom={10}>Not seeing what you want?</EyebrowLabel>
      <View style={styles.row}>
        <SecondaryButton
          label="Change format"
          shape="pill"
          background="white"
          onPress={actions.changeFormat}
          accessibilityHint="Opens format picker"
        />
        <SecondaryButton
          label="Widen window"
          shape="pill"
          background="white"
          onPress={actions.widenWindow}
          accessibilityHint="Widens search time window"
        />
        <SecondaryButton
          label="Edit preferences"
          shape="pill"
          background="white"
          onPress={actions.backToSearch}
          accessibilityHint="Returns to search form"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.cardMutedBg,
    borderWidth: 1,
    borderColor: colors.borderFooter,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
});
