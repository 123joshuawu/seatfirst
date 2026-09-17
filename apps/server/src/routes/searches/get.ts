import {
  TRPCError,
  callTRPCProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  initTRPC,
} from "@trpc/server";
import type { AnyRouter, AnyTRPCRootTypes, TRPCErrorShape, TRPCRootConfig } from "@trpc/server";
import { getHTTPStatusCode } from "@trpc/server/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { SearchResult } from "@seatfirst/core";

import { issueHitNonces, issueRecheckNonces } from "../../session/nonce-issuance.js";
import { assertCallerOwnsSearch } from "../../streaming/ownership.js";
import {
  readLatestSearchAggregate,
  readLatestSearchResultVersion,
  readSearchStatus,
} from "../../streaming/queries.js";
import { mintSessionId } from "../session/bootstrap.js";

import type { SearchGetContext } from "./getContext.js";

/**
 * `searches.get` — the polling read (S19, `seatfirst-architecture.md:270`):
 * `trpc.searches.get({ searchId }) → SearchResult`. Verifies the caller's session owns the
 * search (S12.2, architecture §6.7), then serves — terminal: the immutable stored
 * `search_result_version` row (ADR 0001: "serves the immutable `SearchResultVersion` and
 * never the stream", `docs/adr/0001-durability-search-lifecycle.md:1266-1267`); nonterminal:
 * the stored `search_aggregate` row (ADR 0001 §4.1 nonterminal materialization; A2:
 * "progressive groups come from `SearchAggregate`, not `answer`"). Every served payload is
 * parsed fail-closed against the injected `SearchResultSchema` (S19.7), and the route
 * honors ADR 0006 §D.3's ETag/304 validators. One read-only route; zero writes (S19.9).
 *
 * Served through a bespoke GET route (`registerSearchGet`) ordered before
 * `fastifyTRPCPlugin`'s catch-all (S19.8) — the procedure's minimal context
 * (`{ sessionId, db, ifNoneMatch, searchResultSchema }`) is not satisfiable by the
 * router's `SearchCreateContext`. Mounted on the `appRouter` for path resolution.
 */

export const t = initTRPC.context<SearchGetContext>().create();

/**
 * Zod boundary validation (architecture §12: "Zod validation at every boundary"). The
 * `searchId` regex is exactly the sibling route pins it (`onProgress.ts:33-39`): the
 * namespaced opaque id, `srch_` + 128-bit random (`seatfirst-architecture.md:682`). Only
 * the namespace is checkable at the boundary. A non-conforming `searchId` is BAD_REQUEST
 * (S19.0), never reaching the ownership check.
 */
export const getInput = z.object({
  searchId: z.string().regex(/^srch_.+$/, "searchId must be a `srch_`-prefixed opaque identifier"),
});
export type GetInput = z.infer<typeof getInput>;

/**
 * The terminal statuses S19.3 enumerates for the result-version branch. CANCELLED is
 * deliberately NOT here: `searches.cancel` is a non-goal (S19 non-goals), and a CANCELLED
 * search's `search_result_version.payload` is the ADR 0018 `{ status, cause, answer }`
 * shape, not a `SearchResult` — it cannot be served without fabrication, so it falls to
 * the fail-loud branch below.
 */
export const SERVED_TERMINAL_STATUSES = ["COMPLETE", "PARTIAL", "HALTED"] as const;

