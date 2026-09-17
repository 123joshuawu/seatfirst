import { useCallback, type ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { PrimaryButton, SecondaryButton } from "@/components/core/Button";
import { FadeInView } from "@/components/core/FadeInView";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { formatPlacementLabel, handoffHonestyLabel } from "@/lib/presentation";
import { openHandoff, resolveDeepLinkForShowtime } from "@/lib/handoff";
import type { Placement } from "@seatfirst/core";

export interface ConfirmedCardProps {
  /** Server-validated placement from AVAILABLE result — when omitted, reads from store. */
  placement?: Placement | null;
  /** Checked-at instant from AVAILABLE result — when omitted, reads from store. */
  checkedAt?: string | null;
  /** Showtime deepLinkUrl for handoff — when omitted, resolves via groups. */
  deepLinkUrl?: string | null;
  onRestart?: () => void;
}

function formatCheckedAt(checkedAt: string): string {
  try {
    return new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return checkedAt;
  }
}

export function ConfirmedCard({
  placement: placementProp,
  checkedAt: checkedAtProp,
  deepLinkUrl: deepLinkUrlProp,
  onRestart,
}: ConfirmedCardProps): ReactElement {
  const storeResult = useSeatfirstStore((s) => s.recheckResult);
  const groups = useSeatfirstStore((s) => s.groups);
  const restartAction = useSeatfirstStore((s) => s.restart);
  const clearRecheck = useSeatfirstStore((s) => s.clearRecheck);

  const isAvailable = storeResult !== null && storeResult.status === "AVAILABLE";
  const placement: Placement | null = placementProp ?? (isAvailable ? storeResult.placement : null);
  const checkedAt: string | null = checkedAtProp ?? (isAvailable ? storeResult.checkedAt : null);

  // Resolve deepLinkUrl: explicit prop > resolved from groups via selectedShowtimeId > null
  const selectedShowtimeId = useSeatfirstStore((s) => s.recheckSelectedShowtimeId);
  let deepLinkUrl: string | null = deepLinkUrlProp ?? null;
  if (deepLinkUrl === null && selectedShowtimeId !== null) {
    deepLinkUrl = resolveDeepLinkForShowtime(selectedShowtimeId, groups);
  }

  const placementLabel = placement ? formatPlacementLabel(placement) : "your seats";
  const honestyLine = placement ? handoffHonestyLabel(placement) : null;

  const handleContinue = useCallback(async () => {
    if (deepLinkUrl !== null) {
      await openHandoff(deepLinkUrl);
    }
  }, [deepLinkUrl]);

  const handleRestart = useCallback(() => {
    clearRecheck();
    if (onRestart) onRestart();
    else restartAction();
  }, [onRestart, restartAction, clearRecheck]);

  return (
    <FadeInView style={styles.card}>
      <View style={styles.checkBadge}>
        <AppText weight="700" style={styles.checkGlyph}>
          ✓
        </AppText>
      </View>
      <AppText family="display" weight="800" style={styles.title}>
        Available as of just now — continuing to AMC
      </AppText>
      <AppText weight="400" style={styles.body}>
        {placementLabel}
        {checkedAt ? ` · checked ${formatCheckedAt(checkedAt)}` : ""}
        {honestyLine ? `\n${honestyLine}` : ""}
      </AppText>
      <View style={styles.actions}>
        <PrimaryButton
          label="Continue to AMC"
          onPress={() => void handleContinue()}
          disabled={deepLinkUrl === null}
        />
      </View>
      <View style={styles.restartWrap}>
        <SecondaryButton label="Start a new search" onPress={handleRestart} />
      </View>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingVertical: 32,
    paddingHorizontal: 26,
    alignItems: "center",
    gap: 12,
  },
  checkBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.statusGreen,
    alignItems: "center",
    justifyContent: "center",
  },
  checkGlyph: {
    fontSize: 18,
    color: colors.white,
  },
  title: {
    fontSize: 17,
    color: colors.textPrimary,
    textAlign: "center",
  },
  body: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19.5,
    textAlign: "center",
  },
  actions: {
    marginTop: 8,
    width: "100%",
  },
  restartWrap: {
    marginTop: 8,
  },
});
