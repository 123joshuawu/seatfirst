import { describe, expect, it } from "vitest";

import type {
  SqlClient,
  TmdbFetchRow,
  TmdbMovieRow,
  TmdbPrewarmStateRow,
  UpsertTmdbMovieInput,
} from "@seatfirst/durability";

import type { TmdbMovieDetails, TmdbMovieSummary } from "../src/tmdb/client.js";
import { processTmdbFetch, runTmdbPrewarmTick } from "../src/tmdb/duties.js";
import type { TmdbFetchDeps, TmdbPrewarmDeps } from "../src/tmdb/duties.js";
import type { RelayMessage } from "../src/relay/publisher.js";

import { capturingLogger } from "./support/logger.js";
import type { CapturingLogger } from "./support/logger.js";

/**
 * Fake-dependency harness for the two TMDB duties (S25.3/S25.5): every wrapper is a
 * recording stub, so the orchestration — due-ness, dedup, normalize-then-upsert, and the
 * PENDING→DONE/FAILED transitions — is asserted on the exact calls made, with no
 * durability, no Redis, no HTTP.
 */

const db = { query: () => Promise.resolve({ rows: [] }) } as unknown as SqlClient;
const NOW = new Date("2026-08-15T12:00:00Z"); // after today's 08:00 UTC boundary (EDT)

function summary(tmdbId: number, posterPath: string | null = `/p${tmdbId}.jpg`): TmdbMovieSummary {
  return { tmdbId, title: `Title ${tmdbId}`, posterPath };
}

function details(
  tmdbId: number,
  runtimeMinutes: number | null = 100 + tmdbId,
  genres: readonly string[] = [`Genre ${tmdbId}`],
): TmdbMovieDetails {
  return { tmdbId, runtimeMinutes, genres };
}

function fetchRow(state: TmdbFetchRow["state"]): TmdbFetchRow {
  return {
    tmdb_fetch_id: "fetch-1",
    movie_title: "The Odyssey",
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

describe("runTmdbPrewarmTick (S25.3)", () => {
  interface PrewarmHarness {
    deps: TmdbPrewarmDeps;
    upserts: UpsertTmdbMovieInput[];
    detailCalls: number[];
    completed: number;
  }
  function makePrewarmHarness(options: {
    state: TmdbPrewarmStateRow[];
    nowPlaying: TmdbMovieSummary[];
    upcoming: TmdbMovieSummary[];
    detailsErrorIds?: readonly number[];
  }): PrewarmHarness {
    const upserts: UpsertTmdbMovieInput[] = [];
    const detailCalls: number[] = [];
    const harness: PrewarmHarness = {
      upserts,
      detailCalls,
      completed: 0,
      deps: {
        db,
        readPrewarmState: () => Promise.resolve(options.state),
        completePrewarm: () => {
          harness.completed += 1;
          return Promise.resolve([{ last_completed_at: new Date() }]);
        },
        nowPlaying: () => Promise.resolve(options.nowPlaying),
        upcoming: () => Promise.resolve(options.upcoming),
        movieDetails: (tmdbId) => {
          detailCalls.push(tmdbId);
          if (options.detailsErrorIds?.includes(tmdbId)) {
            return Promise.reject(new Error(`details down for ${tmdbId}`));
          }
          return Promise.resolve(details(tmdbId));
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
              updated_at: new Date(),
            },
          ]);
        },
        now: () => NOW,
      },
    };
    return harness;
  }

  it("skips when the last completed pass is already past today's boundary", async () => {
    const harness = makePrewarmHarness({
      state: [{ last_completed_at: new Date("2026-08-15T09:00:00Z") }],
      nowPlaying: [],
      upcoming: [],
    });
    await expect(runTmdbPrewarmTick(harness.deps)).resolves.toEqual({ kind: "SKIPPED_NOT_DUE" });
    expect(harness.upserts).toEqual([]);
    expect(harness.completed).toBe(0);
  });

  it("is due when never run, normalizes titles, dedups by tmdb_id, and completes", async () => {
    const harness = makePrewarmHarness({
      state: [],
      nowPlaying: [summary(1), summary(2)],
      upcoming: [summary(2), summary(3, null)],
    });
    await expect(runTmdbPrewarmTick(harness.deps)).resolves.toEqual({
      kind: "PREWARMED",
      upserted: 3,
    });
    expect(harness.upserts).toEqual([
      {
        tmdbId: 1,
        normalizedTitle: "title 1",
        posterPath: "/p1.jpg",
        runtimeMinutes: 101,
        genres: ["Genre 1"],
      },
      {
        tmdbId: 2,
        normalizedTitle: "title 2",
        posterPath: "/p2.jpg",
        runtimeMinutes: 102,
        genres: ["Genre 2"],
      },
      {
        tmdbId: 3,
        normalizedTitle: "title 3",
        posterPath: null,
        runtimeMinutes: 103,
        genres: ["Genre 3"],
      },
    ]);
    // One details call per deduped tmdbId, before the upsert — no new job kind.
    expect(harness.detailCalls).toEqual([1, 2, 3]);
    expect(harness.completed).toBe(1);
  });

  it("S55.5 — a details failure degrades only that entry to its poster half, never the batch", async () => {
    const harness = makePrewarmHarness({
      state: [],
      nowPlaying: [summary(1), summary(2)],
      upcoming: [],
      detailsErrorIds: [1],
    });
    await expect(runTmdbPrewarmTick(harness.deps)).resolves.toEqual({
      kind: "PREWARMED",
      upserted: 2,
    });
    expect(harness.upserts).toEqual([
      {
        tmdbId: 1,
        normalizedTitle: "title 1",
        posterPath: "/p1.jpg",
        runtimeMinutes: null,
        genres: [],
      },
      {
        tmdbId: 2,
        normalizedTitle: "title 2",
        posterPath: "/p2.jpg",
        runtimeMinutes: 102,
        genres: ["Genre 2"],
      },
    ]);
    expect(harness.detailCalls).toEqual([1, 2]);
    expect(harness.completed).toBe(1);
  });
});

