// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { useSeatfirstStore } from "@/store/seatfirstStore";

const state = vi.hoisted(() => ({
  surface: "full",
  calls: [] as unknown[],
  impl: null as null | ((input: unknown) => Promise<unknown>),
}));

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn((input: unknown) => {
    state.calls.push(input);
    if (state.impl) return state.impl(input);
    return Promise.resolve({ movies: [] });
  }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {},
  trpcClient: {
    get movies() {
      return state.surface === "full"
        ? { search: { query: (...args: unknown[]) => mockQuery(...args) } }
        : undefined;
    },
  },
  queryClient: { clear: vi.fn() },
  getTrpcUrl: () => "http://localhost:3000/trpc",
}));

import { resetMovieSearchCachesForTests, useMovieSearch } from "./useMovieSearch";

function HookProbe(props: Parameters<typeof useMovieSearch>[0]) {
  useMovieSearch(props);
  return null;
}

function SuggestionProbe(
  props: Parameters<typeof useMovieSearch>[0] & { onSeen: (s: unknown) => void },
) {
  const { suggestions } = useMovieSearch(props);
  props.onSeen(suggestions);
  return null;
}

let activeRenderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  resetMovieSearchCachesForTests();
  mockQuery.mockClear();
  state.calls = [];
  state.impl = null;
  state.surface = "full";
  useSeatfirstStore.setState({ bootstrapReady: true } as never);
});

afterEach(() => {
  for (const r of activeRenderers) {
    r.unmount();
  }
  activeRenderers = [];
  resetMovieSearchCachesForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  mockQuery.mockClear();
  state.calls = [];
  state.impl = null;
  state.surface = "full";
  useSeatfirstStore.setState({ bootstrapReady: false } as never);
});

function createProbe(props: Parameters<typeof useMovieSearch>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HookProbe, props));
  });
  activeRenderers.push(renderer);
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function lastInput(): Record<string, unknown> {
  const calls = state.calls;
  return calls[calls.length - 1] as Record<string, unknown>;
}

