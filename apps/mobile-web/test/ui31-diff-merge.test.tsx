import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { specHash } from "@seatfirst/core";
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
  // Mirrors sse-replay.test.tsx: the vanilla client export is `trpcClient`;
  // both keys share one mock so @/api/search bindings hit these spies.
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

import { buildSearchSpec } from "@/lib/buildSearchSpec";
import { useSearchSubscription } from "@/hooks/useSearchSubscription";
import { useSearchResultsViewModel } from "@/hooks/viewModels/useSearchResultsViewModel";

interface SseHandlers {
  onData: (e: unknown) => void;
  onError: (e: unknown) => void;
}

// Fixture specs must survive the real specHash normalization (which rejects
// hand-rolled shapes), so they go through the production builder. The tag
// selects a party size — the only difference between the two specs.
function fakeSpec(tag: string): unknown {
  const spec = buildSearchSpec({
    where: {
      deviceCenter: null,
      wherePlace: null,
      selectedTheatres: [{ id: "th_1", providerId: "amc" }],
      whereRadiusKm: 10,
      whereLimit: 10,
      isHandEdited: false,
    },
    movieId: "mv_dune",
    selectedDates: [new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)],
    timeOfDay: "Evening",
    selectedBands: ["Evening"],
    seatPrefs: { Centered: false, Aisle: false, "Avoid front": false },
    partySize: tag === "a" ? 2 : 4,
    formatPref: "any",
  });
  if (spec === null) throw new Error("fixture spec failed to build");
  return spec;
}

function mkEntry(
  showtimeId: string,
  over: { resolved?: boolean; rank?: number } = {},
): Record<string, unknown> {
  return {
    showtimeId,
    theatreId: "th_old",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: over.rank ?? 0,
    admitted: true,
    resolved: over.resolved ?? false,
  };
}

function mkGroup(theatreId: string, showtimeIds: string[]): Record<string, unknown> {
  return {
    theatreId,
    showtimes: showtimeIds.map((showtimeId) => ({ showtimeId, resolved: false })),
  };
}

function skeletonEnvelope(
  entries: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  id = "1-0",
): unknown {
  return { id, data: { type: "skeleton", payload: { scheduleSkeleton: entries, ...extra } } };
}

