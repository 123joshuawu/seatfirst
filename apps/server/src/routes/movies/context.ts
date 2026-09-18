import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { TmdbClient } from "../../tmdb/client.js";

/**
 * `movies.search` context (S63.4) — the sibling of S20's `TheatreSearchContext`,
 * widened with the live TMDB query surface the typed-query path needs.
 *
 * - `db`: the injected pool. Both paths read local Postgres (`tmdb_movie` slate,
 *   AMC `movie` catalogue); the typed path also lazily upserts live TMDB hits.
 * - `tmdbClient`: the injected live TMDB client (Bearer-authenticated, under its
 *   own 30 req/s token bucket per ADR 0019 §5). `undefined` in app assemblies
 *   that never wired one (older test servers): the empty-query slate path does
 *   not need it and keeps serving; the typed path fails closed with
 *   `TMDB_UNAVAILABLE` instead of serving TMDB results it cannot fetch.
 */
export interface MoviesSearchContext {
  readonly db: Pool;
  readonly tmdbClient: TmdbClient | undefined;
}

export interface MoviesSearchContextOptions {
  readonly db: Pool;
  readonly tmdbClient?: TmdbClient | undefined;
}

/**
 * Builds the per-request context factory. `movies.search` needs nothing from the
 * request (no session, no headers), so the factory ignores `req` and binds only
 * the injected pool + client — the same required-no-default convention as
 * `createTheatreSearchContextFactory` (S20).
 */
export function createMoviesSearchContextFactory(
  opts: MoviesSearchContextOptions,
): (req: FastifyRequest) => MoviesSearchContext {
  const { db, tmdbClient } = opts;
  return () => ({ db, tmdbClient });
}
