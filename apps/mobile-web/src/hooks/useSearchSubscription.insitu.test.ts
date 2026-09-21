import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import type {
  ResultGroup,
  ScheduleSkeletonEntry,
  SearchSpec,
  TheatreSelector,
} from "@seatfirst/core";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { flowInitialState } from "@/store/flowSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import { isSameSearchSubject, useSearchSubscription } from "./useSearchSubscription";

const { mockCreateSearch, mockGetSearch, mockSubscribe } = vi.hoisted(() => ({
  mockCreateSearch: vi.fn<(...args: unknown[]) => unknown>(),
  mockGetSearch: vi.fn<(...args: unknown[]) => unknown>(),
  mockSubscribe: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("@/api/search", () => ({
  createSearch: (...args: unknown[]) => mockCreateSearch(...args),
  getSearch: (...args: unknown[]) => mockGetSearch(...args),
}));
vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    searches: { onProgress: { subscribe: (...args: unknown[]) => mockSubscribe(...args) } },
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  useWindowDimensions: () => ({ width: 800, height: 600 }),
}));

const mountedRenderers: Array<{ unmount: () => void }> = [];
afterEach(() => {
  TestRenderer.act(() => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
  });
});

function mountHook(): { getHook: () => ReturnType<typeof useSearchSubscription> } {
  let captured!: ReturnType<typeof useSearchSubscription>;
  function Harness(): null {
    captured = useSearchSubscription();
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  mountedRenderers.push(renderer);
  return { getHook: () => captured };
}

function listTheatres(ids: string[]): TheatreSelector {
  return { kind: "LIST", refs: ids.map((id) => ({ id })) } as unknown as TheatreSelector;
}

function mkSpec(movieId: string, theatres: TheatreSelector, partySize = 2): SearchSpec {
  return {
    specVersion: 2,
    providerId: "amc",
    theatres,
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [movieId] },
        { kind: "DATE_RANGE", from: "2026-09-22", to: "2026-09-22" },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    group: { kind: "RUN", count: partySize },
    groupStrict: false,
    rank: "SCORE",
  } as unknown as SearchSpec;
}

function mkEntry(showtimeId: string, theatreId: string, resolved = false): ScheduleSkeletonEntry {
  return {
    showtimeId,
    theatreId,
    showDateTimeLocal: "2026-09-22T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: true,
    resolved,
  } as unknown as ScheduleSkeletonEntry;
}

function seedActiveSearch(
  spec: SearchSpec,
  skeleton: ScheduleSkeletonEntry[],
  groups: ResultGroup[] = [],
): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    searchId: "srch_A",
    status: "COMPLETE",
    phase: "terminal",
    serverCoverageSpec: spec,
    scheduleSkeleton: skeleton,
    groups,
    resolved: skeleton.length,
    total: skeleton.length,
  });
}

function mockCreateReturning(skeleton: ScheduleSkeletonEntry[]): void {
  mockCreateSearch.mockResolvedValue({
    searchId: "srch_B",
    status: "RUNNING",
    scheduleSkeleton: skeleton,
    groups: [],
  });
}

beforeEach(() => {
  mockCreateSearch.mockReset();
  mockGetSearch.mockReset();
  mockSubscribe.mockReset();
  mockSubscribe.mockReturnValue({ unsubscribe: () => {} });
  mockGetSearch.mockResolvedValue({
    status: "RUNNING",
    answer: null,
    groups: [],
    resolved: 0,
    total: 0,
  });
});

describe("isSameSearchSubject (ADR 0064 in-situ retention boundary)", () => {
  const base = mkSpec("mv_dune", listTheatres(["th_1"]));

  it("retains party-size and overlapping-theatre refinements, but not movie or wholesale theatre swaps", () => {
    expect(isSameSearchSubject(base, mkSpec("mv_dune", listTheatres(["th_1"]), 4))).toBe(true);
    expect(isSameSearchSubject(base, mkSpec("mv_dune", listTheatres(["th_1", "th_2"])))).toBe(true);
    expect(isSameSearchSubject(base, mkSpec("mv_oppenheimer", listTheatres(["th_1"])))).toBe(false);
    expect(isSameSearchSubject(base, mkSpec("mv_dune", listTheatres(["th_2"])))).toBe(false);
  });

  it("keeps the ADR 0064 §4 AREA-to-LIST hand-prune on the refinement path", () => {
    const area = mkSpec("mv_dune", {
      kind: "AREA",
      center: { lat: 37.7, lng: -122.4 },
      radiusKm: 10,
      limit: 20,
    } as unknown as TheatreSelector);
    expect(isSameSearchSubject(area, base)).toBe(true);
    expect(isSameSearchSubject(base, area)).toBe(true);
  });
});

