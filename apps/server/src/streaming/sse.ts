import {
  callTRPCProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
} from "@trpc/server";
import type { AnyRouter, AnyTRPCRootTypes, TRPCErrorShape, TRPCRootConfig } from "@trpc/server";
import { getHTTPStatusCode } from "@trpc/server/http";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SearchStreamContext } from "./context.js";

/**
 * The SSE transport for `searches.onProgress`.
 *
 * Why a bespoke endpoint rather than tRPC's stock subscription response writer: the
 * stock pipeline cannot emit an SSE comment — every chunk it frames is an event — and
 * S12.5 requires a transport-level keepalive comment when an `XREAD BLOCK` window
 * elapses with no events, without fabricating a domain event. This handler implements
 * the tRPC v11 SSE wire protocol exactly (the same `event:`/`data:`/`id:` framing the
 * `httpSubscriptionLink` client consumes, with errors as `serialized-error` events), and
 * adds precisely one capability on top: the `: keepalive` comment line.
 *
 * Production wiring note: register this GET route BEFORE `fastifyTRPCPlugin` (which
 * registers `fastify.all` for POST queries/mutations) so the subscription GET is matched
 * first.
 */

/** The headers tRPC's SSE responses use; the client's EventSource requires them. */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

export const ON_PROGRESS_PATH = "searches.onProgress";

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "AbortError"
  );
}

function write(res: FastifyReply, frame: string): void {
  if (!res.raw.destroyed && !res.raw.writableEnded) {
    res.raw.write(frame);
  }
}

/** `event: serialized-error` — the frame the client turns into a thrown TRPCClientError. */
function writeSerializedError(
  res: FastifyReply,
  router: AnyRouter,
  ctx: SearchStreamContext,
  cause: unknown,
  input: unknown,
): number {
  const config = router._def._config as TRPCRootConfig<AnyTRPCRootTypes>;
  const shape: unknown = getErrorShape({
    config,
    error: getTRPCErrorFromUnknown(cause),
    type: "subscription",
    path: ON_PROGRESS_PATH,
    input,
    ctx,
  });
  const serialized: unknown = config.transformer.output.serialize(shape);
  write(res, `event: serialized-error\ndata: ${JSON.stringify(serialized)}\n\n`);
  return getHTTPStatusCode({ error: shape as TRPCErrorShape });
}

/**
 * O11.5 — log a subscription failure through the request-scoped logger before the
 * stream ends. Severity matches the fault: a caller rejection (4xx status of the
 * serialized tRPC error) warns, a server fault (5xx) errors.
 */
function logStreamFailure(
  log: FastifyBaseLogger,
  sessionId: string | undefined,
  cause: unknown,
  status: number,
  reason: string,
): void {
  const fields: Record<string, unknown> = { error: cause, status };
  if (sessionId !== undefined) fields.session_id = sessionId;
  if (status >= 500) {
    log.error(fields, reason);
  } else {
    log.warn(fields, reason);
  }
}

export interface OnProgressSseOptions {
  readonly router: AnyRouter;
  readonly createContext: (
    req: FastifyRequest,
    res: FastifyReply,
  ) => SearchStreamContext | Promise<SearchStreamContext>;
}

