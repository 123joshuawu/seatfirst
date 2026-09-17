import { randomBytes } from "node:crypto";

import { callTRPCProcedure, getErrorShape, getTRPCErrorFromUnknown, initTRPC } from "@trpc/server";
import type { AnyRouter, AnyTRPCRootTypes, TRPCErrorShape, TRPCRootConfig } from "@trpc/server";
import { getHTTPStatusCode } from "@trpc/server/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { SessionBootstrapResponseSchema } from "@seatfirst/core";
import type { SessionBootstrapResponse } from "@seatfirst/core";
import { poolClient, upsertSession } from "@seatfirst/durability";

import { buildSessionCookie, parseSessionCookie } from "../../session/cookie.js";
import type { SessionCookiePolicy } from "../../session/cookie.js";
import type { SessionRateLimitConfig } from "../../session/limiter.js";

/**
 * `trpc.session.bootstrap` (S16.11; seatfirst-architecture.md:274): mint-or-recognize
 * the caller's session and report the injected limits that will be enforced against it.
 *
 * With a valid signed cookie (S16.10): verify, `upsertSession` (S16.2 — same id, the
 * row's `last_seen_at` touched), return the SAME id, no cookie re-set. Without one (or
 * with a forged signature): mint a fresh text ULID, `upsertSession`, set the S16.10
 * cookie. A forged id is never trusted (S16 verification item 8) — the minted id is
 * fresh, and no row is ever written for the forged value.
 *
 * Served through a bespoke route registered before `fastifyTRPCPlugin` (S16.15), like
 * `onProgress`'s SSE transport — this procedure needs its own context
 * (`{ db, sessionSecret, cookiePolicy, rateLimitConfig, req, res }`, S16.15's named
 * shape), which the searches router's `SearchCreateContext` does not carry. The
 * procedure is still mounted on the `appRouter` (router.ts) so the tRPC client's
 * `trpc.session.bootstrap.mutate()` resolves; the catch-all would fail loudly (missing
 * secret) rather than silently misbehave if ever reached.
 */

export const SESSION_BOOTSTRAP_PATH = "session.bootstrap";

export interface SessionBootstrapContext {
  readonly db: Pool;
  readonly sessionSecret: string;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly rateLimitConfig: SessionRateLimitConfig;
  readonly req: FastifyRequest;
  readonly res: FastifyReply;
}

/**
 * Builds the per-request context factory for the bespoke bootstrap route. The same
 * required-no-default convention as the searches factories (gate 14): the secret and
 * cookie policy are wired once and the factory merely binds the request pair.
 */
export function createSessionBootstrapContextFactory(
  opts: SessionBootstrapContextOptions,
): (req: FastifyRequest, res: FastifyReply) => SessionBootstrapContext {
  const { db, sessionSecret, cookiePolicy, rateLimitConfig } = opts;
  return (req, res) => ({ db, sessionSecret, cookiePolicy, rateLimitConfig, req, res });
}

export interface SessionBootstrapContextOptions {
  readonly db: Pool;
  readonly sessionSecret: string;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly rateLimitConfig: SessionRateLimitConfig;
}

const tSession = initTRPC.context<SessionBootstrapContext>().create();

/** Crockford base32 — no I, L, O, U (the ULID alphabet). */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * S16.11's "fresh text ULID" — the repo's id convention (docs/tasks/README.md:170,
 * backend-work-plan S2.3): 128 bits, a 48-bit millisecond timestamp in the high bytes
 * (time-sortable, which is why S18's retention job and Redis key naming get a
 * monotone-ish id) plus 80 bits from `randomBytes`, encoded as 26 Crockford chars.
 * No prefix: `session_id` is a plain opaque text key.
 */
export function mintSessionId(): string {
  const bytes = new Uint8Array(16);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  randomBytes(10).copy(bytes, 6);

  // 128 bits → 26 × 5-bit chars, MSB first; the ULID's two zero padding bits ride in
  // the first char (a timestamp beyond 2^48 ms is centuries away).
  let encoded = "";
  let carry = 0;
  let pending = 0;
  for (const byte of bytes) {
    carry = (carry << 8) | byte;
    pending += 8;
    while (pending >= 5) {
      pending -= 5;
      encoded += ULID_ALPHABET[(carry >> pending) & 31];
    }
  }
  if (pending > 0) {
    encoded += ULID_ALPHABET[(carry << (5 - pending)) & 31];
  }
  return encoded;
}

