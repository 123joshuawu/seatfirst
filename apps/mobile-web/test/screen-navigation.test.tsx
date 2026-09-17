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
import type { RankedAnswer, ResultGroup } from "@seatfirst/core";

const mockCancelSearch = vi.fn<(...args: unknown[]) => unknown>();
let mockStopFn: (() => void) | null = null;
const mockStartRealSearch = vi.fn<(spec: unknown) => Promise<void>>();
const mockRecheckShowtime = vi.fn<(input: unknown) => Promise<unknown>>();
mockRecheckShowtime.mockRejectedValue(new Error("not expected in these tests"));

vi.mock("@/api/search", () => ({
  cancelSearch: (...args: unknown[]) => mockCancelSearch(...args),
  createSearch: vi.fn(),
  getSearch: vi.fn(),
}));

vi.mock("@/lib/searchSubscriptionController", () => ({
  setStopSubscription: vi.fn(),
  getStopSubscription: () => mockStopFn,
}));

vi.mock("@/api/showtimes", () => ({
  recheckShowtime: (input: unknown) => mockRecheckShowtime(input),
}));

// Sibling hooks need react-query providers; stub them — the screen derivation
// under test does not depend on their data.
vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: undefined, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    searches: {},
  },
  trpc: { searches: { create: { useMutation: () => ({ mutate: vi.fn() }) } } },
}));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: mockStartRealSearch }),
}));

import { useSeatfirstDemo } from "./useSeatfirstDemo";

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
  });
}

interface Harness {
  result: { current: ReturnType<typeof useSeatfirstDemo> };
  rerender: () => void;
  unmount: () => void;
}

/** Renders the real hook via react-test-renderer (repo convention, see a11y-motion.test.tsx). */
function renderHookHarness(): Harness {
  const result = {
    current: undefined as unknown as ReturnType<typeof useSeatfirstDemo>,
  };
  function HookComp(): React.JSX.Element | null {
    result.current = useSeatfirstDemo();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const element = React.createElement(HookComp);
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return {
    result,
    rerender: () => {
      act(() => {
        renderer!.update(element);
      });
    },
    unmount: () => {
      act(() => {
        renderer!.unmount();
      });
    },
  };
}

const THEATRE_ID = "amc:theatre:832";
const MOVIE_ID = "amc:movie:78421";

/** Seed form selections so the form is editable and a new search can start. */
function seedSelections(): void {
  useSeatfirstStore.setState({
    movie: "Dune: Part Two",
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
    } as NonNullable<ReturnType<typeof useSeatfirstStore.getState>["selectedTheatre"]>,
  });
}

