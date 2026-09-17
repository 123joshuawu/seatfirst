import type { Pool } from "pg";

import { assembleRecoveryLadder, createResultContractSchemas } from "@seatfirst/core";

import { readLatestSearchResultVersion } from "../../streaming/queries.js";
import type { RecoverySeam } from "./recheckContext.js";
import { findTerminalPlacement } from "./terminal-placement.js";

/**
 * S32.10/S32.17 — the GONE recovery-ladder seam (Phase 2 + Phase 3). Replaces the
 * `UNLANDED_RECHECK_RECOVERY` loud-fail placeholder that S22.12 wired until `W` was
 * decided: it reads the search's terminal `search_result_version.payload`, validates it
 * against the S27 writer's own contract (`SearchResultSchema` — Zod at the boundary), walks
 * the terminal answer to the gone placement (S22's shared `findTerminalPlacement`), and
 * hands the gone group to the pure `assembleRecoveryLadder` (S32.17's strict first-success
 * `L1 → L2 → L3 → L4` degradation, ADR 0026/ADR 0027).
 *
 * Every failure path throws with a specific message — never a fabricated fallback ladder
 * and never an empty `[]`. A `GONE` verdict whose payload carries no equivalent at any
 * level is contract-invalid (`RecheckResultSchema.GONE` requires `recovery` min-1), so the
 * only honest posture left when all four rungs fail is to fail loudly (S32 finding F5).
 *
 * `rowWeight` is the `W` of `docs/seatfirst-architecture.md:395`, injected with no default
 * (gate 14; ADR 0024 amendment pins the production value to 2). `providerHostAllowlists`
 * is the same ops config the reveal validator consumes (`streaming/context.ts`).
 */
export function createRecoverySeam(deps: {
  readonly db: Pool;
  readonly rowWeight: number;
  readonly providerHostAllowlists: Record<string, string[]>;
}): RecoverySeam {
  const { db, rowWeight, providerHostAllowlists } = deps;
  const schemas = createResultContractSchemas({ providerHostAllowlists });

  return async ({ searchId, showtimeId, placementKey }) => {
    const terminal = await readLatestSearchResultVersion(db, searchId);
    if (terminal === null) {
      throw new Error(
        `recovery seam: search ${searchId} has no terminal search_result_version — ` +
          "a GONE recovery ladder cannot be assembled from a missing terminal payload",
      );
    }

    const parsed = schemas.SearchResultSchema.parse(terminal.payload);

    const gonePlacement = findTerminalPlacement(parsed, placementKey, showtimeId);
    if (gonePlacement === null) {
      throw new Error(
        `recovery seam: terminal answer has no placement matching placementKey ` +
          `${placementKey} at showtime ${showtimeId} — cannot locate the gone placement ` +
          "to ladder from",
      );
    }

    const group = parsed.groups.find(
      (candidate) => candidate.layoutId === gonePlacement.placement.layoutId,
    );
    if (group === undefined) {
      throw new Error(
        `recovery seam: terminal result groups have no group for layoutId ` +
          `${gonePlacement.placement.layoutId} — cannot assemble a level-1 recovery without ` +
          "the gone placement's group evidence",
      );
    }

    const option = assembleRecoveryLadder({
      gonePlacement: gonePlacement.placement,
      goneShowtimeId: showtimeId,
      group,
      rowWeight,
    });
    if (option === null) {
      throw new Error(
        `recovery seam: no recovery option survives at any level (1-4) for placementKey ` +
          `${placementKey} at showtime ${showtimeId} — a GONE result requires a non-empty ` +
          "recovery ladder (RecoveryOptionSchema); all four rungs failed (S32 finding F5)",
      );
    }

    return [option];
  };
}
