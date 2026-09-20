/**
 * The TMDB worker's fetch duty (S25.5), extracted as a dependency-injected pure-ish
 * function so it is unit-testable with fakes (the same discipline
 * `apps/server/src/catalogue-crawl/duties.ts` uses). The S25.3 pre-warm duty is
 * decommissioned (ADR 0102 decision 7). The duty touches no network or database
 * directly — the entrypoint wires the injected functions to the TMDB client and
 * `@seatfirst/durability` repository wrappers.
 */

import type {
  SqlClient,
  TmdbFetchRow,
  TmdbMovieRow,
  UpsertTmdbMovieInput,
} from "@seatfirst/durability";

import type { SeatfirstLogger } from "@seatfirst/config/logger";

import type { RelayMessage } from "../relay/publisher.js";

import type { TmdbMovieDetails, TmdbMovieSummary } from "./client.js";
import { cleanTitleForSearch, normalizeTitle } from "./normalize.js";

/* ----------------------------------------------------------------- S25.5 — fetch */

export interface TmdbFetchDeps {
  readonly readFetch: (db: SqlClient, tmdbFetchId: string) => Promise<TmdbFetchRow[]>;
  readonly markDone: (db: SqlClient, tmdbFetchId: string) => Promise<TmdbFetchRow[]>;
  readonly markFailed: (
    db: SqlClient,
    tmdbFetchId: string,
    failCause: string,
  ) => Promise<TmdbFetchRow[]>;
  readonly searchMovie: (query: string) => Promise<TmdbMovieSummary[]>;
  readonly movieDetails: (tmdbId: number) => Promise<TmdbMovieDetails>;
  readonly upsertMovie: (db: SqlClient, input: UpsertTmdbMovieInput) => Promise<TmdbMovieRow[]>;
  readonly db: SqlClient;
  /** Required since O11.4 (O6's "never fall back to console logging" applied to this
   * layer): the fetch duty swallows upstream errors by design — the FAILED durable row is
   * the recovery mechanism — so without an injected logger the error would vanish.
   * Production wires the entrypoint's logger; tests inject a capturing double. */
  readonly logger: SeatfirstLogger;
}

export type TmdbFetchTick =
  | { readonly kind: "FETCH_MISSING" }
  | { readonly kind: "ALREADY_TERMINAL"; readonly state: "DONE" | "FAILED" }
  | { readonly kind: "FETCHED"; readonly tmdbId: number }
  | { readonly kind: "FETCH_FAILED"; readonly cause: string };

/**
 * One fetch-job processing (S25.5). The durable row is read for its `movie_title`; a
 * non-PENDING row is a no-op (at-least-once delivery or a manual redrive). On success the
 * row is DONE and the poster stored; on any failure — no match, a match with no poster, or
 * a transport error — the row is FAILED with the cause, and the error is swallowed so the
 * BullMQ job completes cleanly: the FAILED state is the recovery mechanism (it does not
 * block a later re-dispatch via `one_live_tmdb_fetch_per_title`), not the queue's failed
 * set (the relay publishes with no retry, so rethrowing would only strand the outbox row).
 */
export async function processTmdbFetch(
  deps: TmdbFetchDeps,
  message: RelayMessage,
): Promise<TmdbFetchTick> {
  const rows = await deps.readFetch(deps.db, message.targetId);
  const fetch = rows[0];
  if (fetch === undefined) {
    return { kind: "FETCH_MISSING" };
  }
  if (fetch.state !== "PENDING") {
    return { kind: "ALREADY_TERMINAL", state: fetch.state };
  }

  try {
    let results = await deps.searchMovie(fetch.movie_title);
    if (results.length === 0) {
      const cleaned = cleanTitleForSearch(fetch.movie_title);
      if (cleaned !== fetch.movie_title && cleaned.length > 0) {
        results = await deps.searchMovie(cleaned);
      }
    }
    const match = results[0];
    if (match === undefined) {
      await deps.markFailed(deps.db, message.targetId, "no TMDB match");
      return { kind: "FETCH_FAILED", cause: "no TMDB match" };
    }
    if (match.posterPath === null) {
      await deps.markFailed(deps.db, message.targetId, "TMDB match has no poster");
      return { kind: "FETCH_FAILED", cause: "TMDB match has no poster" };
    }
    // S55.5 — one details call for the resolved tmdbId, merged into the same upsert.
    // Inside the existing per-title try/catch, so a details failure fails only this
    // job (FAILED with its cause) and never aborts any other title's batch entry.
    const details = await deps.movieDetails(match.tmdbId);
    const displayTitle = match.title.trim() === "" ? null : match.title;
    const releaseDate = details.releaseDate ?? match.releaseDate ?? null;
    await deps.upsertMovie(deps.db, {
      tmdbId: match.tmdbId,
      normalizedTitle: normalizeTitle(fetch.movie_title),
      posterPath: match.posterPath,
      runtimeMinutes: details.runtimeMinutes,
      genres: [...details.genres],
      title: displayTitle,
      releaseDate,
    });
    await deps.markDone(deps.db, message.targetId);
    return { kind: "FETCHED", tmdbId: match.tmdbId };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    await deps.markFailed(deps.db, message.targetId, cause);
    deps.logger.error({ error, tmdb_fetch_id: message.targetId, cause }, "tmdb fetch failed");
    return { kind: "FETCH_FAILED", cause };
  }
}