describe("backToSearch / changeFormat / widenWindow return to and stay on the form", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockStopFn = null;
  });

  it("Bug 1: backToSearch lands on the editable form and stays there across re-renders", () => {
    seedSelections();
    // COMPLETE + non-null answer is exactly what re-derived "result" over
    // screen:"search" on every render before the fix.
    act(() => {
      useSeatfirstStore.getState().setSearchTerminal({
        status: "COMPLETE",
        answer: { mode: "CONFIDENT", otherFormats: [] } as unknown as RankedAnswer,
        groups: [],
        resolved: 12,
        total: 12,
      });
    });
    const h = renderHookHarness();

    expect(h.result.current.screen).toBe("result");

    act(() => {
      h.result.current.actions.backToSearch();
    });

    expect(h.result.current.screen).toBe("search");
    // Live search identity cleared — nothing left for the derivation to override with.
    const st = useSeatfirstStore.getState();
    expect(st.searchId).toBeNull();
    expect(st.status).toBeNull();
    expect(st.answer).toBeNull();
    // Form fields preserved (only live search state reset).
    expect(st.movie).toBe("Dune: Part Two");
    expect(st.selectedMovieId).toBe(MOVIE_ID);
    expect(st.selectedTheatre?.id).toBe(THEATRE_ID);
    // Form unlocked and editable.
    expect(h.result.current.isLocked).toBe(false);

    // Durable across a re-render / effect flush — not a one-frame flicker back.
    h.rerender();
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("changeFormat from a PARTIAL terminal screen returns to and stays on the form, format reset", () => {
    act(() => {
      useSeatfirstStore.setState({ formatPref: "imax" });
      useSeatfirstStore
        .getState()
        .setSearchTerminal({ status: "PARTIAL", answer: null, groups: [], resolved: 9, total: 12 });
    });
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("partial");

    act(() => {
      h.result.current.actions.changeFormat();
    });
    expect(h.result.current.screen).toBe("search");
    expect(useSeatfirstStore.getState().formatPref).toBe("any");
    expect(useSeatfirstStore.getState().status).toBeNull();

    h.rerender();
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("widenWindow returns to and stays on the form", () => {
    act(() => {
      useSeatfirstStore.setState({ timeOfDay: "Morning" });
      useSeatfirstStore.getState().setSearchTerminal({
        status: "HALTED",
        answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] } as unknown as RankedAnswer,
        groups: [],
      });
    });
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("halted");

    act(() => {
      h.result.current.actions.widenWindow();
    });
    expect(h.result.current.screen).toBe("search");
    expect(useSeatfirstStore.getState().timeOfDay).toBe("All times");

    h.rerender();
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("restart clears the stale terminal answer too (same override path)", () => {
    seedSelections();
    act(() => {
      useSeatfirstStore.getState().setSearchTerminal({
        status: "COMPLETE",
        answer: { mode: "CONFIDENT", otherFormats: [] } as unknown as RankedAnswer,
        groups: [],
      });
    });
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("result");

    act(() => {
      h.result.current.actions.restart();
    });
    expect(h.result.current.screen).toBe("search");
    const st = useSeatfirstStore.getState();
    expect(st.answer).toBeNull();
    expect(st.status).toBeNull();
    expect(st.movie).toBe("");
    expect(st.selectedTheatre).toBeNull();
    h.unmount();
  });

  it("a new search still starts normally after backToSearch (create-direct, checking on success)", async () => {
    seedSelections();
    act(() => {
      useSeatfirstStore.getState().setSearchTerminal({
        status: "COMPLETE",
        answer: { mode: "CONFIDENT", otherFormats: [] } as unknown as RankedAnswer,
        groups: [],
      });
    });
    const h = renderHookHarness();

    act(() => {
      h.result.current.actions.backToSearch();
    });
    expect(h.result.current.screen).toBe("search");

    // ADR 0054: submit calls create directly; checking arrives via setSearchId.
    mockStartRealSearch.mockImplementation(() => {
      const store = useSeatfirstStore.getState();
      store.setSearchCreating({ pendingKey: "k-nav", pendingHash: "h-nav" });
      store.setSearchId("srch_nav_1", "RUNNING");
      store.clearPendingKey();
      return Promise.resolve();
    });
    await act(async () => {
      h.result.current.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockStartRealSearch).toHaveBeenCalledTimes(1);
    expect(h.result.current.screen).toBe("checking");
    h.unmount();
  });
});

describe("cancel resolves to the editable form, not a cancelled results screen", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockStopFn = null;
  });

  it("Bug 2: successful cancel lands on the unlocked form with prior selections intact", async () => {
    seedSelections();
    useSeatfirstStore.getState().setSearchId("srch_test123", "RUNNING");
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("checking");
    expect(h.result.current.isLocked).toBe(true);

    mockCancelSearch.mockResolvedValue({ searchId: "srch_test123", status: "CANCELLED" });
    mockStopFn = vi.fn();
    await act(async () => {
      await h.result.current.actions.cancelSearch();
    });

    expect(mockCancelSearch).toHaveBeenCalledWith("srch_test123");
    expect(h.result.current.screen).toBe("search");
    // Unlocked per UI5.5; status reflects the server response per UI5.4/UI5.5.
    expect(h.result.current.isLocked).toBe(false);
    expect(useSeatfirstStore.getState().status).toBe("CANCELLED");
    // Prior inputs NOT cleared (UI5 verification 4: "form still shows prior inputs").
    expect(h.result.current.movieValue).toBe("Dune: Part Two");
    expect(h.result.current.theaterConfirmed).toBe(true);
    expect(mockStopFn).toHaveBeenCalledTimes(1);

    // Durable across a re-render / effect flush.
    h.rerender();
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });

  it("CANCELLED arriving via setSearchTerminal (SSE/polling path) also returns to the form", () => {
    seedSelections();
    useSeatfirstStore.getState().setSearchId("srch_x", "RUNNING");
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("checking");

    act(() => {
      useSeatfirstStore.getState().setSearchTerminal({ status: "CANCELLED", answer: null });
    });
    expect(h.result.current.screen).toBe("search");
    expect(h.result.current.isLocked).toBe(false);

    h.rerender();
    expect(h.result.current.screen).toBe("search");
    h.unmount();
  });
});

describe("UI30 — handoff rechecks inline without leaving the results screen", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockStopFn = null;
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
  });

  it("an AVAILABLE handoff never leaves the derived result screen", async () => {
    act(() => {
      useSeatfirstStore.getState().setSearchTerminal({
        status: "COMPLETE",
        answer: {
          mode: "CONFIDENT",
          otherFormats: [],
          primary: {
            placement: { placementKey: "nav_key" },
            showtimes: [
              {
                showtimeId: "sh_nav",
                nonce: "nonce_sh_nav",
                deepLinkUrl: "https://www.amctheatres.com/showtimes/sh_nav/seats",
              },
            ],
          },
        } as unknown as RankedAnswer,
        groups: [
          {
            // Decoy layout: placement-card resolution matches groups by layoutId,
            // so this row must not match any recommendation — it exists only for
            // the AVAILABLE path's deep-link lookup.
            layoutId: "lay_decoy_no_match",
            showtimes: [
              {
                showtimeId: "sh_nav",
                deepLinkUrl: "https://www.amctheatres.com/showtimes/sh_nav/seats",
              },
            ],
          },
        ] as unknown as ResultGroup[],
        resolved: 1,
        total: 1,
      });
      useSeatfirstStore.setState({ searchId: "search_nav" });
    });
    const h = renderHookHarness();
    expect(h.result.current.screen).toBe("result");

    await act(async () => {
      h.result.current.actions.startHandoff("sh_nav");
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {});

    // Still on the results surface — no confirmed/replacement screen intervenes.
    expect(h.result.current.screen).toBe("result");
    h.rerender();
    expect(h.result.current.screen).toBe("result");
    expect(useSeatfirstStore.getState().recheckResult).toMatchObject({ status: "AVAILABLE" });
    expect(useSeatfirstStore.getState().recheckingShowtimeId).toBeNull();
    h.unmount();
  });
});
