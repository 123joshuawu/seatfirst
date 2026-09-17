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
import { MovieIdSchema, TheatreIdSchema } from "@seatfirst/core";
import { ShowtimeList } from "@/components/search/ShowtimeList";
import { ShowtimeRow } from "@/components/search/ShowtimeRow";
import type { ScheduleSkeletonEntry, ResultGroup } from "@seatfirst/core";

vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    searches: {},
  },
  trpc: {
    searches: { create: { useMutation: () => ({ mutate: vi.fn() }) } },
    sessions: { bootstrap: { useQuery: () => ({ data: null }) } },
  },
  getTrpcUrl: () => "http://localhost:3000/trpc",
  queryClient: { clear: vi.fn() },
}));
const mockStartRealSearch = vi.fn();
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: mockStartRealSearch }),
}));
vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: null, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
import { useSeatfirstDemo } from "./useSeatfirstDemo";

const THEATRE_ID = TheatreIdSchema.parse("amc:theatre:832");
const MOVIE_ID = MovieIdSchema.parse("amc:movie:78421");

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
function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const holder = { current: null as unknown as T };
  function HookWrapper(): null {
    holder.current = hook();
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HookWrapper));
  });
  return {
    result: holder,
    unmount: () => {
      act(() => renderer.unmount());
    },
  };
}
function mkEntry(
  over: Partial<Omit<ScheduleSkeletonEntry, "showtimeId">> & { showtimeId: string },
): ScheduleSkeletonEntry {
  return {
    showtimeId: over.showtimeId as ScheduleSkeletonEntry["showtimeId"],
    theatreId: over.theatreId ?? THEATRE_ID,
    showDateTimeLocal: over.showDateTimeLocal ?? "2026-08-30T19:00",
    formatCode: over.formatCode ?? "STANDARD",
    distanceKm: over.distanceKm ?? null,
    rank: over.rank ?? 0,
    admitted: over.admitted ?? true,
    resolved: over.resolved ?? false,
  };
}

beforeEach(() => {
  resetStore();
  mockStartRealSearch.mockReset();
  useSeatfirstStore.setState({
    movie: "Dune",
    selectedMovieId: MOVIE_ID,
    selectedTheatre: {
      id: THEATRE_ID,
      providerId: "amc",
      name: "Test",
      city: "SF",
    } as unknown as never,
    selectedDates: ["2026-09-04", "2026-09-05", "2026-09-06"],
    timeOfDay: "Evening",
    formatPref: "any",
  });
});

describe("immediate result transition (ADR 0054: no screen flip before create succeeds)", () => {
  it("screen stays on search while create is in flight, then checking on success", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartRealSearch.mockImplementation(async () => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-ui", pendingHash: "h-ui" });
      await gate;
      store.setSearchId("srch_ui_1", "RUNNING");
      store.clearPendingKey();
      // Mirror useSearchSubscription: create success hands off to
      // reconcileAndSubscribe, which moves phase off "creating".
      store.setSearchReconciling();
    });
    const h = renderHook(() => useSeatfirstDemo());
    expect(h.result.current.screen).toBe("search");
    act(() => {
      h.result.current.actions.startSearch();
    });
    // Create-direct: the injected create runs, but nothing flips the screen yet.
    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    expect(useSeatfirstStore.getState().screen).toBe("search");
    expect(h.result.current.capacityGateBusy).toBe(true);
    await act(async () => {
      release();
      await gate;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useSeatfirstStore.getState().screen).toBe("checking");
    expect(h.result.current.capacityGateBusy).toBe(false);
    h.unmount();
  });
});

describe("placeholder count/replacement", () => {
  it("store placeholder clears when authoritative skeleton arrives and rendering switches from 20 generic to 20 actual in rank order", () => {
    // Exercise actual store contract: setPreviewPlaceholderCount then setScheduleSkeleton
    useSeatfirstStore.getState().setPreviewPlaceholderCount(20);
    expect(useSeatfirstStore.getState().previewPlaceholderCount).toBe(20);

    // ShowtimeList renders 20 generic placeholder rows when skeleton empty
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ShowtimeList, {
          skeleton: [],
          groups: [],
          partySize: 2,
          resolved: 0,
          total: 0,
          placeholderCount: useSeatfirstStore.getState().previewPlaceholderCount,
        }),
      );
    });
    let json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("placeholder-skeleton");
    expect((json.match(/placeholder-row/g) ?? []).length).toBe(20);
    act(() => renderer.unmount());

    // Authoritative skeleton arrives — store clears placeholder
    const skeleton = Array.from({ length: 20 }, (_, i) =>
      mkEntry({ showtimeId: `sh_${i}`, rank: i }),
    );
    useSeatfirstStore.getState().setScheduleSkeleton(skeleton);
    expect(useSeatfirstStore.getState().previewPlaceholderCount).toBeNull();
    expect(useSeatfirstStore.getState().scheduleSkeleton).toHaveLength(20);
    expect(useSeatfirstStore.getState().scheduleSkeleton.map((e) => e.showtimeId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `sh_${i}`),
    );

    // Rendering now shows 20 actual ShowtimeRow instances in stable server rank order, not placeholders
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ShowtimeList, {
          skeleton: useSeatfirstStore.getState().scheduleSkeleton,
          groups: [],
          partySize: 2,
          resolved: 0,
          total: 20,
          placeholderCount: useSeatfirstStore.getState().previewPlaceholderCount,
        }),
      );
    });
    json = JSON.stringify(renderer.toJSON());
    expect(json).not.toContain("placeholder-skeleton");
    // Count actual rows via ShowtimeRow testID or showtimeId presence
    const actualRows = renderer.root.findAllByType(ShowtimeRow);
    expect(actualRows).toHaveLength(20);
    expect(
      actualRows.map((n) => (n.props as { entry: ScheduleSkeletonEntry }).entry.showtimeId),
    ).toEqual(Array.from({ length: 20 }, (_, i) => `sh_${i}`));
    act(() => renderer.unmount());
  });
});

