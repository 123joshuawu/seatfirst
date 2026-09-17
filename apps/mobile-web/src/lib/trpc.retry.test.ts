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
