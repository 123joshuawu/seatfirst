import type { FastifyRequest } from "fastify";
import type { z } from "zod";

import { createResultContractSchemas } from "@seatfirst/core";
import type { ResultContractConfig, SearchResult } from "@seatfirst/core";

import type { Queryable } from "../../streaming/queries.js";

/**
 * `searches.get` context (S19.8) — the minimal per-request surface the polling read
 * needs. `searches.get` is served through its own bespoke registration (like
 * `session.bootstrap`/`showtimes.recheck`) because the `appRouter`'s `SearchCreateContext`
 * carries none of these; the procedure is still mounted on the `appRouter` for path
 * resolution.
 *
 * Every policy-relevant figure is a REQUIRED factory parameter — no defaults (gate 14):
 * - `db`: the read-only query surface (`Queryable` — the transport's stated policy is that
 *   reads live in `apps/server` and involve no boundary statement because they transition
 *   nothing, `apps/server/src/streaming/queries.ts:4-9`).
 * - `providerHostAllowlists`: the `ResultContractConfig` field the built `SearchResultSchema`
 *   reads for its provider deep-link checks (`packages/core/src/result-contracts.ts:394-397`).
 *   Required with NO fallback (S19.7) — a deployment that omits it fails at wiring time,
 *   never at request time (the S6U3.5 pattern).
 */
export interface SearchGetContext {
  /**
   * The caller's session id from the S16.16 plugin's decorated request — captured, never
   * defaulted or fabricated (S19.2). `undefined` when no valid signed cookie was
   * presented; the ownership guard fails closed on it.
   */
  readonly sessionId: string | undefined;
  /** Read side of the durability schema (`search`/`search_aggregate`/`search_result_version`). */
  readonly db: Queryable;
  /**
   * The request's `If-None-Match` header value (ADR 0006 §D.3), normalized to a single
   * string or `undefined`. The route handler weak-compares it against the validator the
   * resolver computed for the row it actually served (S19.6).
   */
  readonly ifNoneMatch: string | undefined;
  /**
   * The built `SearchResultSchema` — the fail-closed wire gate every served payload is
   * parsed against before it leaves the route (S19.3/S19.4). Constructed ONCE in the
   * context factory (S19.7); the schema is immutable, so per-request construction is pure
   * waste and is explicitly forbidden.
   */
  readonly searchResultSchema: z.ZodType<SearchResult>;
  /**
   * The shared recheck-nonce signing secret (ADR 0017, S34) — injected, no default
   * (gate 14). The terminal branch signs each offer's nonce with it at serve time.
   */
  readonly nonceSecret: string;
  /**
   * The current validator (ETag) for the row the resolver served — set by the resolver
   * before it returns (weak `W/"<searchId>.v<version>"` terminal,
   * `W/"<searchId>.r<revision>"` nonterminal, ADR 0006 §D.3). The route handler reads it
   * after `callTRPCProcedure` to set the `ETag` header and decide the 304 short-circuit.
   * It is the one mutable slot on an otherwise-readonly per-request context — the
   * request-scoped channel carrying a computed value out of the resolver.
   */
  currentValidator: string | undefined;
}

export interface CreateSearchGetContextOptions {
  readonly db: Queryable;
  readonly providerHostAllowlists: ResultContractConfig["providerHostAllowlists"];
  readonly nonceSecret: string;
}

/**
 * Builds the per-request context factory. `sessionId` comes from the S16.16 session
 * plugin's `req.session` decoration; `ifNoneMatch` is captured from the request's
 * `If-None-Match` header. `SearchResultSchema` is built once here (S19.7) from the
 * injected, no-default `providerHostAllowlists`; `nonceSecret` is captured for the
 * terminal branch's serve-time nonce issuance (S34).
 */
export function createSearchGetContextFactory(
  opts: CreateSearchGetContextOptions,
): (req: FastifyRequest) => SearchGetContext {
  const { db, providerHostAllowlists, nonceSecret } = opts;
  const searchResultSchema = createResultContractSchemas({
    providerHostAllowlists,
  }).SearchResultSchema;
  return (req) => {
    const session = req.session;
    const ifNoneMatch = req.headers["if-none-match"];
    return {
      sessionId: session === null ? undefined : session.sessionId,
      db,
      ifNoneMatch: typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
      searchResultSchema,
      nonceSecret,
      currentValidator: undefined,
    };
  };
}
