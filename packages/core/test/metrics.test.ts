import { describe, expect, it } from "vitest";

import {
  buildAuditoriumLayout,
  computeSeatMetrics,
  metricsVersion,
  type SparseLayoutCell,
} from "../src/index.js";

function standard(row: number, column: number, available = true): SparseLayoutCell {
  return { row, column, kind: "STANDARD", available, visible: true };
}

function values(values: Float64Array | Int32Array): readonly number[] {
  return Array.from(values);
}

function bytes(values: Float64Array | Int32Array): readonly number[] {
  return Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

describe("seat metrics", () => {
  it("matches hand-derived values on a symmetric five-seat row", () => {
    const { layout } = buildAuditoriumLayout({
      rows: 1,
      columns: 5,
      cells: [1, 2, 3, 4, 5].map((column) => standard(1, column)),
    });
    const actual = computeSeatMetrics(layout);
    expect(values(actual.seatIndexInRow)).toEqual([0, 1, 2, 3, 4]);
    expect(values(actual.depth)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(values(actual.lateral)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(values(actual.aisleDistance)).toEqual([0, 1, 2, 1, 0]);
  });

  it("uses seat ordinals rather than grid columns on an asymmetric house", () => {
    const { layout } = buildAuditoriumLayout({
      rows: 3,
      columns: 5,
      cells: [
        standard(1, 2),
        standard(1, 3),
        standard(2, 1),
        standard(2, 3),
        standard(2, 4),
        standard(2, 5),
        standard(3, 5),
      ],
    });
    const actual = computeSeatMetrics(layout);
    expect(values(actual.seatIndexInRow)).toEqual([
      -1, 0, 1, -1, -1, 0, -1, 1, 2, 3, -1, -1, -1, -1, 0,
    ]);
    expect(actual.seatIndexInRow[7]).toBe(1);
    expect(7 % layout.columns).toBe(2);
    expect(values(actual.depth)).toEqual([
      -1, 0, 0, -1, -1, 0.5, -1, 0.5, 0.5, 0.5, -1, -1, -1, -1, 1,
    ]);
    expect(actual.lateral[5]).toBe(-1);
    expect(actual.lateral[7]).toBeCloseTo(-1 / 3, 12);
    expect(actual.lateral[9]).toBe(1);
    expect(actual.aisleDistance[5]).toBe(0);
    expect(actual.aisleDistance[8]).toBe(1);
  });

  it("measures two aisles as segment edges in seats", () => {
    const { layout } = buildAuditoriumLayout({
      rows: 1,
      columns: 9,
      cells: [1, 2, 4, 5, 6, 8, 9].map((column) => standard(1, column)),
    });
    const actual = computeSeatMetrics(layout);
    expect(values(actual.seatIndexInRow)).toEqual([0, 1, -1, 2, 3, 4, -1, 5, 6]);
    // This shape has one occupied row, so every seat has the defined neutral depth 0.5;
    // the two hand-placed aisle columns remain the -1 non-seat sentinel.
    expect(values(actual.depth)).toEqual([0.5, 0.5, -1, 0.5, 0.5, 0.5, -1, 0.5, 0.5]);
    expect(values(actual.aisleDistance)).toEqual([0, 0, -1, 0, 1, 0, -1, 0, 0]);
    expect(values(actual.lateral)).toEqual([
      -1,
      -2 / 3,
      Number.NaN,
      -1 / 3,
      0,
      1 / 3,
      Number.NaN,
      2 / 3,
      1,
    ]);
  });

  it("is byte-identical when only availability changes", () => {
    const open = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: [standard(1, 1, true), standard(1, 2, false)],
    });
    const reversed = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: [standard(1, 1, false), standard(1, 2, true)],
    });
    const left = computeSeatMetrics(open.layout);
    const right = computeSeatMetrics(reversed.layout);
    expect(bytes(left.seatIndexInRow)).toEqual(bytes(right.seatIndexInRow));
    expect(bytes(left.depth)).toEqual(bytes(right.depth));
    expect(bytes(left.lateral)).toEqual(bytes(right.lateral));
    expect(bytes(left.aisleDistance)).toEqual(bytes(right.aisleDistance));
  });

  it("pins the cache version to the current metric definitions", () => {
    expect(metricsVersion).toBe(1);
  });
});