describe("processTmdbFetch (S25.5)", () => {
  interface FetchHarness {
    deps: TmdbFetchDeps;
    logger: CapturingLogger;
    upserts: UpsertTmdbMovieInput[];
    detailCalls: number[];
    done: string[];
    failed: Array<{ id: string; cause: string }>;
    setResults(results: TmdbMovieSummary[]): void;
    setSearchError(error: Error): void;
    setDetailsError(error: Error): void;
  }

  function makeFetchHarness(options: {
    state: TmdbFetchRow["state"];
    missing?: boolean;
  }): FetchHarness {
    const upserts: UpsertTmdbMovieInput[] = [];
    const detailCalls: number[] = [];
    const done: string[] = [];
    const failed: Array<{ id: string; cause: string }> = [];
    let results: TmdbMovieSummary[] = [];
    const logger = capturingLogger();
    let searchError: Error | null = null;
    let detailsError: Error | null = null;
    const harness: FetchHarness = {
      upserts,
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
        readFetch: () => Promise.resolve(options.missing ? [] : [fetchRow(options.state)]),
        markDone: (_db, id) => {
          done.push(id);
          return Promise.resolve([fetchRow("DONE")]);
        },
        markFailed: (_db, id, cause) => {
          failed.push({ id, cause });
          return Promise.resolve([{ ...fetchRow("FAILED"), fail_cause: cause }]);
        },
        searchMovie: () => {
          if (searchError !== null) throw searchError;
          return Promise.resolve(results);
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
    harness.setResults([{ tmdbId: 99, title: "The Odyssey (2026)", posterPath: "/odyssey.jpg" }]);

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
        posterPath: "/odyssey.jpg",
        runtimeMinutes: 128,
        genres: ["Action", "Adventure"],
      },
    ]);
    expect(harness.done).toEqual(["fetch-1"]);
    expect(harness.failed).toEqual([]);
  });

  it("S55.5 — a details failure fails only this job (FAILED with its cause), never the batch", async () => {
    const harness = makeFetchHarness({ state: "PENDING" });
    harness.setResults([{ tmdbId: 99, title: "The Odyssey (2026)", posterPath: "/odyssey.jpg" }]);
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
    harness.setResults([{ tmdbId: 99, title: "The Odyssey", posterPath: null }]);

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
});
