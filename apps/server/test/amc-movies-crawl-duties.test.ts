import { describe, expect, it } from "vitest";

import type { NavigationAttempt, NavigationScope } from "@seatfirst/browser-runtime";
import type {
  AmcMovieCatalogueStateRow,
  UpsertAmcMovieCatalogueInput,
} from "@seatfirst/durability";
import type { PublicMovieSummary } from "@seatfirst/providers";

import { amcMoviesCrawlBoundary } from "../src/amc-movies-crawl/due.js";
import { runAmcMoviesCrawlTick } from "../src/amc-movies-crawl/duties.js";
import type { AmcMoviesCrawlDeps } from "../src/amc-movies-crawl/duties.js";

/**
 * Fake-dependency harness (mirrors `catalogue-crawl-duties.test.ts`'s S26.6 DI seam):
 * every wrapper is a recording stub, so the orchestration is asserted on the exact
 * calls made — no durability, no Redis, no browser.
 */
interface Harness {
  deps: AmcMoviesCrawlDeps;
  upserts: UpsertAmcMovieCatalogueInput[];
  navigated: Array<{ url: string; scope: NavigationScope }>;
  released: Array<{ holderId: string; generation: number }>;
  completions: number;
  setState(rows: AmcMovieCatalogueStateRow[]): void;
  setNow(now: Date): void;
  setControls(states: Array<"OPEN" | "PAUSED" | "HALTED">): void;
  setSemaphoreHeld(held: boolean): void;
  setNavigationAttempt(attempt: NavigationAttempt): void;
  setMovies(movies: PublicMovieSummary[]): void;
}

/**
 * Due-ness anchor: 08:00 Eastern on a fixed winter (EST) day — safely past the
 * jittered 07:00 boundary (±5 min) and inside the 4-hour give-up window, with the
 * boundary derived from the same deterministic hash the duty reads. `dueNow()` lands
 * just after the boundary; `earlyNow()` just before it.
 */
const PROBE = new Date("2026-01-15T13:00:00Z");
const BOUNDARY = amcMoviesCrawlBoundary(PROBE);
const DUE_NOW = new Date(BOUNDARY.getTime() + 60_000);
const EARLY_NOW = new Date(BOUNDARY.getTime() - 60_000);

const MOVIES_URL = "https://www.amctheatres.com/movies";

function makeHarness(): Harness {
  const h = {
    state: [] as AmcMovieCatalogueStateRow[],
    now: DUE_NOW,
    controls: ["OPEN"] as Array<"OPEN" | "PAUSED" | "HALTED">,
    semaphoreHeld: false,
    attempt: successAttempt("<html></html>"),
    movies: [] as PublicMovieSummary[],
    upserts: [] as UpsertAmcMovieCatalogueInput[],
    navigated: [] as Array<{ url: string; scope: NavigationScope }>,
    released: [] as Array<{ holderId: string; generation: number }>,
    completions: 0,
  };

  const deps: AmcMoviesCrawlDeps = {
    egressIdentityLabel: "test-egress",
    readState: () => Promise.resolve(h.state),
    completeCrawl: () => {
      h.completions += 1;
      return Promise.resolve(h.state);
    },
    upsertMovie: (input) => {
      h.upserts.push(input);
      return Promise.resolve();
    },
    readControlState: () => Promise.resolve(h.controls.shift() ?? "OPEN"),
    acquireSemaphore: () => Promise.resolve(h.semaphoreHeld ? false : 7),
    releaseSemaphore: (holderId, generation) => {
      h.released.push({ holderId, generation });
      return Promise.resolve();
    },
    navigate: (url, scope) => {
      h.navigated.push({ url, scope });
      return Promise.resolve(h.attempt);
    },
    parseMovies: () => h.movies,
    buildMoviesUrl: () => MOVIES_URL,
    mintId: () => "raw-id",
    now: () => h.now,
  };

  return {
    deps,
    get upserts() {
      return h.upserts;
    },
    get navigated() {
      return h.navigated;
    },
    get released() {
      return h.released;
    },
    get completions() {
      return h.completions;
    },
    setState: (rows) => {
      h.state = rows;
    },
    setNow: (now) => {
      h.now = now;
    },
    setControls: (states) => {
      h.controls = [...states];
    },
    setSemaphoreHeld: (held) => {
      h.semaphoreHeld = held;
    },
    setNavigationAttempt: (attempt) => {
      h.attempt = attempt;
    },
    setMovies: (movies) => {
      h.movies = movies;
    },
  };
}

function stateRow(overrides: Partial<AmcMovieCatalogueStateRow> = {}): AmcMovieCatalogueStateRow {
  return {
    last_completed_at: null,
    ...overrides,
  };
}

function successAttempt(documentHtml: string): NavigationAttempt {
  return {
    outcome: {
      kind: "SUCCESS",
      classification: "AMC_INITIAL",
      hops: [],
      payload: {
        finalUrl: {
          origin: "https://www.amctheatres.com",
          pathname: "/movies",
          queryKeys: [],
        },
        finalStatus: 200,
        headers: {},
        documentHtml,
      },
      subresourceAborts: 0,
    },
    cleanupCompleted: Promise.resolve(),
  };
}

