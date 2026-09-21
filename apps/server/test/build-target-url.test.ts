import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { createBuildTargetUrl } from "../src/dispatch/handlers/build-target-url.js";
import type { RunKeyRow } from "../src/dispatch/queries.js";

function runKey(kind: RunKeyRow["kind"]): RunKeyRow {
  const schedule = kind === "SCHEDULE_RESOLUTION";
  const movieSchedule = kind === "MOVIE_SCHEDULE_RESOLUTION";
  return {
    runKeyId: "run-key",
    kind,
    providerId: "amc",
    routeClass: movieSchedule ? "movie-schedule" : schedule ? "schedule" : "seat",
    showtimeId: schedule || movieSchedule ? null : "amc:showtime:100",
    theatreId: schedule || movieSchedule ? "amc:theatre:2325" : null,
    localDate: schedule || movieSchedule ? "2026-08-12" : null,
    movieSlug: movieSchedule ? "the-movie-12345" : null,
    acceptedRevision: "0",
    projectedRevision: "0",
    latestObservationId: null,
    latestCapturedAt: null,
    recheckPlacement: null,
  };
}

describe("createBuildTargetUrl (S31.2)", () => {
  it("uses the sanctioned numeric-id seat URL builder without a catalogue read", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    const buildTargetUrl = createBuildTargetUrl({ query } as unknown as Pool);

    await expect(buildTargetUrl(runKey("SHOWTIME_FETCH"))).resolves.toBe(
      "https://www.amctheatres.com/showtimes/100/seats",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("reads the theatre through THEATRE_READ_BY_ID before building a schedule URL", async () => {
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      expect(text).toContain("FROM theatre");
      expect(values).toEqual(["amc:theatre:2325"]);
      return Promise.resolve({
        rows: [
          {
            theatre_id: "amc:theatre:2325",
            provider_id: "amc",
            name: "AMC Metreon 16",
            lat: 37.784,
            lng: -122.401,
            market_slug: "san-francisco",
            timezone: "America/Los_Angeles",
            address: null,
            slugs: { "san-francisco": "amc-metreon-16" },
            first_seen_at: new Date(),
            last_seen_at: new Date(),
          },
        ],
      });
    });
    const buildTargetUrl = createBuildTargetUrl({ query } as unknown as Pool);

    await expect(buildTargetUrl(runKey("SCHEDULE_RESOLUTION"))).resolves.toBe(
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2026-08-12",
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("builds a movie schedule URL from the run key movie slug and anchor theatre", async () => {
    const query = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            theatre_id: "amc:theatre:2325",
            provider_id: "amc",
            name: "AMC Metreon 16",
            lat: 37.784,
            lng: -122.401,
            market_slug: "san-francisco",
            timezone: "America/Los_Angeles",
            address: null,
            slugs: { "san-francisco": "amc-metreon-16" },
            first_seen_at: new Date(),
            last_seen_at: new Date(),
          },
        ],
      }),
    );
    const buildTargetUrl = createBuildTargetUrl({ query } as unknown as Pool);

    await expect(buildTargetUrl(runKey("MOVIE_SCHEDULE_RESOLUTION"))).resolves.toBe(
      "https://www.amctheatres.com/movies/the-movie-12345/showtimes?date=2026-08-12&theatre=amc-metreon-16",
    );
  });
});