export const bootstrap = tSession.procedure.mutation(
  async ({ ctx }): Promise<SessionBootstrapResponse> => {
    const { db, sessionSecret, cookiePolicy, rateLimitConfig } = ctx;

    const presented = parseSessionCookie(ctx.req.headers.cookie, sessionSecret);
    const minted = presented === undefined;
    const sessionId = minted ? mintSessionId() : presented;

    // S16.2's upsert makes this idempotent and keeps last_seen_at meaningful for
    // S18's retention job — same id touches the row on every bootstrap.
    await upsertSession(poolClient(db), { sessionId });

    if (minted) {
      ctx.res.header("set-cookie", buildSessionCookie(sessionId, sessionSecret, cookiePolicy));
    }

    return SessionBootstrapResponseSchema.parse({
      sessionId,
      limits: {
        searchesPerHour: rateLimitConfig.searches.limit,
        upstreamFetchesPerHour: rateLimitConfig.fetches.limit,
        concurrentSearches: rateLimitConfig.concurrentSearches,
        recheckCallsPerMinute: rateLimitConfig.recheck.limit,
        facetCountsPerMinute: rateLimitConfig.facetCounts.limit,
        resolvePlacePerMinute: rateLimitConfig.resolvePlace.limit,
        suggestPlacePerMinute: rateLimitConfig.suggestPlace.limit,
      },
    });
  },
);

/** Mounted on the `appRouter` (router.ts) so the procedure is resolvable by path. */
export const sessionRouter = tSession.router({ bootstrap });

export interface SessionBootstrapRouteOptions {
  readonly router: AnyRouter;
  readonly createContext: (
    req: FastifyRequest,
    res: FastifyReply,
  ) => SessionBootstrapContext | Promise<SessionBootstrapContext>;
}

/**
 * Registers the POST route for `session.bootstrap`. Call before `fastifyTRPCPlugin`
 * (whose `fastify.all` catch-all would otherwise win) — the same ordering rule
 * `registerOnProgressSse` documents (sse.ts). The route speaks tRPC v11's single-call
 * JSON envelope (the stock `resolveResponse` shape), so the standard client link parses
 * it. Bootstrap takes no input, so the POST body is ignored.
 */
export function registerSessionBootstrap(
  fastify: FastifyInstance,
  opts: SessionBootstrapRouteOptions,
): void {
  fastify.post(`/trpc/${SESSION_BOOTSTRAP_PATH}`, async (req, res) => {
    const ctx = await opts.createContext(req, res);
    await handleSessionBootstrap(res, opts.router, ctx);
  });
}

export async function handleSessionBootstrap(
  res: FastifyReply,
  router: AnyRouter,
  ctx: SessionBootstrapContext,
): Promise<void> {
  const transformer = router._def._config.transformer;
  const config = router._def._config as TRPCRootConfig<AnyTRPCRootTypes>;

  let output: unknown;
  try {
    output = await callTRPCProcedure({
      router,
      path: SESSION_BOOTSTRAP_PATH,
      type: "mutation",
      getRawInput: () => Promise.resolve(undefined),
      ctx,
      signal: undefined,
      batchIndex: 0,
    });
  } catch (cause) {
    const shape: unknown = getErrorShape({
      config,
      error: getTRPCErrorFromUnknown(cause),
      type: "mutation",
      path: SESSION_BOOTSTRAP_PATH,
      input: undefined,
      ctx,
    });
    const status = getHTTPStatusCode({ error: shape as TRPCErrorShape });
    // faults (the DB upsert or response parse), so they error; a caller-shaped
    // rejection (4xx) still only warns. The context carries the request, whose
    // logger is the request-scoped one (requestId included).
    const logFields: Record<string, unknown> = { error: cause, status };
    if (status >= 500) {
      ctx.req.log.error(logFields, `${SESSION_BOOTSTRAP_PATH}: failed`);
    } else {
      ctx.req.log.warn(logFields, `${SESSION_BOOTSTRAP_PATH}: rejected`);
    }
    const serialized: unknown = transformer.output.serialize(shape);
    res
      .status(status)
      .header("content-type", "application/json")
      .send(JSON.stringify({ error: serialized }));
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
