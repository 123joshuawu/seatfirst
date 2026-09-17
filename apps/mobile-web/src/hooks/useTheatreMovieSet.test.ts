import { describe, expect, it } from "vitest";
import type { TheatreMoviesResponse } from "@seatfirst/core";
import { aggregateTheatreMovies } from "./useTheatreMovieSet";

function response(
  theatreId: string,
  timezone: string,
  movies: TheatreMoviesResponse["movies"],
): TheatreMoviesResponse {
  return {
    theatreId,
    timezone,
    from: "2026-08-29",
    to: "2026-09-27",
    movies,
  } as TheatreMoviesResponse;
}

const showtime = (id: string) =>
  ({
    showtimeId: id,
    showDateTimeUtc: "2026-08-30T02:00:00Z",
    status: "OPEN",
    formatCode: null,
    auditorium: null,
    runtimeMinutes: null,
    deepLinkUrl: null,
    attributes: [],
  }) as unknown as TheatreMoviesResponse["movies"][number]["showtimes"][number];

describe("aggregateTheatreMovies", () => {
  it("unions movies across theatres and retains each theatre timezone", () => {
    const movies = aggregateTheatreMovies([
      response("amc:theatre:1", "America/Los_Angeles", [
        {
          movieId: "amc:movie:shared",
          title: "Shared Movie",
          posterPath: null,
          runtimeMinutes: null,
          genres: [] as string[],
          showtimes: [showtime("amc:showtime:1")],
        },
      ] as TheatreMoviesResponse["movies"]),
      response("amc:theatre:2", "America/New_York", [
        {
          movieId: "amc:movie:shared",
          title: "Shared Movie",
          posterPath: "/shared.jpg",
          runtimeMinutes: 166,
          genres: ["Action", "Adventure"],
          showtimes: [showtime("amc:showtime:2"), showtime("amc:showtime:3")],
        },
        {
          movieId: "amc:movie:local",
          title: "Local Movie",
          posterPath: null,
          runtimeMinutes: null,
          genres: [] as string[],
          showtimes: [showtime("amc:showtime:4")],
        },
      ] as TheatreMoviesResponse["movies"]),
    ]);

    expect(movies.map((movie) => movie.movieId)).toEqual(["amc:movie:shared", "amc:movie:local"]);
    expect(movies[0]).toMatchObject({ showtimeCount: 3, posterPath: "/shared.jpg" });
    expect(movies[0]).toMatchObject({ runtimeMinutes: 166, genres: ["Action", "Adventure"] });
    expect(movies[1]).toMatchObject({ runtimeMinutes: null, genres: [] });
    expect(movies[0]?.entries.map(({ theatreId, timezone }) => ({ theatreId, timezone }))).toEqual([
      { theatreId: "amc:theatre:1", timezone: "America/Los_Angeles" },
      { theatreId: "amc:theatre:2", timezone: "America/New_York" },
    ]);
  });

  it("keeps the first non-null runtime and first non-empty genres", () => {
    const movies = aggregateTheatreMovies([
      response("amc:theatre:1", "America/Los_Angeles", [
        {
          movieId: "amc:movie:shared",
          title: "Shared Movie",
          posterPath: "/first.jpg",
          runtimeMinutes: 120,
          genres: ["Drama"],
          showtimes: [showtime("amc:showtime:1")],
        },
      ] as TheatreMoviesResponse["movies"]),
      response("amc:theatre:2", "America/New_York", [
        {
          movieId: "amc:movie:shared",
          title: "Shared Movie",
          posterPath: "/second.jpg",
          runtimeMinutes: 150,
          genres: ["Comedy"],
          showtimes: [showtime("amc:showtime:2")],
        },
      ] as TheatreMoviesResponse["movies"]),
    ]);

    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({
      posterPath: "/first.jpg",
      runtimeMinutes: 120,
      genres: ["Drama"],
    });
  });

  it("tolerates a version-skewed theatre response that omits genres/runtimeMinutes entirely (regression)", () => {
    // A movie group shaped like the pre-S55 wire contract — the field is missing, not
    // `null`/`[]` — as a rolling-deploy API replica or a schema-lagging environment would
    // send. Merging this with a fully-populated group for the same movie from a second
    // theatre must not throw on `undefined.length`.
    const skewedGroup = {
      movieId: "amc:movie:shared",
      title: "Shared Movie",
      posterPath: null,
      showtimes: [showtime("amc:showtime:1")],
    } as unknown as TheatreMoviesResponse["movies"][number];

    expect(() =>
      aggregateTheatreMovies([
        response("amc:theatre:1", "America/Los_Angeles", [skewedGroup]),
        response("amc:theatre:2", "America/New_York", [
          {
            movieId: "amc:movie:shared",
            title: "Shared Movie",
            posterPath: "/shared.jpg",
            runtimeMinutes: 166,
            genres: ["Action", "Adventure"],
            showtimes: [showtime("amc:showtime:2")],
          },
        ] as TheatreMoviesResponse["movies"]),
      ]),
    ).not.toThrow();

    const movies = aggregateTheatreMovies([
      response("amc:theatre:1", "America/Los_Angeles", [skewedGroup]),
      response("amc:theatre:2", "America/New_York", [
        {
          movieId: "amc:movie:shared",
          title: "Shared Movie",
          posterPath: "/shared.jpg",
          runtimeMinutes: 166,
          genres: ["Action", "Adventure"],
          showtimes: [showtime("amc:showtime:2")],
        },
      ] as TheatreMoviesResponse["movies"]),
    ]);
    expect(movies).toHaveLength(1);
    // The skewed theatre contributes no runtime/genres; the second theatre's values win,
    // exactly as the "first non-null/non-empty wins" rule already guarantees.
    expect(movies[0]).toMatchObject({ runtimeMinutes: 166, genres: ["Action", "Adventure"] });
  });

  it("normalizes a solo version-skewed group's missing genres/runtimeMinutes to the unresolved sentinels (regression)", () => {
    const skewedGroup = {
      movieId: "amc:movie:solo",
      title: "Solo Movie",
      posterPath: null,
      showtimes: [showtime("amc:showtime:1")],
    } as unknown as TheatreMoviesResponse["movies"][number];

    const movies = aggregateTheatreMovies([
      response("amc:theatre:1", "America/Los_Angeles", [skewedGroup]),
    ]);

    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({ runtimeMinutes: null, genres: [] });
  });
});
