import { describe, expect, it } from "vitest";

import {
  buildAuditoriumLayout,
  computeSeatMetrics,
  computeSeatScores,
  metricsVersion,
  runScore,
  scoreVersion,
  seatScores,
  type SeatMetrics,
  type SparseLayoutCell,
} from "../src/index.js";

function standard(row: number, column: number, available = true): SparseLayoutCell {
  return { row, column, kind: "STANDARD", available, visible: true };
}

function toArray(scores: Float64Array): readonly number[] {
  return Array.from(scores);
}

function symmetricFiveSeatRow() {
  return buildAuditoriumLayout({
    rows: 1,
    columns: 5,
    cells: [1, 2, 3, 4, 5].map((column) => standard(1, column)),
  });
}

function asymmetricHouse() {
  return buildAuditoriumLayout({
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
}

function twoAisleRow() {
  return buildAuditoriumLayout({
    rows: 1,
    columns: 9,
    cells: [1, 2, 4, 5, 6, 8, 9].map((column) => standard(1, column)),
  });
}

/** The `seatScores` contract: `z.array(finiteNumber)` in [0,1], one value per `rows × columns` cell. */
function expectFiniteInRange(scores: Float64Array, cellCount: number): void {
  expect(scores).toBeInstanceOf(Float64Array);
  expect(scores.length).toBe(cellCount);
  for (const score of scores) {
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  }
}

describe("seatScores", () => {
  it("scores the symmetric five-seat row with ADR 0015 hand-derived values, finite and in [0,1]", () => {
    const { layout } = symmetricFiveSeatRow();
    const scores = seatScores(computeSeatMetrics(layout));
    expectFiniteInRange(scores, layout.rows * layout.columns);
    // A single occupied row normalizes depth to 0.5 (metrics.ts:72-73), so the depth term is
    // 0.5 / 0.65 for every seat. Each value below is hand-derived from ADR 0015 §1-§3:
    // centerScore = 1 - |lateral|, aisleScore = 1 - aisleDistance / 2, depth curve §2.
    const edge = 0.45 * 0 + 0.4 * (0.5 / 0.65) + 0.15 * 1;
    const near = 0.45 * 0.5 + 0.4 * (0.5 / 0.65) + 0.15 * 0.5;
    const center = 0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * 0;
    [edge, near, center, near, edge].forEach((value, index) => {
      expect(scores[index]).toBeCloseTo(value, 12);
    });
  });

  it("scores the asymmetric house in row-major order with gap cells at exactly 0", () => {
    const { layout } = asymmetricHouse();
    const scores = seatScores(computeSeatMetrics(layout));
    expectFiniteInRange(scores, layout.rows * layout.columns);
    // Row-major: flat index = row * columns + column, so index 5 is row 2 / column 1.
    // Hand-derived per seat from ADR 0015 §1-§3 over the fixture's metrics (maxAisleDistance 1:
    // row 2's col-2 gap splits it into a 1-seat segment and a 3-seat segment). Row 2's four
    // seats sit at lateral −1, −1/3, +1/3, +1 — no exact centre in an even-seat row.
    const front = 0.45 * 0 + 0.4 * (0 / 0.65) + 0.15 * (1 - 0 / 1); // (1,2), (1,3): lateral ±1
    const leftEdge = 0.45 * 0 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1); // (2,1): lateral −1
    const offCenter = 0.45 * (1 - 1 / 3) + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1); // (2,3): lateral −1/3
    const aisleFar = 0.45 * (1 - 1 / 3) + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 1 / 1); // (2,4): lateral +1/3, aisle-far
    const rightEdge = 0.45 * 0 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1); // (2,5): lateral +1
    const back = 0.45 * 1 + 0.4 * (1 - (0.3 * (1 - 0.65)) / 0.35) + 0.15 * (1 - 0 / 1); // (3,5)
    const expected = [
      0,
      front,
      front,
      0,
      0,
      leftEdge,
      0,
      offCenter,
      aisleFar,
      rightEdge,
      0,
      0,
      0,
      0,
      back,
    ];
    expected.forEach((value, index) => {
      if (value === 0) {
        expect(scores[index]).toBe(0);
      } else {
        expect(scores[index]).toBeCloseTo(value, 12);
      }
    });
  });

  it("scores the two-aisle row with the aisle gaps at exactly 0", () => {
    const { layout } = twoAisleRow();
    const scores = seatScores(computeSeatMetrics(layout));
    expectFiniteInRange(scores, layout.rows * layout.columns);
    // Hand-derived from ADR 0015 §1-§3; maxAisleDistance is 1 in this fixture.
    const edge = 0.45 * 0 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1);
    const near = 0.45 * (1 - 2 / 3) + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1);
    const offCenter = 0.45 * (1 - 1 / 3) + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1);
    const centerFar = 0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 1 / 1);
    const expected = [edge, near, 0, offCenter, centerFar, offCenter, 0, near, edge];
    expected.forEach((value, index) => {
      if (value === 0) {
        expect(scores[index]).toBe(0);
      } else {
        expect(scores[index]).toBeCloseTo(value, 12);
      }
    });
  });
});

