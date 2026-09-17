/**
 * EventSource / lastEventId cursor helper for UI9 SSE replay tests.
 * Pattern `^[1-9][0-9]*-0$` per apps/server/src/streaming/cursor.ts:15.
 */
export const LAST_EVENT_ID_PATTERN = /^[1-9][0-9]*-0$/;

export function entryIdForSeq(seq: number | bigint): string {
  return `${seq}-0`;
}

export function cursorAfterSeq(lastEventId: string | undefined): bigint {
  if (lastEventId === undefined) return 0n;
  return BigInt(lastEventId.slice(0, lastEventId.length - 2));
}

export function isValidLastEventId(value: string): boolean {
  return LAST_EVENT_ID_PATTERN.test(value);
}

/** Build a tracked SSE envelope shaped like apps/server/src/streaming/reader.ts. */
export function makeSseEnvelope(seq: number, data: unknown): { id: string; data: unknown } {
  return { id: entryIdForSeq(seq), data };
}

/** Deduplicate envelopes by `id`/`seq` — mimics UI3's idempotent apply. */
export function dedupeById(envelopes: Array<{ id: string }>): Array<{ id: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string }> = [];
  for (const e of envelopes) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}
