import { z } from "zod";

import { CancelSearchResponseSchema, SearchStatusSchema } from "@seatfirst/core";
import type { CancelSearchResponse } from "@seatfirst/core";
import {
  deriveRankedAnswer,
  stageSearchCancellation,
  withTransaction,
} from "@seatfirst/durability";
import type { AnswerEvidence } from "@seatfirst/durability";

import { assertCallerOwnsSearch } from "../../streaming/ownership.js";
import {
  isTerminalStatus,
  readCancelFrozenFacts,
  readSearchStatus,
} from "../../streaming/queries.js";
import { t } from "./create.js";

/**
 * `searches.cancel` — the explicit user-facing cancel (S23, gate 18, ADR 0013 + ADR 0018).
 * Withdraws the caller's interest and, because the caller is the search's only interest
 * holder in v1 (S23.2), terminates the search with a real, distinct `CANCELLED` status,
 * releasing its admission reservation and cancelling its live work in one transaction
 * (S23.3). Idempotent: cancel of an already-terminal search is a no-op success echoing the
 * existing status with zero writes (S23.5, ADR 0013 item 4).
 *
 * Mounted on `create`'s `t` (SearchCreateContext) — it consumes only `ctx.db` and
 * `ctx.sessionId` (S23.7). No bespoke registration: it is a mutation that commits before
 * responding, so the default 200 carries the committed status.
 */

export const cancelInput = z.object({
  searchId: z.string().regex(/^srch_.+$/, "searchId must be a `srch_`-prefixed opaque identifier"),
});
export type CancelInput = z.infer<typeof cancelInput>;

/** S23.1 — ownership before any read or write; a missing/foreign row is UNAUTHORIZED. */
const ownership = t.middleware(async ({ ctx, input, next }) => {
  const { searchId } = input as CancelInput;
  await assertCallerOwnsSearch(ctx.db, searchId, ctx.sessionId);
  return next();
});

export const cancel = t.procedure
  .input(cancelInput)
  .output(CancelSearchResponseSchema)
  .use(ownership)
  .mutation(async ({ input, ctx }): Promise<CancelSearchResponse> => {
    const { searchId } = input;

    // S23.5 — idempotency: an already-terminal search (COMPLETE/PARTIAL/HALTED/CANCELLED)
    // is a no-op success echoing its existing status, with zero writes and no transaction.
    const status = await readSearchStatus(ctx.db, searchId);
    if (status !== null && isTerminalStatus(status)) {
      return { searchId, status: SearchStatusSchema.parse(status) };
    }

    // The frozen pre-cancel facts (S23.3 step (2); ADR 0018): read once, before the
    // transaction, so the reveal is derived from the state as it stood at cancel time —
    // never a newly-computed or fabricated answer.
    const frozen = await readCancelFrozenFacts(ctx.db, searchId);

    const state = await withTransaction(ctx.db, (tx) =>
      stageSearchCancellation(tx, searchId, {
        resultPayload: () => {
          // S60 — frozen evidence is the persisted `assembleAnswerEvidence` output
          // (ADR 0066 §2): `search_aggregate.evidence` already has the
          // `{ exact, hedged }` shape `deriveRankedAnswer` consumes (its extra
          // `hitPlacementKeys` entries are opaque to the lifecycle matrix), so it
          // is used directly. No aggregate row yet — or a null-evidence admission
          // seed — means no partial state existed, so the zero-evidence value
          // applies (it yields EMPTY:HALTED for a zero-fetch cancel,
          // lifecycle.ts:146).
          const stored = frozen.aggregate?.evidence ?? null;
          let frozenEvidence: AnswerEvidence;
          if (stored === null) {
            frozenEvidence = { exact: null, hedged: null };
          } else if (typeof stored === "string") {
            frozenEvidence = JSON.parse(stored) as AnswerEvidence;
          } else {
            frozenEvidence = stored as AnswerEvidence;
          }
          // S60.6 — revision-skew reconciliation (ADR 0066 §3): when
          // `aggRequestedRev > aggregate.revision`, new fetches were accepted
          // after the last materialized aggregate, so the frozen evidence is stale
          // relative to `acceptedFetches`/`freeSeats`. Non-null hedged evidence
          // still reveals HEDGED correctly; otherwise the stale `freeSeats > 0`
          // count would misreport EMPTY:NO_SHAPE_MATCH, so mask it to 0 and let
          // `deriveRankedAnswer` evaluate EMPTY:HALTED instead.
          const skewed = frozen.aggRequestedRev > (frozen.aggregate?.revision ?? 0);
          const freeSeats = skewed && frozenEvidence.hedged === null ? 0 : frozen.freeSeats;
          const answer = deriveRankedAnswer(
            {
              status: "CANCELLED",
              terminalCause: null,
              scheduleOutcome: null,
              acceptedFetches: frozen.acceptedFetches,
              freeSeats,
            },
            frozenEvidence,
          );
          if (answer === null) {
            throw new Error("cancel derived no terminal answer for a CANCELLED search");
          }
          return { status: "CANCELLED", cause: null, answer };
        },
      }),
    );

    if (state === null) {
      // A concurrent terminalization won the race: the S23.4 fence returned zero rows
      // (status no longer PENDING_SCHEDULE/RUNNING), so this cancel wrote nothing. Echo
      // the now-terminal status.
      const current = await readSearchStatus(ctx.db, searchId);
      return { searchId, status: SearchStatusSchema.parse(current) };
    }
    return { searchId, status: "CANCELLED" };
  });
