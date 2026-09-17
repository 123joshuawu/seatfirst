import { callTRPCProcedure, getErrorShape, getTRPCErrorFromUnknown } from "@trpc/server";
import type { AnyRouter, AnyTRPCRootTypes, TRPCErrorShape, TRPCRootConfig } from "@trpc/server";
import { getHTTPStatusCode } from "@trpc/server/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { RateLimitErrorSchema } from "@seatfirst/core";

import { StructuredHttpError } from "../searches/create.js";

import type { RecheckContext } from "./recheckContext.js";

/**
 * The bespoke POST route for `showtimes.recheck` (S22.8). The recheck context
 * (`{ sessionId, db, limiter, nonceSecret, deadlineMs, recovery }`) is NOT satisfiable by
 * the `appRouter`'s catch-all `SearchCreateContext` (it lacks `nonceSecret`/`deadlineMs`/
 * `recovery`), so — exactly like `session.bootstrap` — the procedure is mounted on the
 * `appRouter` for path resolution but served through its own registration, registered
 * BEFORE `fastifyTRPCPlugin` (whose catch-all would otherwise win). It takes a JSON-body
 * mutation, so the raw input is the parsed request body (`httpLink` sends `input`
 * verbatim as `JSON.stringify(input)`).
 */

export const SHOWTIMES_RECHECK_PATH = "showtimes.recheck";

export interface ShowtimesRecheckRouteOptions {
  readonly router: AnyRouter;
  readonly createContext: (req: FastifyRequest) => RecheckContext | Promise<RecheckContext>;
}

export function registerShowtimesRecheck(
  fastify: FastifyInstance,
  opts: ShowtimesRecheckRouteOptions,
): void {
  fastify.post(`/trpc/${SHOWTIMES_RECHECK_PATH}`, async (req, res) => {
    const ctx = await opts.createContext(req);
    await handleShowtimesRecheck(res, opts.router, ctx, req.body);
  });
}

export async function handleShowtimesRecheck(
  res: FastifyReply,
  router: AnyRouter,
  ctx: RecheckContext,
  rawInput: unknown,
): Promise<void> {
  const transformer = router._def._config.transformer;
  const config = router._def._config as TRPCRootConfig<AnyTRPCRootTypes>;

  let output: unknown;
  try {
    output = await callTRPCProcedure({
      router,
      path: SHOWTIMES_RECHECK_PATH,
      type: "mutation",
      getRawInput: () => Promise.resolve(rawInput),
      ctx,
      signal: undefined,
      batchIndex: 0,
    });
  } catch (cause) {
    // S22.10 — the 429 body carries `RateLimitErrorSchema`; its derived `retryAfterSeconds`
    // drives the `Retry-After` header (S16.6, never a constant), mirroring
    // `createSearchResponseMeta`'s rate-limit branch.
    if (cause instanceof StructuredHttpError && cause.structuredBody.code === "RATE_LIMITED") {
      const body = RateLimitErrorSchema.parse(cause.structuredBody);
      if (body.retryAfterSeconds !== null) {
        res.header("retry-after", String(body.retryAfterSeconds));
      }
    }
    const shape: unknown = getErrorShape({
      config,
      error: getTRPCErrorFromUnknown(cause),
      type: "mutation",
      path: SHOWTIMES_RECHECK_PATH,
      input: rawInput,
      ctx,
    });
    const status = getHTTPStatusCode({ error: shape as TRPCErrorShape });
    // O11.5 — log before serializing the response: a caller fault (4xx) warns, a
    // server fault (5xx) errors, through the request-scoped logger the context
    // carries (`req.log`, requestId included).
    const logFields: Record<string, unknown> = { error: cause, status };
    if (ctx.sessionId !== undefined) logFields.session_id = ctx.sessionId;
    if (status >= 500) {
      ctx.logger.error(logFields, `${SHOWTIMES_RECHECK_PATH}: failed`);
    } else {
      ctx.logger.warn(logFields, `${SHOWTIMES_RECHECK_PATH}: rejected`);
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