export function isServedTerminalStatus(status: string | null): boolean {
  return status !== null && (SERVED_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** S19.1 — session ownership before any read; a missing/foreign row is UNAUTHORIZED. */
const ownership = t.middleware(async ({ ctx, input, next }) => {
  const { searchId } = input as GetInput;
  await assertCallerOwnsSearch(ctx.db, searchId, ctx.sessionId);
  return next();
});

export const get = t.procedure
  .input(getInput)
  .use(ownership)
  .query(async ({ input, ctx }): Promise<SearchResult> => {
    const { searchId } = input;

    // S19.3 — the terminal branch: read the status, and when terminal read the latest
    // `search_result_version` row. The gate-9 invariant guarantees a row exists for every
    // terminal status, written in the same transaction as the status
    // (`packages/durability/src/invariants.ts:121-124`); a missing row here is that
    // invariant breaking, and must fail loudly rather than fabricate a body.
    const status = await readSearchStatus(ctx.db, searchId);
    if (isServedTerminalStatus(status)) {
      const row = await readLatestSearchResultVersion(ctx.db, searchId);
      if (row === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `search ${searchId} is terminal (${status}) but has no search_result_version row (gate-9 invariant broken)`,
        });
      }
      // ADR 0006 §D.3 — terminal is a WEAK validator. Serve-time nonce issuance (S34)
      // makes two reads of the same version non-byte-identical (a fresh ULID `id` and
      // `expiry = now + 10 min` differ per serve), so a strong validator would be
      // dishonest. Weak comparison in `matchesIfNoneMatch` is unchanged.
      ctx.currentValidator = `W/"${searchId}.v${row.version}"`;
      // The stored payload is parsed fail-closed (S19.3), then each offer's `nonce`
      // placeholder is replaced with a fresh, signed, correctly-bound token (S34.5).
      // Never derived from events, never reconstructed.
      const parsed = ctx.searchResultSchema.parse(row.payload);
      const answer = parsed.answer;
      if (answer === null) {
        // Unreachable for a served terminal status — the schema's status↔answer refinement
        // admits no null answer here — but fail closed rather than fabricate an answer.
        return parsed;
      }
      const sessionId = ctx.sessionId;
      if (sessionId === undefined) {
        // Unreachable: `ownership` throws for an undefined/foreign caller before this runs.
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      // ADR 0017 amendment (2026-09-03) — one issuance input, two walks: the answer
      // offers (primary/alternatives, unchanged) plus every hit's best-covered
      // showtime. Terminal-serve only: expiry starts at client receipt (S34.3).
      // (The SSE terminal reveal carries answer-only and keeps its own
      // `issueRecheckNonces` call; clients reconcile full groups via this route.)
      const issuance = {
        sessionId,
        searchId,
        resultVersion: row.version,
        nonceSecret: ctx.nonceSecret,
        mintId: mintSessionId,
        now: () => Date.now(),
      };
      return {
        ...parsed,
        groups: issueHitNonces(parsed.groups, issuance),
        answer: issueRecheckNonces(answer, issuance),
      };
    }

    // S19.4 — the nonterminal branch: serve the stored aggregate, never events.
    if (status === "PENDING_SCHEDULE" || status === "RUNNING") {
      const row = await readLatestSearchAggregate(ctx.db, searchId);
      if (row === null) {
        // S19.5 — `stageSearchCreation` (packages/durability/src/transactions.ts) seeds a
        // revision-0 zero-state `search_aggregate` row in the SAME transaction as the
        // search's own creation, so this branch is unreachable in a correct deployment:
        // a nonterminal search always has an aggregate row from the instant it is
        // created, before the AGGREGATE dispatch handler (S27) ever runs its first real
        // pass. Fail loudly rather than fabricate a `resolved`/`total`/`groups` body.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `nonterminal search ${searchId} has no search_aggregate row (S19.5 — stageSearchCreation must seed this row at creation)`,
        });
      }
      // ADR 0006 §D.3 — nonterminal is a weak validator: `SearchAggregate` snapshot
      // semantics do not guarantee byte-identical re-renders of the same revision.
      ctx.currentValidator = `W/"${searchId}.r${row.revision}"`;
      // The schema itself enforces `answer === null` for nonterminal statuses
      // (`result-contracts.ts:913-919`).
      return ctx.searchResultSchema.parse(row.payload);
    }

    // CANCELLED (or any unrecognized status) — outside S19's served set. Its stored
    // payload is not a `SearchResult`, so there is nothing to serve without fabrication.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `searches.get cannot serve status ${String(status)}`,
    });
  });

/* ----------------------------------------------------------------- ETag/304 (ADR 0006 §D.3) */

/** The opaque-tag of an entity-tag, or `undefined` for a malformed tag. Strips the weak
 * prefix and the quotes; weak comparison compares only these opaque-tags (RFC 9110
 * §13.1.2). */
function entityTagOpaque(value: string): string | undefined {
  const tag = value.trim();
  const stripped = tag.startsWith("W/") ? tag.slice(2) : tag;
  if (stripped.startsWith('"') && stripped.endsWith('"') && stripped.length >= 2) {
    return stripped.slice(1, -1);
  }
  return undefined;
}

/**
 * ADR 0006 §D.3 — the `If-None-Match` match decision. Returns true when the current
 * validator weak-matches the request header: `*` matches any current representation, a
 * comma-separated list matches when any listed entity-tag weak-matches the current
 * validator. Weak comparison is used in ALL cases (RFC 9110 §13.1.2), so a client holding
 * a strong `"<searchId>.v<version>"` for the now-weak terminal validator still
 * short-circuits to 304. When there is no current validator (nothing served), no match.
 */
