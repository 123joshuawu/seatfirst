import { afterEach, describe, expect, it, vi } from "vitest";
import { observable } from "@trpc/server/observable";

import {
  devTransportLink,
  getDevTransportHandler,
  onDevTransportChange,
  setDevTransportHandler,
  type DevTransportHandler,
} from "./devTransport";
import { readTrpcErrorCode, readTrpcErrorExtras } from "./errorEnvelope";

/**
 * The link is the seam every mocked API state flows through, so its three outcomes —
 * pass-through, terminate with data, terminate with an error the app can read — are
 * pinned here rather than only exercised through the UI.
 */
type LinkArgs = Parameters<ReturnType<typeof devTransportLink>>[0];

const passthroughNext = (() =>
  observable((observer) => {
    observer.next({ result: { data: "from-network" } });
    observer.complete();
  })) as unknown as LinkArgs["next"];

afterEach(() => {
  setDevTransportHandler(null);
  vi.useRealTimers();
});

describe("devTransportLink", () => {
  it("passes through when no handler is installed", async () => {
    expect(getDevTransportHandler()).toBeNull();
    const received: unknown[] = [];
    const op = { path: "theatres.search", type: "query", input: undefined, id: 1, context: {} };
    devTransportLink({})({ op, next: passthroughNext } as unknown as LinkArgs).subscribe({
      next: (value) => received.push(value),
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ result: { data: "from-network" } });
  });

  it("passes through when the handler declines the operation", async () => {
    setDevTransportHandler(() => null);
    const received: unknown[] = [];
    const op = { path: "searches.onProgress", type: "query", input: undefined, id: 1, context: {} };
    devTransportLink({})({ op, next: passthroughNext } as unknown as LinkArgs).subscribe({
      next: (value) => received.push(value),
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
  });

  it("terminates with fixture data instead of reaching the network", async () => {
    const networkNext = vi.fn(passthroughNext);
    setDevTransportHandler(() => ({ kind: "data", data: { theatres: [] } }));
    const received: unknown[] = [];
    let completed = false;
    const op = { path: "theatres.search", type: "query", input: undefined, id: 1, context: {} };
    devTransportLink({})({
      op,
      next: networkNext as unknown as LinkArgs["next"],
    } as unknown as LinkArgs).subscribe({
      next: (value) => received.push(value),
      complete: () => {
        completed = true;
      },
    });
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(received[0]).toEqual({ result: { data: { theatres: [] } } });
    expect(networkNext).not.toHaveBeenCalled();
  });

  it("emits an error the app's own envelope readers can parse", async () => {
    const handler: DevTransportHandler = () => ({
      kind: "error",
      code: "ADMISSION_REJECTED",
      message: "Too many searches in flight",
      extras: { retryAfterSeconds: 30 },
    });
    setDevTransportHandler(handler);
    const errors: unknown[] = [];
    const op = { path: "searches.create", type: "mutation", input: undefined, id: 1, context: {} };
    devTransportLink({})({
      op,
      next: passthroughNext,
    } as unknown as LinkArgs).subscribe({
      error: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(readTrpcErrorCode(errors[0])).toBe("ADMISSION_REJECTED");
    expect(readTrpcErrorExtras(errors[0])).toEqual({ retryAfterSeconds: 30 });
    expect((errors[0] as Error).message).toBe("Too many searches in flight");
  });

  it("never settles for a pending result, which is the loading state", async () => {
    setDevTransportHandler(() => ({ kind: "pending" }));
    let settled = false;
    const op = { path: "theatres.search", type: "query", input: undefined, id: 1, context: {} };
    devTransportLink({})({
      op,
      next: passthroughNext,
    } as unknown as LinkArgs).subscribe({
      next: () => {
        settled = true;
      },
      error: () => {
        settled = true;
      },
      complete: () => {
        settled = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  });

  it("notifies listeners when transport handler changes and unsubscribes cleanly", () => {
    const fn = vi.fn();
    const unsubscribe = onDevTransportChange(fn);

    setDevTransportHandler(() => null);
    expect(fn).toHaveBeenCalledTimes(1);

    setDevTransportHandler(() => ({ kind: "pending" }));
    expect(fn).toHaveBeenCalledTimes(2);

    unsubscribe();
    setDevTransportHandler(null);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
