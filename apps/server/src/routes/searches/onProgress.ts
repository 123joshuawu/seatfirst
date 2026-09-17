import { initTRPC, tracked, TRPCError, type TRPCSubscriptionProcedure } from "@trpc/server";
import { z } from "zod";

import { issueRecheckNonces } from "../../session/nonce-issuance.js";
import type { SearchStreamContext } from "../../streaming/context.js";
import { cursorAfterSeq, LAST_EVENT_ID_PATTERN } from "../../streaming/cursor.js";
import { assertCallerOwnsSearch } from "../../streaming/ownership.js";
import {
  isTerminalStatus,
  readEventsAfter,
  readLatestSearchResultVersion,
  readSearchStatus,
} from "../../streaming/queries.js";
import type { ProgressEvent } from "../../streaming/reader.js";
import { SEARCH_TERMINAL_EVENT_TYPE, streamSearchEvents } from "../../streaming/reader.js";
import { mintSessionId } from "../session/bootstrap.js";
/**
 * Portable aliases for the tRPC tracked envelope/data — structurally `[id, data, symbol]`
 * and `{ id, data }` but avoids referencing the internal `TrackedData` type that is
 * not portable for declaration emit (TS2883). Runtime still uses `tracked()` from
 * `@trpc/server`; these types are only for the subscription's declared yield/output
 * so the emitted `dist/*.d.ts` references local, portable types instead of
 * `unstable-core-do-not-import`.
 */
type PortableTrackedEnvelope<T> = [string, T, symbol];
type PortableTrackedData<T> = { id: string; data: T };

/**
 * `searches.onProgress` — the subscription that streams a search's progress events over
 * SSE (architecture §6: `trpc.searches.onProgress ({ searchId, lastEventId?: string })`,
 * `docs/seatfirst-architecture.md:271`). Pure transport: it reads `search_event` rows and
 * their Redis Stream projection and delivers them as `tracked(id, event)` tuples — it
 * never writes an event (S12.8; events are produced by the durability tier's acceptance
 * transactions and the sweeper).
 */

export const t = initTRPC.context<SearchStreamContext>().create();

/**
 * Zod boundary validation (architecture §12: "Zod validation at every boundary").
 *
 * - `searchId`: the namespaced opaque id, `srch_` + 128-bit random
 *   (`docs/seatfirst-architecture.md:682`). Only the namespace is checkable at the
 *   boundary — the random part is opaque by design.
 * - `lastEventId`: optional tracked-reconnect cursor. MUST be the exact `${seq}-0`
 *   Redis Stream entry ID form (`docs/seatfirst-architecture.md:187`); a non-conforming
 *   value is rejected with BAD_REQUEST, never silently treated as "start from the
 *   beginning" (S12.3).
 */
export const onProgressInput = z.object({
  searchId: z.string().regex(/^srch_.+$/, "searchId must be a `srch_`-prefixed opaque identifier"),
  lastEventId: z
    .string()
    .regex(LAST_EVENT_ID_PATTERN, "lastEventId must match the `${seq}-0` tracked-event form")
    .optional(),
});

export type OnProgressInput = z.infer<typeof onProgressInput>;

/**
 * Mandatory pre-stream ownership check (S12.2, architecture §6.7): the caller's session
 * must own the search BEFORE anything is delivered. Runs as middleware — before the
 * subscription resolver — so a mismatch is a UNAUTHORIZED error raised before the stream
 * opens, not the first event of an open stream.
 */
const ownership = t.middleware(async ({ ctx, input, next }) => {
  const { searchId } = input as OnProgressInput;
  await assertCallerOwnsSearch(ctx.db, searchId, ctx.sessionId);
  return next();
});

/**
 * S34.6 — serve-time nonce issuance for the terminal reveal. The reader is pure transport
 * (S12.8) and stays byte-identical; this transform runs one layer up in route composition.
 * For the terminal event it parses the reveal payload; an EMPTY answer (no offers) passes
 * through verbatim, while a CONFIDENT/HEDGED answer reads the just-committed `resultVersion`
 * (same transaction as the terminal row — S6U3.3(a)) and signs one nonce per offer.
 * Non-terminal envelopes pass through verbatim.
 */
async function* injectTerminalNonces(
  source: AsyncGenerator<PortableTrackedEnvelope<ProgressEvent>, void, void>,
  ctx: SearchStreamContext,
  searchId: string,
): AsyncGenerator<PortableTrackedEnvelope<ProgressEvent>, void, void> {
  for await (const envelope of source) {
    const data = envelope[1];
    if (data.type !== SEARCH_TERMINAL_EVENT_TYPE) {
      yield envelope;
      continue;
    }
    const payload = ctx.revealPayloadSchema.parse(data.payload);
    // EMPTY carries no offers, so there is nothing to sign — yield verbatim. This keeps
    // EMPTY-reveal delivery byte-identical (the S6U3 monotonicity property) and avoids a
    // result-version read that a raw-seeded EMPTY reveal (no result row) never needs.
    if (payload.answer.mode === "EMPTY") {
      yield envelope;
      continue;
    }
    const sessionId = ctx.sessionId;
    if (sessionId === undefined) {
      // Unreachable: `ownership` throws for an undefined/foreign caller before this runs.
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const version = await readLatestSearchResultVersion(ctx.db, searchId);
    if (version === null) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `terminal reveal for ${searchId} has no search_result_version row (gate-9 invariant broken)`,
      });
    }
    yield tracked(envelope[0], {
      ...data,
      payload: {
        ...payload,
        answer: issueRecheckNonces(payload.answer, {
          sessionId,
          searchId,
          resultVersion: version.version,
          nonceSecret: ctx.nonceSecret,
          mintId: mintSessionId,
          now: () => Date.now(),
        }),
      },
    });
  }
}

export const onProgress = t.procedure
  .input(onProgressInput)
  .use(ownership)
  .subscription(async function* ({
    input,
    ctx,
    signal,
  }): AsyncGenerator<PortableTrackedEnvelope<ProgressEvent>, void, void> {
    const reader = ctx.openStreamReader();
    try {
      // Already-terminal short-circuit (S6U3.6): status and the terminal row commit in
      // one transaction, so a terminal status means the reveal is already in the table.
      // The reader closes immediately — a cursor-less reconnect replays nothing, and a
      // cursor past the reveal has nothing left to wait for (no keepalive loop).
      const status = await readSearchStatus(ctx.db, input.searchId);
      yield* injectTerminalNonces(
        streamSearchEvents({
          searchId: input.searchId,
          afterSeq: cursorAfterSeq(input.lastEventId),
          readEventsAfter: (afterSeq) => readEventsAfter(ctx.db, input.searchId, afterSeq),
          reader,
          blockTimeoutMs: ctx.blockTimeoutMs,
          keepAlive: ctx.keepAlive,
          signal: signal ?? new AbortController().signal,
          revealPayloadSchema: ctx.revealPayloadSchema,
          alreadyTerminal: isTerminalStatus(status),
        }),
        ctx,
        input.searchId,
      );
    } finally {
      // Clean release on terminal close AND on client disconnect (S12.7): the abort
      // path has already closed it (unblocking the XREAD), and close is idempotent.
      reader.close();
    }
  }) as unknown as TRPCSubscriptionProcedure<{
  input: OnProgressInput;
  output: AsyncIterable<PortableTrackedData<ProgressEvent>, void, void>;
  meta: object;
}>;
