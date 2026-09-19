import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCClientError } from "@trpc/client";
import type { Operation } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { Observable } from "@trpc/server/observable";

import { _resetRenewalForTest } from "./session";

function makeError(code: string): TRPCClientError<never> {
  const err = new TRPCClientError(code);
  (err as unknown as { data: { code: string } }).data = { code };
  return err;
}

type NextFn = (op: Operation) => Observable<unknown, TRPCClientError<never>>;

describe("unauthorizedRetryLink", () => {
  beforeEach(() => {
    _resetRenewalForTest();
    vi.resetModules();
  });

  it("retries once on UNAUTHORIZED and succeeds", async () => {
    const mockRenew = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./session", async () => {
      const actual = await vi.importActual("./session");
      return { ...actual, renewSession: mockRenew };
    });

    // Need to re-import the link after mocking session
    const { unauthorizedRetryLink: freshLink } = await import("./trpc");

    let callCount = 0;
    const next = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return observable<string, TRPCClientError<never>>((observer) => {
          observer.error(makeError("UNAUTHORIZED"));
          return { unsubscribe: () => {} };
        });
      }
      return observable<string, TRPCClientError<never>>((observer) => {
        observer.next("ok");
        observer.complete();
        return { unsubscribe: () => {} };
      });
    }) as unknown as NextFn;

    const link = freshLink({});
    const op = { path: "searches.create", type: "mutation", input: {} } as never;
    const result = await new Promise<string>((resolve, reject) => {
      link({ op, next }).subscribe({
        next: (v) => resolve(v as unknown as string),
        error: (e) => reject(e),
        complete: () => {},
      });
    });

    expect(result).toBe("ok");
    expect(mockRenew).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
  });

  it("does not retry on non-UNAUTHORIZED", async () => {
    const mockRenew = vi.fn();
    vi.doMock("./session", async () => {
      const actual = await vi.importActual("./session");
      return { ...actual, renewSession: mockRenew };
    });
    const { unauthorizedRetryLink: freshLink } = await import("./trpc");

    const next = vi.fn(() =>
      observable<string, TRPCClientError<never>>((observer) => {
        observer.error(makeError("NOT_FOUND"));
        return { unsubscribe: () => {} };
      }),
    ) as unknown as NextFn;

    const link = freshLink({});
    const op = { path: "searches.create", type: "mutation", input: {} } as never;

    await expect(
      new Promise<string>((resolve, reject) => {
        link({ op, next }).subscribe({
          next: (v) => resolve(v as unknown as string),
          error: (e) => reject(e),
          complete: () => {},
        });
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

    expect(mockRenew).not.toHaveBeenCalled();
  });

  it("does not retry session.bootstrap itself", async () => {
    const mockRenew = vi.fn();
    vi.doMock("./session", async () => {
      const actual = await vi.importActual("./session");
      return { ...actual, renewSession: mockRenew };
    });
    const { unauthorizedRetryLink: freshLink } = await import("./trpc");

    const next = vi.fn(() =>
      observable<string, TRPCClientError<never>>((observer) => {
        observer.error(makeError("UNAUTHORIZED"));
        return { unsubscribe: () => {} };
      }),
    ) as unknown as NextFn;

    const link = freshLink({});
    const op = { path: "session.bootstrap", type: "mutation", input: {} } as never;
    await expect(
      new Promise<string>((resolve, reject) => {
        link({ op, next }).subscribe({
          next: (v) => resolve(v as unknown as string),
          error: (e) => reject(e),
          complete: () => {},
        });
      }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });

    expect(mockRenew).not.toHaveBeenCalled();
  });

  it("only retries once, then surfaces second UNAUTHORIZED", async () => {
    const mockRenew = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./session", async () => {
      const actual = await vi.importActual("./session");
      return { ...actual, renewSession: mockRenew };
    });
    const { unauthorizedRetryLink: freshLink } = await import("./trpc");

    let callCount = 0;
    const next = vi.fn(() => {
      callCount++;
      return observable<string, TRPCClientError<never>>((observer) => {
        observer.error(makeError("UNAUTHORIZED"));
        return { unsubscribe: () => {} };
      });
    }) as unknown as NextFn;

    const link = freshLink({});
    const op = { path: "searches.create", type: "mutation", input: {} } as never;
    await expect(
      new Promise<string>((resolve, reject) => {
        link({ op, next }).subscribe({
          next: (v) => resolve(v as unknown as string),
          error: (e) => reject(e),
          complete: () => {},
        });
      }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });

    expect(mockRenew).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
  });
});

describe("httpBatchLink maxURLLength (batched 414 split fix)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("splits a 16-query theatres.movies batch into multiple fetches within the cap", async () => {
    const fetchedUrls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      // One envelope per batched op, sized from the request's own `input`
      // param — the same shape `httpBatchLink` parses back.
      const batchInput = JSON.parse(new URL(url).searchParams.get("input") ?? "{}") as Record<
        string,
        unknown
      >;
      const body = Object.keys(batchInput).map(() => ({
        result: {
          data: {
            theatreId: "amc:theatre:1",
            timezone: "America/Denver",
            from: "2026-09-19",
            to: "2026-09-19",
            movies: [],
          },
        },
      }));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.doMock("./cookieJar", () => ({ cookieAwareFetch: mockFetch }));

    // Fresh client so the shipped `httpBatchLink` config (not a re-typed
    // copy) is what batches these queries.
    const { trpcClient: freshClient, TRPC_BATCH_MAX_URL_LENGTH } = await import("./trpc");
    const moviesQuery = (
      freshClient.theatres as unknown as {
        movies: {
          query: (input: { theatreId: string; from: string; to: string }) => Promise<unknown>;
        };
      }
    ).movies.query;
    // A large multi-theatre selection queued in the same tick so the batch
    // link coalesces it. (Measured: 12 short-id `theatres.movies` queries are
    // ~1700 chars — under the cap, one request. 16 exceed it, so the link must
    // split instead of emitting a single giant URL.)
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        moviesQuery({
          theatreId: `amc:theatre:${i + 1}`,
          from: "2026-09-19",
          to: "2026-09-19",
        }),
      ),
    );

    // Without `maxURLLength` this is a single giant URL (the 414); with the
    // cap it must split into sequential requests, each within the cap.
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    expect(results).toHaveLength(16);
    for (const url of fetchedUrls) {
      expect(url.length).toBeLessThanOrEqual(TRPC_BATCH_MAX_URL_LENGTH);
    }
  });
});