describe("useMovieSearch browse-on-focus (UI42.3)", () => {
  it("empty query + browse true enables immediately and sends no query (slate)", async () => {
    createProbe({ query: "", browse: true });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(state.calls[0]).toEqual({});
  });

  it("empty query + browse false stays disabled", async () => {
    createProbe({ query: "", browse: false });
    await flush();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("single-char query fires immediately as browse (no query param, no debounce)", async () => {
    vi.useFakeTimers();
    createProbe({ query: "n", browse: true });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastInput().query).toBeUndefined();
    // No debounce timer involved: advancing time issues no further query.
    await act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("typed query (>= 2 chars) debounces: input lags 250ms", async () => {
    vi.useFakeTimers();
    const renderer = createProbe({ query: "no", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastInput().query).toBe("no");
    act(() => {
      renderer.update(React.createElement(HookProbe, { query: "nosf", browse: false }));
    });
    await flush();
    // Still the old debounced value until the timer fires.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    await act(() => {
      vi.advanceTimersByTime(200);
    });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(lastInput().query).toBe("nosf");
  });

  it("forwards limit when provided", async () => {
    createProbe({ query: "nosferatu", browse: false, limit: 10 });
    await flush();
    // Initial render fires with the typed query immediately (mount, no prior value).
    expect(lastInput().limit).toBe(10);
    expect(lastInput().query).toBe("nosferatu");
  });

  it("stays disabled until bootstrap is ready", async () => {
    useSeatfirstStore.setState({ bootstrapReady: false } as never);
    createProbe({ query: "nosferatu", browse: true });
    await flush();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("degrades to empty without crashing when the movies surface is absent", async () => {
    // Store-level suites mock trpc partially; the hook must not throw during
    // render when `trpcClient.movies.search` is missing.
    state.surface = "partial";
    let seen: unknown = "unset";
    act(() => {
      activeRenderers.push(
        TestRenderer.create(
          React.createElement(SuggestionProbe, {
            query: "nos",
            browse: true,
            onSeen: (s: unknown) => {
              seen = s;
            },
          }),
        ),
      );
    });
    await flush();
    expect(seen).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("useMovieSearch suggestion mapping (UI42.3/4)", () => {
  const HITS = [
    {
      id: "tmdb:movie:917496",
      title: "Nosferatu",
      releaseYear: 2024,
      posterPath: "/5qGIxdE841B6aOXmCj0O5a43ahA2.jpg",
      confidence: "WIDE_THEATRICAL",
      badge: null,
      seenAtAmc: false,
    },
    {
      id: "amc:movie:met-opera",
      title: "Met Opera Live",
      releaseYear: null,
      posterPath: null,
      confidence: "VERIFIED_AMC",
      badge: "AMC Event",
      seenAtAmc: true,
    },
    {
      id: "tmdb:movie:999",
      title: "Obscure Reissue",
      releaseYear: 1979,
      posterPath: null,
      confidence: "UNVERIFIED",
      badge: "May not be playing here",
      seenAtAmc: false,
    },
  ];

  async function captureSuggestions(): Promise<
    Array<{
      label: string;
      onPress: () => void;
      posterUrl: string | null;
      releaseYear: number | null;
      badge: string | null;
      seenAtAmc: boolean;
    }>
  > {
    state.impl = () => Promise.resolve({ movies: HITS });
    let seen: Array<{
      label: string;
      onPress: () => void;
      posterUrl: string | null;
      releaseYear: number | null;
      badge: string | null;
      seenAtAmc: boolean;
    }> = [];
    act(() => {
      activeRenderers.push(
        TestRenderer.create(
          React.createElement(SuggestionProbe, {
            query: "nos",
            browse: false,
            onSeen: (s) => {
              seen = s as typeof seen;
            },
          }),
        ),
      );
    });
    await flush();
    return seen;
  }

  it("maps hits to labels with release year, badges, and resolved poster URLs", async () => {
    const suggestions = await captureSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]?.label).toBe("Nosferatu (2024)");
    expect(suggestions[0]?.badge).toBeNull();
    expect(suggestions[0]?.seenAtAmc).toBe(false);
    expect(suggestions[0]?.releaseYear).toBe(2024);
    expect(suggestions[0]?.posterUrl).toBe(
      "https://image.tmdb.org/t/p/w185/5qGIxdE841B6aOXmCj0O5a43ahA2.jpg",
    );
    expect(suggestions[1]?.label).toBe("Met Opera Live");
    expect(suggestions[1]?.badge).toBe("AMC Event");
    expect(suggestions[1]?.seenAtAmc).toBe(true);
    expect(suggestions[1]?.posterUrl).toBeNull();
    expect(suggestions[2]?.label).toBe("Obscure Reissue (1979)");
    expect(suggestions[2]?.badge).toBe("May not be playing here");
  });

  it("picking a suggestion confirms a custom selection in the store", async () => {
    useSeatfirstStore.setState({ movie: "", selectedMovieId: null, movieSelectionSource: null });
    const suggestions = await captureSuggestions();
    act(() => {
      suggestions[0]?.onPress();
    });
    const s = useSeatfirstStore.getState();
    expect(s.movie).toBe("Nosferatu");
    expect(s.selectedMovieId).toBe("tmdb:movie:917496");
    expect(s.movieSelectionSource).toBe("custom");
  });
});

describe("useMovieSearch request de-duplication (audit finding 8)", () => {
  function holdInFlight(): Array<(value: unknown) => void> {
    const releases: Array<(value: unknown) => void> = [];
    state.impl = () => new Promise((resolve) => void releases.push(resolve));
    return releases;
  }

  async function settle(releases: Array<(value: unknown) => void>): Promise<void> {
    await act(() => {
      for (const release of releases) release({ movies: [] });
    });
    await flush();
  }

  it("coalesces identical concurrent requests across mounted instances to one call", async () => {
    // Audit repro: every useSubmitSearchViewModel owner (SearchForm, LeftPanel,
    // CollapsedFormBar) mounts its own hook instance with the same store query.
    // Holding the response keeps all five mounts overlapping while in flight.
    const releases = holdInFlight();
    for (let i = 0; i < 5; i++) createProbe({ query: "nosferatu-audit-5x", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastInput().query).toBe("nosferatu-audit-5x");
    await settle(releases);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rapid refetches while a request is pending join it instead of re-issuing", async () => {
    const releases = holdInFlight();
    let latestRefetch: () => void = () => {};
    function RefetchProbe(props: Parameters<typeof useMovieSearch>[0]) {
      const { refetch } = useMovieSearch(props);
      latestRefetch = refetch;
      return null;
    }
    act(() => {
      activeRenderers.push(
        TestRenderer.create(
          React.createElement(RefetchProbe, { query: "refetch-race", browse: false }),
        ),
      );
    });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      act(() => {
        latestRefetch();
      });
      await flush();
    }
    expect(mockQuery).toHaveBeenCalledTimes(1);
    await settle(releases);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("serves freshly-resolved inputs from cache on remount without a new call", async () => {
    createProbe({ query: "cache-hit-remount", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    activeRenderers.splice(0).forEach((r) => r.unmount());
    createProbe({ query: "cache-hit-remount", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("still issues a separate request for a different query", async () => {
    createProbe({ query: "dune-part-three", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    createProbe({ query: "nosferatu-2024", browse: false });
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(lastInput().query).toBe("nosferatu-2024");
  });
});