describe("depth curve", () => {
  it("reproduces ADR 0015's worked example, including breakpoint continuity from both segments", () => {
    // Centre-ness and aisle proximity are pinned to 1 (lateral 0; maxAisleDistance 0 hits the
    // degenerate guard), so each score is 0.60 + 0.40 × depthScore and the curve is observable
    // as (score − 0.60) / 0.40.
    const metrics: SeatMetrics = {
      seatIndexInRow: new Int32Array([0, 1, 2, 3, 4]),
      depth: new Float64Array([0, 0.3, 0.65, 1, 0.650001]),
      lateral: new Float64Array([0, 0, 0, 0, 0]),
      aisleDistance: new Float64Array([0, 0, 0, 0, 0]),
    };
    const scores = seatScores(metrics);
    expectFiniteInRange(scores, 5);
    const derived = toArray(scores).map((score) => (score - 0.6) / 0.4);
    expect(derived[0]).toBeCloseTo(0, 12); // front row → 0
    expect(derived[1]).toBeCloseTo(0.4615, 4); // depth 0.30 → ≈0.4615 (ADR 0015:181,197-200)
    expect(derived[2]).toBeCloseTo(1, 12); // depth 0.65 → 1.0, from the first segment
    expect(derived[3]).toBeCloseTo(0.7, 12); // back wall → 0.70, from the second segment
    expect(derived[4]).toBeCloseTo(0.9999991428571429, 12); // 0.65 + ε, second segment
    expect(derived[4]).toBeCloseTo(1, 5); // both segments agree at the breakpoint
    expect(scores[2]).toBeCloseTo(1, 12); // the composed seatScore peaks at exactly 1.0
  });
});

describe("gap cells", () => {
  it("places exactly 0 on gap cells while real neighbours score at least 0", () => {
    // Synthetic metrics carrying E2's gap sentinels (metrics.ts:11-18): -1 / NaN on all four arrays.
    const metrics: SeatMetrics = {
      seatIndexInRow: new Int32Array([0, -1, 1, -1]),
      depth: new Float64Array([0.5, -1, 0.5, -1]),
      lateral: new Float64Array([0, Number.NaN, 0, Number.NaN]),
      aisleDistance: new Float64Array([1, -1, 0, -1]),
    };
    const scores = seatScores(metrics);
    expect(scores[1]).toBe(0);
    expect(scores[3]).toBe(0);
    // Hand-derived neighbours: seat 0 is aisle-far, seat 2 aisle-adjacent (maxAisleDistance 1).
    expect(scores[0]).toBeCloseTo(0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 1 / 1), 12);
    expect(scores[2]).toBeCloseTo(0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1), 12);
    expect(scores[0]).toBeGreaterThanOrEqual(0);
    expect(scores[2]).toBeGreaterThanOrEqual(0);
  });
});

