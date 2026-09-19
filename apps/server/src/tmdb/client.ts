/**
 * The TMDB HTTP client (S25.5) — Bearer-authenticated calls to `now_playing`, `upcoming`,
 * and `search/movie`, each gated by the injected token bucket so the worker never exceeds
 * the ADR-pinned 30 req/sec (decision 3). `fetch` is injectable for tests (no live TMDB);
 * only the API host is a literal here, and it is the TMDB public REST endpoint, not a
 * gate-14 tunable.
 */

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { TokenBucket } from "./token-bucket.js";

const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

export interface TmdbMovieSummary {
  readonly tmdbId: number;
  readonly title: string;
  readonly posterPath: string | null;
  readonly releaseDate: string | null;
}

export interface TmdbMovieDetails {
  readonly tmdbId: number;
  readonly runtimeMinutes: number | null;
  readonly genres: readonly string[];
  readonly releaseDate: string | null;
}

export interface TmdbClient {
  nowPlaying(): Promise<TmdbMovieSummary[]>;
  upcoming(): Promise<TmdbMovieSummary[]>;
  searchMovie(query: string): Promise<TmdbMovieSummary[]>;
  movieDetails(tmdbId: number): Promise<TmdbMovieDetails>;
}

export interface TmdbClientDeps {
  readonly apiKey: string;
  readonly bucket: TokenBucket;
  /** O11.8 — the worker's logger; TMDB wire-level request failures are operator
   *  signals and are logged here (warn) before rethrowing. */
  readonly logger: SeatfirstLogger;
  readonly fetch?: typeof fetch;
}
/** Maps one raw TMDB `results` entry; drops entries lacking an id or title. */
function toSummary(raw: unknown): TmdbMovieSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as {
    id?: unknown;
    title?: unknown;
    poster_path?: unknown;
    release_date?: unknown;
  };
  if (typeof entry.id !== "number" || typeof entry.title !== "string") return null;
  return {
    tmdbId: entry.id,
    title: entry.title,
    posterPath:
      typeof entry.poster_path === "string" && entry.poster_path !== "" ? entry.poster_path : null,
    releaseDate:
      typeof entry.release_date === "string" && entry.release_date !== ""
        ? entry.release_date
        : null,
  };
}

/** Maps one raw TMDB details (`GET /movie/{id}`) response; a falsy/absent/non-integer
 *  `runtime` reads as null (never a fabricated number), and any `genres` entry
 *  without a non-empty `name` is dropped without throwing — mirroring `toSummary`'s
 *  defensive-parse style. */
function toDetails(tmdbId: number, raw: unknown): TmdbMovieDetails {
  const entry =
    typeof raw === "object" && raw !== null
      ? (raw as { runtime?: unknown; genres?: unknown; release_date?: unknown })
      : {};
  const runtime = entry.runtime;
  const genres = Array.isArray(entry.genres)
    ? entry.genres.flatMap((genre) => {
        if (typeof genre !== "object" || genre === null) return [];
        const name = (genre as { name?: unknown }).name;
        return typeof name === "string" && name !== "" ? [name] : [];
      })
    : [];
  const releaseDate =
    typeof entry.release_date === "string" && entry.release_date !== "" ? entry.release_date : null;
  return {
    tmdbId,
    runtimeMinutes:
      typeof runtime === "number" && Number.isInteger(runtime) && runtime > 0 ? runtime : null,
    genres,
    releaseDate,
  };
}

export function createTmdbClient(deps: TmdbClientDeps): TmdbClient {
  const fetchImpl = deps.fetch ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.apiKey}`,
    Accept: "application/json",
  };

  async function fetchJson(path: string): Promise<unknown> {
    await deps.bucket.acquire();
    const url = `${TMDB_API_BASE_URL}${path}`;
    // O11.8 — log wire-level request failures (network rejection, non-ok status)
    // before rethrowing; the duty layer owns the FETCH_FAILED transition, this owns
    // the bearer-authenticated fetch signal.
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    }).catch((error: unknown) => {
      deps.logger.warn({ error, url }, "tmdb request failed");
      throw error;
    });
    if (!response.ok) {
      const error = new Error(`TMDB ${path} responded ${response.status}`);
      deps.logger.warn({ error, status: response.status, url }, "tmdb request failed");
      throw error;
    }
    const body: unknown = await response.json();
    return body;
  }

  async function get(path: string): Promise<TmdbMovieSummary[]> {
    const body = (await fetchJson(path)) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      throw new Error(`TMDB ${path} returned no results array`);
    }
    return body.results
      .map(toSummary)
      .filter((summary): summary is TmdbMovieSummary => summary !== null);
  }

  return {
    nowPlaying: () => get("/movie/now_playing?language=en-US"),
    upcoming: () => get("/movie/upcoming?language=en-US"),
    searchMovie: (query) => get(`/search/movie?query=${encodeURIComponent(query)}&language=en-US`),
    movieDetails: async (tmdbId) =>
      toDetails(tmdbId, await fetchJson(`/movie/${tmdbId}?language=en-US`)),
  };
}
