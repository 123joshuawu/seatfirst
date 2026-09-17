import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { TextLinkButton } from "@/components/core/Button";

export interface QuickEditBarProps {
  movieTitle: string;
  theaterName: string;
  quickFormatLabel: string;
  quickPartyLabel: string;
  quickWindowLabel: string;
  showEditAction?: boolean;
  actions: {
    backToSearch: () => void;
    changeFormat: () => void;
    widenWindow: () => void;
  };
}

export function QuickEditBar({
  movieTitle,
  theaterName,
  quickFormatLabel,
  quickPartyLabel,
  quickWindowLabel,
  showEditAction = true,
  actions,
}: QuickEditBarProps): ReactElement {
  const formatPart =
    quickFormatLabel && quickFormatLabel !== "Any format" ? ` · ${quickFormatLabel}` : "";
  const breadcrumb = `${quickPartyLabel} · ${quickWindowLabel}${formatPart}`;

  return (
    <View>
      {showEditAction ? (
        <TextLinkButton
          label="← Edit search"
          onPress={actions.backToSearch}
          size={13}
          weight="600"
          color={colors.textMuted}
          accessibilityHint="Returns to search form"
        />
      ) : null}
      <AppText family="display" weight="700" style={styles.title}>
        {movieTitle} · {theaterName}
      </AppText>
      <AppText weight="400" style={styles.breadcrumb}>
        {breadcrumb}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  breadcrumb: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 8,
  },
});
