import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCClientError } from "@trpc/client";

import { isUnauthorizedError, _resetRenewalForTest } from "./session";

describe("isUnauthorizedError", () => {
  it("detects TRPCClientError with data.code UNAUTHORIZED", () => {
    const err = new TRPCClientError("UNAUTHORIZED");
    (err as unknown as { data: { code: string } }).data = { code: "UNAUTHORIZED" };
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it("detects shape.data.code UNAUTHORIZED", () => {
    const err = new TRPCClientError("error");
    (err as unknown as { shape: { data: { code: string } } }).shape = {
      data: { code: "UNAUTHORIZED" },
    };
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it("detects plain object with data.code", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED" } })).toBe(true);
  });

  it("returns false for other codes", () => {
    expect(isUnauthorizedError({ data: { code: "NOT_FOUND" } })).toBe(false);
    expect(isUnauthorizedError(new Error("something"))).toBe(false);
  });
});

describe("renewSession", () => {
  beforeEach(() => {
    _resetRenewalForTest();
    vi.resetModules();
  });

  it("calls bootstrap and updates store", async () => {
    const mockBootstrap = vi.fn().mockResolvedValue({
      sessionId: "sess_new",
      limits: {
        searchesPerHour: 10,
        upstreamFetchesPerHour: 20,
        concurrentSearches: 5,
        recheckCallsPerMinute: 10,
        facetCountsPerMinute: 120,
        resolvePlacePerMinute: 10,
      },
    });
    vi.doMock("./trpc", () => {
      // UI11: the vanilla client export is now named `trpcClient`; both keys share one mock.
      const api = { session: { bootstrap: { mutate: mockBootstrap } } };
      return { trpc: api, trpcClient: api };
    });
    const { renewSession } = await import("./session");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");
    useSeatfirstStore.setState({
      bootstrapReady: false,
      sessionId: null,
      limits: null,
    } as never);

    await renewSession();

    expect(mockBootstrap).toHaveBeenCalledTimes(1);
    const state = useSeatfirstStore.getState();
    expect(state.sessionId).toBe("sess_new");
    expect(state.bootstrapReady).toBe(true);
  });

  it("deduplicates concurrent calls", async () => {
    let callCount = 0;
    const mockBootstrap = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        sessionId: "sess_new",
        limits: {
          searchesPerHour: 10,
          upstreamFetchesPerHour: 20,
          concurrentSearches: 5,
          recheckCallsPerMinute: 10,
          facetCountsPerMinute: 120,
          resolvePlacePerMinute: 10,
        },
      };
    });
    vi.doMock("./trpc", () => {
      const api = { session: { bootstrap: { mutate: mockBootstrap } } };
      return { trpc: api, trpcClient: api };
    });
    const { renewSession } = await import("./session");
    const p1 = renewSession();
    const p2 = renewSession();
    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });
});
