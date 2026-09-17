import { tracked, TRPCError } from "@trpc/server";
import type { TrackedEnvelope } from "@trpc/server";

import type { RevealPayload } from "@seatfirst/core";
import type { z } from "zod";

import { entryIdForSeq, seqOfEntryId } from "./cursor.js";
import type { EventRow } from "./queries.js";
import type { StreamRedisReader } from "./redisStreams.js";
import { searchStreamKey } from "./redisStreams.js";
/**
 * The event type the B8 terminalization composition writes when a search terminalizes
 * (`packages/durability/src/transactions.ts:284-289`: type `"SEARCH_TERMINAL"`). The
 * payload is now the widened `{ status, cause, answer }` — the mid-stream reveal (ADR
 * 0012): the classified `RankedAnswer` travels on the terminal row only, never earlier
 * (S6U3.1/S6U3.8). Terminal events are regular `search_event` rows like any other
 * (`docs/seatfirst-architecture.md:187`); the subscription yields the row and closes.
 */
export const SEARCH_TERMINAL_EVENT_TYPE = "SEARCH_TERMINAL";

/** A domain event as delivered to subscribers: the `search_event` row, seq as a number. */
export interface ProgressEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface StreamSearchEventsOptions {
  readonly searchId: string;
  /** Deliver only events with `seq > afterSeq` — the tracked-reconnect cursor (S12.3). */
  readonly afterSeq: bigint;
  /** Authoritative catch-up source: `search_event` rows with `seq > given`. */
  readonly readEventsAfter: (afterSeq: bigint) => Promise<EventRow[]>;
  readonly reader: StreamRedisReader;
  /** `XREAD BLOCK` window; injected by the caller, no default (gate 14). */
  readonly blockTimeoutMs: number;
  /** Transport-level keepalive hook, invoked when a block window elapses with no events. */
  readonly keepAlive: () => void;
  readonly signal: AbortSignal;
  /**
   * The built `RevealPayloadSchema` every terminal payload must parse against before
   * yielding — the fail-closed delivery-side gate (S6U3.4). Built once per server in
   * `createContextFactory`, injected via `ctx` (S6U3.5).
   */
  readonly revealPayloadSchema: z.ZodType<RevealPayload>;
  /**
   * The S6U3.6 already-terminal fact (from `readSearchStatus`), for a cursor-less
   * reconnect: a subscriber who resumes after terminalization is owed no pre-terminal
   * replay, so the stream closes immediately instead of entering the loop (which would
   * otherwise re-deliver the table's full history or keepalive forever on a cursor past
   * the terminal row).
   */
  readonly alreadyTerminal: boolean;
}
function parseStreamPayload(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The delivery-side half of the reveal contract (S6U3.4). Phase B (stream) is untrusted
 * — a projector is just another writer — so both yield sites validate fail-closed:
 *
 * 1. Every terminal row's payload must parse against the built `RevealPayloadSchema`
 *    (S6U3.0) — including the answer-less payloads old terminalizations wrote. Failure
 *    is a delivery failure: that row is evidence the stream already errored for this
 *    search, and fabricating a placeholder answer would be exactly what ADR 0012
 *    forbids.
 * 2. A non-terminal row must NOT carry an `answer` key — the reveal is reserved for the
 *    terminal row (S6U3.8). The table's own invariant admits no such row, so an injected
 *    key means a corrupted projection; fail closed there too.
 *
 * The error is a NON-retryable `TRPCError`: tRPC's client treats INTERNAL_SERVER_ERROR
 * frames as retryable connection errors and would silently re-subscribe in a loop. This
 * violation is deterministic — the persisted row is corrupt, a retry changes nothing —
 * so the frame must terminate the subscription (PRECONDITION_FAILED, a self-decided
 * finding: the spec pins "serialized error", not a code).
 */
class RevealContractError extends TRPCError {
  constructor(message: string) {
    super({ code: "PRECONDITION_FAILED", message });
  }
}

function assertRevealContract(
  type: string,
  payload: unknown,
  revealPayloadSchema: z.ZodType<RevealPayload>,
): void {
  const hasAnswer = typeof payload === "object" && payload !== null && "answer" in payload;
  if (type === SEARCH_TERMINAL_EVENT_TYPE) {
    const parsed = revealPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new RevealContractError(
        `SEARCH_TERMINAL payload failed reveal validation: ${parsed.error.message}`,
      );
    }
    return;
  }
  if (hasAnswer) {
    throw new RevealContractError(`non-terminal ${type} row carries an answer key`);
  }
}

