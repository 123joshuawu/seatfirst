import IORedis from "ioredis";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

/**
 * The Redis Stream side of `searches.onProgress`: per-subscriber XREAD against the
 * search's stream projection.
 *
 * Architecture (`docs/seatfirst-architecture.md:94,148,187`): the stream key
 * `search:{searchId}` is a PROJECTION of the `search_event` table, written by the
 * projector (B10/S10) with entry ID `${seq}-0` and value fields `{ type, payload }`
 * where `payload` is a JSON string. Reads use XREAD — NOT XREADGROUP: consumer groups
 * would distribute one search's entries across one group member each, splitting events
 * across subscribers; per-subscriber replay requires plain XREAD. This module only ever
 * reads the stream — the transport never writes it.
 *
 * `ioredis` is CommonJS: the default import is the module namespace, so the client is
 * `IORedis.Redis`.
 */

export interface StreamEntry {
  readonly id: string;
  readonly fields: Record<string, string>;
}

export interface StreamRedisReader {
  /**
   * `XREAD BLOCK` from the entry strictly after `afterId`. Returns `null` when the block
   * window elapsed with no new entries (the caller sends a keepalive then); entries are
   * in id order. `afterId` is the projector's `${seq}-0` entry ID — never `$`, which
   * would drop events emitted between search creation and subscription.
   */
  readBlocked(key: string, afterId: string, blockMs: number): Promise<StreamEntry[] | null>;
  /** Releases the connection. Aborts an in-flight blocked read (its promise rejects). */
  close(): void;
}

export function searchStreamKey(searchId: string): string {
  return `search:${searchId}`;
}

/**
 * Opens a DEDICATED connection for one subscription. The blocked XREAD owns the
 * connection for the whole block window, so a shared client would stall every other
 * command behind it; a per-subscription client is also what makes clean release on
 * client disconnect a `close()` instead of a protocol-level abort.
 */
export function openSearchStreamReader(url: string, logger?: SeatfirstLogger): StreamRedisReader {
  const client = new IORedis.Redis(url, { lazyConnect: true });
  let connectPromise: Promise<void> | null = null;

  // O11.8 — log connection-level failures (socket drops, reconnect aborts) without
  // touching the fail-open transport behavior: a dead reader surfaces to the subscriber
  // exactly as before. Per-read failures are NOT logged here (per-message noise); they
  // reject `readBlocked` and are logged once by the SSE stream-loop catch.
  if (logger !== undefined) {
    client.on("error", (error: Error) => {
      logger.warn({ error }, "search stream reader connection error");
    });
  }

  const ensureConnected = (): Promise<void> => {
    connectPromise ??= client.connect();
    return connectPromise;
  };

  return {
    async readBlocked(key, afterId, blockMs): Promise<StreamEntry[] | null> {
      await ensureConnected();
      const reply = await client.xread("BLOCK", blockMs, "STREAMS", key, afterId);
      if (reply === null) return null;
      const first = reply[0];
      if (first === undefined) return null;
      const entries = first[1];
      return entries.map(([id, fields]) => {
        const record: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const name = fields[i];
          const value = fields[i + 1];
          if (name !== undefined && value !== undefined) record[name] = value;
        }
        return { id, fields: record };
      });
    },
    close(): void {
      // disconnect() (not quit()) — there may be a blocked XREAD in flight; quit would
      // wait for it forever. disconnect stops reconnection and drops the socket.
      void client.disconnect();
    },
  };
}
