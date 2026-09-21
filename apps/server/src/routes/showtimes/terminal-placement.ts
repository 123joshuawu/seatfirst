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
 * S22.12 — find the `placement` whose `placementKey` matches, walking first the
 * terminal `SearchResult`'s ranked answer (CONFIDENT `primary`, HEDGED `alternatives`,
 * EMPTY none) and then, as a fallback, `groups[].groupHits[]` entries carrying a
 * persisted full `placement`. The fallback covers nonces issued via `issueHitNonces`
 * (ADR 0017 amendment) for hits outside the ranked answer — every resolved hit row
 * gets a handoff nonce, not just the primary's showtimes, so a groups-only match is
 * a legitimate recheck, not an unreachable case.
 * The placement is re-validated against `PlacementSchema` here (Zod at every boundary);
 * `capturedAt` is the matched offer's freshness stamp (`lastKnown.capturedAt`) on the
 * answer path, or the matched resolved group showtime's `capturedAt` on the groups
 * fallback path. `null` means neither the terminal answer nor any group hit carries
 * such a placement.
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
  // This fix — groups fallback for hits outside the ranked answer. A nonce minted by
  // `issueHitNonces` (ADR 0017 amendment) exists for every resolved `groupHits[]`
  // entry, not just the ones selected into `answer`, so a placementKey/showtimeId
  // pair that never appears in `primary`/`alternatives` is still legitimate. Each
  // such hit now persists its full `placement` alongside `placementKey`; resolve it
  // here by matching the key, then confirming the showtime is one the hit covers
  // (`hit.showtimeIndices` → `group.showtimes[index]`) and is resolved (`capturedAt`
  // present). The hit placement is re-validated via `PlacementSchema.parse`, exactly
  // like the answer-walk path above (Zod at every boundary).
  const groups = (payload as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) {
    return null;
  }
  for (const group of groups) {
    if (typeof group !== "object" || group === null) {
      continue;
    }
    const record = group as { showtimes?: unknown; groupHits?: unknown };
    if (!Array.isArray(record.showtimes) || !Array.isArray(record.groupHits)) {
      continue;
    }
    for (const hit of record.groupHits) {
      if (typeof hit !== "object" || hit === null) {
        continue;
      }
      const candidate = hit as {
        placementKey?: unknown;
        placement?: unknown;
        showtimeIndices?: unknown;
      };
      if (candidate.placementKey !== placementKey || candidate.placement == null) {
        continue;
      }
      let placement: Placement;
      try {
        placement = PlacementSchema.parse(candidate.placement);
      } catch {
        continue;
      }
      if (!Array.isArray(candidate.showtimeIndices)) {
        continue;
      }
      for (const index of candidate.showtimeIndices) {
        if (typeof index !== "number") {
          continue;
        }
        const showtime = (record.showtimes as readonly unknown[])[index];
        if (typeof showtime !== "object" || showtime === null) {
          continue;
        }
        const matched = showtime as {
          showtimeId?: unknown;
          capturedAt?: unknown;
        };
        if (matched.showtimeId === showtimeId && typeof matched.capturedAt === "string") {
          return { placement, capturedAt: matched.capturedAt };
        }
      }
    }
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
