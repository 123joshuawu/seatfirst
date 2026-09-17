import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import type { RankedAnswer, RecheckInput, ResultGroup } from "@seatfirst/core";
import { Linking } from "react-native";

const mockRecheckShowtime = vi.fn<(input: RecheckInput) => Promise<unknown>>();

// The real handoff chain (resolve → complete → openHandoff → Linking) runs
// unmocked: intra-module calls can't be observed through a module mock, and the
// Linking mock records the final open. jsdom's window.open returns null, so the
// AVAILABLE path deterministically takes the direct-open fallback.
const openUrlSpy = vi.spyOn(Linking, "openURL");

vi.mock("@/api/search", () => ({
  cancelSearch: vi.fn(),
  createSearch: vi.fn(),
  getSearch: vi.fn(),
}));

vi.mock("@/lib/searchSubscriptionController", () => ({
  setStopSubscription: vi.fn(),
  getStopSubscription: () => null,
}));

vi.mock("@/api/showtimes", () => ({
  recheckShowtime: (input: RecheckInput) => mockRecheckShowtime(input),
}));

vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: undefined, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

import { useSeatfirstDemo } from "./useSeatfirstDemo";

function renderHookHarness(): { current: ReturnType<typeof useSeatfirstDemo> } {
  const result = { current: undefined as unknown as ReturnType<typeof useSeatfirstDemo> };
  function HookComp(): React.JSX.Element | null {
    result.current = useSeatfirstDemo();
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(HookComp));
  });
  return result;
}

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    isFormCollapsed: false,
    isCanceling: false,
    cancelError: null,
    searchId: "search_123",
    status: "COMPLETE",
  });
}

function mkOffer(showtimeId: string): {
  showtimeId: string;
  nonce: string | null;
  deepLinkUrl: string;
} {
  return {
    showtimeId,
    nonce: `nonce_${showtimeId}`,
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}/seats`,
  };
}

function mkHedgedAnswer(): RankedAnswer {
  // Two alternatives; the hit under test lives in the SECOND alternative — exactly
  // the case the legacy alternatives[0]-only path could not reach.
  return {
    mode: "HEDGED",
    otherFormats: [],
    primary: null,
    alternatives: [
      {
        placement: { placementKey: "alt1_key" },
        showtimes: [mkOffer("sh_alt1")],
        relaxed: null,
        reasonLabel: null,
      },
      {
        placement: { placementKey: "alt2_key" },
        showtimes: [mkOffer("sh_alt2"), mkOffer("sh_alt2b")],
        relaxed: null,
        reasonLabel: null,
      },
    ],
    suggestions: [],
  } as unknown as RankedAnswer;
}

function mkConfidentAnswer(): RankedAnswer {
  return {
    mode: "CONFIDENT",
    otherFormats: [],
    primary: { placement: { placementKey: "primary_key" }, showtimes: [mkOffer("sh_primary")] },
    alternatives: [],
    suggestions: [],
  } as unknown as RankedAnswer;
}

/** Seed the answer plus the store groups row the AVAILABLE path resolves the deep link from. */
function seedInlineHandoff(answer: RankedAnswer, showtimeId: string): void {
  useSeatfirstStore.setState({
    answer,
    groups: [
      {
        // Decoy layoutId: placement-card resolution matches groups by layoutId,
        // so this row must NOT match any recommendation — it exists only for
        // the AVAILABLE path's deep-link lookup.
        layoutId: "lay_decoy_no_match",
        showtimes: [
          {
            showtimeId,
            deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}/seats`,
          },
        ],
      },
    ] as unknown as ResultGroup[],
  });
}
/** Fire-and-forget handoff; two microtask flushes let the IIFE reach recheckShowtime. */
async function runHandoff(
  vm: { current: ReturnType<typeof useSeatfirstDemo> },
  id: string,
): Promise<void> {
  await act(async () => {
    vm.current.actions.startHandoff(id);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("UI15.5 — startHandoff uses the real UI6 recheck contract per canonical answer", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
  });

  it("reaches a hit in the SECOND HEDGED alternative with that alternative's placementKey and nonce", async () => {
    useSeatfirstStore.setState({ answer: mkHedgedAnswer() });
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_alt2b");
    expect(mockRecheckShowtime).toHaveBeenCalledTimes(1);
    const input = mockRecheckShowtime.mock.calls[0]?.[0];
    expect(input).toEqual({
      searchId: "search_123",
      showtimeId: "sh_alt2b",
      placementKey: "alt2_key",
      nonce: "nonce_sh_alt2b",
    });
  });

  it("reaches a CONFIDENT primary offer through the same executor", async () => {
    useSeatfirstStore.setState({ answer: mkConfidentAnswer() });
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_primary");
    expect(mockRecheckShowtime).toHaveBeenCalledWith({
      searchId: "search_123",
      showtimeId: "sh_primary",
      placementKey: "primary_key",
      nonce: "nonce_sh_primary",
    });
  });

  it("is a no-op for a showtimeId absent from the canonical answer", async () => {
    useSeatfirstStore.setState({ answer: mkHedgedAnswer() });
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_unknown");
    expect(mockRecheckShowtime).not.toHaveBeenCalled();
  });

  it("never mutates selectedShowtimeIdx (retryRecheck's index contract stays intact)", async () => {
    useSeatfirstStore.setState({ answer: mkHedgedAnswer(), selectedShowtimeIdx: null });
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_alt2");
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBeNull();
  });

  it("exposes eligibility ids covering every HEDGED alternative on the view model", () => {
    useSeatfirstStore.setState({ answer: mkHedgedAnswer() });
    const vm = renderHookHarness();
    expect([...vm.current.handoffEligibleShowtimeIds].sort()).toEqual([
      "sh_alt1",
      "sh_alt2",
      "sh_alt2b",
    ]);
  });
});

