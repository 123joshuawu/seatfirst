/* eslint-disable @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, create } from "react-test-renderer";
import React from "react";
import type { TheatreMoviesResponse } from "@seatfirst/core";

// UI42.6 regression: `clearTheatreMovieCache()` used to be invisible to React
// — nothing subscribed to the cleared cache, so a successful "Check today's
// live schedule" call never caused the movie list to refetch. See
// `useTheatreMovieSet.ts` for the fix (cache clears notify subscribers).
const mockQuery = vi.fn<(input: { theatreId: string; from: string; to: string }) => unknown>();
vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    theatres: {
      movies: {
        query: (input: { theatreId: string; from: string; to: string }) => mockQuery(input),
      },
    },
  },
}));

import { clearTheatreMovieCache, useTheatreMovieSet } from "./useTheatreMovieSet";
import { useSeatfirstStore } from "@/store/seatfirstStore";

function response(movieId: string, title: string): TheatreMoviesResponse {
  return {
    theatreId: "amc:theatre:54",
    timezone: "America/Denver",
    from: "2026-09-18",
    to: "2026-09-18",
    movies: [
      {
        movieId,
        title,
        posterPath: null,
        runtimeMinutes: null,
        genres: [],
        showtimes: [],
      },
    ],
  } as unknown as TheatreMoviesResponse;
}

function TestHarness() {
  const { movies } = useTheatreMovieSet({
    theatreIds: ["amc:theatre:54"],
    from: "2026-09-18",
    to: "2026-09-18",
  });
  return React.createElement("div", {
    "data-testid": "movies",
    "data-titles": JSON.stringify(movies.map((m) => m.title)),
  });
}

function responseFor(theatreId: string, movieId: string, title: string): TheatreMoviesResponse {
  return {
    theatreId,
    timezone: "America/Denver",
    from: "2026-09-18",
    to: "2026-09-18",
    movies: [
      {
        movieId,
        title,
        posterPath: null,
        runtimeMinutes: null,
        genres: [],
        showtimes: [],
      },
    ],
  } as unknown as TheatreMoviesResponse;
}

function MultiHarness({ theatreIds }: { theatreIds: readonly string[] }) {
  const { movies } = useTheatreMovieSet({
    theatreIds,
    from: "2026-09-18",
    to: "2026-09-18",
  });
  return React.createElement("div", {
    "data-testid": "movies-multi",
    "data-titles": JSON.stringify(movies.map((m) => m.title)),
  });
}

interface PendingFetch {
  resolve: (value: TheatreMoviesResponse) => void;
  reject: (cause: unknown) => void;
}

// BATCH-414 dedup: hold every `movies.query` call open until the test settles
// it, so an effect re-run (or a second mounted instance) lands inside the same
// in-flight window the live 6-theatre → 12-query duplication needed.
function holdQueriesOpen(pending: Map<string, PendingFetch>): void {
  mockQuery.mockImplementation(
    (input: { theatreId: string; from: string; to: string }) =>
      new Promise<TheatreMoviesResponse>((resolve, reject) => {
        pending.set(input.theatreId, { resolve, reject });
      }),
  );
}

describe("useTheatreMovieSet — cache-clear notification (UI42.6 refresh gap)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    clearTheatreMovieCache();
    useSeatfirstStore.setState({
      bootstrapReady: true,
      selectedTheatreMovies: null,
    } as never);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refetches and swaps in fresh data after clearTheatreMovieCache(), without any prop change", async () => {
    mockQuery.mockResolvedValueOnce(response("cold:movie:1", "Cold Mode Pick"));
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(TestHarness));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    let el = renderer!.root.findByProps({ "data-testid": "movies" });
    expect(JSON.parse(el.props["data-titles"] as string)).toEqual(["Cold Mode Pick"]);

    // Simulate a successful "Check today's live schedule" refresh: the real
    // handler calls exactly this, with no other prop/state change on the
    // hook's inputs.
    mockQuery.mockResolvedValueOnce(response("amc:movie:real", "Practical Magic 2"));
    await act(async () => {
      clearTheatreMovieCache();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    el = renderer!.root.findByProps({ "data-testid": "movies" });
    expect(JSON.parse(el.props["data-titles"] as string)).toEqual(["Practical Magic 2"]);
    // Hygiene for the multi-test file: a lingering mount would refetch on the
    // next test's `clearTheatreMovieCache()` and pollute its call counts.
    renderer!.unmount();
  });
});

describe("useTheatreMovieSet — in-flight dedup (batched 414 duplicate fix)", () => {
  const mounted: Array<ReturnType<typeof create>> = [];

  beforeEach(() => {
    mockQuery.mockReset();
    clearTheatreMovieCache();
    useSeatfirstStore.setState({
      bootstrapReady: true,
      selectedTheatreMovies: null,
    } as never);
  });
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount();
    vi.clearAllMocks();
  });

  it("reuses the pending fetch when the effect re-runs before the first round settles", async () => {
    const pending = new Map<string, PendingFetch>();
    holdQueriesOpen(pending);
    const theatreIds = ["amc:theatre:1", "amc:theatre:2"];
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(MultiHarness, { theatreIds }));
      mounted.push(renderer);
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // The live repro: the effect re-runs (a new store/`legacyResponse`
    // reference, same range) before either fetch settles. Without dedup this
    // fires a second `theatres.movies` per theatre (6 → 12, then 414).
    await act(async () => {
      useSeatfirstStore.setState({
        selectedTheatreMovies: {
          theatreId: "amc:theatre:other",
          from: "2026-09-18",
          to: "2026-09-18",
        } as never,
      });
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.map(([input]) => input.theatreId).sort()).toEqual([
      "amc:theatre:1",
      "amc:theatre:2",
    ]);

    await act(async () => {
      pending.get("amc:theatre:1")!.resolve(responseFor("amc:theatre:1", "m1", "Alpha"));
      pending.get("amc:theatre:2")!.resolve(responseFor("amc:theatre:2", "m2", "Beta"));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    const el = renderer!.root.findByProps({ "data-testid": "movies-multi" });
    expect(JSON.parse(el.props["data-titles"] as string).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("shares one fetch per theatre across two simultaneously mounted instances", async () => {
    const pending = new Map<string, PendingFetch>();
    holdQueriesOpen(pending);
    const theatreIds = ["amc:theatre:1", "amc:theatre:2"];
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        React.createElement(
          "div",
          null,
          React.createElement(MultiHarness, { theatreIds }),
          React.createElement(MultiHarness, { theatreIds }),
        ),
      );
      mounted.push(renderer);
    });
    // One `movies.query` per theatre — not one per mount (which would be 4).
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.map(([input]) => input.theatreId).sort()).toEqual([
      "amc:theatre:1",
      "amc:theatre:2",
    ]);

    await act(async () => {
      pending.get("amc:theatre:1")!.resolve(responseFor("amc:theatre:1", "m1", "Alpha"));
      pending.get("amc:theatre:2")!.resolve(responseFor("amc:theatre:2", "m2", "Beta"));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    const nodes = renderer!.root.findAllByProps({ "data-testid": "movies-multi" });
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(JSON.parse(node.props["data-titles"] as string).sort()).toEqual(["Alpha", "Beta"]);
    }
  });

  it("fetches again once the in-flight request has settled (dedup window closes)", async () => {
    const pending = new Map<string, PendingFetch>();
    holdQueriesOpen(pending);
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(MultiHarness, { theatreIds: ["amc:theatre:1"] }));
      mounted.push(renderer);
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.get("amc:theatre:1")!.resolve(responseFor("amc:theatre:1", "m1", "Alpha"));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // A later refresh (cache cleared, effect re-runs) must NOT be swallowed by
    // a stale in-flight entry — the window closed when the promise settled.
    await act(async () => {
      clearTheatreMovieCache();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
