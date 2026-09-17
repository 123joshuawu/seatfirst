import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { Linking } from "react-native";
import type { RecheckInput } from "@seatfirst/core";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import {
  DEV_CAPTURED_AT,
  devDeepLink,
  devShowtimeId,
  makeConfidentAnswer,
  makeEmptyAnswer,
  makePlacement,
  makeRecommendation,
  makeResolvedGroupShowtime,
  makeResultGroup,
  makeShowtimeOffer,
} from "@/fixtures/contracts";
import {
  useSearchResultsViewModel,
  type SearchResultsViewModel,
} from "./useSearchResultsViewModel";

// useSearchSubscription pulls in the real SSE/tRPC client; this test only exercises
// the pure EMPTY-cause derivation below, so its network-facing surface is stubbed.
vi.mock("../useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: async () => {}, phase: "idle", searchId: null }),
}));

const mockRecheckShowtime = vi.fn<(input: RecheckInput) => Promise<unknown>>();

vi.mock("@/api/showtimes", () => ({
  recheckShowtime: (input: RecheckInput) => mockRecheckShowtime(input),
}));

function captureVm(): SearchResultsViewModel {
  let captured!: SearchResultsViewModel;
  function Harness(): null {
    captured = useSearchResultsViewModel();
    return null;
  }
  TestRenderer.act(() => {
    TestRenderer.create(React.createElement(Harness));
  });
  return captured;
}

describe("useSearchResultsViewModel EMPTY cause (UI15.6)", () => {
  it("surfaces the cause heading and suggestions even when zero groups were ever discovered", () => {
    // Reproduces the real HALTED trace: a search can time out before a single
    // performance is discovered (scheduleSkeleton/groups stay empty for its whole
    // life), yet the answer is still legitimately EMPTY:HALTED.
    useSeatfirstStore.setState({
      searchId: "srch_test",
      status: "COMPLETE",
      answer: makeEmptyAnswer("HALTED", [{ kind: "WIDEN_WINDOW", direction: "FULL_DAY" }]),
      groups: [],
      scheduleSkeleton: [],
      resolved: 0,
      total: 0,
    });

    const vm = captureVm();

    expect(vm.answerMode).toBe("EMPTY");
    expect(vm.emptyCause).toBe("HALTED");
    expect(vm.emptyCauseLabel).toBe("Search halted before completion");
    expect(vm.noValidActions).toHaveLength(1);
    expect(vm.noValidActions[0]?.label).toBeTruthy();
  });

  it("still surfaces the cause when groups are non-empty (SOLD_OUT keeps its existing behavior)", () => {
    useSeatfirstStore.setState({
      searchId: "srch_test_2",
      status: "COMPLETE",
      answer: makeEmptyAnswer("SOLD_OUT", []),
      groups: [
        {
          showtimeId: "sh_a",
          admitted: false,
          placement: null,
        } as unknown as SearchResultsViewModel["groups"][number],
      ],
      scheduleSkeleton: [],
      resolved: 1,
      total: 1,
    });

    const vm = captureVm();

    expect(vm.emptyCause).toBe("SOLD_OUT");
    expect(vm.emptyCauseLabel).toBe("No seats remain for this window");
  });
});

function mkSkeletonEntry(
  showtimeId: string,
  over: { resolved?: boolean; admitted?: boolean } = {},
): SearchResultsViewModel["scheduleSkeleton"][number] {
  return {
    showtimeId,
    theatreId: "th_amc_metreon",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: over.admitted ?? true,
    resolved: over.resolved ?? false,
  } as unknown as SearchResultsViewModel["scheduleSkeleton"][number];
}

function mkLiveGroup(
  theatreId: string,
  showtimeIds: string[],
): SearchResultsViewModel["groups"][number] {
  return {
    theatreId,
    showtimes: showtimeIds.map((showtimeId) => ({ showtimeId })),
  } as unknown as SearchResultsViewModel["groups"][number];
}

