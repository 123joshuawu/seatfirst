-- AMC's own movies catalogue, periodically fetched (ADR 0102), replacing the TMDB
-- now_playing/upcoming pre-warm slate (ADR 0019 decision 3, superseded by ADR 0102) as the
-- source for `trpc.movies.search`'s empty-query default browse.
--
-- Deliberate choices:
--   1. `movie_id` is AMC's own numeric `movieId` (`PublicMovieSummary.movieId`,
--      `packages/providers/src/amc/parse/movies.ts`) as the primary key — an `int`, not
--      `text`, matching the parser's own `z.number()` type. This is deliberately a
--      different id space than `movie.movie_id` (AMC's *showtime-catalogue* movie id,
--      `009_movie_catalog.sql`, always `text`): the `/movies` page and the schedule-crawl
--      catalogue are two different AMC surfaces observed to use different id encodings, and
--      this ADR does not assert they always coincide. `readSlate()`'s AMC cross-reference
--      still joins by normalized title, the same key `TMDB_SLATE_BROWSE` used, not by id.
--   2. Upsert-only, no delete (ADR 0102 decision 4, mirroring ADR 0022's theatre-catalogue
--      posture, `003_catalog.sql`/`009_movie_catalog.sql`'s existing precedent): a title AMC
--      stops listing simply stops being touched; `updated_at` freezes rather than the row
--      being removed.
--   3. No FK to or from `movie` or `tmdb_movie`: a decoupled augmentation, mirroring
--      `tmdb_movie`'s own no-inbound-FK posture (`011_tmdb_movie.sql`).
--   4. `release_date`/`mpaa_rating`/`runtime_minutes`/`status`/`image_url`/`trailer`-adjacent
--      fields are all nullable: `PublicMovieSummary` itself marks them
--      `.nullable().optional()` — AMC's own page omits them for some entries, and a missing
--      value reads as "unknown", never fabricated.
--   5. `amc_movie_catalogue_state` is the worker's single-row due-ness checkpoint, the exact
--      shape of `tmdb_prewarm_state` (`012_tmdb_fetch_outbox.sql`) minus nothing: this is
--      also a single daily pass against one upstream, no per-provider or cursor dimension
--      needed (ADR 0102 decision 1/2 — one page, no multi-page crawl to resume mid-pass).
--
-- Decommissions ADR 0019 decision 3 (superseded by ADR 0102, see that ADR's amendment to
-- ADR 0019): the TMDB pre-warm checkpoint and slate-membership flags have no remaining
-- reader once `readSlate()` is repointed, and are dropped here rather than left dead.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction). IF NOT
-- EXISTS/IF EXISTS guards throughout: the tier-0 pending-only ledger test re-applies the
-- last migration file in isolation, matching 025/026's precedent.

CREATE TABLE IF NOT EXISTS amc_movie_catalogue (
  movie_id        int PRIMARY KEY,
  slug            text NOT NULL,
  name            text NOT NULL,
  mpaa_rating     text,
  runtime_minutes int,
  release_date    date,
  status          text,
  image_url       text,
  details_path    text,
  showtimes_path  text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS amc_movie_catalogue_state (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_completed_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS tmdb_prewarm_state;

ALTER TABLE tmdb_movie DROP COLUMN IF EXISTS is_now_playing;
ALTER TABLE tmdb_movie DROP COLUMN IF EXISTS is_upcoming;
