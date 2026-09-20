import { describe, expect, it } from "vitest";

import type {
  SqlClient,
  TmdbFetchRow,
  TmdbMovieRow,
  UpsertTmdbMovieInput,
} from "@seatfirst/durability";

import type { TmdbMovieDetails, TmdbMovieSummary } from "../src/tmdb/client.js";
import { processTmdbFetch } from "../src/tmdb/duties.js";
import type { TmdbFetchDeps } from "../src/tmdb/duties.js";
import { cleanTitleForSearch } from "../src/tmdb/normalize.js";
import type { RelayMessage } from "../src/relay/publisher.js";

import { capturingLogger } from "./support/logger.js";
import type { CapturingLogger } from "./support/logger.js";

/**
 * Fake-dependency harness for the TMDB fetch duty (S25.5): every wrapper is a
 * recording stub, so the orchestration — normalize-then-upsert and the
 * PENDING→DONE/FAILED transitions — is asserted on the exact calls made, with no
 * durability, no Redis, no HTTP.
 */

const db = { query: () => Promise.resolve({ rows: [] }) } as unknown as SqlClient;

function details(
  tmdbId: number,
  runtimeMinutes: number | null = 100 + tmdbId,
  genres: readonly string[] = [`Genre ${tmdbId}`],
  releaseDate: string | null = null,
): TmdbMovieDetails {
  return { tmdbId, runtimeMinutes, genres, releaseDate };
}

function fetchRow(state: TmdbFetchRow["state"], movieTitle = "The Odyssey"): TmdbFetchRow {
  return {
    tmdb_fetch_id: "fetch-1",
    movie_title: movieTitle,
    state,
    attempt: 0,
    fail_cause: null,
    created_at: new Date(),
  };
}

const message: RelayMessage = {
  outboxId: "outbox-1",
  targetKind: "TMDB_FETCH",
  targetId: "fetch-1",
  traceparent: null,
};

