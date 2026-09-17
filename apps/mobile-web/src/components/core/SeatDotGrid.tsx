import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { SeatDot } from "./SeatDot";
import type { RowDotGrid } from "@/lib/rowSummary";

export interface SeatDotGridProps {
  grid: RowDotGrid;
  highlightedRange?: { row: number; startCol: number; endCol: number } | null;
}

const DOT_SIZE = 5;
const GAP = 3;
/**
 * Real auditoriums vary widely in column count. `ShowtimeRow`'s grid column is a fixed
 * 120px box — without this cap, a wide layout renders past `DOT_SIZE`/`GAP` and the grid
 * (centered in that box) bleeds out both sides, eating the card's padding. Scaling dot
 * size and gap down together keeps every grid, however wide, inside the box with its
 * padding intact.
 */
const GRID_MAX_WIDTH = 96;

export function SeatDotGrid({ grid, highlightedRange }: SeatDotGridProps): ReactElement {
  const naturalWidth = grid.columns * DOT_SIZE + (grid.columns - 1) * GAP;
  const scale = Math.min(1, GRID_MAX_WIDTH / naturalWidth);
  const dotSize = DOT_SIZE * scale;
  const gap = GAP * scale;
  const dotSizeStyle = { width: dotSize, height: dotSize, borderRadius: dotSize / 2 };
  let totalSeats = 0;
  let freeSeats = 0;
  const rows: ReactElement[] = [];
  for (let r = 0; r < grid.rows; r += 1) {
    const cells: ReactElement[] = [];
    for (let c = 0; c < grid.columns; c += 1) {
      const idx = r * grid.columns + c;
      const cell = grid.cells[idx];
      if (!cell) continue;
      if (!cell.isSeat) {
        cells.push(
          <View
            key={c}
            accessible={false}
            importantForAccessibility="no"
            style={[styles.notASeat, dotSizeStyle]}
          />,
        );
        continue;
      }
      totalSeats += 1;
      if (cell.free) {
        freeSeats += 1;
      }
      const isHighlighted =
        highlightedRange !== null &&
        highlightedRange !== undefined &&
        r === highlightedRange.row &&
        c >= highlightedRange.startCol &&
        c <= highlightedRange.endCol;
      if (isHighlighted) {
        cells.push(<SeatDot key={c} active hue="amber" size={dotSize} />);
        continue;
      }
      if (cell.free) {
        cells.push(
          <View
            key={c}
            accessible={false}
            importantForAccessibility="no"
            style={[styles.freeDot, dotSizeStyle]}
          />,
        );
        continue;
      }
      // Taken seat — distinct darker shade
      cells.push(
        <View
          key={c}
          accessible={false}
          importantForAccessibility="no"
          style={[styles.takenDot, dotSizeStyle]}
        />,
      );
    }
    rows.push(
      <View key={r} style={[styles.row, { gap }]} accessible={false} importantForAccessibility="no">
        {cells}
      </View>,
    );
  }
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Seating map: ${freeSeats} of ${totalSeats} seats available`}
      style={[styles.grid, { gap }]}
      testID="seat-dot-grid"
    >
      {rows}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    alignItems: "flex-start",
  },
  row: {
    flexDirection: "row",
  },
  notASeat: {
    backgroundColor: "transparent",
  },
  takenDot: {
    backgroundColor: colors.seatTaken,
  },
  freeDot: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: "#DCD5C8",
  },
});
