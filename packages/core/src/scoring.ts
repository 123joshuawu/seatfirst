import type { AuditoriumLayoutGeometry } from "./layout.js";
import { computeSeatMetrics, type SeatMetrics } from "./metrics.js";

/**
 * Versions the ADR 0015 score composition layered on top of E2's geometry metrics: the §1
 * per-metric normalizations, the §2 two-segment depth curve, the §3 0.45/0.40/0.15 weight
 * vector, and the §4 `runScore` aggregation. Bump this integer whenever any of those change —
 * never `metricsVersion`, which stays the version of the four geometry-metric definitions
 * themselves (`docs/adr/0015-score-composition-weights-recommendation.md:278-294`).
 */
export const scoreVersion = 1;

function assertMetricLengths(metrics: SeatMetrics): number {
  const cellCount = metrics.seatIndexInRow.length;
  if (
    metrics.depth.length !== cellCount ||
    metrics.lateral.length !== cellCount ||
    metrics.aisleDistance.length !== cellCount
  ) {
    throw new RangeError("seat metric array lengths must all be equal");
  }
  return cellCount;
}

/** Maximum `aisleDistance` over the auditorium's seat cells (gap cells carry the -1 sentinel). */
function maximumAisleDistance(metrics: SeatMetrics, cellCount: number): number {
  let maximum = 0;
  for (let index = 0; index < cellCount; index += 1) {
    if ((metrics.seatIndexInRow[index] ?? -1) >= 0) {
      const distance = metrics.aisleDistance[index] ?? -1;
      if (distance > maximum) {
        maximum = distance;
      }
    }
  }
  return maximum;
}

/**
 * Scores every grid cell, seat and gap, in row-major order — one finite value in [0,1] per
 * `rows × columns` cell, matching the `seatScores` contract (`packages/core/src/result-contracts.ts:6,565,584-591`).
 * Seat cells follow ADR 0015 §1-§3 exactly; gap cells score exactly 0 (E4.4: the floor of
 * placement quality scores the floor of the scale, and a leaked gap sorts last rather than
 * mid-pack). Pure and deterministic: no I/O, no mutable state, nothing beyond core-internal
 * modules.
 */
export function seatScores(metrics: SeatMetrics): Float64Array {
  const cellCount = assertMetricLengths(metrics);
  const maxAisleDistance = maximumAisleDistance(metrics, cellCount);
  const scores = new Float64Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    if ((metrics.seatIndexInRow[index] ?? -1) < 0) {
      scores[index] = 0;
      continue;
    }
    const lateralValue = metrics.lateral[index] ?? Number.NaN;
    const depthValue = metrics.depth[index] ?? -1;
    const aisleValue = metrics.aisleDistance[index] ?? -1;
    // ADR 0015 §1 — centre-ness, better is 1: `centerScore = 1 - |lateral|`.
    const centerScore = 1 - Math.abs(lateralValue);
    // ADR 0015 §1 — aisle proximity min-maxed within the auditorium and inverted; the
    // degenerate guard scores every seat 1 when the most aisle-distant seat sits at distance 0.
    const aisleScore = maxAisleDistance === 0 ? 1 : 1 - aisleValue / maxAisleDistance;
    // ADR 0015 §2 — two-segment depth curve: peak 1.0 at 65% depth, 0.7 at the back wall.
    const depthScore =
      depthValue <= 0.65 ? depthValue / 0.65 : 1 - (0.3 * (depthValue - 0.65)) / 0.35;
    // ADR 0015 §3 — 45% centre-ness, 40% depth, 15% aisle proximity.
    scores[index] = 0.45 * centerScore + 0.4 * depthScore + 0.15 * aisleScore;
  }
  return scores;
}

/**
 * Arithmetic mean of a run's member seat scores (ADR 0015 §4) — the expected per-person seat
 * quality of a placement, kept on the same [0,1] scale as `seatScores` so `groupHits[].runScore`
 * satisfies its `finiteNumber` contract. Throws `RangeError` on an empty array and on any
 * non-finite member: no accepted document defines a mean over zero members, and a non-finite
 * member must never silently produce a non-finite output.
 */
export function runScore(memberScores: readonly number[]): number {
  if (memberScores.length === 0) {
    throw new RangeError("runScore requires at least one member score");
  }
  let total = 0;
  for (const memberScore of memberScores) {
    if (!Number.isFinite(memberScore)) {
      throw new RangeError("runScore member scores must all be finite");
    }
    total += memberScore;
  }
  return total / memberScores.length;
}

/**
 * Convenience for the common call chain: scores straight from a layout, delegating metric
 * computation to E2's shipped `computeSeatMetrics`. `seatScores(metrics)` remains the primary
 * API — scores are per-showtime over stable metrics, and cross-showtime averaging is out of
 * scope for this module (ADR 0015 §6).
 */
export function computeSeatScores(layout: AuditoriumLayoutGeometry): Float64Array {
  return seatScores(computeSeatMetrics(layout));
}