function nonTerminalGet(searchId: string, groups: Record<string, unknown>[] = []): unknown {
  return { searchId, status: "RUNNING", resolved: 0, total: 0, groups, answer: null };
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

function captureResultsVm(): ReturnType<typeof useSearchResultsViewModel> {
  let captured!: ReturnType<typeof useSearchResultsViewModel>;
  function Harness(): null {
    captured = useSearchResultsViewModel();
    return null;
  }
  TestRenderer.act(() => {
    TestRenderer.create(React.createElement(Harness));
  });
  return captured;
}

function lastSubscribeHandlers(): SseHandlers {
  const calls = mockSubscribe.mock.calls;
  if (calls.length === 0) throw new Error("subscribe never called");
  return calls[calls.length - 1]![1] as SseHandlers;
}

describe("UI31 in-situ diff-merge end to end (ADR 0064)", () => {
  beforeEach(() => {
    resetStore();
    vi.resetAllMocks();
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  });

  it("happy path: update retains predecessor rows, stages specs only after create resolves, merged groups keep the anchor", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    expect(specHash(specA)).not.toBe(specHash(specB));

    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    expect(useSeatfirstStore.getState().searchId).toBe("srch_1");

    // Search A resolves two rows with a live group behind them.
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 0, total: 2 }),
      );
    });
    useSeatfirstStore.getState().setProgress({
      resolved: 0,
      total: 2,
      groups: [mkGroup("th_old", ["sh_1", "sh_2"])] as never,
    });
    expect(useSeatfirstStore.getState().scheduleSkeleton).toHaveLength(2);

    // The successor create hangs: the update is staged but not yet committed.
    let resolveCreateB!: (v: unknown) => void;
    mockCreate.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveCreateB = res;
        }),
    );
    mockGet.mockResolvedValue(nonTerminalGet("srch_2", [mkGroup("th_new", ["sh_3"])]));
    let update: Promise<void> | undefined;
    await act(async () => {
      update = result.current.startSearch(specB as never, "srch_1");
      await Promise.resolve();
    });
    const mid = useSeatfirstStore.getState();
    // Predecessor rows are retained; the live specs still describe search A
    // until the successor create actually resolves.
    expect(mid.retainedRowIds).toBeInstanceOf(Set);
    expect([...(mid.retainedRowIds as Set<string>)].sort()).toEqual(["sh_1", "sh_2"]);
    expect(mid.retainedGroups.map((g) => g.theatreId)).toEqual(["th_old"]);
    expect(specHash(mid.serverCoverageSpec)).toBe(specHash(specA));
    expect(specHash(mid.effectiveViewSpec)).toBe(specHash(specA));

    await act(async () => {
      resolveCreateB({ searchId: "srch_2", status: "RUNNING" });
      await update;
    });
    const after = useSeatfirstStore.getState();
    expect(after.searchId).toBe("srch_2");
    expect(specHash(after.serverCoverageSpec)).toBe(specHash(specB));
    expect(specHash(after.effectiveViewSpec)).toBe(specHash(specB));
    // The merged surface still carries the retained anchor next to live data.
    const vm = captureResultsVm();
    expect(vm.groups.map((g) => g.theatreId)).toEqual(["th_new", "th_old"]);
  });

  it("promotes a retained row to live once it resolves under the successor search", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 0, total: 2 }),
      );
    });
    useSeatfirstStore.getState().setProgress({
      resolved: 0,
      total: 2,
      groups: [mkGroup("th_old", ["sh_1", "sh_2"])] as never,
    });

    mockCreate.mockResolvedValueOnce({ searchId: "srch_2", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_2"));
    await act(async () => {
      await result.current.startSearch(specB as never, "srch_1");
    });
    expect([...(useSeatfirstStore.getState().retainedRowIds as Set<string>)].sort()).toEqual([
      "sh_1",
      "sh_2",
    ]);

    // Successor SSE resolves sh_1 only: it promotes, sh_2 stays retained.
    await act(() => {
      lastSubscribeHandlers().onData(skeletonEnvelope([{ ...mkEntry("sh_1"), resolved: true }]));
    });
    expect([...(useSeatfirstStore.getState().retainedRowIds as Set<string>)]).toEqual(["sh_2"]);
    const vm = captureResultsVm();
    expect(vm.provenanceByShowtimeId.get("sh_2")).toBe("RETAINED_DISPLAY_ONLY");
  });

  it("terminal state clears retained rows even when some never resolved", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 0, total: 2 }),
      );
    });
    mockCreate.mockResolvedValueOnce({ searchId: "srch_2", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_2"));
    await act(async () => {
      await result.current.startSearch(specB as never, "srch_1");
    });
    expect(useSeatfirstStore.getState().retainedRowIds).not.toBeNull();

    mockGet.mockResolvedValueOnce({
      searchId: "srch_2",
      status: "COMPLETE",
      resolved: 2,
      total: 2,
      groups: [],
      answer: null,
    });
    await act(() => {
      lastSubscribeHandlers().onData({
        id: "9-0",
        data: { type: "SEARCH_TERMINAL", payload: { status: "COMPLETE", answer: null } },
      });
    });
    // sh_2 never resolved under the successor, yet the terminal still drops
    // the whole retained bookkeeping — no stale anchors survive.
    expect(useSeatfirstStore.getState().status).toBe("COMPLETE");
    expect(useSeatfirstStore.getState().retainedRowIds).toBeNull();
    expect(useSeatfirstStore.getState().retainedGroups).toEqual([]);
  });

  it("generation fencing drops a stale first-search callback after a second search starts", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    const staleHandlers = lastSubscribeHandlers();
    await act(() => {
      staleHandlers.onData(skeletonEnvelope([mkEntry("sh_1")], { resolved: 1, total: 1 }));
    });
    expect(useSeatfirstStore.getState().resolved).toBe(1);

    // Second search bumps the generation and resets progress via its reconcile.
    mockCreate.mockResolvedValueOnce({ searchId: "srch_2", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_2"));
    await act(async () => {
      await result.current.startSearch(specB as never);
    });
    expect(useSeatfirstStore.getState().searchId).toBe("srch_2");
    expect(useSeatfirstStore.getState().resolved).toBe(0);

    // The first search's captured handler now fires late with progress that
    // would overwrite everything — fencing must swallow it whole.
    await act(() => {
      staleHandlers.onData({
        id: "stale-1",
        data: { resolved: 999, total: 999, groups: [mkGroup("th_stale", ["sh_x"])] },
      });
    });
    const st = useSeatfirstStore.getState();
    expect(st.searchId).toBe("srch_2");
    expect(st.resolved).toBe(0);
    expect(st.total).toBe(0);
    expect(st.groups).toEqual([]);
  });

  it("create failure rolls back progress and clears retained rows without touching search A's display data", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 1, total: 2 }),
      );
    });
    // Search A is mid-flight with real progress worth restoring.
    useSeatfirstStore
      .getState()
      .setAnswer({ mode: "EMPTY", cause: "HALTED", suggestions: [] } as never);
    useSeatfirstStore
      .getState()
      .setProgress({ resolved: 3, total: 5, groups: [mkGroup("th_old", ["sh_1"])] as never });
    useSeatfirstStore.getState().setTerminalCause("BATCH_DEFERRED");
    const before = useSeatfirstStore.getState();

    const err = Object.assign(new Error("capacity"), {
      data: { code: "ADMISSION_REJECTED", retryAfterSeconds: 30 },
    });
    mockCreate.mockRejectedValueOnce(err);
    await act(async () => {
      await result.current.startSearch(specB as never, "srch_1");
    });

    const st = useSeatfirstStore.getState();
    // Optimistic progress reset is undone; retained bookkeeping is dropped.
    expect(st.answer).toEqual(before.answer);
    expect(st.resolved).toBe(3);
    expect(st.total).toBe(5);
    expect(st.terminalCause).toBe("BATCH_DEFERRED");
    expect(st.retainedRowIds).toBeNull();
    expect(st.retainedGroups).toEqual([]);
    // Search A's own display data was never mutated by the failed update.
    expect(st.searchId).toBe("srch_1");
    expect(st.status).toBe("RUNNING");
    expect(st.groups).toEqual(before.groups);
    expect(st.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_1", "sh_2"]);
    expect(st.error?.code).toBe("ADMISSION_REJECTED");
  });
  it("update submitted while the live search is still RUNNING omits continuesSearchId but still retains rows (S45 CONTINUATION_NOT_DEFERRED fix)", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 0, total: 2 }),
      );
    });
    useSeatfirstStore.getState().setProgress({
      resolved: 0,
      total: 2,
      groups: [mkGroup("th_old", ["sh_1", "sh_2"])] as never,
    });
    // Search A is still RUNNING — it never reached BATCH_DEFERRED.
    expect(useSeatfirstStore.getState().terminalCause).not.toBe("BATCH_DEFERRED");

    mockCreate.mockResolvedValueOnce({ searchId: "srch_2", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_2"));
    await act(async () => {
      await result.current.startSearch(specB as never, "srch_1");
    });

    // Backend contract (S45/ADR-0037): continuesSearchId is only valid after
    // BATCH_DEFERRED — the RUNNING update must go out as an independent
    // Search B without it, or create rejects with CONTINUATION_NOT_DEFERRED.
    const createInput = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
      string,
      unknown
    >;
    expect(createInput).not.toHaveProperty("continuesSearchId");
    // ...but the client-side diff-merge treatment still applies.
    expect([...(useSeatfirstStore.getState().retainedRowIds as Set<string>)].sort()).toEqual([
      "sh_1",
      "sh_2",
    ]);
    expect(useSeatfirstStore.getState().searchId).toBe("srch_2");
    expect(useSeatfirstStore.getState().error).toBeNull();
  });

  it("update submitted after BATCH_DEFERRED still forwards continuesSearchId (checkMore contract intact)", async () => {
    const specA = fakeSpec("a");
    const specB = fakeSpec("b");
    mockCreate.mockResolvedValueOnce({ searchId: "srch_1", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_1"));
    const { result } = renderHook(() => useSearchSubscription());
    await act(async () => {
      await result.current.startSearch(specA as never);
    });
    await act(() => {
      lastSubscribeHandlers().onData(
        skeletonEnvelope([mkEntry("sh_1"), mkEntry("sh_2")], { resolved: 0, total: 2 }),
      );
    });
    useSeatfirstStore.getState().setProgress({
      resolved: 0,
      total: 2,
      groups: [mkGroup("th_old", ["sh_1", "sh_2"])] as never,
    });
    useSeatfirstStore.getState().setTerminalCause("BATCH_DEFERRED");

    mockCreate.mockResolvedValueOnce({ searchId: "srch_2", status: "RUNNING" });
    mockGet.mockResolvedValue(nonTerminalGet("srch_2"));
    await act(async () => {
      await result.current.startSearch(specB as never, "srch_1");
    });

    const createInput = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
      string,
      unknown
    >;
    expect(createInput.continuesSearchId).toBe("srch_1");
    expect([...(useSeatfirstStore.getState().retainedRowIds as Set<string>)].sort()).toEqual([
      "sh_1",
      "sh_2",
    ]);
    expect(useSeatfirstStore.getState().searchId).toBe("srch_2");
  });
});
