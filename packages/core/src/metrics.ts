import { getBit } from "./bitmap.js";
import { SEAT_KIND_CODE, type AuditoriumLayoutGeometry } from "./layout.js";

/**
 * Versions all four geometry metric definitions. Bump this integer whenever any meaning or
 * normalization below changes, because metric and region-mask caches do not expire on their own.
 */
export const metricsVersion = 1;

export interface SeatMetrics {
  /** Zero-based ordinal among seat positions in the same row; -1 marks a visual gap. */
  readonly seatIndexInRow: Int32Array;
  /** Occupied-row ordinal normalized front=0 to back=1; -1 marks a visual gap. */
  readonly depth: Float64Array;
  /** Signed seat-ordinal offset normalized left=-1, center=0, right=+1; NaN marks a gap. */
  readonly lateral: Float64Array;
  /** Number of intervening seats to the nearest aisle or row edge; -1 marks a visual gap. */
  readonly aisleDistance: Float64Array;
}

function cellCount(layout: AuditoriumLayoutGeometry): number {
  const count = layout.rows * layout.columns;
  if (
    !Number.isInteger(layout.rows) ||
    layout.rows <= 0 ||
    !Number.isInteger(layout.columns) ||
    layout.columns <= 0 ||
    layout.seatKinds.length !== count ||
    layout.displayMask.length !== Math.ceil(count / 8)
  ) {
    throw new RangeError("layout geometry dimensions are inconsistent");
  }
  return count;
}

function isSeatPosition(layout: AuditoriumLayoutGeometry, flatIndex: number): boolean {
  return (
    getBit(layout.displayMask, flatIndex, layout.rows * layout.columns) &&
    layout.seatKinds[flatIndex] !== SEAT_KIND_CODE.NOT_A_SEAT
  );
}

function rowSeatIndices(layout: AuditoriumLayoutGeometry, row: number): readonly number[] {
  const indices: number[] = [];
  for (let column = 0; column < layout.columns; column += 1) {
    const flatIndex = row * layout.columns + column;
    if (isSeatPosition(layout, flatIndex)) {
      indices.push(flatIndex);
    }
  }
  return indices;
}

export function seatIndexInRow(layout: AuditoriumLayoutGeometry): Int32Array {
  const result = new Int32Array(cellCount(layout));
  result.fill(-1);
  for (let row = 0; row < layout.rows; row += 1) {
    rowSeatIndices(layout, row).forEach((flatIndex, index) => {
      result[flatIndex] = index;
    });
  }
  return result;
}

export function depth(layout: AuditoriumLayoutGeometry): Float64Array {
  const result = new Float64Array(cellCount(layout));
  result.fill(-1);
  const occupiedRows = Array.from({ length: layout.rows }, (_, row) => row).filter(
    (row) => rowSeatIndices(layout, row).length > 0,
  );
  occupiedRows.forEach((row, occupiedIndex) => {
    const normalized =
      occupiedRows.length === 1 ? 0.5 : occupiedIndex / Math.max(1, occupiedRows.length - 1);
    for (const flatIndex of rowSeatIndices(layout, row)) {
      result[flatIndex] = normalized;
    }
  });
  return result;
}

export function lateral(layout: AuditoriumLayoutGeometry): Float64Array {
  const result = new Float64Array(cellCount(layout));
  result.fill(Number.NaN);
  for (let row = 0; row < layout.rows; row += 1) {
    const seats = rowSeatIndices(layout, row);
    const center = (seats.length - 1) / 2;
    seats.forEach((flatIndex, index) => {
      result[flatIndex] = seats.length === 1 ? 0 : (index - center) / center;
    });
  }
  return result;
}

export function aisleDistance(layout: AuditoriumLayoutGeometry): Float64Array {
  const result = new Float64Array(cellCount(layout));
  result.fill(-1);
  for (let row = 0; row < layout.rows; row += 1) {
    let segment: number[] = [];
    const flushSegment = () => {
      segment.forEach((flatIndex, index) => {
        result[flatIndex] = Math.min(index, segment.length - 1 - index);
      });
      segment = [];
    };
    for (let column = 0; column < layout.columns; column += 1) {
      const flatIndex = row * layout.columns + column;
      if (isSeatPosition(layout, flatIndex)) {
        segment.push(flatIndex);
      } else {
        flushSegment();
      }
    }
    flushSegment();
  }
  return result;
}

export function computeSeatMetrics(layout: AuditoriumLayoutGeometry): SeatMetrics {
  return {
    seatIndexInRow: seatIndexInRow(layout),
    depth: depth(layout),
    lateral: lateral(layout),
    aisleDistance: aisleDistance(layout),
  };
}