describe("aisle proximity", () => {
  it("scores aisle-adjacent seats strictly above aisle-far seats with equal centre and depth terms", () => {
    const metrics: SeatMetrics = {
      seatIndexInRow: new Int32Array([0, 1, 2]),
      depth: new Float64Array([0.5, 0.5, 0.5]),
      lateral: new Float64Array([0, 0, 0]),
      aisleDistance: new Float64Array([0, 1, 0]),
    };
    const scores = seatScores(metrics);
    const adjacent = 0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 0 / 1);
    const far = 0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * (1 - 1 / 1);
    expect(scores[0]).toBeCloseTo(adjacent, 12);
    expect(scores[2]).toBeCloseTo(adjacent, 12);
    expect(scores[1]).toBeCloseTo(far, 12);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? -1);
    expect(scores[2]).toBeGreaterThan(scores[1] ?? -1);
  });

  it("scores every seat's aisle component exactly 1 when maxAisleDistance is 0", () => {
    // Every seat is aisle/edge-adjacent: the degenerate guard (ADR 0015:152-154).
    const metrics: SeatMetrics = {
      seatIndexInRow: new Int32Array([0, 1]),
      depth: new Float64Array([0, 0]),
      lateral: new Float64Array([-1, 1]),
      aisleDistance: new Float64Array([0, 0]),
    };
    const scores = seatScores(metrics);
    for (const score of scores) {
      expect(score).toBe(0.15); // centre 0 and depth 0 → the score is exactly the aisle term
      expect(score / 0.15).toBe(1); // …and the aisle component itself is exactly 1
    }
  });
});

describe("runScore", () => {
  it("computes the arithmetic mean of its members, verified by hand", () => {
    expect(runScore([1, 2, 3, 4])).toBe(2.5); // (1 + 2 + 3 + 4) / 4
  });

  it("matches the hand-derived mean of the symmetric fixture's seat scores", () => {
    const { layout } = symmetricFiveSeatRow();
    const scores = toArray(seatScores(computeSeatMetrics(layout)));
    const edge = 0.45 * 0 + 0.4 * (0.5 / 0.65) + 0.15 * 1;
    const near = 0.45 * 0.5 + 0.4 * (0.5 / 0.65) + 0.15 * 0.5;
    const center = 0.45 * 1 + 0.4 * (0.5 / 0.65) + 0.15 * 0;
    expect(runScore(scores)).toBeCloseTo((edge * 2 + near * 2 + center) / 5, 12);
  });

  it("throws RangeError on an empty run", () => {
    expect(() => runScore([])).toThrow(RangeError);
  });

  it("never silently produces a result from a non-finite member", () => {
    expect(() => runScore([0.5, Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => runScore([Number.NaN])).toThrow(RangeError);
  });
});

describe("input validation", () => {
  it("throws RangeError when any metric array length differs from the others", () => {
    const consistent: SeatMetrics = {
      seatIndexInRow: new Int32Array([0, 1, 2]),
      depth: new Float64Array([0.5, 0.5, 0.5]),
      lateral: new Float64Array([0, 0, 0]),
      aisleDistance: new Float64Array([0, 0, 0]),
    };
    const mismatched: readonly SeatMetrics[] = [
      { ...consistent, seatIndexInRow: new Int32Array([0, 1]) },
      { ...consistent, depth: new Float64Array([0.5, 0.5]) },
      { ...consistent, lateral: new Float64Array([0, 0]) },
      { ...consistent, aisleDistance: new Float64Array([0, 0]) },
    ];
    for (const metrics of mismatched) {
      expect(() => seatScores(metrics)).toThrow(RangeError);
    }
    expect(() => seatScores(consistent)).not.toThrow(); // positive control
  });
});

describe("barrel and convenience surface", () => {
  it("exposes seatScores, runScore, scoreVersion, and computeSeatScores with scoreVersion pinned to 1", () => {
    expect(scoreVersion).toBe(1);
    expect(metricsVersion).toBe(1); // a separate symbol, never repurposed (ADR 0015 §5)
    expect(typeof seatScores).toBe("function");
    expect(typeof runScore).toBe("function");
    expect(typeof computeSeatScores).toBe("function");
  });

  it("computeSeatScores delegates to computeSeatMetrics without re-implementing it", () => {
    const { layout } = symmetricFiveSeatRow();
    const direct = computeSeatScores(layout);
    const viaMetrics = seatScores(computeSeatMetrics(layout));
    expect(toArray(direct)).toEqual(toArray(viaMetrics));
  });
});
