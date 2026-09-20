import { describe, expect, it, vi } from "vitest";

import { createTmdbClient } from "../src/tmdb/client.js";
import type { TmdbMovieDetails, TmdbMovieSummary } from "../src/tmdb/client.js";
import type { TokenBucket } from "../src/tmdb/token-bucket.js";

import { capturingLogger } from "./support/logger.js";

const instantBucket: TokenBucket = { acquire: async () => {} };

interface FakeFetch {
  readonly fn: typeof fetch;
  readonly calls: Array<{ url: string; init: RequestInit | undefined }>;
}

function fakeFetch(body: unknown, ok = true): FakeFetch {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve({
      ok,
      status: ok ? 200 : 429,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
  return { fn, calls };
}

describe("createTmdbClient (S25.5)", () => {
  it("authenticates with the Bearer key, gates on the bucket, and hits the search endpoint", async () => {
    const { fn, calls } = fakeFetch({ results: [] });
    const logger = capturingLogger();
    const client = createTmdbClient({
      apiKey: "key-123",
      bucket: instantBucket,
      fetch: fn,
      logger,
    });

    await client.searchMovie("Dune: Part Two");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.themoviedb.org/3/search/movie?query=Dune%3A%20Part%20Two&language=en-US",
    );
    expect(calls[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer key-123",
      Accept: "application/json",
    });
  });

  it("maps results and drops entries without an id or title", async () => {
    const { fn } = fakeFetch({
      results: [
        { id: 1, title: "One", poster_path: "/one.jpg", release_date: "2024-05-10" },
        { id: 2, title: "No Poster", poster_path: null },
        { title: "No Id" },
        { id: 3, poster_path: "/no-title.jpg" },
      ],
    });
    const client = createTmdbClient({
      apiKey: "k",
      bucket: instantBucket,
      fetch: fn,
      logger: capturingLogger(),
    });

    await expect(client.searchMovie("x")).resolves.toEqual([
      { tmdbId: 1, title: "One", posterPath: "/one.jpg", releaseDate: "2024-05-10" },
      { tmdbId: 2, title: "No Poster", posterPath: null, releaseDate: null },
    ] satisfies TmdbMovieSummary[]);
  });

  it("movieDetails hits GET /movie/{id} with the Bearer header and bucket gate (S55.4)", async () => {
    const { fn, calls } = fakeFetch({
      id: 99,
      runtime: 128,
      release_date: "2026-08-01",
      genres: [
        { id: 12, name: "Adventure" },
        { id: 28, name: "Action" },
      ],
    });
    const client = createTmdbClient({
      apiKey: "k",
      bucket: instantBucket,
      fetch: fn,
      logger: capturingLogger(),
    });

    await expect(client.movieDetails(99)).resolves.toEqual({
      tmdbId: 99,
      runtimeMinutes: 128,
      genres: ["Adventure", "Action"],
      releaseDate: "2026-08-01",
    } satisfies TmdbMovieDetails);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.themoviedb.org/3/movie/99?language=en-US");
    expect(calls[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer k",
      Accept: "application/json",
    });
  });

  it("movieDetails maps a 0/absent runtime to null, never a fabricated number", async () => {
    for (const body of [
      { id: 1, runtime: 0, genres: [] },
      { id: 2, genres: [] },
    ]) {
      const { fn } = fakeFetch(body);
      const client = createTmdbClient({
        apiKey: "k",
        bucket: instantBucket,
        fetch: fn,
        logger: capturingLogger(),
      });
      await expect(client.movieDetails(body.id)).resolves.toMatchObject({
        runtimeMinutes: null,
        genres: [],
      });
    }
  });

  it("movieDetails drops malformed genre entries without throwing", async () => {
    const { fn } = fakeFetch({
      id: 7,
      runtime: 95,
      genres: [{ id: 1, name: "Drama" }, { id: 2 }, { id: 3, name: "" }, null, "Comedy"],
    });
    const client = createTmdbClient({
      apiKey: "k",
      bucket: instantBucket,
      fetch: fn,
      logger: capturingLogger(),
    });

    await expect(client.movieDetails(7)).resolves.toEqual({
      tmdbId: 7,
      runtimeMinutes: 95,
      genres: ["Drama"],
      releaseDate: null,
    } satisfies TmdbMovieDetails);
  });

  it("throws on a non-OK response", async () => {
    const { fn } = fakeFetch({}, false);
    const logger = capturingLogger();
    const client = createTmdbClient({ apiKey: "k", bucket: instantBucket, fetch: fn, logger });

    await expect(client.searchMovie("Dune")).rejects.toThrow(/responded 429/);

    // O11.8 — the wire-level failure is a logged operator signal before the rethrow.
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: "warn",
      message: "tmdb request failed",
      fields: { status: 429 },
    });
  });

  it("logs and rethrows when the fetch itself rejects (network failure)", async () => {
    const networkError = new Error("getaddrinfo ENOTFOUND api.themoviedb.org");
    const fn = (() => Promise.reject(networkError)) as typeof fetch;
    const logger = capturingLogger();
    const client = createTmdbClient({ apiKey: "k", bucket: instantBucket, fetch: fn, logger });

    await expect(client.searchMovie("x")).rejects.toBe(networkError);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: "warn",
      message: "tmdb request failed",
      fields: { error: networkError },
    });
  });

  it("passes a 5s abort signal and maps a timeout rejection to the documented logged rethrow (I15.7)", async () => {
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    const abortSignalTimeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fn = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return Promise.reject(timeoutError);
    }) as typeof fetch;
    const logger = capturingLogger();
    const client = createTmdbClient({ apiKey: "k", bucket: instantBucket, fetch: fn, logger });

    await expect(client.searchMovie("Dune")).rejects.toBe(timeoutError);

    expect(abortSignalTimeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: "warn",
      message: "tmdb request failed",
      fields: { error: timeoutError },
    });
    abortSignalTimeout.mockRestore();
  });
});
