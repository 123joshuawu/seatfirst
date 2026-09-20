import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  browseAmcMovieCatalogue,
  poolClient,
  readAmcMovieCatalogueByNormalizedTitles,
  readMoviesByNormalizedTitles,
  searchMoviesByTitle,
  upsertTmdbMovie,
  type AmcMovieCatalogueSlateRow,
  type MovieRow,
  type SqlClient,
  type TmdbMovieRow,
} from "@seatfirst/durability";

import type { TmdbClient, TmdbMovieSummary } from "../../tmdb/client.js";
import { normalizeTitle } from "../../tmdb/normalize.js";

import type { MoviesSearchContext } from "./context.js";

/**
 * `movies.search` (S63.4, ADR 0100 §Cold Mode) — unified movie & special-event
 * discovery across the AMC movies catalogue and the AMC-observed catalogue, for the
 * search form's Cold Mode (`isWarm === false`): the user can pick any active
 * theatrical release or special event and submit, instead of deadlocking on an
 * empty `theatres.movies` list.
 *
 * - **Empty query** (`query` omitted, blank, or shorter than
 *   `MIN_TYPED_QUERY_LENGTH`): serves the AMC movies catalogue from local
 *   `amc_movie_catalogue` in one query — no TMDB egress, no AMC traffic (the
 *   catalogue is already locally cached by the periodic worker, ADR 0102).
 * - **Typed query** (`query.length >= 2`, spec S63.4 §4.2): live
 *   `tmdbClient.searchMovie(query)` (under its own 30 req/s bucket, ADR 0019
 *   §5), each hit lazily upserted into `tmdb_movie` enriched with `movieDetails`
 *   (the S55.5 summary+details merge), UNIONED with a zero-egress substring
 *   lookup over the local AMC `movie` catalogue (Screen Unseen, Met Opera Live,
 *   Fathom Events).
 * - **Tri-state confidence** (spec S63.4 §4.3): `VERIFIED_AMC` (observed at AMC;
 *   `"AMC Event"` badge only when AMC-only, i.e. non-TMDB), `WIDE_THEATRICAL`
 *   (AMC lists this title in its own movies catalogue but has not yet confirmed
 *   a showtime for it at any observed theatre; no badge — an AMC-listed release
 *   is expected to play here), `UNVERIFIED` (general TMDB search only;
 *   `"May not be playing here"` badge).
 *
 * Lazy upserts are best-effort cache fills: a per-entry failure (details outage,
 * `normalized_title` collision across TMDB ids) skips persistence for that entry
 * but never fails the search — the response is assembled from the live data plus
 * the local reads. TMDB wire failures are already logged at the client layer
 * (O11.8), so the route needs no logger to swallow them honestly.
 */

export const t = initTRPC.context<MoviesSearchContext>().create();

/** Spec S63.4 §4.2: below this trimmed length the query is default-slate browse. */
export const MIN_TYPED_QUERY_LENGTH = 2;

/**
 * Route-local result cap. The 50 maximum mirrors ADR 0016's 50-result cap
 * (`theatres.search` applies it route-side after ranking); the 20 default keeps
 * a debounced keystroke query — and its bounded `movieDetails` fan-out — small.
 */
export const DEFAULT_MOVIE_SEARCH_LIMIT = 20;
export const MAX_MOVIE_SEARCH_LIMIT = 50;

export const moviesSearchInputSchema = z.strictObject({
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(MAX_MOVIE_SEARCH_LIMIT).optional(),
});

export const MovieSearchConfidenceSchema = z.enum([
  "VERIFIED_AMC",
  "WIDE_THEATRICAL",
  "UNVERIFIED",
]);

export type MovieSearchConfidence = z.infer<typeof MovieSearchConfidenceSchema>;

export interface MovieSearchHit {
  /**
   * `tmdb:movie:<id>` for typed-query TMDB-backed hits, the verbatim
   * `movie.movie_id` for AMC-schedule-confirmed hits, and
   * `amc:catalogue:<movie_id>` for catalogue-only default-slate hits not yet
   * on a live schedule (AMC's own numeric id, a different id space than
   * `movie.movie_id`).
   */
  readonly id: string;
  /** AMC-observed verbatim title when matched, else the catalogue/TMDB display title. */
  readonly title: string;
  /** Parsed from the catalogue or TMDB `release_date`; null when no date is carried. */
  readonly releaseYear: number | null;
  readonly posterPath: string | null;
  readonly confidence: MovieSearchConfidence;
  /** `"AMC Event"` (AMC-only), `"May not be playing here"` (unverified), else null. */
  readonly badge: string | null;
  readonly seenAtAmc: boolean;
}

