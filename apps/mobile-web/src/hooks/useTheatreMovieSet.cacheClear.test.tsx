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
  });
});
