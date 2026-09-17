import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";

vi.mock("@/lib/trpc", () => {
  const g = globalThis as unknown as {
    __mockGetQuery?: Mock<(...args: unknown[]) => unknown>;
    __mockSubscribe?: Mock<(...args: unknown[]) => unknown>;
  };
  if (!g.__mockGetQuery) g.__mockGetQuery = vi.fn();
  if (!g.__mockSubscribe) g.__mockSubscribe = vi.fn();
  // UI11: the vanilla client export is now named `trpcClient`; both keys share one mock.
  const api = {
    searches: {
      create: { mutate: vi.fn() },
      get: { query: (...a: unknown[]) => g.__mockGetQuery!(...a) },
      cancel: { mutate: vi.fn() },
      onProgress: { subscribe: (...a: unknown[]) => g.__mockSubscribe!(...a) },
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

function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = { current: undefined as unknown as T };
  function HookComp(): React.JSX.Element | null {
    result.current = hook();
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(HookComp));
  });
  return { result };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function getAppStateHandlers(): Array<(s: string) => void> {
  const g = globalThis as unknown as { __rntlAppStateHandlers?: Array<(s: string) => void> };
  if (!g.__rntlAppStateHandlers) g.__rntlAppStateHandlers = [];
  return g.__rntlAppStateHandlers;
}

function getMockGetQuery(): Mock<(...args: unknown[]) => unknown> {
  const g = globalThis as unknown as { __mockGetQuery?: Mock<(...args: unknown[]) => unknown> };
  if (!g.__mockGetQuery) g.__mockGetQuery = vi.fn();
  return g.__mockGetQuery;
}

function getMockSubscribe(): Mock<(...args: unknown[]) => unknown> {
  const g = globalThis as unknown as { __mockSubscribe?: Mock<(...args: unknown[]) => unknown> };
  if (!g.__mockSubscribe) g.__mockSubscribe = vi.fn();
  return g.__mockSubscribe;
}

describe("UI9.6 foreground resume — AppState background/active (real hook)", () => {
  beforeEach(() => {
    resetStore();
    vi.resetAllMocks();
    getAppStateHandlers().length = 0;
    const mockGetQuery = getMockGetQuery();
    const mockSubscribe = getMockSubscribe();
    mockGetQuery.mockReset();
    mockSubscribe.mockReset();
    mockGetQuery.mockResolvedValue({
      searchId: "srch_1",
      status: "RUNNING",
      resolved: 3,
      total: 10,
      groups: [],
      answer: null,
    });
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  });

  it("active → background → active while RUNNING triggers exactly one searches.get reconciliation then resubscribe with lastEventId", async () => {
    const mockGetQuery = getMockGetQuery();
    const mockSubscribe = getMockSubscribe();
    let subscribeCallInput: unknown = null;
    mockSubscribe.mockImplementation((input: unknown) => {
      subscribeCallInput = input;
      return { unsubscribe: vi.fn() };
    });

    renderHook(() => useSearchSubscription());
    useSeatfirstStore.setState({
      searchId: "srch_1",
      status: "RUNNING",
      phase: "streaming",
      lastEventId: "5-0",
    });
    await flush();
    expect(getAppStateHandlers().length).toBe(1);
    const handler = getAppStateHandlers()[0]!;
    mockGetQuery.mockClear();
    mockSubscribe.mockClear();

    act(() => {
      handler("background");
    });
    await act(async () => {
      handler("active");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(mockGetQuery).toHaveBeenCalledTimes(1);
    expect(mockGetQuery).toHaveBeenCalledWith({ searchId: "srch_1" });
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeCallInput).toMatchObject({ searchId: "srch_1", lastEventId: "5-0" });
    const phase = useSeatfirstStore.getState().phase;
    expect(["streaming", "reconciling", "polling", "terminal"]).toContain(phase);
  });

  it("foreground resume when already terminal does not re-open subscription", async () => {
    const mockGetQuery = getMockGetQuery();
    const mockSubscribe = getMockSubscribe();
    useSeatfirstStore.setState({ searchId: "srch_9", status: "COMPLETE", phase: "terminal" });
    renderHook(() => useSearchSubscription());
    await flush();
    expect(getAppStateHandlers().length).toBe(1);
    const handler = getAppStateHandlers()[0]!;
    mockGetQuery.mockClear();
    mockSubscribe.mockClear();

    act(() => {
      handler("background");
    });
    await act(async () => {
      handler("active");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(mockGetQuery).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rapid background→active→background→active does not double-fire excessively (real hook prev tracking)", async () => {
    const mockGetQuery = getMockGetQuery();
    useSeatfirstStore.setState({ searchId: "srch_1", status: "RUNNING", phase: "streaming" });
    renderHook(() => useSearchSubscription());
    await flush();
    expect(getAppStateHandlers().length).toBe(1);
    const handler = getAppStateHandlers()[0]!;
    mockGetQuery.mockClear();

    await act(async () => {
      handler("background");
      handler("active");
      handler("background");
      handler("active");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(mockGetQuery.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockGetQuery.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("resume after process kill — no in-memory searchId — is a no-op", async () => {
    const mockGetQuery = getMockGetQuery();
    const mockSubscribe = getMockSubscribe();
    resetStore();
    renderHook(() => useSearchSubscription());
    await flush();
    expect(getAppStateHandlers().length).toBe(1);
    const handler = getAppStateHandlers()[0]!;
    mockGetQuery.mockClear();
    mockSubscribe.mockClear();

    act(() => {
      handler("background");
    });
    await act(async () => {
      handler("active");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(mockGetQuery).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});
