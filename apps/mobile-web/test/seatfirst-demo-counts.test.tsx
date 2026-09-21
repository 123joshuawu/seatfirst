import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { MovieIdSchema, ShowtimeIdSchema, TheatreIdSchema } from "@seatfirst/core";
import type { TheatreMoviesResponse } from "@seatfirst/core";
import { recheckInitialState } from "@/store/recheckSlice";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    searches: { create: { useMutation: () => ({ mutate: vi.fn() }) } },
    sessions: { bootstrap: { useQuery: () => ({ data: null }) } },
  },
  trpcClient: {},
  getTrpcUrl: () => "http://localhost:3000/trpc",
  queryClient: { clear: vi.fn() },
}));

// Fixture: 7 showtimes for one movie at AMC Metreon 16, America/Los_Angeles (UTC-8 in Feb).
// Hand-derived theatre-local calendar (see src/lib/buildSearchSpec.window.test.ts):
//   s1 Fri Feb 6 12:00 imax · s2 Fri Feb 6 18:00 dolbycinemaatamcprime · s3 Sat Feb 7 01:30 standard (null)
//   s4 Sat Feb 7 11:00 standard (null) · s5 Sat Feb 7 18:00 imax · s6 Sat Feb 7 20:00 null
//   s7 Sun Feb 8 17:00 dolbycinemaatamcprime
const THEATRE_ID = TheatreIdSchema.parse("amc:theatre:832");
const MOVIE_ID = MovieIdSchema.parse("amc:movie:78421");
const FIXTURE: TheatreMoviesResponse = {
  theatreId: THEATRE_ID,
  timezone: "America/Los_Angeles",
  from: "2026-02-06",
  to: "2026-03-07",
  isWarm: true,
  movies: [
    {
      movieId: MOVIE_ID,
      title: "Dune: Part Three",
      posterPath: "/abc123.jpg",
      runtimeMinutes: 166,
      genres: ["Action", "Adventure"],
      showtimes: [
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st1"),
          showDateTimeUtc: "2026-02-06T20:00:00Z",
          status: "OPEN",
          formatCode: "imax",
          auditorium: "1",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/1",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st2"),
          showDateTimeUtc: "2026-02-07T02:00:00Z",
          status: "OPEN",
          formatCode: "dolbycinemaatamcprime",
          auditorium: "2",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/2",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st3"),
          showDateTimeUtc: "2026-02-07T09:30:00Z",
          status: "OPEN",
          formatCode: null,
          auditorium: "3",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/3",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st4"),
          showDateTimeUtc: "2026-02-07T19:00:00Z",
          status: "OPEN",
          formatCode: null,
          auditorium: "3",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/4",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st5"),
          showDateTimeUtc: "2026-02-08T02:00:00Z",
          status: "OPEN",
          formatCode: "imax",
          auditorium: "1",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/5",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st6"),
          showDateTimeUtc: "2026-02-08T04:00:00Z",
          status: "OPEN",
          formatCode: null,
          auditorium: "4",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/6",
          attributes: [],
        },
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st7"),
          showDateTimeUtc: "2026-02-09T01:00:00Z",
          status: "OPEN",
          formatCode: "dolbycinemaatamcprime",
          auditorium: "2",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/7",
          attributes: [],
        },
        // Monday Feb 9 20:00 PST — outside the Fri/Sat/Sun chip vocabulary entirely, so
        // any day-chip selection yields a genuine zero-match window.
        {
          showtimeId: ShowtimeIdSchema.parse("amc:showtime:st8"),
          showDateTimeUtc: "2026-02-10T04:00:00Z",
          status: "OPEN",
          formatCode: null,
          auditorium: "5",
          runtimeMinutes: 166,
          deepLinkUrl: "https://example.invalid/8",
          attributes: [],
        },
      ],
    },
    {
      movieId: MovieIdSchema.parse("amc:movie:78502"),
      title: "The Long Reel",
      posterPath: null,
      runtimeMinutes: null,
      genres: [],
      showtimes: [],
    },
  ],
};

vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: FIXTURE, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

import { useSeatfirstDemo } from "./useSeatfirstDemo";

function resetStore(): void {
  useSeatfirstStore.setState({
    ...bootstrapInitialState,
    ...searchInitialState,
    ...flowInitialState,
    ...searchFormInitialState,
    // Keep the date filter aligned with this fixed fixture instead of the wall clock.
    selectedDates: ["2026-02-06", "2026-02-07", "2026-02-08", "2026-02-09"],
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

function selectMovieAndTheatre(): void {
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
      amenities: [],
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
      distanceKm: null,
    },
    selectedTheatreMovies: FIXTURE,
  });
}
describe("useSeatfirstDemo real window counts, search gate, and poster", () => {
  beforeEach(() => {
    resetStore();
  });

  it("all format chips stay bare at hook level — counts render via ChipRow facets", () => {
    selectMovieAndTheatre();
    useSeatfirstStore.setState({
      selectedDates: ["2026-02-06"],
      timeOfDay: "All times",
      selectedBands: [],
    });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    // No pre-baked "(N)" suffix: "Any format" renders its count through the
    // same ChipRow/getFacetDisplay path as IMAX/Dolby/Standard (ADR 0036
    // amendment) — the hook only supplies the bare label.
    const labels = result.current.formatOptions.map((o) => o.label);
    expect(labels).toEqual(["Any format", "IMAX", "Dolby Cinema", "Standard"]);
    expect(result.current.matchingShowtimeCount).toBe(2);
    unmount();
  });

  it("derives CTA scope from warm counts", () => {
    selectMovieAndTheatre();
    useSeatfirstStore.setState({
      selectedDates: ["2026-02-06"],
      timeOfDay: "All times",
      selectedBands: [],
    });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.submitButtonLabel).toBe("Search 2 showtimes across 1 theatre");
    unmount();
  });

  it("zero day chips: all 8 showtimes count regardless of timeOfDay chip", () => {
    // NOTE: the app's shipped default window is Fri/Sat/Sun + Evening
    // (searchFormInitialState), so the zero-day-chips edge case must clear the chips
    // explicitly.
    selectMovieAndTheatre();
    useSeatfirstStore.setState({
      selectedDates: ["2026-02-06", "2026-02-07", "2026-02-08", "2026-02-09"],
      timeOfDay: "All times",
      selectedBands: [],
    });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.matchingShowtimeCount).toBe(8);
    expect(result.current.formatOptions.map((o) => o.label)).toEqual([
      "Any format",
      "IMAX",
      "Dolby Cinema",
      "Standard",
    ]);
    unmount();
  });

  it("toggling to Saturday + Evening updates counts to 2 (imax 1, standard 1)", () => {
    selectMovieAndTheatre();
    useSeatfirstStore.setState({ selectedDates: ["2026-02-07"] });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.matchingShowtimeCount).toBe(2);
    unmount();
  });

  it("zero matching showtimes disables Find my seats", () => {
    selectMovieAndTheatre();
    // Hand-derived: the fixture has no Fri/Sat/Sun day+evening combination with zero
    // matches, and "Morning"/"All times" fall back to 00:00–23:59 (no restriction), so
    // the honest zero here is the second movie, whose showtime list is empty. The
    // weekday-vs-Monday zero is covered at the unit level (buildSearchSpec.window.test.ts).
    useSeatfirstStore.setState({ selectedMovieId: "amc:movie:78502", movie: "The Long Reel" });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.matchingShowtimeCount).toBe(0);
    expect(result.current.searchDisabled).toBe(true);
    expect(result.current.submitButtonLabel).toBe("No showtimes match");
    unmount();
  });

  it("posterUrl joins the TMDB image base; null posterPath stays null", () => {
    selectMovieAndTheatre();
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.posterUrl).toBe("https://image.tmdb.org/t/p/w185/abc123.jpg");
    unmount();
    useSeatfirstStore.setState({ selectedMovieId: "amc:movie:78502", movie: "The Long Reel" });
    const second = renderHook(() => useSeatfirstDemo());
    expect(second.result.current.posterUrl).toBeNull();
    second.unmount();
  });

  it("selecting a format narrows matchingShowtimeCount to that format (UI16, ADR 0039 d2)", () => {
    // Hand-derived over the whole fixture with zero chips + All times (8 showtimes:
    // imax 2, dolby 2, standard 4): the "N showtimes will be searched" figure must equal
    // the selected format's own count so it can never contradict the submitted FORMAT leaf.
    selectMovieAndTheatre();
    useSeatfirstStore.setState({
      selectedDates: ["2026-02-06", "2026-02-07", "2026-02-08", "2026-02-09"],
      timeOfDay: "All times",
      selectedBands: [],
      formatPref: "imax",
    });
    const { result, unmount } = renderHook(() => useSeatfirstDemo());
    expect(result.current.matchingShowtimeCount).toBe(2);
    unmount();

    useSeatfirstStore.setState({ formatPref: "dolby" });
    const second = renderHook(() => useSeatfirstDemo());
    expect(second.result.current.matchingShowtimeCount).toBe(2);
    second.unmount();

    useSeatfirstStore.setState({ formatPref: "any" });
    const third = renderHook(() => useSeatfirstDemo());
    expect(third.result.current.matchingShowtimeCount).toBe(8);
    third.unmount();
  });
  it("format narrowing works for non-Any-day windows: Saturday Evening respects FORMAT (UI16.3 extended)", () => {
    // Hand-derived with Saturday + Evening (17:00–20:59): s5 Sat18 imax, s6 Sat20 standard => 2
    selectMovieAndTheatre();
    useSeatfirstStore.setState({
      selectedDates: ["2026-02-07"],
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      formatPref: "any",
    });
    const any = renderHook(() => useSeatfirstDemo());
    expect(any.result.current.matchingShowtimeCount).toBe(2);
    expect(any.result.current.formatOptions.map((o) => o.label)).toEqual([
      "Any format",
      "IMAX",
      "Dolby Cinema",
      "Standard",
    ]);
    any.unmount();

    useSeatfirstStore.setState({ formatPref: "imax" });
    const imax = renderHook(() => useSeatfirstDemo());
    expect(imax.result.current.matchingShowtimeCount).toBe(1); // s5 only
    imax.unmount();

    useSeatfirstStore.setState({ formatPref: "standard" });
    const std = renderHook(() => useSeatfirstDemo());
    expect(std.result.current.matchingShowtimeCount).toBe(1); // s6 only
    std.unmount();

    useSeatfirstStore.setState({ formatPref: "dolby" });
    const dolby = renderHook(() => useSeatfirstDemo());
    expect(dolby.result.current.matchingShowtimeCount).toBe(0); // no dolby on Sat evening
    dolby.unmount();
  });

  it("Any day + Evening narrowing matches summarizeMovieWindow with FORMAT (UI16.2/3 parity)", () => {
    // Zero chips + Evening across whole FIXTURE (8 showtimes): s2 Fri18 dolby, s5 Sat18 imax, s6 Sat20 std, s7 Sun17 dolby, st8 Mon20 std => 5
    // Verify the hook's count equals the direct summarizeMovieWindow count for each formatPref.
    selectMovieAndTheatre();
    const cases: Array<{ pref: "any" | "imax" | "dolby" | "standard"; expected: number }> = [
      { pref: "any", expected: 5 },
      { pref: "imax", expected: 1 },
      { pref: "dolby", expected: 2 },
      { pref: "standard", expected: 2 },
    ];
    for (const { pref, expected } of cases) {
      useSeatfirstStore.setState({
        selectedDates: ["2026-02-06", "2026-02-07", "2026-02-08", "2026-02-09"],
        timeOfDay: "Evening",
        selectedBands: ["Evening"],
        formatPref: pref,
      });
      const h = renderHook(() => useSeatfirstDemo());
      expect(h.result.current.matchingShowtimeCount).toBe(expected);
      h.unmount();
    }
  });
});
