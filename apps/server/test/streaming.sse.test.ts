import { initTRPC, tracked, TRPCError } from "@trpc/server";
import type { AnyRouter } from "@trpc/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createContextFactory } from "../src/streaming/context.js";
import {
  handleOnProgressSse,
  ON_PROGRESS_PATH,
  registerOnProgressSse,
} from "../src/streaming/sse.js";
import type { OnProgressSseOptions } from "../src/streaming/sse.js";
import type { SearchStreamContext } from "../src/streaming/context.js";

/**
 * S38.6 — the SSE transport's paths against fake request/reply pairs and a real minimal
 * tRPC router mounted at `searches.onProgress`: header + framing on the success path,
 * `serialized-error` frames built through `getErrorShape`, silent termination on
 * `AbortError`, and the GET registration that must precede `fastifyTRPCPlugin`.
 */

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

interface FakeRaw {
  writes: string[];
  writtenHead: { status: number; headers: Record<string, string> } | null;
  ended: boolean;
  destroyed: boolean;
  writableEnded: boolean;
  closeCallbacks: (() => void)[];
  write: (frame: string) => boolean;
  end: () => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  setHeader: (name: string, value: unknown) => void;
  once: (event: string, callback: () => void) => void;
}

function makeRaw(): FakeRaw & Record<string | symbol, unknown> {
  const raw = {
    writes: [] as string[],
    writtenHead: null as FakeRaw["writtenHead"],
    ended: false,
    destroyed: false,
    writableEnded: false,
    closeCallbacks: [] as (() => void)[],
    write(frame: string): boolean {
      raw.writes.push(frame);
      return true;
    },
    end(): void {
      raw.ended = true;
      raw.writableEnded = true;
    },
    writeHead(status: number, headers: Record<string, string>): void {
      raw.writtenHead = { status, headers };
    },
    setHeader(): undefined {},
    once(event: string, callback: () => void): void {
      if (event === "close") raw.closeCallbacks.push(callback);
    },
  };
  return raw;
}

function makeRes(): FastifyReply & { raw: FakeRaw & Record<string | symbol, unknown> } {
  const raw = makeRaw();
  const res = {
    raw,
    getHeaders: () => ({}),
    hijack: () => undefined,
    code: () => res,
    send: () => res,
  };
  return res as unknown as FastifyReply & { raw: typeof raw };
}

function makeReq(headers: Record<string, string> = {}): FastifyRequest {
  return {
    url: `/trpc/${ON_PROGRESS_PATH}`,
    headers,
    session: null,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as FastifyRequest;
}

function reqLog(req: FastifyRequest): {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return (
    req as unknown as { log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } }
  ).log;
}

function makeContext(): SearchStreamContext {
  const factory = createContextFactory({
    db: { query: () => Promise.resolve({ rows: [] }) },
    redisUrl: "redis://streams.example.invalid:6379",
    blockTimeoutMs: 15_000,
    providerHostAllowlists: { amc: ["example.invalid"] },
    nonceSecret: "s38-test-nonce-secret",
  });
  return factory(makeReq(), makeRes());
}

/** A real minimal router mounted at the exact path the transport calls. */
function makeRouter(
  run: (
    signal: AbortSignal | undefined,
  ) => AsyncGenerator<unknown, void, void> | Generator<unknown, void, void>,
  guard?: (opts: { ctx: SearchStreamContext }) => never,
): AnyRouter {
  const t = initTRPC.context<SearchStreamContext>().create();
  const onProgress = (guard ? t.procedure.use(guard) : t.procedure).subscription(async function* ({
    signal,
  }) {
    yield* run(signal);
  });
  return t.router({
    searches: t.router({ onProgress }),
  });
}

async function drive(
  router: AnyRouter,
): Promise<{ req: FastifyRequest; res: ReturnType<typeof makeRes> }> {
  const req = makeReq();
  const res = makeRes();
  await handleOnProgressSse(req, res, { router, createContext: () => makeContext() });
  return { req, res };
}

