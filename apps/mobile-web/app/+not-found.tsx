import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { AppText } from "@/components/core/AppText";
import { PrimaryButton } from "@/components/core/Button";
import { colors } from "@/theme/colors";

/** Branded 404 screen. Expo Router renders this for any unmatched URL. */
export default function NotFoundScreen(): ReactElement {
  const router = useRouter();
  return (
    <View style={styles.safeArea}>
      <View style={styles.card}>
        <AppText family="display" weight="800" style={styles.heading}>
          Page not found
        </AppText>
        <AppText weight="400" style={styles.body}>
          We couldn&apos;t find the page you were looking for. It may have moved, or the link might
          be mistyped.
        </AppText>
        <PrimaryButton
          label="Go home"
          onPress={() => router.replace("/")}
          accessibilityHint="Return to the Seatfirst home screen"
          testID="not-found-go-home"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.pageBg,
  },
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
    backgroundColor: colors.pageBg,
  },
  heading: {
    fontSize: 28,
    color: colors.textPrimary,
    textAlign: "center",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: "center",
    maxWidth: 420,
  },
});
