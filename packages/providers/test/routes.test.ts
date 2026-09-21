import { describe, it, expect } from "vitest";
import { buildMovieShowtimesUrl, isAllowedUrl } from "../src/amc/routes.js";

describe("buildMovieShowtimesUrl / isAllowedUrl (S64, ADR 0104)", () => {
  it("builds the movie-first showtimes URL shape", () => {
    expect(buildMovieShowtimesUrl("dune-part-3", "amc-metreon-16", "2026-08-13").toString()).toBe(
      "https://www.amctheatres.com/movies/dune-part-3/showtimes?date=2026-08-13&theatre=amc-metreon-16",
    );
  });

  it("positive control: the builder's own output is allowlisted", () => {
    expect(
      isAllowedUrl(buildMovieShowtimesUrl("dune-part-3", "amc-metreon-16", "2026-08-13")),
    ).toBe(true);
  });

  it("accepts a hand-built valid movie-showtimes URL", () => {
    expect(
      isAllowedUrl(
        new URL(
          "https://www.amctheatres.com/movies/spider-man-78598/showtimes?date=2026-08-13&theatre=amc-empire-25",
        ),
      ),
    ).toBe(true);
  });

  it("rejects a wrong origin", () => {
    expect(
      isAllowedUrl(
        new URL(
          "https://evil.example.com/movies/dune-part-3/showtimes?date=2026-08-13&theatre=amc-metreon-16",
        ),
      ),
    ).toBe(false);
  });

  it("rejects extra query params, missing params, and duplicated keys", () => {
    const base = "https://www.amctheatres.com/movies/dune-part-3/showtimes";
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13&theatre=amc-metreon-16&foo=bar`))).toBe(
      false,
    );
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?theatre=amc-metreon-16`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13&theatre=a&theatre=b`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13&date=2026-08-14&theatre=a`))).toBe(false);
  });

  it("rejects malformed dates and theatre slugs", () => {
    const base = "https://www.amctheatres.com/movies/dune-part-3/showtimes";
    expect(isAllowedUrl(new URL(`${base}?date=08-13-2026&theatre=amc-metreon-16`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=2026-8-3&theatre=amc-metreon-16`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=&theatre=amc-metreon-16`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13&theatre=`))).toBe(false);
    expect(isAllowedUrl(new URL(`${base}?date=2026-08-13&theatre=amc_metreon!`))).toBe(false);
  });

  it("rejects credentials and hash fragments", () => {
    expect(
      isAllowedUrl(
        new URL(
          "https://user:pass@www.amctheatres.com/movies/dune-part-3/showtimes?date=2026-08-13&theatre=amc-metreon-16",
        ),
      ),
    ).toBe(false);
    expect(
      isAllowedUrl(
        new URL(
          "https://www.amctheatres.com/movies/dune-part-3/showtimes?date=2026-08-13&theatre=amc-metreon-16#frag",
        ),
      ),
    ).toBe(false);
  });

  it("rejects near-miss paths (no showtimes suffix, nested slug)", () => {
    expect(
      isAllowedUrl(
        new URL("https://www.amctheatres.com/movies/dune-part-3?date=2026-08-13&theatre=a"),
      ),
    ).toBe(false);
    expect(
      isAllowedUrl(
        new URL(
          "https://www.amctheatres.com/movies/dune-part-3/showtimes/extra?date=2026-08-13&theatre=a",
        ),
      ),
    ).toBe(false);
  });
});
