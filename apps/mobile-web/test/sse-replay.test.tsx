import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  LAST_EVENT_ID_PATTERN,
  entryIdForSeq,
  cursorAfterSeq,
  isValidLastEventId,
  makeSseEnvelope,
  dedupeById,
} from "./mocks/sse";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";

const { mockCreate, mockGet, mockSubscribe, mockStartPolling } = vi.hoisted(() => {
  const c = vi.fn<(...args: unknown[]) => unknown>();
  const g = vi.fn<(...args: unknown[]) => unknown>();
  const s = vi.fn<(...args: unknown[]) => unknown>();
  const p = vi.fn<(...args: unknown[]) => unknown>(() => () => {});
  return { mockCreate: c, mockGet: g, mockSubscribe: s, mockStartPolling: p };
});
vi.mock("@/lib/trpc", () => {
  // UI11: the vanilla client export is now named `trpcClient`; both keys share one mock.
  const api = {
    searches: {
      create: { mutate: (...a: unknown[]) => mockCreate(...a) },
      get: { query: (...a: unknown[]) => mockGet(...a) },
      cancel: { mutate: vi.fn() },
      onProgress: { subscribe: (...a: unknown[]) => mockSubscribe(...a) },
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

vi.mock("@/lib/polling", () => ({
  startPolling: (...a: unknown[]) => mockStartPolling(...a),
}));

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

describe("UI9.4 SSE cursor replay and dedup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clean connect with no lastEventId receives seq 1..N", () => {
    expect(cursorAfterSeq(undefined)).toBe(0n);
    const envelopes = [1, 2, 3].map((seq) => makeSseEnvelope(seq, { resolved: seq }));
    expect(envelopes.map((e) => e.id)).toEqual(["1-0", "2-0", "3-0"]);
    for (const e of envelopes) {
      expect(isValidLastEventId(e.id)).toBe(true);
    }
  });

  it("disconnect after seq K, reconnect with lastEventId K-0 receives only seq > K and dedups seq <= K", () => {
    const K = 3;
    const seen = new Set<string>();
    const firstBatch = [1, 2, 3].map((s) => makeSseEnvelope(s, { resolved: s }));
    for (const e of firstBatch) seen.add(e.id);

    const lastEventId = entryIdForSeq(K);
    expect(isValidLastEventId(lastEventId)).toBe(true);
    expect(cursorAfterSeq(lastEventId)).toBe(BigInt(K));

    const resend = [1, 2, 3, 4, 5].map((s) => makeSseEnvelope(s, { resolved: s }));
    const toApply = resend.filter((e) => {
      const seqNum = Number(e.id.split("-")[0]);
      return seqNum > K;
    });
    expect(toApply.map((e) => e.id)).toEqual(["4-0", "5-0"]);

    const withDup = [...firstBatch, makeSseEnvelope(3, { resolved: 3 })];
    const deduped = dedupeById(withDup);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((e) => e.id)).toEqual(["1-0", "2-0", "3-0"]);
  });

  it("reconnect with invalid lastEventId is rejected by pattern (no leading zeros, must be N-0)", () => {
    expect(isValidLastEventId("0-0")).toBe(false);
    expect(isValidLastEventId("01-0")).toBe(false);
    expect(isValidLastEventId("1-1")).toBe(false);
    expect(isValidLastEventId("1")).toBe(false);
    expect(isValidLastEventId("abc-0")).toBe(false);
    expect(isValidLastEventId("1-0")).toBe(true);
    expect(isValidLastEventId("10-0")).toBe(true);
    expect(LAST_EVENT_ID_PATTERN.test("1-0")).toBe(true);
  });

  it("cursorAfterSeq semantics: undefined => 0n, otherwise BigInt(lastEventId.slice(0,-2)) — resume AFTER seq", () => {
    expect(cursorAfterSeq(undefined)).toBe(0n);
    expect(cursorAfterSeq("1-0")).toBe(1n);
    expect(cursorAfterSeq("42-0")).toBe(42n);
    expect(entryIdForSeq(cursorAfterSeq("5-0") + 1n)).toBe("6-0");
  });
});

describe("UI9.4 polling fallback via real openSubscription onError", () => {
  beforeEach(() => {
    resetStore();
    vi.resetAllMocks();
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
    mockGet.mockResolvedValue({
      searchId: "srch_1",
      status: "RUNNING",
      resolved: 0,
      total: 10,
      groups: [],
      answer: null,
    });
    mockCreate.mockResolvedValue({ searchId: "srch_1", status: "RUNNING" });
    mockStartPolling.mockReturnValue(() => {});
  });

  it("non-auth SSE error before hasReceivedData triggers polling fallback (phase polling + startPolling called)", async () => {
    let capturedOnError: ((err: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((...args: unknown[]) => {
      const [, handlers] = args as [
        unknown,
        { onData: (e: unknown) => void; onError: (err: unknown) => void; onComplete: () => void },
      ];
      capturedOnError = handlers.onError;
      return { unsubscribe: vi.fn() };
    });

    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await flush();

    expect(capturedOnError).not.toBeNull();
    expect(mockStartPolling).not.toHaveBeenCalled();

    await act(async () => {
      capturedOnError!(new Error("SSE failed"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(mockStartPolling).toHaveBeenCalledTimes(1);
    const onResult: unknown = expect.any(Function);
    expect(mockStartPolling).toHaveBeenCalledWith(
      "srch_1",
      expect.objectContaining<{ onResult: unknown }>({ onResult }),
    );
    expect(useSeatfirstStore.getState().phase).toBe("polling");

    mockStartPolling.mockClear();
    let capturedOnError2: ((err: unknown) => void) | null = null;
    mockSubscribe.mockImplementation((...args: unknown[]) => {
      const [, handlers] = args as [
        unknown,
        { onData: (e: unknown) => void; onError: (err: unknown) => void; onComplete: () => void },
      ];
      capturedOnError2 = handlers.onError;
      return { unsubscribe: vi.fn() };
    });
    resetStore();
    await act(async () => {
      await result.current.startSearch(fakeSpec() as never);
    });
    await flush();
    await act(async () => {
      const err = Object.assign(new Error("Unauthorized"), { data: { code: "UNAUTHORIZED" } });
      capturedOnError2!(err);
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(useSeatfirstStore.getState().phase).not.toBe("polling");
    expect(useSeatfirstStore.getState().error).not.toBeNull();
  });
});