export interface MoviesSearchResponse {
  readonly movies: readonly MovieSearchHit[];
}

/** Spec S63.4 §4.3 badge strings, verbatim. */
export const AMC_EVENT_BADGE = "AMC Event";
export const UNVERIFIED_BADGE = "May not be playing here";

/** Parses `YYYY-MM-DD` (the pg `date` text form and TMDB's `release_date` shape). */
export function releaseYearFromDate(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

export const search = t.procedure
  .input(moviesSearchInputSchema)
  .query(async ({ input, ctx }): Promise<MoviesSearchResponse> => {
    const db = poolClient(ctx.db);
    const limit = input.limit ?? DEFAULT_MOVIE_SEARCH_LIMIT;
    const query = (input.query ?? "").trim();
    if (query.length < MIN_TYPED_QUERY_LENGTH) {
      return { movies: await readSlate(db, limit) };
    }
    const tmdbClient = ctx.tmdbClient;
    if (tmdbClient === undefined) {
      // Wiring gap, not a user error: an assembly that never injected the live
      // client cannot serve typed queries. Fail closed and loud — never serve a
      // silently TMDB-less "union".
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "movies.search typed query requires a wired TmdbClient",
      });
    }
    return { movies: await searchLive(db, tmdbClient, query, limit) };
  });

/**
 * Default-slate browse (ADR 0102 decision 5): AMC movies catalogue rows with
 * their AMC schedule match. Catalogue rows carry no compliant poster (ADR 0102
 * decision 5), so `posterPath` is always null; confidence is `VERIFIED_AMC`
 * (AMC observed — normal chip, no badge) or `WIDE_THEATRICAL`, never
 * `UNVERIFIED`.
 */
async function readSlate(db: SqlClient, limit: number): Promise<MovieSearchHit[]> {
  const hits: MovieSearchHit[] = [];
  const seen = new Set<number>();
  const slate: AmcMovieCatalogueSlateRow[] = await browseAmcMovieCatalogue(db, limit);
  for (const row of slate) {
    // The AMC LEFT JOIN fans out on multi-provider title collisions; the
    if (seen.has(row.movie_id)) {
      continue;
    }
    seen.add(row.movie_id);
    const seenAtAmc = row.amc_movie_id !== null;
    hits.push({
      id: row.amc_movie_id ?? `amc:catalogue:${row.movie_id}`,
      title: row.amc_title ?? row.name,
      releaseYear: releaseYearFromDate(row.release_date),
      posterPath: null,
      confidence: seenAtAmc ? "VERIFIED_AMC" : "WIDE_THEATRICAL",
      badge: null,
      seenAtAmc,
    });
  }
  return hits;
}

interface EnrichedLiveHit {
  readonly summary: TmdbMovieSummary;
  /** Null when enrichment or persistence was skipped — the hit still serves. */
  readonly upserted: TmdbMovieRow | null;
}