export function matchesIfNoneMatch(
  ifNoneMatch: string | undefined,
  currentValidator: string | undefined,
): boolean {
  if (ifNoneMatch === undefined || currentValidator === undefined) return false;
  const header = ifNoneMatch.trim();
  if (header === "*") return true;
  const currentOpaque = entityTagOpaque(currentValidator);
  if (currentOpaque === undefined) return false;
  return header.split(",").some((tag) => entityTagOpaque(tag) === currentOpaque);
}

/* ------------------------------------------------------------- bespoke route (S19.8) */

export const SEARCHES_GET_PATH = "searches.get";

export interface SearchGetRouteOptions {
  readonly router: AnyRouter;
  readonly createContext: (req: FastifyRequest) => SearchGetContext | Promise<SearchGetContext>;
}

/**
 * Registers the GET route for `searches.get`. Call before registering
 * `fastifyTRPCPlugin` (whose catch-all would otherwise win) — the same ordering rule
 * `registerSessionBootstrap` documents. A query rides the GET `?input=` query parameter
 * (the tRPC v11 GET wire shape, the same input the `onProgress` SSE transport parses).
 * The route speaks tRPC v11's single-call JSON envelope, so the standard client link
 * parses it.
 */
export function registerSearchGet(fastify: FastifyInstance, opts: SearchGetRouteOptions): void {
  fastify.get(`/trpc/${SEARCHES_GET_PATH}`, async (req, res) => {
    await handleSearchGet(req, res, opts);
  });
}

export async function handleSearchGet(
  req: FastifyRequest,
  res: FastifyReply,
  opts: SearchGetRouteOptions,
): Promise<void> {
  const { router } = opts;
  const url = new URL(req.url, "http://local");
  const transformer = router._def._config.transformer;
  const config = router._def._config as TRPCRootConfig<AnyTRPCRootTypes>;

  // GET query input rides the `?input=` query parameter, JSON-encoded.
  let input: unknown = {};
  const rawInput = url.searchParams.get("input");
  if (rawInput !== null) {
    input = transformer.input.deserialize(JSON.parse(rawInput) as unknown);
  }

  const ctx = await opts.createContext(req);

  // Ownership (middleware) and Zod input validation both run inside this call — a
  // UNAUTHORIZED/BAD_REQUEST surfaces here as a tRPC error before any body is served.
  let output: unknown;
  try {
    output = await callTRPCProcedure({
      router,
      path: SEARCHES_GET_PATH,
      type: "query",
      getRawInput: () => Promise.resolve(input),
      ctx,
      signal: undefined,
      batchIndex: 0,
    });
  } catch (cause) {
    const shape: unknown = getErrorShape({
      config,
      error: getTRPCErrorFromUnknown(cause),
      type: "query",
      path: SEARCHES_GET_PATH,
      input,
      ctx,
    });
    const status = getHTTPStatusCode({ error: shape as TRPCErrorShape });
    // O11.5 — log before serializing the response: a caller fault (4xx — the
    // ownership guard, Zod validation) warns, a server fault (5xx) errors, through
    // the request-scoped logger.
    const logFields: Record<string, unknown> = { error: cause, status };
    if (ctx.sessionId !== undefined) logFields.session_id = ctx.sessionId;
    if (status >= 500) {
      req.log.error(logFields, `${SEARCHES_GET_PATH}: failed`);
    } else {
      req.log.warn(logFields, `${SEARCHES_GET_PATH}: rejected`);
    }
    const serialized: unknown = transformer.output.serialize(shape);
    res
      .status(status)
      .header("content-type", "application/json")
      .send(JSON.stringify({ error: serialized }));
    return;
  }

  // ADR 0006 §D.3 — the ETag/304 decision. The resolver set `ctx.currentValidator` to the
  // validator of the row it actually served; honor `If-None-Match` with weak comparison in
  // all cases, and on a match return 304 with no body.
  if (ctx.currentValidator !== undefined) {
    res.header("etag", ctx.currentValidator);
  }
  if (matchesIfNoneMatch(ctx.ifNoneMatch, ctx.currentValidator)) {
    res.status(304).header("content-type", "application/json").send();
    return;
  }

  const untransformed = { result: { data: output } };
  const status = getHTTPStatusCode(untransformed);
  const serializedData: unknown = transformer.output.serialize(output);
  res
    .status(status)
    .header("content-type", "application/json")
    .send(JSON.stringify({ result: { data: serializedData } }));
}
