-- TMDB poster metadata, decoupled from the AMC movie catalogue (S25, ADR 0019).
--
-- ADR 0019 §1 gives the exact table: tmdb_movie(tmdb_id int PRIMARY KEY,
-- normalized_title text UNIQUE, poster_path text, updated_at timestamptz). ADR 0002
-- §2.8 constraint 3 forbids capturing AMC's copyrighted poster media, so poster data
-- lives here (sourced from TMDB, the compliant upstream) and NOT on the `movie` table,
-- which remains strictly provider truth (S24). `MOVIE_READ_BY_ID` LEFT JOINs this table
-- on normalized_title to resolve a poster at read time (ADR 0019 §2).
--
-- Deliberate choices:
--   1. Column set is ADR 0019's DDL verbatim: `poster_path` and `updated_at` are nullable
--      exactly as specified (a movie may have no poster; `updated_at` is populated by
--      TMDB_MOVIE_UPSERT at write time). No NOT NULL/DEFAULT is added beyond the ADR.
--   2. `normalized_title` is the join key used by MOVIE_READ_BY_ID's LEFT JOIN
--      (lower(movie.title) = tmdb_movie.normalized_title). It is UNIQUE per the ADR, and
--      the worker normalizes upstream titles before upsert so the join resolves.
--   3. No FK to or from `movie`: the table is a decoupled augmentation, not part of the
--      provider catalogue's reference graph — mirroring the movie table's own
--      no-inbound-FK posture (009_movie_catalog.sql:11-16). A FK would force every
--      tmdb write to pre-exist in `movie`, which the pre-warm path (ADR 0019 §3) does not
--      guarantee.
--
-- Postgres 16. timestamptz throughout, no frozen partition month.

CREATE TABLE tmdb_movie (
  tmdb_id          int PRIMARY KEY,
  normalized_title text UNIQUE,
  poster_path      text,
  updated_at       timestamptz
);
