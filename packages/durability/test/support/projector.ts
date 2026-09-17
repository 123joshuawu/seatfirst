import * as B from "../../src/boundaries.js";

import type { SqlClient } from "./pg.js";
import type { RedisClient } from "./redis.js";

export interface ProjectableEvent {
  readonly seq: string;
  readonly type: string;
  readonly payload: unknown;
}

/** Project a previously read event, including crash retry and concurrent-winner handling. */
export async function projectEvent(
  db: SqlClient,
  redis: RedisClient,
  searchId: string,
  event: ProjectableEvent,
): Promise<number> {
  const seq = Number(event.seq);
  const entryId = `${seq}-0`;
  const key = `search:${searchId}`;
  try {
    await redis.xadd(key, entryId, { type: event.type, payload: JSON.stringify(event.payload) });
  } catch (error) {
    const existing = await redis.xrange(key, entryId, entryId);
    if (existing.length === 0) {
      throw new Error(
        `event ${entryId} is an interior stream gap; stop and rebuild rather than skipping it`,
        { cause: error },
      );
    }
  }

  const advanced = await db.query(B.B10_ADVANCE_EVENT_WATERMARK.text, [searchId, seq]);
  if (advanced.rows.length === 0) {
    const current = await db.query(B.B10_READ_EVENT_WATERMARK.text, [searchId]);
    const projectedThrough = Number(current.rows[0]?.projected_through ?? -1);
    if (projectedThrough < seq) {
      throw new Error(
        `event ${entryId} exists but the contiguous watermark is only ${projectedThrough}`,
      );
    }
  }
  return seq;
}

/** Project exactly one event from the current durable watermark. */
export async function projectNextEvent(
  db: SqlClient,
  redis: RedisClient,
  searchId: string,
): Promise<number | null> {
  const pending = await db.query(B.B10_UNPROJECTED_EVENTS.text, [searchId]);
  const event = pending.rows[0] as ProjectableEvent | undefined;
  return event ? projectEvent(db, redis, searchId, event) : null;
}

/** Replace a stream to repair an interior gap; replay into the higher-ID live key is invalid. */
export async function rebuildEventStream(
  db: SqlClient,
  redis: RedisClient,
  searchId: string,
  rebuildId: string,
): Promise<number> {
  const liveKey = `search:${searchId}`;
  const replacementKey = `${liveKey}:r${rebuildId}`;
  await redis.command("DEL", replacementKey);

  // A real worker holds the per-search rebuild lease while this reset is in progress.
  // The durability package owns a search-scoped reset for interior repair. The global
  // full-loss reset must never be used here: unrelated live streams remain valid.
  const reset = await db.query(B.B10_RESET_EVENT_WATERMARK_FOR_SEARCH.text, [searchId]);
  if (reset.rows.length !== 1) {
    throw new Error(`search ${searchId} is not eligible for an interior-gap rebuild`);
  }
  const events = await db.query(B.B10_UNPROJECTED_EVENTS.text, [searchId]);
  for (const event of events.rows as { seq: string; type: string; payload: unknown }[]) {
    await redis.xadd(replacementKey, `${event.seq}-0`, {
      type: event.type,
      payload: JSON.stringify(event.payload),
    });
  }

  await redis.rename(replacementKey, liveKey);
  for (const event of events.rows as { seq: string }[]) {
    const advanced = await db.query(B.B10_ADVANCE_EVENT_WATERMARK.text, [searchId, event.seq]);
    if (advanced.rows.length !== 1) {
      throw new Error(`replacement stream is complete but watermark stopped at seq ${event.seq}`);
    }
  }
  return events.rows.length;
}
