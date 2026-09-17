import type { FastifyReply, FastifyRequest } from "fastify";

import { createResultContractSchemas } from "@seatfirst/core";
import type { RevealPayload, ResultContractConfig } from "@seatfirst/core";
import type { z } from "zod";

import type { Queryable } from "./queries.js";
import type { StreamRedisReader } from "./redisStreams.js";
import { openSearchStreamReader } from "./redisStreams.js";

/**
 * Per-request context for the `searches.onProgress` subscription.
 *
 * The subscription is a pure transport layer (S12.8): every dependency that touches a
 * service arrives here, injected, so the procedure reads what the caller wires.
 */
export interface SearchStreamContext {
  /**
   * The caller's session from the S16.16 plugin's decorated request. Derived by the
   * transport's onRequest hook; the ownership guard (architecture §6.7) compares it to
   * `search.session_id`. Absent means "no valid signed session cookie was presented" —
   * the guard fails closed.
   */
  readonly sessionId: string | undefined;
  /**
   * `XREAD BLOCK` window. Injected by the deployment with NO default: a block timeout is
   * a numeric policy decision nobody has written down (gate 14, `docs/gates.md`).
   */
  readonly blockTimeoutMs: number;
  /** Read side of the durability schema (`search`/`search_event`) — reads only. */
  readonly db: Queryable;
  /**
   * Opens the per-subscription Redis Stream reader. One connection per subscription: the
   * blocked XREAD owns its connection, and a dedicated client is what makes clean release
   * on client disconnect a close instead of a protocol-level abort (S12.7). The reader
   * connects lazily on its first blocked read.
   */
  readonly openStreamReader: () => StreamRedisReader;
  /**
   * SSE transport-level keepalive (a comment line, `: keepalive`). Invoked on an
   * XREAD-block timeout; it is NOT part of the tRPC event iterable (S12.5) — the wire
   * keeps breathing without fabricating a domain event.
   */
  readonly keepAlive: () => void;
  /**
   * The shared recheck-nonce signing secret (ADR 0017, S34) — injected, no default
   * (gate 14). The terminal reveal signs each offer's nonce with it at serve time.
   */
  readonly nonceSecret: string;
  /**
   * The built `RevealPayloadSchema` — the delivery-side gate parses every terminal
   * payload against it fail-closed before yielding (S6U3.4). Constructed ONCE in
   * `createContextFactory`: the schema is immutable, so per-request construction is
   * pure waste.
   */
  readonly revealPayloadSchema: z.ZodType<RevealPayload>;
}

export interface CreateSearchStreamContextOptions {
  readonly db: Queryable;
  readonly redisUrl: string;
  readonly blockTimeoutMs: number;
  /**
   * The `ResultContractConfig` field the reveal validator's provider deep-link checks
   * read (`packages/core/src/result-contracts.ts:394-397`). Required with NO fallback —
   * ops data config, injected by the deployment like `blockTimeoutMs` (gate 14); a
   * deployment that omits it fails at wiring time, never at request time (S6U3.5).
   */
  readonly providerHostAllowlists: ResultContractConfig["providerHostAllowlists"];
  readonly nonceSecret: string;
}

/**
 * Builds the per-request context factory. `sessionId` comes from the S16.16 session
 * plugin's `req.session` decoration — the `x-session-id` header placeholder this module
 * used to read is gone (S16.12). `keepAlive` is bound to this request's raw response.
 */
export function createContextFactory(
  opts: CreateSearchStreamContextOptions,
): (req: FastifyRequest, res: FastifyReply) => SearchStreamContext {
  const { db, redisUrl, blockTimeoutMs, providerHostAllowlists, nonceSecret } = opts;
  const revealPayloadSchema = createResultContractSchemas({
    providerHostAllowlists,
  }).RevealPayloadSchema;
  return (req, res) => {
    const session = req.session;
    return {
      sessionId: session === null ? undefined : session.sessionId,
      blockTimeoutMs,
      db,
      openStreamReader: () => openSearchStreamReader(redisUrl, req.log),
      revealPayloadSchema,
      nonceSecret,
      keepAlive: () => {
        if (!res.raw.destroyed && !res.raw.writableEnded) {
          res.raw.write(": keepalive\n\n");
        }
      },
    };
  };
}
