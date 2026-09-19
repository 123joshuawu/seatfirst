import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetQuery = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    searches: {
      get: {
        query: (...args: unknown[]) => mockGetQuery(...args),
      },
    },
  },
}));

import { MAX_CONSECUTIVE_POLL_FAILURES, startPolling } from "./polling";

function pendingResult(status: string): unknown {
  return { status, searchId: "srch_1" };
}

describe("startPolling — consecutive-failure exhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetQuery.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stops polling after N consecutive failures instead of retrying forever", async () => {
    mockGetQuery.mockRejectedValue(new Error("Internal server error"));
    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = startPolling("srch_1", { intervalMs: 2000, onResult, onError });

    // Immediate tick + enough intervals to exceed any unbounded retry loop.
    await vi.advanceTimersByTimeAsync(2000 * 10);
    stop();

    expect(mockGetQuery.mock.calls.length).toBe(MAX_CONSECUTIVE_POLL_FAILURES);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError.mock.calls.length).toBe(MAX_CONSECUTIVE_POLL_FAILURES);
    // Transient ticks report exhausted=false; only the final giving-up tick is exhausted.
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES - 1; i += 1) {
      expect(onError.mock.calls[i]?.[1]).toBe(false);
    }
    expect(onError.mock.calls[MAX_CONSECUTIVE_POLL_FAILURES - 1]?.[1]).toBe(true);
  });

  it("resets the consecutive-failure counter on any successful tick", async () => {
    mockGetQuery
      .mockRejectedValueOnce(new Error("blip 1"))
      .mockRejectedValueOnce(new Error("blip 2"))
      .mockResolvedValueOnce(pendingResult("RUNNING"))
      .mockRejectedValue(new Error("down again"));
    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = startPolling("srch_1", { intervalMs: 2000, onResult, onError });

    // Immediate tick (fail 1) + interval (fail 2) + interval (success resets) +
    // two more failures — still below the consecutive budget, so no exhaustion.
    await vi.advanceTimersByTimeAsync(2000 * 4);
    stop();

    expect(onResult).toHaveBeenCalledTimes(1);
    const exhaustedCalls = onError.mock.calls.filter((c) => c[1] === true);
    expect(exhaustedCalls.length).toBe(0);
    expect(onError.mock.calls.length).toBe(4);
  });

  it("still stops on terminal status without reporting an error", async () => {
    mockGetQuery.mockResolvedValue(pendingResult("COMPLETE"));
    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = startPolling("srch_1", { intervalMs: 2000, onResult, onError });

    await vi.advanceTimersByTimeAsync(2000 * 5);
    stop();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(mockGetQuery.mock.calls.length).toBe(1);
  });
});