function seedProvenanceState(args: {
  skeleton: SearchResultsViewModel["scheduleSkeleton"];
  retainedRowIds: ReadonlySet<string> | null;
  retainedGroups?: SearchResultsViewModel["groups"];
  liveGroups?: SearchResultsViewModel["groups"];
  answer?: SearchResultsViewModel["answer"];
}): void {
  useSeatfirstStore.setState({
    searchId: "srch_prov",
    status: "RUNNING",
    answer: args.answer ?? null,
    groups: args.liveGroups ?? [],
    scheduleSkeleton: args.skeleton,
    retainedRowIds: args.retainedRowIds,
    retainedGroups: args.retainedGroups ?? [],
    resolved: 0,
    total: args.skeleton.length,
  });
}

describe("useSearchResultsViewModel in-situ provenance (UI31 / ADR 0064)", () => {
  it("marks ids in the retained set RETAINED_DISPLAY_ONLY, on both the map and displayRows", () => {
    seedProvenanceState({
      skeleton: [mkSkeletonEntry("sh_keep", { resolved: true })],
      retainedRowIds: new Set(["sh_keep"]),
    });
    const vm = captureVm();
    expect(vm.provenanceByShowtimeId.get("sh_keep")).toBe("RETAINED_DISPLAY_ONLY");
    expect(vm.displayRows).toHaveLength(1);
    expect(vm.displayRows[0]?.showtimeId).toBe("sh_keep");
    expect(vm.displayRows[0]?.provenance).toBe("RETAINED_DISPLAY_ONLY");
    // A retained row is never handoffable, even once resolved.
    expect(vm.displayRows[0]?.canHandoff).toBe(false);
  });

  it("marks unresolved non-retained rows PENDING_UPDATE while an update is in flight", () => {
    seedProvenanceState({
      skeleton: [
        mkSkeletonEntry("sh_keep", { resolved: true }),
        mkSkeletonEntry("sh_new", { resolved: false }),
        mkSkeletonEntry("sh_live", { resolved: true }),
      ],
      // Non-null set that does NOT contain sh_new/sh_live: they are successor-
      // search rows whose fate is still unknown.
      retainedRowIds: new Set(["sh_keep"]),
    });
    const vm = captureVm();
    expect(vm.provenanceByShowtimeId.get("sh_new")).toBe("PENDING_UPDATE");
    // Resolved under the successor search means current, even mid-update.
    expect(vm.provenanceByShowtimeId.get("sh_live")).toBe("RESOLVED_CURRENT");
  });

  it("marks every row RESOLVED_CURRENT when no update is in flight, regardless of resolved state", () => {
    seedProvenanceState({
      skeleton: [
        mkSkeletonEntry("sh_done", { resolved: true }),
        mkSkeletonEntry("sh_wait", { resolved: false }),
      ],
      retainedRowIds: null,
    });
    const vm = captureVm();
    expect(vm.provenanceByShowtimeId.get("sh_done")).toBe("RESOLVED_CURRENT");
    expect(vm.provenanceByShowtimeId.get("sh_wait")).toBe("RESOLVED_CURRENT");
  });

  it("handoffEligibleShowtimeIds excludes ids still in the retained set", () => {
    seedProvenanceState({
      skeleton: [
        mkSkeletonEntry("sh_a", { resolved: true }),
        mkSkeletonEntry("sh_b", { resolved: true }),
      ],
      retainedRowIds: new Set(["sh_a"]),
      answer: makeConfidentAnswer({
        primary: makeRecommendation("a", {
          showtimes: [
            makeShowtimeOffer("a", { showtimeId: "sh_a" }),
            makeShowtimeOffer("b", { showtimeId: "sh_b" }),
          ],
        }),
      }),
    });
    const vm = captureVm();
    // Without the retained filter both primary showtimes would be eligible.
    expect(vm.handoffEligibleShowtimeIds).toEqual(["sh_b"]);
    expect(vm.handoffEligibleShowtimeIds).not.toContain("sh_a");
  });

  it("merges retained groups absent from live groups so retained rows keep their anchors", () => {
    const live = mkLiveGroup("th_live", ["sh_live"]);
    const retained = mkLiveGroup("th_old", ["sh_keep"]);
    seedProvenanceState({
      skeleton: [
        mkSkeletonEntry("sh_live", { resolved: true }),
        mkSkeletonEntry("sh_keep", { resolved: true }),
      ],
      retainedRowIds: new Set(["sh_keep"]),
      liveGroups: [live],
      retainedGroups: [retained],
    });
    const vm = captureVm();
    // Live groups come first; the retained-only theatre still surfaces.
    expect(vm.groups.map((g) => g.theatreId)).toEqual(["th_live", "th_old"]);
    const keptRow = vm.displayRows.find((r) => r.showtimeId === "sh_keep");
    expect(keptRow?.provenance).toBe("RETAINED_DISPLAY_ONLY");
    expect(keptRow?.group?.theatreId).toBe("th_old");
  });
});

