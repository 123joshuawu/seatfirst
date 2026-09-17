import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { SeatGrid } from "@/components/map/SeatGrid";
import type { SeatDotData, SeatGridRow } from "@/types/placement";

/**
 * Static illustrative mini map for the State-1 ghost card: 4 rows of 11 dots with
 * one centered run of 4 active indigo dots, mirroring the hardcoded "Row G,
 * Seats 8–11 · four together" example text. Not derived from any real search.
 * Dot sizes match `buildGrid`'s mini sizing (5 idle / 7 active).
 */
const GHOST_MINI_ROWS = 4;
const GHOST_MINI_COLS = 11;
const GHOST_MINI_ACTIVE_ROW = 2;
const GHOST_MINI_ACTIVE_START_COL = 4;
const GHOST_MINI_ACTIVE_COUNT = 4;

function buildGhostMiniRows(): SeatGridRow[] {
  const rows: SeatGridRow[] = [];
  for (let r = 0; r < GHOST_MINI_ROWS; r += 1) {
    const dots: SeatDotData[] = [];
    for (let c = 0; c < GHOST_MINI_COLS; c += 1) {
      const active =
        r === GHOST_MINI_ACTIVE_ROW &&
        c >= GHOST_MINI_ACTIVE_START_COL &&
        c < GHOST_MINI_ACTIVE_START_COL + GHOST_MINI_ACTIVE_COUNT;
      dots.push({ active, hue: "indigo", size: active ? 7 : 5 });
    }
    rows.push({ dots });
  }
  return rows;
}

const ghostMiniRows: SeatGridRow[] = buildGhostMiniRows();

/**
 * The State-1 "example result" ghost card, shared by desktop `LeftPanel` (where it
 * renders persistently) and the mobile-only `HowItWorksSheet` (where it renders on
 * demand). Static, illustrative, non-interactive content — no props.
 */
export function GhostResultCard(): ReactElement {
  return (
    <>
      <View style={styles.ghostCard}>
        <View style={styles.ghostBadge}>
          <AppText weight="600" style={styles.ghostLabel}>
            Example result
          </AppText>
        </View>
        <AppText family="display" weight="700" style={styles.ghostHeading}>
          Row G, Seats 8–11
        </AppText>
        <View style={styles.ghostMap}>
          <SeatGrid gridRows={ghostMiniRows} variant="mini" />
        </View>
        <AppText weight="400" style={styles.ghostLine}>
          Centered · middle third · four together
        </AppText>
        <AppText weight="400" style={styles.ghostLine}>
          Available Friday at 7:10 and 9:40
        </AppText>
        <AppText weight="600" style={styles.ghostLine}>
          From $18.99
        </AppText>
      </View>
      <AppText weight="400" style={styles.ghostFooter}>
        One answer, not twelve seating charts.
      </AppText>
      <AppText weight="400" style={styles.ghostFooterDetail}>
        Traditional booking makes you check showtimes one by one to see who has the best seats left.
        Tell Seatfirst your party and window, and it scans every showtime to find the best seats
        together.
      </AppText>
    </>
  );
}

const styles = StyleSheet.create({
  ghostCard: {
    opacity: 0.85,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.ghostDashed,
    borderRadius: 14,
    padding: 20,
    backgroundColor: colors.cardMutedBg,
  },
  ghostBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.gateBg,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 8,
  },
  ghostLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  ghostHeading: {
    fontSize: 19,
    color: colors.textPrimary,
  },
  ghostMap: {
    marginTop: 10,
    marginBottom: 4,
  },
  ghostLine: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 6,
  },
  ghostFooter: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19.5,
  },
  ghostFooterDetail: {
    fontSize: 13,
    color: colors.textTertiary,
    lineHeight: 19.5,
    marginTop: 6,
  },
});