describe("UI30.2 — inline handoff rechecks in place and never leaves the results screen", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
  });

  it("AVAILABLE opens the offer deep link with no screen mutation", async () => {
    seedInlineHandoff(mkConfidentAnswer(), "sh_primary");
    const screenBefore = useSeatfirstStore.getState().screen;
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_primary");
    // Drain the completion chain (recheck → popup handoff → result store).
    await act(async () => {});
    expect(openUrlSpy).toHaveBeenCalledWith(
      "https://www.amctheatres.com/showtimes/sh_primary/seats",
    );
    const st = useSeatfirstStore.getState();
    expect(st.screen).toBe(screenBefore);
    expect(st.recheckingShowtimeId).toBeNull();
    expect(st.recheckResult).toMatchObject({ status: "AVAILABLE" });
  });

  it("recheckingShowtimeId brackets the in-flight recheck", async () => {
    let resolveRecheck!: (value: unknown) => void;
    mockRecheckShowtime.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        resolveRecheck = resolve;
      }),
    );
    seedInlineHandoff(mkConfidentAnswer(), "sh_primary");
    const vm = renderHookHarness();
    act(() => {
      vm.current.actions.startHandoff("sh_primary");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRecheckShowtime).toHaveBeenCalledTimes(1);
    expect(useSeatfirstStore.getState().recheckingShowtimeId).toBe("sh_primary");
    resolveRecheck({ status: "AVAILABLE" });
    await act(async () => {});
    expect(useSeatfirstStore.getState().recheckingShowtimeId).toBeNull();
  });

  it("GONE stores the recovery result inline without touching the screen", async () => {
    mockRecheckShowtime.mockResolvedValueOnce({ status: "GONE", recovery: [] });
    seedInlineHandoff(mkConfidentAnswer(), "sh_primary");
    const screenBefore = useSeatfirstStore.getState().screen;
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_primary");
    await act(async () => {});
    const st = useSeatfirstStore.getState();
    expect(st.recheckResult).toMatchObject({ status: "GONE" });
    expect(st.recheckingShowtimeId).toBeNull();
    expect(st.screen).toBe(screenBefore);
    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it("transport failure surfaces the retry error with the row re-enabled", async () => {
    mockRecheckShowtime.mockRejectedValueOnce(new Error("Network down"));
    seedInlineHandoff(mkConfidentAnswer(), "sh_primary");
    const vm = renderHookHarness();
    await runHandoff(vm, "sh_primary");
    await act(async () => {});
    const st = useSeatfirstStore.getState();
    expect(st.recheckStatus).toBe("unavailable");
    expect(st.recheckErrorCode).toBe("NETWORK_ERROR");
    expect(st.recheckErrorMessage).toBe("Couldn't re-verify — check your connection and try again");
    expect(st.recheckingShowtimeId).toBeNull();
    expect(openUrlSpy).not.toHaveBeenCalled();
  });
});