export async function handleOnProgressSse(
  req: FastifyRequest,
  res: FastifyReply,
  opts: OnProgressSseOptions,
): Promise<void> {
  const { router } = opts;
  const url = new URL(req.url, "http://local");
  const searchParams = url.searchParams;
  const transformer = router._def._config.transformer;

  // GET subscription request: input rides the `?input=` query parameter, JSON-encoded.
  let input: unknown = {};
  const rawInput = searchParams.get("input");
  if (rawInput !== null) {
    input = transformer.input.deserialize(JSON.parse(rawInput) as unknown);
  }

  // EventSource's native retry sends `Last-Event-Id`; tRPC's link reconnects by merging
  // `lastEventId` into the input instead. Honor both, exactly as the stock pipeline does.
  const lastEventId =
    req.headers["last-event-id"] ??
    searchParams.get("lastEventId") ??
    searchParams.get("Last-Event-Id");
  if (lastEventId !== null && lastEventId !== undefined) {
    const value = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    input = { ...(typeof input === "object" && input !== null ? input : {}), lastEventId: value };
  }

  const abort = new AbortController();
  const release = (): void => abort.abort();
  res.raw.once("close", release);

  let ctx: SearchStreamContext;
  try {
    ctx = await opts.createContext(req, res);
  } catch (cause) {
    // Nothing streamed yet: fail the request through Fastify rather than faking a
    // serialized-error frame without a context. The EventSource client surfaces this as
    // a connection error either way. O11.5 — context creation is deployment wiring,
    // never caller input, so this is always a server fault: log it (error) before the
    // response goes out.
    req.log.error({ error: cause }, `${ON_PROGRESS_PATH}: context creation failed`);
    res.code(500).send({ error: "context creation failed", message: String(cause) });
    return;
  }

  // `reply.hijack()` bypasses Fastify's normal send pipeline. Copy headers that
  // onRequest plugins already attached (notably @fastify/cors) to the raw response
  // before writing the SSE headers, or a browser rejects the cross-origin stream.
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value !== undefined) res.raw.setHeader(name, value);
  }
  res.hijack();
  res.raw.writeHead(200, SSE_HEADERS);

  // Ownership (middleware) and Zod input validation both run inside this call — a
  // UNAUTHORIZED/BAD_REQUEST surfaces here, BEFORE `connected` is written: the stream
  // never opens, which is S12.2/S12.3's "before the subscription stream opens".
  let output: unknown;
  try {
    output = (await callTRPCProcedure({
      router,
      path: ON_PROGRESS_PATH,
      type: "subscription",
      getRawInput: () => Promise.resolve(input),
      ctx,
      signal: abort.signal,
      batchIndex: 0,
    })) as unknown;
  } catch (cause) {
    const status = writeSerializedError(res, router, ctx, cause, input);
    // O11.5 — the ownership guard / Zod validation reject callers (4xx → warn);
    // anything else is a server fault (5xx → error).
    logStreamFailure(
      req.log,
      ctx.sessionId,
      cause,
      status,
      `${ON_PROGRESS_PATH}: subscription failed to open`,
    );
    res.raw.end();
    release();
    return;
  }

  // tRPC wraps subscription resolvers in an Observable; async-generator resolvers come
  // back as async iterables. Both are valid procedure outputs — normalize to the
  // iterable the framing loop consumes.
  let iterable: AsyncIterable<unknown>;
  const data = output;
  if (isObservable(data)) {
    iterable = observableToAsyncIterable(data, abort.signal);
  } else if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  ) {
    iterable = data as AsyncIterable<unknown>;
  } else {
    const cause = new Error(`Subscription ${ON_PROGRESS_PATH} did not return an async generator`);
    const status = writeSerializedError(res, router, ctx, cause, input);
    // O11.5 — a resolver returning neither Observable nor async iterable is a server
    // fault in the procedure wiring, never caller input.
    logStreamFailure(
      req.log,
      ctx.sessionId,
      cause,
      status,
      `${ON_PROGRESS_PATH}: invalid procedure output`,
    );
    res.raw.end();
    release();
    return;
  }

  write(res, "event: connected\ndata: {}\n\n");

  try {
    for await (const value of iterable) {
      if (abort.signal.aborted) break;
      const chunk = isTrackedEnvelope(value)
        ? { id: value[0] as string, data: value[1] }
        : { id: undefined, data: value };
      const json = JSON.stringify(transformer.output.serialize(chunk.data));
      write(res, `data: ${json}\n`);
      if (chunk.id !== undefined) write(res, `id: ${chunk.id}\n`);
      write(res, "\n");
    }
    if (!abort.signal.aborted) {
      write(res, "event: return\ndata: \n\n");
    }
  } catch (cause) {
    if (!abort.signal.aborted && !isAbortError(cause)) {
      const status = writeSerializedError(res, router, ctx, cause, input);
      // O11.5 — an aborted stream is the client hanging up (no signal value); every
      // other mid-stream failure is logged, severity by the serialized error's status.
      logStreamFailure(
        req.log,
        ctx.sessionId,
        cause,
        status,
        `${ON_PROGRESS_PATH}: stream loop failed`,
      );
    }
  } finally {
    release();
    res.raw.end();
  }
}

/**
 * Registers the subscription GET route. Call before registering `fastifyTRPCPlugin` so
 * this route wins over the plugin's catch-all `fastify.all` registration.
 */
export function registerOnProgressSse(fastify: FastifyInstance, opts: OnProgressSseOptions): void {
  fastify.get(`/trpc/${ON_PROGRESS_PATH}`, async (req, res) => {
    await handleOnProgressSse(req, res, opts);
  });
}
