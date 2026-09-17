import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The trpc client reads EXPO_PUBLIC_API_URL at import time; lock it for this
// suite so the captured request URLs are deterministic.
process.env.EXPO_PUBLIC_API_URL = "http://localhost:3000";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("trpc bespoke routes use plain httpLink", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- trpcClient is a value export; typeof import() is the idiomatic way to reference its type without a separate type export
  let trpcClient: (typeof import("@/lib/trpc"))["trpcClient"];

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // single envelope object. Return the matching shape so the link's response
      // parser does not throw before we inspect the outbound request.
      if (url.includes("batch=1")) {
        return jsonResponse([{ result: { data: { ok: true } } }]);
      }
      return jsonResponse({ result: { data: { status: "AVAILABLE" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("@/lib/trpc");
    trpcClient = mod.trpcClient;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("showtimes.recheck posts plain input without batch envelope", async () => {
    const input = {
      searchId: "srch_transport_test",
      showtimeId: "amc:showtime:146024502",
      placementKey: "9b03725197304af8",
      nonce: "nonce-transport",
    };

    // The mock fetch returns 200 before the server's zod validation runs, so
    // the outbound request shape is captured deterministically.
    await trpcClient.showtimes.recheck.mutate(input as never).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const urlStr = String(url);

    // Bespoke showtimes.recheck is mounted ahead of fastifyTRPCPlugin's
    // batch-aware catch-all (registerShowtimesRecheck) and only understands
    // the plain JSON body. It must not be sent via httpBatchLink.
    expect(urlStr).not.toContain("batch=1");
    expect(urlStr).toContain("showtimes.recheck");

    const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("0");
    expect(body).toEqual(input);
  });

  it("searches.get queries plain without batch envelope", async () => {
    await trpcClient.searches.get.query({ searchId: "srch_transport_test" }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain("batch=1");
    expect(String(url)).toContain("searches.get");
  });

  it("searches.create uses the batch envelope (control)", async () => {
    const spec = {
      specVersion: 1 as const,
      providerId: "amc" as const,
      theatres: { kind: "LIST" as const, refs: [{ id: "amc:theatre:4145" }] },
      where: {
        kind: "AND" as const,
        of: [
          { kind: "MOVIE" as const, ids: ["amc:movie:82975"] },
          { kind: "DATE_RANGE" as const, from: "2026-08-28", to: "2026-08-28" },
        ],
      },
      aggregation: { reduce: "COUNT" as const, threshold: { kind: "NONE" as const } },
      group: { kind: "RUN" as const, count: 2 },
      groupStrict: false,
      rank: "SCORE" as const,
    };

    await trpcClient.searches.create
      .mutate({ spec, idempotencyKey: "idem-transport" })
      .catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const urlStr = String(url);
    // All non-bespoke mutations go through the batch-aware catch-all.
    expect(urlStr).toContain("batch=1");
    const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
    expect(body).toHaveProperty("0");
  });
});

describe("production web build resolves the API relatively (ADR 0055)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- same idiom as the suite above: typeof import() references the value export's type without a separate type export
  type TrpcModule = typeof import("@/lib/trpc");

  async function importTrpcWithEnv(env: Record<string, string | undefined>): Promise<TrpcModule> {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else vi.stubEnv(key, value);
    }
    fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("batch=1")) {
        return jsonResponse([{ result: { data: { ok: true } } }]);
      }
      return jsonResponse({ result: { data: { status: "AVAILABLE" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return import("@/lib/trpc");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("empty EXPO_PUBLIC_API_URL in a production browser build yields a relative /trpc endpoint", async () => {
    const mod = await importTrpcWithEnv({ EXPO_PUBLIC_API_URL: "", NODE_ENV: "production" });

    expect(mod.getTrpcUrl()).toBe("/trpc");
  });

  it("unset EXPO_PUBLIC_API_URL in a production browser build yields a relative /trpc endpoint", async () => {
    const mod = await importTrpcWithEnv({ EXPO_PUBLIC_API_URL: undefined, NODE_ENV: "production" });

    expect(mod.getTrpcUrl()).toBe("/trpc");
  });

  it("an explicit EXPO_PUBLIC_API_URL still wins in production builds", async () => {
    const mod = await importTrpcWithEnv({
      EXPO_PUBLIC_API_URL: "https://api.example.com/",
      NODE_ENV: "production",
    });

    expect(mod.getTrpcUrl()).toBe("https://api.example.com/trpc");
  });

  it("empty EXPO_PUBLIC_API_URL outside production keeps the localhost dev default", async () => {
    const mod = await importTrpcWithEnv({ EXPO_PUBLIC_API_URL: "", NODE_ENV: "test" });

    expect(mod.getTrpcUrl()).toBe("http://localhost:3000/trpc");
  });

  it("queries against the relative endpoint send credentials: include", async () => {
    const mod = await importTrpcWithEnv({ EXPO_PUBLIC_API_URL: "", NODE_ENV: "production" });
    expect(mod.getTrpcUrl()).toBe("/trpc");

    await mod.trpcClient.searches.get.query({ searchId: "srch_relative" }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const urlStr = String(url);
    // Same-origin: the request line carries no scheme/host at all.
    expect(urlStr.startsWith("/trpc")).toBe(true);
    expect(urlStr).not.toContain("localhost");
    expect(urlStr).toContain("searches.get");
    // The browser still presents the first-party session cookie (UI2/UI3.8).
    expect(init.credentials).toBe("include");
  });

  it("SSE subscriptions open the relative endpoint with withCredentials: true", async () => {
    const mod = await importTrpcWithEnv({ EXPO_PUBLIC_API_URL: "", NODE_ENV: "production" });
    expect(mod.getTrpcUrl()).toBe("/trpc");

    const seen: Array<{ url: string | URL; init: { withCredentials?: boolean } | undefined }> = [];
    class FakeEventSource {
      constructor(url: string | URL, init?: { withCredentials?: boolean }) {
        seen.push({ url, init });
      }
      addEventListener(..._args: unknown[]): void {
        void _args;
      }
      removeEventListener(..._args: unknown[]): void {
        void _args;
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);

    const sub = mod.trpcClient.searches.onProgress.subscribe(
      { searchId: "srch_relative_sse" },
      { onData: () => undefined, onError: () => undefined },
    );
    try {
      // The subscription link constructs the EventSource asynchronously.
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

      const urlStr = String(seen[0]?.url);
      expect(urlStr.startsWith("/trpc/")).toBe(true);
      expect(urlStr).not.toContain("localhost");
      expect(urlStr).toContain("searches.onProgress");
      expect(seen[0]?.init).toMatchObject({ withCredentials: true });
    } finally {
      sub.unsubscribe();
    }
  });
});