async function searchLive(
  db: SqlClient,
  tmdbClient: TmdbClient,
  query: string,
  limit: number,
): Promise<MovieSearchHit[]> {
  // The AMC lookup runs regardless of TMDB health: a TMDB outage degrades the
  // typed path to local-only results instead of failing the search.
  const [live, amcRows] = await Promise.all([
    queryTmdb(tmdbClient, query),
    searchMoviesByTitle(db, query),
  ]);
  // Dedupe live hits by tmdb_id, preserving TMDB relevance order, and bound the
  // enrichment fan-out to what the response can carry.
  const seenIds = new Set<number>();
  const candidates = live
    .filter((hit) => {
      if (seenIds.has(hit.tmdbId)) {
        return false;
      }
      seenIds.add(hit.tmdbId);
      return true;
    })
    .slice(0, limit);
  const enriched = await Promise.all(
    candidates.map((summary) => enrichAndUpsert(db, tmdbClient, summary)),
  );
  const liveKeys = new Set(enriched.map(({ summary }) => normalizeTitle(summary.title)));
  const amcByTitle = new Map<string, MovieRow>();
  const normalizedKeys = [...liveKeys];
  // ADR 0102 2026-09-20 amendment: typed-query `WIDE_THEATRICAL` repoints from
  // the deleted `tmdb_movie` slate flags to `amc_movie_catalogue` membership
  // by normalized title — the same "AMC lists this as playing/coming" signal
  // as the empty-query path, batched in one query mirroring `amcByTitle` above.
  const catalogueByTitle = new Set<string>();
  if (normalizedKeys.length > 0) {
    for (const row of await readMoviesByNormalizedTitles(db, normalizedKeys)) {
      const key = normalizeTitle(row.title);
      if (!amcByTitle.has(key)) {
        amcByTitle.set(key, row);
      }
    }
    for (const row of await readAmcMovieCatalogueByNormalizedTitles(db, normalizedKeys)) {
      catalogueByTitle.add(normalizeTitle(row.name));
    }
  }
  const hits: MovieSearchHit[] = enriched.map(({ summary, upserted }) => {
    const amc = amcByTitle.get(normalizeTitle(summary.title));
    const seenAtAmc = amc !== undefined;
    const onCatalogue = catalogueByTitle.has(normalizeTitle(summary.title));
    const confidence: MovieSearchConfidence = seenAtAmc
      ? "VERIFIED_AMC"
      : onCatalogue
        ? "WIDE_THEATRICAL"
        : "UNVERIFIED";
    return {
      id: `tmdb:movie:${summary.tmdbId}`,
      title: amc?.title ?? summary.title,
      releaseYear: releaseYearFromDate(upserted?.release_date ?? summary.releaseDate),
      posterPath: upserted?.poster_path ?? summary.posterPath,
      confidence,
      badge: confidence === "UNVERIFIED" ? UNVERIFIED_BADGE : null,
      seenAtAmc,
    };
  });
  // AMC-only extras: catalogue titles no live TMDB hit covered, in catalogue
  // order (`MOVIE_TITLE_SEARCH`'s `ORDER BY title, movie_id`). They are observed
  // AMC programming, so `VERIFIED_AMC` — and non-TMDB, so the `"AMC Event"` badge.
  // The AMC catalogue search can return multiple distinct `movie_id` rows
  // sharing the exact same title; dedupe by normalized title (first,
  // catalogue-order occurrence wins), seeded with the live-hit titles above.
  const seenAmcTitles = new Set<string>(liveKeys);
  for (const row of amcRows) {
    if (hits.length >= limit) {
      break;
    }
    const amcKey = normalizeTitle(row.title);
    if (seenAmcTitles.has(amcKey)) {
      continue;
    }
    seenAmcTitles.add(amcKey);
    hits.push({
      id: row.movie_id,
      title: row.title,
      releaseYear: null,
      posterPath: null,
      confidence: "VERIFIED_AMC",
      badge: AMC_EVENT_BADGE,
      seenAtAmc: true,
    });
  }
  return hits;
}

/** Live TMDB query as best-effort union input: rejection degrades to no live hits. */
async function queryTmdb(tmdbClient: TmdbClient, query: string): Promise<TmdbMovieSummary[]> {
  try {
    return await tmdbClient.searchMovie(query);
  } catch {
    return [];
  }
}

/**
 * Lazy upsert for one live hit: `movieDetails` enrichment merged into the same
 * upsert (the S55.5 discipline). Any failure — details outage, `tmdb_id`
 * conflict, `normalized_title` cross-id collision — skips persistence for this
 * entry only; the hit still serves from live data with catalogue-only
 * confidence (hence `UNVERIFIED` unless AMC-matched or catalogue-listed).
 */
async function enrichAndUpsert(
  db: SqlClient,
  tmdbClient: TmdbClient,
  summary: TmdbMovieSummary,
): Promise<EnrichedLiveHit> {
  try {
    const details = await tmdbClient.movieDetails(summary.tmdbId);
    const displayTitle = summary.title.trim() === "" ? null : summary.title;
    const releaseDate = details.releaseDate ?? summary.releaseDate ?? null;
    const rows = await upsertTmdbMovie(db, {
      tmdbId: summary.tmdbId,
      normalizedTitle: normalizeTitle(summary.title),
      title: displayTitle,
      posterPath: summary.posterPath,
      runtimeMinutes: details.runtimeMinutes,
      genres: [...details.genres],
      releaseDate,
    });
    return { summary, upserted: rows[0] ?? null };
  } catch {
    return { summary, upserted: null };
  }
}
