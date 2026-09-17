import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";

const mockCreateMutate = vi.fn<(...args: unknown[]) => unknown>();
const mockGetQuery = vi.fn<(...args: unknown[]) => unknown>();
const mockSubscribe = vi.fn<(...args: unknown[]) => unknown>();
const mockCancelMutate = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("@/lib/trpc", () => {
  // UI11: the vanilla client export is now named `trpcClient`; both keys share one mock.
  const api = {
    searches: {
      create: { mutate: (...args: unknown[]) => mockCreateMutate(...args) },
      get: { query: (...args: unknown[]) => mockGetQuery(...args) },
      cancel: { mutate: (...args: unknown[]) => mockCancelMutate(...args) },
      onProgress: { subscribe: (...args: unknown[]) => mockSubscribe(...args) },
    },
    session: { bootstrap: { mutate: vi.fn() } },
    theatres: { search: { query: vi.fn() }, movies: { query: vi.fn() } },
    showtimes: { recheck: { mutate: vi.fn() } },
  };
  return {
    trpc: api,
    trpcClient: api,
    getTrpcUrl: () => "http://localhost:3000/trpc",
    queryClient: { clear: vi.fn() },
  };
});

import { useSearchSubscription } from "@/hooks/useSearchSubscription";

function fakeSpec(): unknown {
  return {
    specVersion: 1,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: "theatre:1" }] },
    where: { kind: "MOVIE", ids: ["movie:1"] },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
  };
}

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
  });
}

function terminalResult(status: "COMPLETE" | "PARTIAL" | "HALTED", searchId = "srch_1") {
  return {
    searchId,
    status,
    resolved: 10,
    total: 10,
    groups: [],
    answer:
      status === "HALTED"
        ? { mode: "EMPTY" as const, cause: "HALTED" as const, suggestions: [] }
        : status === "PARTIAL"
          ? { mode: "HEDGED" as const, recommendations: [] }
          : null,
  };
}

function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as unknown as T };
  function HookComp(): React.JSX.Element | null {
    result.current = hook();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HookComp));
  });
  return {
    result,
    unmount: () => void act(() => renderer.unmount()),
  };
}

describe("UI9.3 race: terminal-before-subscribe", () => {
  beforeEach(() => {
    resetStore();
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("COMPLETE via get — subscription not opened redundantly, view-model shows terminal", async () => {
    mockCreateMutate.mockResolvedValue({ searchId: "srch_1", status: "PENDING_SCHEDULE" });
    mockGetQuery.mockResolvedValue(terminalResult("COMPLETE"));

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const s = useSeatfirstStore.getState();
    expect(s.status).toBe("COMPLETE");
    expect(s.phase).toBe("terminal");
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockGetQuery).toHaveBeenCalledWith({ searchId: "srch_1" });
  });

  it("PARTIAL via get — reconciles to terminal without subscribing", async () => {
    mockCreateMutate.mockResolvedValue({ searchId: "srch_2", status: "RUNNING" });
    mockGetQuery.mockResolvedValue(terminalResult("PARTIAL", "srch_2"));

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const s = useSeatfirstStore.getState();
    expect(s.status).toBe("PARTIAL");
    expect(s.phase).toBe("terminal");
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("HALTED via get — terminal banner path, no redundant subscription", async () => {
    mockCreateMutate.mockResolvedValue({ searchId: "srch_3", status: "RUNNING" });
    mockGetQuery.mockResolvedValue(terminalResult("HALTED", "srch_3"));

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const s = useSeatfirstStore.getState();
    expect(s.status).toBe("HALTED");
    expect(s.phase).toBe("terminal");
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("CANCELLED via SSE terminal envelope — not served by get, arrives via onProgress", async () => {
    mockCreateMutate.mockResolvedValue({ searchId: "srch_4", status: "RUNNING" });
    mockGetQuery
      .mockResolvedValueOnce({
        searchId: "srch_4",
        status: "RUNNING",
        resolved: 2,
        total: 10,
        groups: [],
        answer: null,
      })
      .mockResolvedValueOnce({
        searchId: "srch_4",
        status: "CANCELLED",
        resolved: 3,
        total: 8,
        groups: [],
        answer: null,
      });
    let capturedOnData: ((e: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((...args: unknown[]) => {
      const [, handlers] = args as [unknown, { onData: (e: unknown) => void }];
      capturedOnData = handlers.onData;
      return { unsubscribe: vi.fn() };
    });

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(capturedOnData).not.toBeNull();
    await act(async () => {
      capturedOnData!({
        id: "1-0",
        data: { type: "SEARCH_TERMINAL", payload: { status: "CANCELLED", answer: null } },
      });
      await vi.runAllTimersAsync();
    });

    const s = useSeatfirstStore.getState();
    expect(s.status).toBe("CANCELLED");
    expect(s.phase).toBe("terminal");
    expect(s.resolved).toBe(3);
    expect(s.total).toBe(8);
    expect(mockGetQuery).toHaveBeenCalledTimes(2);
  });

  it("ADMISSION_REJECTED 429 surfaces without retry — error.code preserved, no get retry", async () => {
    const err = Object.assign(new Error("capacity"), {
      data: { code: "ADMISSION_REJECTED", retryAfterSeconds: 30 },
    });
    mockCreateMutate.mockRejectedValue(err);

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const s = useSeatfirstStore.getState();
    expect(s.error?.code).toBe("ADMISSION_REJECTED");
    expect(s.error?.retryAfterSeconds).toBe(30);
    expect(mockGetQuery).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});