describe("startSearch in-situ skeleton merge", () => {
  it("patches party-size overlaps in place and appends genuinely-new rows", async () => {
    const specA = mkSpec("mv_dune", listTheatres(["th_1"]), 2);
    seedActiveSearch(specA, [mkEntry("sh_1", "th_1", true), mkEntry("sh_2", "th_1", true)]);
    const specB = mkSpec("mv_dune", listTheatres(["th_1"]), 4);
    mockCreateReturning([
      mkEntry("sh_1", "th_1"),
      mkEntry("sh_2", "th_1"),
      mkEntry("sh_3", "th_1"),
    ]);
    const { getHook } = mountHook();

    await TestRenderer.act(async () => {
      await getHook().startSearch(specB, "srch_A");
    });

    const state = useSeatfirstStore.getState();
    expect(state.scheduleSkeleton.map((entry) => entry.showtimeId)).toEqual([
      "sh_1",
      "sh_2",
      "sh_3",
    ]);
    expect([...(state.retainedRowIds as Set<string>)].sort()).toEqual(["sh_1", "sh_2"]);
    expect(mockCreateSearch).toHaveBeenCalledWith(specB, expect.any(String), undefined);
  });

  it("keeps an overlapping theatre selection in-situ and surfaces new theatre rows", async () => {
    const specA = mkSpec("mv_dune", listTheatres(["th_1"]));
    seedActiveSearch(specA, [mkEntry("sh_1", "th_1", true)]);
    const specB = mkSpec("mv_dune", listTheatres(["th_1", "th_2"]));
    mockCreateReturning([
      mkEntry("sh_1", "th_1"),
      mkEntry("sh_2", "th_2"),
      mkEntry("sh_3", "th_2"),
    ]);
    const { getHook } = mountHook();

    await TestRenderer.act(async () => {
      await getHook().startSearch(specB, "srch_A");
    });

    const state = useSeatfirstStore.getState();
    expect(state.scheduleSkeleton.map((entry) => entry.showtimeId)).toEqual([
      "sh_1",
      "sh_2",
      "sh_3",
    ]);
    expect(
      state.scheduleSkeleton
        .filter((entry) => entry.theatreId === "th_2")
        .map((entry) => entry.showtimeId),
    ).toEqual(["sh_2", "sh_3"]);
    expect(state.retainedRowIds).not.toBeNull();
  });

  it("fully clears a movie switch rather than appending stale predecessor rows", async () => {
    const specA = mkSpec("mv_dune", listTheatres(["th_1"]));
    seedActiveSearch(
      specA,
      [mkEntry("sh_1", "th_1", true), mkEntry("sh_2", "th_1", true)],
      [{ theatreId: "th_1", showtimes: [] } as unknown as ResultGroup],
    );
    const specB = mkSpec("mv_oppenheimer", listTheatres(["th_1"]));
    mockCreateReturning([mkEntry("sh_9", "th_1")]);
    const { getHook } = mountHook();

    await TestRenderer.act(async () => {
      await getHook().startSearch(specB, "srch_A");
    });

    const state = useSeatfirstStore.getState();
    expect(state.scheduleSkeleton.map((entry) => entry.showtimeId)).toEqual(["sh_9"]);
    expect(state.groups).toEqual([]);
    expect(state.retainedRowIds).toBeNull();
    expect(state.serverCoverageSpec).toEqual(specB);
  });

  it("fully clears a wholesale theatre replacement", async () => {
    const specA = mkSpec("mv_dune", listTheatres(["th_1"]));
    seedActiveSearch(specA, [mkEntry("sh_1", "th_1", true)]);
    const specB = mkSpec("mv_dune", listTheatres(["th_2"]));
    mockCreateReturning([mkEntry("sh_7", "th_2")]);
    const { getHook } = mountHook();

    await TestRenderer.act(async () => {
      await getHook().startSearch(specB, "srch_A");
    });

    const state = useSeatfirstStore.getState();
    expect(state.scheduleSkeleton.map((entry) => entry.showtimeId)).toEqual(["sh_7"]);
    expect(state.retainedRowIds).toBeNull();
  });

  it("keeps the same-spec BATCH_DEFERRED continuation append behavior", async () => {
    const spec = mkSpec("mv_dune", listTheatres(["th_1"]));
    seedActiveSearch(spec, [mkEntry("sh_1", "th_1", true)]);
    useSeatfirstStore.setState({ terminalCause: "BATCH_DEFERRED" });
    mockCreateReturning([mkEntry("sh_2", "th_1")]);
    const { getHook } = mountHook();

    await TestRenderer.act(async () => {
      await getHook().startSearch(spec, "srch_A");
    });

    expect(useSeatfirstStore.getState().scheduleSkeleton.map((entry) => entry.showtimeId)).toEqual([
      "sh_1",
      "sh_2",
    ]);
    expect(mockCreateSearch).toHaveBeenCalledWith(spec, expect.any(String), "srch_A");
  });
});
