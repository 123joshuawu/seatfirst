import { PlacementSchema } from "@seatfirst/core";
import type { Placement } from "@seatfirst/core";

/**
 * S22.12 — the terminal-answer placement walk, shared by the recheck route (`recheck.ts`,
 * which resolves the placement before staging its run) and the S32.10 recovery seam
 * (`recovery-seam.ts`, which resolves it before assembling the level-1 ladder). Extracted
 * verbatim from `recheck.ts` so the two call sites cannot drift on the walk (S32.10:
 * "factor a shared helper, don't duplicate").
 */

/** The placement (and its offer's `capturedAt`) matched from the terminal answer, S22.12. */
export interface TerminalPlacement {
  readonly placement: Placement;
  readonly capturedAt: string;
}

/**
 * S22.12 — find the `placement` whose `placementKey` matches, walking the terminal
 * `SearchResult`'s ranked answer (CONFIDENT `primary`, HEDGED `alternatives`, EMPTY none).
 * The placement is re-validated against `PlacementSchema` here (Zod at every boundary);
 * `capturedAt` is the matched offer's freshness stamp (`lastKnown.capturedAt`). `null`
 * means the terminal answer carries no such placement — unreachable for a nonce that
 * passed `resultVersion` binding (a placement nonce only exists for a revealed placement).
 */
export function findTerminalPlacement(
  payload: unknown,
  placementKey: string,
  showtimeId: string,
): TerminalPlacement | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const answer = (payload as { answer?: unknown }).answer;
  const recommendations: readonly { placement: unknown; offers: readonly unknown[] }[] =
    collectRecommendations(answer);
  for (const recommendation of recommendations) {
    let placement: Placement;
    try {
      placement = PlacementSchema.parse(recommendation.placement);
    } catch {
      continue;
    }
    if (placement.placementKey !== placementKey) {
      continue;
    }
    let capturedAt: string | null = null;
    for (const offer of recommendation.offers) {
      if (typeof offer !== "object" || offer === null) {
        continue;
      }
      const candidate = offer as { showtimeId?: unknown; capturedAt?: unknown };
      if (candidate.showtimeId === showtimeId && typeof candidate.capturedAt === "string") {
        capturedAt = candidate.capturedAt;
        break;
      }
    }
    if (capturedAt === null) {
      return null;
    }
    return { placement, capturedAt };
  }
  return null;
}

/** Collect every recommendation (placement + its offers) reachable from a ranked answer. */
function collectRecommendations(
  answer: unknown,
): readonly { placement: unknown; offers: readonly unknown[] }[] {
  if (typeof answer !== "object" || answer === null) {
    return [];
  }
  const record = answer as {
    mode?: unknown;
    primary?: unknown;
    alternatives?: readonly unknown[];
  };
  if (record.mode === "CONFIDENT" && record.primary !== undefined) {
    return [recommendationShape(record.primary)];
  }
  if (record.mode === "HEDGED" && Array.isArray(record.alternatives)) {
    return record.alternatives.map(recommendationShape);
  }
  return [];
}

function recommendationShape(recommendation: unknown): {
  placement: unknown;
  offers: readonly unknown[];
} {
  const record =
    typeof recommendation === "object" && recommendation !== null
      ? (recommendation as { placement?: unknown; showtimes?: readonly unknown[] })
      : {};
  return {
    placement: record.placement,
    offers: Array.isArray(record.showtimes) ? record.showtimes : [],
  };
}