describe("handleOnProgressSse", () => {
  it("writes the SSE headers, the connected frame, tracked-event frames, and the return frame", async () => {
    const router = makeRouter(function* () {
      yield tracked("1-0", { kind: "PROGRESS", step: 1 });
      yield tracked("2-0", { kind: "COMPLETE", step: 2 });
    });

    const { res } = await drive(router);

    expect(res.raw.writtenHead).toEqual({ status: 200, headers: SSE_HEADERS });
    expect(res.raw.writes[0]).toBe("event: connected\ndata: {}\n\n");
    expect(res.raw.writes[1]).toBe('data: {"kind":"PROGRESS","step":1}\n');
    expect(res.raw.writes[2]).toBe("id: 1-0\n");
    expect(res.raw.writes[3]).toBe("\n");
    expect(res.raw.writes[4]).toBe('data: {"kind":"COMPLETE","step":2}\n');
    expect(res.raw.writes[5]).toBe("id: 2-0\n");
    expect(res.raw.writes[6]).toBe("\n");
    expect(res.raw.writes[7]).toBe("event: return\ndata: \n\n");
    expect(res.raw.ended).toBe(true);
    expect(res.raw.closeCallbacks).toHaveLength(1);
  });

  it("emits a serialized-error frame built through getErrorShape when the stream fails mid-flight", async () => {
    const router = makeRouter(function* () {
      yield tracked("1-0", { kind: "PROGRESS" });
      throw new Error("mid-stream boom");
    });

    const { req, res } = await drive(router);

    const joined = res.raw.writes.join("");
    expect(joined).toContain("event: connected");
    expect(joined).toContain('data: {"kind":"PROGRESS"}');
    const errorFrame = res.raw.writes.find((frame) =>
      frame.startsWith("event: serialized-error\n"),
    );
    expect(errorFrame).toBeDefined();
    const payload = JSON.parse(
      (errorFrame ?? "").replace(/^event: serialized-error\ndata: /, ""),
    ) as {
      code: number;
      message: string;
      data: { code: string; path: string; httpStatus: number };
    };
    expect(payload.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(payload.data.path).toBe(ON_PROGRESS_PATH);
    expect(payload.data.httpStatus).toBe(500);
    // A server fault logs at error severity before the response ends (O11.5).
    expect(reqLog(req).error).toHaveBeenCalledOnce();
    expect(res.raw.writes.some((frame) => frame.startsWith("event: return"))).toBe(false);
    expect(res.raw.ended).toBe(true);
  });

  it("terminates silently on an AbortError instead of writing an error frame", async () => {
    const router = makeRouter(function* () {
      yield tracked("1-0", { kind: "PROGRESS" });
      throw Object.assign(new Error("client hung up"), { name: "AbortError" });
    });

    const { req, res } = await drive(router);

    const joined = res.raw.writes.join("");
    expect(joined).toContain("event: connected");
    expect(joined).not.toContain("serialized-error");
    expect(joined).not.toContain("event: return");
    expect(reqLog(req).warn).not.toHaveBeenCalled();
    expect(reqLog(req).error).not.toHaveBeenCalled();
    expect(res.raw.ended).toBe(true);
  });

  it("fails closed before the stream opens when the ownership guard rejects, logging at warn", async () => {
    const router = makeRouter(
      function* () {
        yield tracked("1-0", {});
      },
      () => {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "not yours" });
      },
    );

    const { req, res } = await drive(router);

    // Nothing streamed yet: the serialized error is the very first frame.
    expect(res.raw.writes[0]?.startsWith("event: serialized-error\n")).toBe(true);
    const payload = JSON.parse(
      (res.raw.writes[0] ?? "").replace(/^event: serialized-error\ndata: /, ""),
    ) as {
      data: { code: string; httpStatus: number };
    };
    expect(payload.data.code).toBe("UNAUTHORIZED");
    expect(payload.data.httpStatus).toBe(401);
    expect(reqLog(req).warn).toHaveBeenCalledOnce();
    expect(res.raw.ended).toBe(true);
  });
});

describe("registerOnProgressSse", () => {
  it("registers a GET route at the exact path whose handler drives the SSE transport", async () => {
    const get = vi.fn<
      (url: string, handler: (req: FastifyRequest, res: FastifyReply) => Promise<void>) => void
    >(() => undefined);
    const fastify = { get } as unknown as FastifyInstance;

    const opts: OnProgressSseOptions = {
      router: makeRouter(async function* () {}),
      createContext: () => makeContext(),
    };
    registerOnProgressSse(fastify, opts);

    expect(get).toHaveBeenCalledOnce();
    const [url, handler] = get.mock.calls[0] as [
      string,
      (req: FastifyRequest, res: FastifyReply) => Promise<void>,
    ];
    expect(url).toBe(`/trpc/${ON_PROGRESS_PATH}`);

    // The registered handler delegates to handleOnProgressSse: driving it produces
    // the same connected/return framing the transport owns.
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.raw.writtenHead).toEqual({ status: 200, headers: SSE_HEADERS });
    expect(res.raw.writes[0]).toBe("event: connected\ndata: {}\n\n");
    expect(res.raw.writes.at(-1)).toBe("event: return\ndata: \n\n");
  });
});