const failedAttempt: NavigationAttempt = {
  outcome: { kind: "NAVIGATION_FAILED", error: "timeout" },
  cleanupCompleted: Promise.resolve(),
};

function movie(movieId: number, overrides: Partial<PublicMovieSummary> = {}): PublicMovieSummary {
  return {
    name: `Movie ${movieId}`,
    slug: `movie-${movieId}`,
    movieId,
    detailsPath: `/movies/movie-${movieId}`,
    showtimesPath: `/movies/movie-${movieId}/showtimes`,
    mpaaRating: "PG-13",
    runTimeMinutes: 120,
    releaseDate: "2026-01-01",
    status: "Now Playing",
    imageUrl: `https://example.com/${movieId}.jpg`,
    ...overrides,
  };
}

describe("runAmcMoviesCrawlTick — ADR 0102 orchestration", () => {
  it("skips fail-closed when control is not OPEN, before touching the semaphore", async () => {
    const h = makeHarness();
    h.setControls(["PAUSED"]);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_CONTROL", state: "PAUSED" });
    expect(h.navigated).toHaveLength(0);
    expect(h.released).toHaveLength(0);
    expect(h.completions).toBe(0);
  });

  it("skips when the daily pass is not yet due, without acquiring the semaphore", async () => {
    const h = makeHarness();
    h.setNow(EARLY_NOW);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_NOT_DUE" });
    expect(h.navigated).toHaveLength(0);
    expect(h.released).toHaveLength(0);
    expect(h.completions).toBe(0);
  });

  it("skips when a pass already completed since the boundary", async () => {
    const h = makeHarness();
    h.setState([stateRow({ last_completed_at: new Date(BOUNDARY.getTime() + 1000) })]);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_NOT_DUE" });
    expect(h.navigated).toHaveLength(0);
    expect(h.released).toHaveLength(0);
  });

  it("skips without release when the shared semaphore is held", async () => {
    const h = makeHarness();
    h.setSemaphoreHeld(true);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_SEMAPHORE" });
    expect(h.navigated).toHaveLength(0);
    // Never acquired, so nothing to release.
    expect(h.released).toHaveLength(0);
    expect(h.completions).toBe(0);
  });

  it("re-checks control after acquiring and skips without navigating", async () => {
    const h = makeHarness();
    h.setControls(["OPEN", "HALTED"]);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_CONTROL", state: "HALTED" });
    expect(h.navigated).toHaveLength(0);
    expect(h.released).toHaveLength(1);
    expect(h.completions).toBe(0);
  });

  it("reports unsuccessful navigation and still releases the semaphore", async () => {
    const h = makeHarness();
    h.setNavigationAttempt(failedAttempt);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "NAVIGATION_UNSUCCESSFUL", outcome: "NAVIGATION_FAILED" });
    expect(h.navigated).toHaveLength(1);
    expect(h.upserts).toHaveLength(0);
    expect(h.completions).toBe(0);
    expect(h.released).toHaveLength(1);
    expect(h.released[0]).toEqual({ holderId: "raw-id", generation: 7 });
  });

  it("upserts every parsed hit, checkpoints completion, and releases", async () => {
    const h = makeHarness();
    h.setMovies([
      movie(1),
      movie(2, {
        mpaaRating: undefined,
        runTimeMinutes: null,
        releaseDate: undefined,
        status: null,
        imageUrl: undefined,
      }),
    ]);

    const tick = await runAmcMoviesCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "CRAWL_COMPLETED", movieCount: 2 });
    expect(h.navigated).toHaveLength(1);
    expect(h.navigated[0]!.url).toBe(MOVIES_URL);
    expect(h.upserts).toEqual([
      {
        movieId: 1,
        slug: "movie-1",
        name: "Movie 1",
        mpaaRating: "PG-13",
        runtimeMinutes: 120,
        releaseDate: "2026-01-01",
        status: "Now Playing",
        imageUrl: "https://example.com/1.jpg",
        detailsPath: "/movies/movie-1",
        showtimesPath: "/movies/movie-1/showtimes",
      },
      {
        movieId: 2,
        slug: "movie-2",
        name: "Movie 2",
        // Missing enrichment reads as unknown (null), never fabricated.
        mpaaRating: null,
        runtimeMinutes: null,
        releaseDate: null,
        status: null,
        imageUrl: null,
        detailsPath: "/movies/movie-2",
        showtimesPath: "/movies/movie-2/showtimes",
      },
    ]);
    expect(h.completions).toBe(1);
    expect(h.released).toHaveLength(1);
  });

  it("mints the navigation scope for provider amc with no separate lane", async () => {
    const h = makeHarness();

    await runAmcMoviesCrawlTick(h.deps);

    expect(h.navigated).toHaveLength(1);
    const scope = h.navigated[0]!.scope;
    expect(scope.providerId).toBe("amc");
    expect(scope.routeClass).toBe("");
    expect(scope.egressIdentityLabel).toBe("test-egress");
    expect(scope.observationId).toBe("amc:movie:raw-id");
    expect(scope.fetchRunId).toBe("amc:movie:raw-id");
  });
});