describe("capacity rejection clean return (ADR 0054: create was attempted, nothing to revert)", () => {
  it("CAPACITY_CEILING_EXCEEDED stays on search with the banner after attempting create", async () => {
    mockStartRealSearch.mockImplementation(() => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-blk", pendingHash: "h-blk" });
      store.setSearchError({
        message: "ceiling",
        code: "CAPACITY_CEILING_EXCEEDED",
        matchedCount: 237,
        limit: 200,
      });
      return Promise.resolve();
    });
    const h = renderHook(() => useSeatfirstDemo());
    expect(h.result.current.capacityBlockLabel).toBeNull();
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Create ran (no pre-submit block), the screen never left the form, and the
    // banner derives from store.error.
    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    expect(h.result.current.screen).toBe("search");
    expect(h.result.current.capacityBlockLabel).toContain("237");
    expect(useSeatfirstStore.getState().previewPlaceholderCount).toBeNull();
    h.unmount();
  });
});

describe("per-progress resolved patch preserving order", () => {
  it("setProgress marks resolved without reordering", () => {
    resetStore();
    const a = mkEntry({ showtimeId: "sh_a", rank: 0, resolved: false });
    const b = mkEntry({ showtimeId: "sh_b", rank: 1, resolved: false });
    const c = mkEntry({ showtimeId: "sh_c", rank: 2, resolved: false });
    useSeatfirstStore.getState().setScheduleSkeleton([a, b, c]);
    const groups: ResultGroup[] = [
      {
        showtimes: [
          {
            showtimeId: "sh_b" as unknown as never,
            resolved: true,
            showDateTimeUtc: "",
            theatreId: THEATRE_ID as unknown as never,
            distanceKm: null,
            timezone: "",
            status: "AVAILABLE",
            deepLinkUrl: "",
          } as unknown as ResultGroup["showtimes"][number],
        ],
        groupHits: [
          { showtimeIndices: [0], availableCount: 1 },
        ] as unknown as ResultGroup["groupHits"],
      } as unknown as ResultGroup,
    ];
    useSeatfirstStore.getState().setProgress({ resolved: 1, total: 3, groups });
    const s = useSeatfirstStore.getState();
    expect(s.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c"]);
    expect(s.scheduleSkeleton[1]?.resolved).toBe(true);
    expect(s.scheduleSkeleton[0]?.resolved).toBe(false);
  });
});

describe("miss-row disclosure", () => {
  it("keeps hit rows visible and reveals every resolved miss in one tap", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh0", rank: 0, admitted: true, resolved: true }),
      mkEntry({ showtimeId: "sh1", rank: 1, admitted: true, resolved: true }),
      mkEntry({ showtimeId: "sh2", rank: 2, admitted: true, resolved: true }),
      mkEntry({ showtimeId: "sh3", rank: 3, admitted: true, resolved: true }),
      mkEntry({ showtimeId: "sh4", rank: 4, admitted: true, resolved: true }),
    ];
    const groups: ResultGroup[] = [
      {
        showtimes: skeleton
          .slice(0, 2)
          .map((e) => ({ showtimeId: e.showtimeId, resolved: true }) as unknown as never),
        groupHits: [{ showtimeIndices: [0, 1], availableCount: 1 }] as unknown as never,
      } as unknown as ResultGroup,
      {
        showtimes: skeleton
          .slice(2)
          .map((e) => ({ showtimeId: e.showtimeId, resolved: true }) as unknown as never),
        groupHits: [] as unknown as never,
      } as unknown as ResultGroup,
    ];
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ShowtimeList, {
          skeleton,
          groups,
          partySize: 2,
          resolved: 5,
          total: 5,
        }),
      );
    });
    let rows = renderer.root.findAllByType(ShowtimeRow);
    expect(rows).toHaveLength(2);
    expect(rows.map((n) => (n.props as { entry: ScheduleSkeletonEntry }).entry.showtimeId)).toEqual(
      ["sh0", "sh1"],
    );
    let json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("miss-toggle");
    expect(json).toContain("3 didn't fit · show them");

    const toggle = renderer.root.findByProps({ testID: "miss-toggle" });
    act(() => {
      (toggle.props.onPress as () => void)();
    });

    rows = renderer.root.findAllByType(ShowtimeRow);
    expect(rows).toHaveLength(5);
    expect(rows.map((n) => (n.props as { entry: ScheduleSkeletonEntry }).entry.showtimeId)).toEqual(
      ["sh0", "sh1", "sh2", "sh3", "sh4"],
    );
    json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("Hide the 3 that didn't fit");
    expect(json).toContain("No 2 together");
    for (const id of ["sh0", "sh1", "sh2", "sh3", "sh4"]) {
      expect(json).toContain(id);
    }
    act(() => renderer.unmount());
  });
});