/**
 * ADR 0063 §4 — auto-open the AMC tab after a successful recheck, without a
 * second manual click. `startHandoff` pre-opens the tab synchronously in the tap
 * gesture; the AVAILABLE path navigates it to the deep link. These pin both the
 * held-popup navigation and the blocked-pre-open direct fallback at the real
 * view-model boundary (the real `@/lib/handoff` chain runs unmocked).
 */
describe("useSearchResultsViewModel auto-open handoff (ADR 0063 §4)", () => {
  const SEARCH_ID = "srch_handoff";
  const SHOWTIME_ID = devShowtimeId("s1");
  const DEEP_LINK = devDeepLink("s1");

  function fakePopup() {
    return { closed: false as const, location: { href: "" }, close: vi.fn() };
  }

  // A valid recheck-eligible store state: terminal search, CONFIDENT primary
  // carrying the nonce, and a groups row carrying the deep link — the
  // NONCE_MISSING trap is avoided because every id resolves for real.
  function seedHandoffState(): void {
    useSeatfirstStore.setState({
      searchId: SEARCH_ID,
      status: "COMPLETE",
      answer: makeConfidentAnswer({ primary: makeRecommendation("s1") }),
      groups: [makeResultGroup({ showtimes: [makeResolvedGroupShowtime("s1")] })],
      scheduleSkeleton: [],
      resolved: 1,
      total: 1,
      retainedRowIds: null,
      retainedGroups: [],
      recheckStatus: "idle",
      recheckingShowtimeId: null,
      recheckErrorCode: null,
      recheckErrorMessage: null,
      recheckResult: null,
      recheckSelectedShowtimeId: null,
    });
  }

  // `startHandoff` is fire-and-forget; drain the recheck → popup chain.
  async function runHandoff(showtimeId: string): Promise<SearchResultsViewModel> {
    const vm = captureVm();
    await TestRenderer.act(async () => {
      vm.actions.startHandoff(showtimeId);
      for (let i = 0; i < 10; i += 1) {
        const s = useSeatfirstStore.getState();
        if (s.recheckResult !== null || s.recheckStatus === "unavailable") break;
        await new Promise((r) => setTimeout(r, 0));
      }
    });
    await TestRenderer.act(async () => {});
    return vm;
  }

  beforeEach(() => {
    mockRecheckShowtime.mockReset();
    mockRecheckShowtime.mockResolvedValue({
      status: "AVAILABLE",
      placement: makePlacement(),
      checkedAt: DEV_CAPTURED_AT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigates the pre-opened tab to the deep link with no direct open", async () => {
    seedHandoffState();
    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const openURL = vi.spyOn(Linking, "openURL");
    await runHandoff(SHOWTIME_ID);
    expect(mockRecheckShowtime).toHaveBeenCalledTimes(1);
    expect(mockRecheckShowtime).toHaveBeenCalledWith({
      searchId: SEARCH_ID,
      showtimeId: SHOWTIME_ID,
      placementKey: "dev-placement-1",
      nonce: "dev-nonce-s1",
    });
    // The held tab auto-navigates — no second click, no stranded blank tab.
    expect(popup.location.href).toBe(DEEP_LINK);
    expect(popup.close).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    const st = useSeatfirstStore.getState();
    expect(st.recheckResult).toMatchObject({ status: "AVAILABLE" });
    expect(st.recheckingShowtimeId).toBeNull();
  });

  it("falls back to exactly one direct open without re-running the recheck", async () => {
    seedHandoffState();
    vi.spyOn(window, "open").mockReturnValue(null);
    const openURL = vi.spyOn(Linking, "openURL");
    await runHandoff(SHOWTIME_ID);
    expect(mockRecheckShowtime).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(DEEP_LINK);
  });
});