describe("processTmdbFetch (S25.5)", () => {
  interface FetchHarness {
    deps: TmdbFetchDeps;
    logger: CapturingLogger;
    upserts: UpsertTmdbMovieInput[];
    searchCalls: string[];
    detailCalls: number[];
    done: string[];
    failed: Array<{ id: string; cause: string }>;
    setResults(results: TmdbMovieSummary[] | ((query: string) => TmdbMovieSummary[])): void;
    setSearchError(error: Error): void;
    setDetailsError(error: Error): void;
  }

  function makeFetchHarness(options: {
    state: TmdbFetchRow["state"];
    missing?: boolean;
    movieTitle?: string;
  }): FetchHarness {
    const upserts: UpsertTmdbMovieInput[] = [];
    const searchCalls: string[] = [];
    const detailCalls: number[] = [];
    const done: string[] = [];
    const failed: Array<{ id: string; cause: string }> = [];
    let results: TmdbMovieSummary[] | ((query: string) => TmdbMovieSummary[]) = [];
    const logger = capturingLogger();
    let searchError: Error | null = null;
    let detailsError: Error | null = null;
    const harness: FetchHarness = {
      upserts,
      searchCalls,
      detailCalls,
      done,
      failed,
      logger,
      setResults(value) {
        results = value;
      },
      setSearchError(error) {
        searchError = error;
      },
      setDetailsError(error) {
        detailsError = error;
      },
      deps: {
        db,
        readFetch: () =>
          Promise.resolve(options.missing ? [] : [fetchRow(options.state, options.movieTitle)]),
        markDone: (_db, id) => {
          done.push(id);
          return Promise.resolve([fetchRow("DONE")]);
        },
        markFailed: (_db, id, cause) => {
          failed.push({ id, cause });
          return Promise.resolve([{ ...fetchRow("FAILED"), fail_cause: cause }]);
        },
        searchMovie: (query) => {
          searchCalls.push(query);
          if (searchError !== null) throw searchError;
          return Promise.resolve(typeof results === "function" ? results(query) : results);
        },
        movieDetails: (tmdbId) => {
          detailCalls.push(tmdbId);
          if (detailsError !== null) throw detailsError;
          return Promise.resolve(details(tmdbId, 128, ["Action", "Adventure"]));
        },
        upsertMovie: (_db, input) => {
          upserts.push(input);
          return Promise.resolve([
            {
              tmdb_id: input.tmdbId,
              normalized_title: input.normalizedTitle,
              poster_path: input.posterPath,
              runtime_minutes: input.runtimeMinutes,
              genres: [...input.genres],
              // S63 widening: the fetch never observes these, so the fake mirrors the
              // repository's preserve-on-NULL (all absent; ADR 0102 dropped the slate flags).
              release_date: null,
              title: null,
              updated_at: new Date(),
            },
          ] satisfies TmdbMovieRow[]);
        },
        logger,
      },
    };
    return harness;
  }

  it("acks a vanished fetch row without a search", async () => {
    const harness = makeFetchHarness({ state: "PENDING", missing: true });
    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_MISSING",
    });
    expect(harness.upserts).toEqual([]);
    expect(harness.done).toEqual([]);
    expect(harness.failed).toEqual([]);
  });

  it("skips a non-PENDING row (at-least-once redelivery)", async () => {
    const harness = makeFetchHarness({ state: "DONE" });
    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "ALREADY_TERMINAL",
      state: "DONE",
    });
    expect(harness.upserts).toEqual([]);
  });

  it("searches, normalizes the AMC title, merges details, upserts, and marks DONE on success", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setResults([
      { tmdbId: 99, title: "The Odyssey (2026)", posterPath: "/odyssey.jpg", releaseDate: null },
    ]);

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCHED",
      tmdbId: 99,
    });
    // S55.5 — one movieDetails call for the resolved tmdbId, passed through unchanged.
    expect(harness.detailCalls).toEqual([99]);
    expect(harness.upserts).toEqual([
      {
        tmdbId: 99,
        normalizedTitle: "the odyssey",
        title: "The Odyssey (2026)",
        posterPath: "/odyssey.jpg",
        runtimeMinutes: 128,
        genres: ["Action", "Adventure"],
        releaseDate: null,
      },
    ]);
    expect(harness.done).toEqual(["fetch-1"]);
    expect(harness.failed).toEqual([]);
  });

  it("S55.5 — a details failure fails only this job (FAILED with its cause), never the batch", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setResults([
      { tmdbId: 99, title: "The Odyssey (2026)", posterPath: "/odyssey.jpg", releaseDate: null },
    ]);
    harness.setDetailsError(new Error("details down"));

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_FAILED",
      cause: "details down",
    });
    expect(harness.detailCalls).toEqual([99]);
    expect(harness.upserts).toEqual([]);
    expect(harness.failed).toEqual([{ id: "fetch-1", cause: "details down" }]);
    expect(harness.done).toEqual([]);
  });

  it("marks FAILED with a cause when TMDB has no match", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setResults([]);

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_FAILED",
      cause: "no TMDB match",
    });
    expect(harness.failed).toEqual([{ id: "fetch-1", cause: "no TMDB match" }]);
    expect(harness.done).toEqual([]);
  });

  it("marks FAILED when the only match has no poster", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setResults([{ tmdbId: 99, title: "The Odyssey", posterPath: null, releaseDate: null }]);

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_FAILED",
      cause: "TMDB match has no poster",
    });
    expect(harness.failed).toEqual([{ id: "fetch-1", cause: "TMDB match has no poster" }]);
    // The details call happens only after a postered match resolves — no wasted call.
    expect(harness.detailCalls).toEqual([]);
  });

  it("marks FAILED (and swallows the throw) on a transport error", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setSearchError(new Error("network down"));

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_FAILED",
      cause: "network down",
    });
    expect(harness.failed).toEqual([{ id: "fetch-1", cause: "network down" }]);
  });

  it("logs the swallowed transport failure via the injected logger before returning (O11.4)", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setSearchError(new Error("network down"));

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCH_FAILED",
      cause: "network down",
    });

    const errors = harness.logger.calls.filter((call) => call.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("tmdb fetch failed");
    expect(errors[0]?.fields.tmdb_fetch_id).toBe("fetch-1");
    expect(errors[0]?.fields.cause).toBe("network down");
    expect(errors[0]?.fields.error).toBeInstanceOf(Error);
  });

  it("falls back to cleanTitleForSearch when verbatim AMC title has no TMDB match", async () => {
    const harness = makeFetchHarness({
      state: "PENDING",
      movieTitle: "The Transformers: The Movie 40th Anniversary",
    });
    harness.setResults((query) => {
      if (query === "The Transformers: The Movie") {
        return [
          {
            tmdbId: 1857,
            title: "The Transformers: The Movie",
            posterPath: "/transformers.jpg",
            releaseDate: "1986-08-08",
          },
        ];
      }
      return [];
    });

    await expect(processTmdbFetch(harness.deps, message)).resolves.toEqual({
      kind: "FETCHED",
      tmdbId: 1857,
    });
    expect(harness.searchCalls).toEqual([
      "The Transformers: The Movie 40th Anniversary",
      "The Transformers: The Movie",
    ]);
    expect(harness.detailCalls).toEqual([1857]);
    expect(harness.upserts).toEqual([
      {
        tmdbId: 1857,
        normalizedTitle: "the transformers: the movie 40th anniversary",
        title: "The Transformers: The Movie",
        posterPath: "/transformers.jpg",
        runtimeMinutes: 128,
        genres: ["Action", "Adventure"],
        releaseDate: "1986-08-08",
      },
    ]);
    expect(harness.done).toEqual(["fetch-1"]);
    expect(harness.failed).toEqual([]);
  });
});

describe("cleanTitleForSearch", () => {
  it("strips anniversary tags, re-release labels, and event suffixes", () => {
    expect(cleanTitleForSearch("The Transformers: The Movie 40th Anniversary")).toBe(
      "The Transformers: The Movie",
    );
    expect(cleanTitleForSearch("Ghost in the Shell 30th Anniversary")).toBe("Ghost in the Shell");
    expect(cleanTitleForSearch("Cars: 20th Anniversary")).toBe("Cars");
    expect(cleanTitleForSearch("The Passion of the Christ (2026 Event)")).toBe(
      "The Passion of the Christ",
    );
    expect(cleanTitleForSearch("Avatar (2022 Re-release)")).toBe("Avatar");
    expect(cleanTitleForSearch("Coraline 15th Anniversary - 3D")).toBe("Coraline");
    expect(cleanTitleForSearch("Inception - Fan Event")).toBe("Inception");
    expect(cleanTitleForSearch("Standard Movie Title")).toBe("Standard Movie Title");
  });
});
