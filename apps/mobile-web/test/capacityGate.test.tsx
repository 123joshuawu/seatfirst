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

/**
 * UI27 verification — the create-direct submit path (`wrappedStartSearch`, ADR 0054),
 * over a mocked tRPC layer exactly as the component suite does elsewhere.
 *
 * Contract under test:
 * - submit calls the injected `create` exactly once per explicit submit attempt and
 *   NOWHERE else (chip taps, format changes, text entry, mount).
 * - screen never leaves "search" until `create` succeeds — `setSearchId` flips it to
 *   "checking", so no revert path exists.
 * - a `CAPACITY_CEILING_EXCEEDED` create rejection surfaces the exact returned count
 *   plus fixed remedy copy through the reactive capacityBlockLabel, with busy clearing.
 * - other rejection codes (e.g. ADMISSION_REJECTED) produce no capacity banner.
 */

import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";

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

const mockStartRealSearch = vi.fn<(spec: unknown) => Promise<void>>();
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
    ...bootstrapInitialState,
    ...searchInitialState,
    ...flowInitialState,
    ...searchFormInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    selectedTheatreMovies: null,
  });
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
  return { result, unmount: () => renderer.unmount() };
}

beforeEach(() => {
  resetStore();
  mockStartRealSearch.mockReset();
  // A valid selection so the spec builds (fail-closed null check passes).
  useSeatfirstStore.setState({
    movie: "Dune: Part Three",
    selectedMovieId: MOVIE_ID,
    selectedTheatre: {
      id: THEATRE_ID,
      providerId: "amc",
      name: "AMC Metreon 16",
      location: { lat: 37.7846, lng: -122.4081 },
      timezone: "America/Los_Angeles",
      city: "San Francisco",
      address: null,
      slugs: null,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
      distanceKm: null,
    },
  });
});

describe("UI27 create-direct submit-time capacity gate", () => {
  it("submit calls create once with the v2 spec and stays on search", async () => {
    mockStartRealSearch.mockResolvedValue(undefined);
    const h = renderHook(() => useSeatfirstDemo());
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    const created = mockStartRealSearch.mock.calls[0]?.[0] as {
      specVersion: unknown;
      where: unknown;
    };
    expect(created.specVersion).toBe(2);
    // No screen flip on submit alone — checking arrives only via setSearchId.
    expect(h.result.current.screen).toBe("search");
    expect(h.result.current.capacityGateBusy).toBe(false);
    h.unmount();
  });

  it("successful create flips to checking via setSearchId (no manual transition)", async () => {
    mockStartRealSearch.mockImplementation(() => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-ok", pendingHash: "h-ok" });
      store.setSearchId("srch_gate_ok", "RUNNING");
      store.clearPendingKey();
      return Promise.resolve();
    });
    const h = renderHook(() => useSeatfirstDemo());
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    expect(h.result.current.screen).toBe("checking");
    expect(h.result.current.isChecking).toBe(true);
    h.unmount();
  });

  it("capacity rejection renders the banner, stays on search, clears busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartRealSearch.mockImplementation(async () => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-cap", pendingHash: "h-cap" });
      await gate;
      store.setSearchError({
        message: "ceiling",
        code: "CAPACITY_CEILING_EXCEEDED",
        matchedCount: 237,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      });
    });
    const h = renderHook(() => useSeatfirstDemo());
    act(() => {
      h.result.current.actions.startSearch();
    });
    // In-flight create: busy derives from phase, screen still on the form.
    expect(h.result.current.capacityGateBusy).toBe(true);
    expect(h.result.current.screen).toBe("search");
    await act(async () => {
      release();
      await gate;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.result.current.capacityGateBusy).toBe(false);
    expect(h.result.current.capacityBlockLabel).toBe(
      `237 showtimes match — above the ${DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes} limit. Narrow your filters to continue.`,
    );
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("admission rejection shows the admission label and no capacity banner", async () => {
    mockStartRealSearch.mockImplementation(() => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-adm", pendingHash: "h-adm" });
      store.setSearchError({
        message: "admission",
        code: "ADMISSION_REJECTED",
        retryAfterSeconds: 30,
      });
      return Promise.resolve();
    });
    const h = renderHook(() => useSeatfirstDemo());
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    expect(h.result.current.capacityBlockLabel).toBeNull();
    expect(h.result.current.admissionRejected).toEqual({ retryAfterSeconds: 30 });
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("the capacity banner survives filter edits until the next submit (reactive derivation)", async () => {
    mockStartRealSearch.mockImplementation(() => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-cap2", pendingHash: "h-cap2" });
      store.setSearchError({
        message: "ceiling",
        code: "CAPACITY_CEILING_EXCEEDED",
        matchedCount: 250,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      });
      return Promise.resolve();
    });
    const h = renderHook(() => useSeatfirstDemo());
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.result.current.capacityBlockLabel).not.toBeNull();
    act(() => {
      useSeatfirstStore.getState().selectTod("All times");
    });
    // Like admissionRejected, the banner derives from store.error — editing filters
    // no longer clears it; only the next submit's setSearchCreating does.
    expect(h.result.current.capacityBlockLabel).not.toBeNull();
    h.unmount();
  });

  it("chip taps, format changes, and text entry never invoke create", async () => {
    const h = renderHook(() => useSeatfirstDemo());
    act(() => {
      const [firstDate] = useSeatfirstStore.getState().selectedDates;
      useSeatfirstStore.getState().removeSelectedDate(firstDate!);
    });
    act(() => {
      useSeatfirstStore.getState().selectTod("Evening");
    });
    act(() => {
      useSeatfirstStore.getState().selectFormat("imax");
    });
    act(() => {
      useSeatfirstStore.setState({ movie: "Dune Part" });
    });
    await act(async () => {});
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    h.unmount();
  });

  it("mount does not invoke create (negative: no create on mount)", async () => {
    const h = renderHook(() => useSeatfirstDemo());
    await act(async () => {});
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    h.unmount();
  });

  it("focus events do not invoke create (negative: focus)", async () => {
    const h = renderHook(() => useSeatfirstDemo());
    act(() => {
      h.result.current.actions.onMovieFocus();
    });
    act(() => {
      h.result.current.actions.onTheaterFocus();
    });
    act(() => {
      h.result.current.actions.onMovieBlur();
    });
    act(() => {
      h.result.current.actions.onTheaterBlur();
    });
    await act(async () => {});
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    h.unmount();
  });

  it("debounce/tick after interactions does not invoke create (negative: debounce)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = renderHook(() => useSeatfirstDemo());
    act(() => {
      useSeatfirstStore.getState().toggleBand("Morning");
    });
    act(() => {
      useSeatfirstStore.getState().selectTod("Morning");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockStartRealSearch).not.toHaveBeenCalled();
    vi.useRealTimers();
    h.unmount();
  });
});