/**
 * The delivery loop behind `searches.onProgress`. The `search_event` table is truth and
 * history; the Redis Stream is the accelerator (architecture §5, §4.1:187). Each cycle:
 *
 * 1. Serve everything the table has beyond the cursor (phase A). This is also the
 *    "stream empty or behind" fallback (S12.4): a lagging projector costs nothing, the
 *    rows are read straight from Postgres — and it is what lets a terminal search close
 *    within one block window even if its terminal row was never projected.
 * 2. If the table had nothing new, XREAD BLOCK from the last delivered entry ID. Never
 *    `$` — that would lose events committed between search creation and subscription.
 * 3. On timeout: keepalive, then re-check the table (an event may have committed without
 *    being projected).
 * 4. Already-terminal searches (S6U3.6) still run phase A once — a cursor before the
 *    reveal gets it from the table — but never enter the XREAD loop when the table has
 *    nothing left: a stale reconnect closes instead of keepaliving forever.
 *
 * Stream entries are merged by seq and deduplicated on it: a lagged projection re-appends
 * nothing new, and a seq ahead of the cursor means the table knows more than the stream,
 * so phase A takes over. An unreadable entry leaves the cursor where it is so the table
 * serves that seq. Yielding the terminal row closes the generator from the server side
 * (S12.7).
 *
 * Every row is checked against the reveal contract before it yields (S6U3.4/S6U3.8):
 * terminal payloads must parse as the widened `RevealPayload` (answer included) and no
 * earlier row may carry an `answer` key. A violation fails the delivery — fail closed.
 */
export async function* streamSearchEvents(
  opts: StreamSearchEventsOptions,
): AsyncGenerator<TrackedEnvelope<ProgressEvent>, void, void> {
  const { searchId, blockTimeoutMs, keepAlive, reader, signal, revealPayloadSchema } = opts;
  const key = searchStreamKey(searchId);
  let nextSeq = opts.afterSeq + 1n;

  // Already-terminal searches still run phase A once (S6U3.6): status and the terminal
  // row commit in one transaction and status never moves backward, so a cursor before
  // the reveal is served it by the table catch-up (the in-loop return, S12.7). The
  // XREAD-entry skip below covers the cursor-at/past case.

  // Client disconnect (tRPC SSE abort) closes the dedicated reader connection, which
  // unblocks the in-flight XREAD: the rejected promise unwinds the generator, whose
  // caller's `finally` releases the connection (S12.7).
  const onAbort = (): void => {
    reader.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      let advanced = false;
      for (const row of await opts.readEventsAfter(nextSeq - 1n)) {
        assertRevealContract(row.type, row.payload, revealPayloadSchema);
        yield tracked(`${row.seq}-0`, {
          seq: Number(row.seq),
          type: row.type,
          payload: row.payload,
        });
        nextSeq = BigInt(row.seq) + 1n;
        advanced = true;
        if (row.type === SEARCH_TERMINAL_EVENT_TYPE) return;
      }
      if (advanced) continue;
      // Already-terminal and nothing left in the table: the cursor is at or past the
      // reveal — close instead of entering the XREAD loop (no keepalive ping-pong).
      if (opts.alreadyTerminal) return;
      const entries = await reader.readBlocked(key, entryIdForSeq(nextSeq - 1n), blockTimeoutMs);
      if (entries === null) {
        keepAlive();
        continue;
      }
      for (const entry of entries) {
        const seq = seqOfEntryId(entry.id);
        if (seq === null) continue;
        if (seq < nextSeq) continue; // dedupe: a lagged projection re-appended nothing new
        if (seq > nextSeq) break; // stream ahead of delivery: the table has the gap
        const type = entry.fields["type"];
        const payload = parseStreamPayload(entry.fields["payload"]);
        if (type === undefined || payload === undefined) {
          // Unreadable stream entry: leave the cursor put so the next phase-A pass
          // serves this seq from the table instead of skipping it.
          break;
        }
        assertRevealContract(type, payload, revealPayloadSchema);
        yield tracked(entry.id, { seq: Number(seq), type, payload });
        nextSeq += 1n;
        if (type === SEARCH_TERMINAL_EVENT_TYPE) return;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
