import type { ReactElement } from "react";
import { StyleSheet, Platform, View } from "react-native";
import { colors } from "@/theme/colors";
import { monoFontFamily } from "@/theme/typography";
import type { SeatGridRow } from "@/types/placement";
import { AppText } from "@/components/core/AppText";
import { SeatDot } from "@/components/core/SeatDot";

export interface SeatGridProps {
  gridRows: SeatGridRow[];
  /** 'full' renders the screen gradient bar above the grid (map card, auditorium panel). */
  variant?: "full" | "mini";
}

/**
 * `linear-gradient(90deg,#e9e5dd,#c9c2b4,#e9e5dd)` — react-native-web passes `backgroundImage`
 * straight through to CSS; native platforms fall back to the solid `--map-filled` color, since
 * RN core has no gradient primitive.
 */
const screenBarStyle = StyleSheet.create({
  screenBar: {
    width: "70%",
    height: 6,
    borderRadius: 4,
    backgroundColor: colors.mapEmptyEnd,
    ...(Platform.OS === "web"
      ? {
          backgroundImage: `linear-gradient(90deg, ${colors.mapEmptyStart}, ${colors.mapEmptyEnd}, ${colors.mapEmptyStart})`,
        }
      : {}),
  },
});

export function SeatGrid({ gridRows, variant = "full" }: SeatGridProps): ReactElement {
  const isMini = variant === "mini";
  const rowCount = gridRows.length;
  let activeCount = 0;
  let lostCount = 0;
  let firstActiveHue: string | null = null;
  for (const row of gridRows) {
    for (const dot of row.dots) {
      if (dot.lost) {
        lostCount += 1;
      } else if (dot.active) {
        activeCount += 1;
        if (firstActiveHue === null) firstActiveHue = dot.hue;
      }
    }
  }
  const hueLabel = firstActiveHue ?? "indigo";
  const accessibilityDetails = [`${rowCount} rows`];
  if (lostCount > 0) accessibilityDetails.push(`${lostCount} seats taken`);
  if (activeCount > 0) accessibilityDetails.push(`${activeCount} seats in ${hueLabel} highlighted`);
  const accessibilityLabel = `Seat map, ${accessibilityDetails.join(", ")}`;
  return (
    <View
      accessible={true}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{ alignItems: "center", gap: isMini ? 8 : 10 }}
    >
      {isMini ? null : (
        <>
          <View
            style={screenBarStyle.screenBar}
            accessible={false}
            importantForAccessibility="no"
          />
          <AppText weight="500" style={styles.screenLabel}>
            SCREEN
          </AppText>
        </>
      )}
      <View
        accessible={false}
        importantForAccessibility="no"
        style={{
          gap: isMini ? 3 : 6,
          alignItems: "center",
          paddingVertical: isMini ? 0 : 8,
        }}
      >
        {gridRows.map((row, ri) => (
          <View
            key={ri}
            accessible={false}
            importantForAccessibility="no"
            style={{ flexDirection: "row", gap: isMini ? 3 : 6 }}
          >
            {row.dots.map((dot, ci) => (
              <SeatDot
                key={ci}
                active={dot.active}
                hue={dot.hue}
                size={dot.size}
                lost={dot.lost ?? false}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screenLabel: {
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.textTertiary,
    fontFamily: monoFontFamily,
  },
});
