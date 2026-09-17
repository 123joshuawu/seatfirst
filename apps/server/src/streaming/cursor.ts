/**
 * Tracked-reconnect cursor management for `searches.onProgress` (architecture §6, tRPC's
 * tracked-reconnect: `docs/seatfirst-architecture.md:271`).
 *
 * The cursor a client sends back is the Redis Stream entry ID of the last event it saw.
 * The projector writes `search_event.seq = n` as entry ID `${n}-0`
 * (`docs/seatfirst-architecture.md:187`), and `search_event.seq` is per-search monotonic
 * and GAPLESS (`packages/durability/migrations/001_schema.sql:153`), so the exact
 * conforming form is `<digits>-0` with no leading zeros — the same rendering Postgres
 * gives a `bigint`. Anything else is rejected at the tRPC boundary (BAD_REQUEST), never
 * silently treated as "start from the beginning".
 */

/** Exact `${seq}-0` form: a positive integer seq (no leading zeros) followed by `-0`. */
export const LAST_EVENT_ID_PATTERN: RegExp = /^[1-9][0-9]*-0$/;

/**
 * The seq of the cursor event: delivery resumes from the event AFTER it (S12.3). Omission
 * means "start from the beginning", i.e. everything with `seq >= 1`.
 *
 * Callers must Zod-validate `lastEventId` against {@link LAST_EVENT_ID_PATTERN} first; this
 * function is only given conforming values.
 */
export function cursorAfterSeq(lastEventId: string | undefined): bigint {
  if (lastEventId === undefined) return 0n;
  return BigInt(lastEventId.slice(0, lastEventId.length - 2));
}

/** The Redis Stream entry ID the projector gives `search_event.seq` (§4.1). */
export function entryIdForSeq(seq: bigint): string {
  return `${seq}-0`;
}

/**
 * Parse the projector's entry ID back to a seq. Returns `null` for anything not shaped
 * like an entry ID; the reader treats a malformed stream entry as "trust the table
 * instead" rather than guessing.
 */
export function seqOfEntryId(entryId: string): bigint | null {
  const match = /^([0-9]+)-[0-9]+$/.exec(entryId);
  if (match === null || match[1] === undefined) return null;
  return BigInt(match[1]);
}
