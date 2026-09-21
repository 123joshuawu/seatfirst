import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";
import { SeatDot, type SeatDotProps } from "./SeatDot";

export interface SeatLegendProps {
  /**
   * Compact variant for space-constrained cards (e.g. the LeftPanel auditorium card):
   * smaller sample glyphs, smaller labels, tighter gaps. Labels are kept — following this
   * codebase's compact convention (ShowtimeRow/ShowtimeList) of shrinking chrome, not
   * dropping content.
   */
  compact?: boolean;
}

interface LegendEntry {
  label: string;
  dot: Pick<SeatDotProps, "active" | "lost" | "taken" | "isAccessible">;
}

const ENTRIES: readonly LegendEntry[] = [
  { label: "Best placement", dot: { active: true } },
  { label: "Available", dot: { active: false } },
  { label: "Taken", dot: { active: false, taken: true } },
  { label: "Lost", dot: { active: false, lost: true } },
  { label: "Accessible", dot: { active: false, isAccessible: true } },
];

/**
 * Shape vocabulary key for the seat maps (UI39 / ADR 0069, WCAG 1.4.1): every seat state
 * differs by silhouette, not just color. Sample glyphs reuse `SeatDot` directly so the
 * legend can never drift from the map rendering.
 *
 * (No `typography.caption` constant or `colors.textSecondary` token exists in this codebase —
 * labels follow the nearest existing pattern: 11px secondary text like PreferBar's caption.)
 */
export function SeatLegend({ compact = false }: SeatLegendProps): ReactElement {
  const glyphSize = compact ? 8 : 10;
  return (
    <View
      accessible={true}
      accessibilityRole="summary"
      accessibilityLabel="Seating legend: Best placement, Available, Taken, Lost, and Accessible seating"
      testID="seat-legend"
      style={[styles.cluster, compact ? styles.clusterCompact : null]}
    >
      {ENTRIES.map((entry) => (
        <View
          key={entry.label}
          style={[styles.item, compact ? styles.itemCompact : null]}
          accessible={false}
          importantForAccessibility="no"
        >
          <View
            style={[styles.glyphBox, { width: glyphSize + 5, height: glyphSize + 5 }]}
          >
            <SeatDot
              active={entry.dot.active}
              hue="amber"
              size={glyphSize}
              lost={entry.dot.lost ?? false}
              taken={entry.dot.taken ?? false}
              isAccessible={entry.dot.isAccessible ?? false}
            />
          </View>
          <AppText weight="400" style={[styles.label, compact ? styles.labelCompact : null]}>
            {entry.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cluster: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
  },
  clusterCompact: {
    gap: 8,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  itemCompact: {
    gap: 3,
  },
  // Fixed box slightly larger than the glyph so the rotated accessible diamond
  // (bounding box ~1.42x the glyph) stays centered and never clips neighbors.
  glyphBox: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 11,
    color: colors.textMuted,
  },
  labelCompact: {
    fontSize: 10,
    color: colors.textMuted,
  },
});
