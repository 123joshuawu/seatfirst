import type { FastifyReply, FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createContextFactory } from "../src/streaming/context.js";
import type { CreateSearchStreamContextOptions } from "../src/streaming/context.js";
import type { StreamRedisReader } from "../src/streaming/redisStreams.js";

/**
 * S38.5 — per-request context factory wiring. Every service-touching dependency arrives
 * injected with NO default (`blockTimeoutMs` and `nonceSecret` deliberately carry none —
 * a default would be an unwritten numeric-policy decision, gate 14); `sessionId` comes
 * from the S16.16 session plugin's request decoration.
 */

const state = vi.hoisted(() => {
  const readers: { url: string | undefined; logger: unknown }[] = [];
  return { readers };
});

vi.mock("../src/streaming/redisStreams.js", () => ({
  openSearchStreamReader: (url: string, logger?: unknown) => {
    state.readers.push({ url, logger });
    // No reader behavior is under test here — only what wiring the factory hands it.
    return {
      readBlocked: () => Promise.reject(new Error("not expected in this suite")),
      close: () => undefined,
    } satisfies StreamRedisReader;
  },
}));

function makeOpts(): CreateSearchStreamContextOptions & {
  db: {
    query: ReturnType<
      typeof vi.fn<
        (text: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
      >
    >;
  };
} {
  return {
    db: { query: vi.fn(() => Promise.resolve({ rows: [] as Record<string, unknown>[] })) },
    redisUrl: "redis://streams.example.invalid:6379",
    blockTimeoutMs: 15_000,
    providerHostAllowlists: { amc: ["example.invalid"] },
    nonceSecret: "s38-test-nonce-secret",
  };
}

function makeReq(
  session: {
    sessionId: string | undefined;
    clientIp: string | undefined;
    asn: string | undefined;
  } | null,
): FastifyRequest {
  return {
    session,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeRes(): FastifyReply & {
  raw: { write: ReturnType<typeof vi.fn>; destroyed: boolean; writableEnded: boolean };
} {
  const raw = {
    write: vi.fn(),
    destroyed: false,
    writableEnded: false,
  };
  return { raw } as unknown as FastifyReply & { raw: typeof raw };
}

const SESSION = {
  sessionId: "sess_ctx",
  clientIp: undefined,
  asn: undefined,
} as const;

beforeEach(() => {
  state.readers.length = 0;
});

describe("createContextFactory", () => {
  it("derives sessionId from the request's session-plugin decoration", () => {
    const factory = createContextFactory(makeOpts());
    expect(factory(makeReq(SESSION), makeRes()).sessionId).toBe("sess_ctx");
  });

  it("yields sessionId undefined when no valid signed cookie was presented", () => {
    const factory = createContextFactory(makeOpts());
    expect(factory(makeReq(null), makeRes()).sessionId).toBeUndefined();
  });

  it("surfaces the injected members unchanged on every per-request context", () => {
    const opts = makeOpts();
    const factory = createContextFactory(opts);

    const first = factory(makeReq(SESSION), makeRes());
    const second = factory(makeReq(null), makeRes());

    expect(first.db).toBe(opts.db);
    expect(second.db).toBe(opts.db);
    expect(first.blockTimeoutMs).toBe(15_000);
    expect(first.nonceSecret).toBe("s38-test-nonce-secret");
    expect(first.revealPayloadSchema).toBe(second.revealPayloadSchema);
    expect(typeof first.openStreamReader).toBe("function");
    expect(typeof first.keepAlive).toBe("function");
  });

  it("opens the reader against the injected Redis URL with this request's logger", () => {
    const opts = makeOpts();
    const factory = createContextFactory(opts);
    const req = makeReq(SESSION);

    const ctx = factory(req, makeRes());
    ctx.openStreamReader();

    expect(state.readers).toHaveLength(1);
    expect(state.readers[0]?.url).toBe("redis://streams.example.invalid:6379");
    expect(state.readers[0]?.logger).toBe(req.log);
  });

  it("binds keepAlive to this request's raw response and stays silent once it is gone", () => {
    const factory = createContextFactory(makeOpts());
    const res = makeRes();

    const ctx = factory(makeReq(SESSION), res);
    ctx.keepAlive();
    expect(res.raw.write.mock.calls).toEqual([[": keepalive\n\n"]]);

    res.raw.destroyed = true;
    ctx.keepAlive();
    expect(res.raw.write.mock.calls).toHaveLength(1);
  });

  it("fails at wiring time when the required options are absent — no defaults exist", () => {
    expect(() => createContextFactory({} as unknown as CreateSearchStreamContextOptions)).toThrow();
  });
});
