-- TMDB slate membership, release date, and display title (S63, ADR 0100 §Cold Mode).
--
-- `trpc.movies.search` (S63.4) serves two reads off `tmdb_movie` that the S25/S55
-- column set cannot express:
--   1. Default (empty-query) browse returns TMDB's North American theatrical slate
--      (`now_playing` + `upcoming`) from local Postgres in <10ms, so the search form
--      has movies to offer before any schedule is cached. That needs slate
--      membership ON the row: `is_now_playing` / `is_upcoming`.
--   2. Results disambiguate remakes and classics with `releaseYear` parsed from
--      `release_date` (e.g. Nosferatu (2024) vs. Nosferatu (1922)).
--
-- Deliberate choices:
--   1. Additive only: four `ADD COLUMN`s, no backfill, no constraint on existing
--      rows. `is_now_playing`/`is_upcoming` are `NOT NULL DEFAULT false`, so every
--      pre-S63 row reads as off-slate until the TMDB pre-warm worker marks it (a
--      follow-up duties change; `TMDB_MOVIE_UPSERT` already accepts the flags and
--      preserves them on conflict when the caller passes NULL).
--   2. `release_date` is a nullable `date`: TMDB itself omits it for some entries,
--      and a missing date reads as "unknown year" (NULL), never a fabricated year.
--   3. `title` is a nullable display-case title. `tmdb_movie` previously stored only
--      `normalized_title` (`trim().toLowerCase()`), which is a join key, not display
--      text. The search endpoint prefers the AMC-observed verbatim title when the
--      row joins to `movie`, then this column, then `normalized_title` as a last
--      resort. NULL means "never observed in display case" (pre-S63 rows and the
--      pre-warm path, which does not pass it yet).
--   4. No index on the slate flags: the slate is hundreds of rows; the browse scans
--      `tmdb_movie` with a sequential filter, which is the same plan an index would
--      yield at this cardinality. Add one when the table outgrows it.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction).
-- `date` for the calendar date, matching the house convention that schedule-local
-- dates are `date` (001_schema.sql) while instants are timestamptz.
--
-- The four ADDs use IF NOT EXISTS (unlike 019's bare ADDs): the tier-0
-- pending-only ledger test re-applies the last migration file in isolation, so
-- the file must be re-runnable — the same defensive posture as 024's
-- DROP ... IF EXISTS. The exact-column-shape guarantee lives in
-- tier0.schema.test.ts, not in the absence of the guard.

ALTER TABLE tmdb_movie ADD COLUMN IF NOT EXISTS release_date date;
ALTER TABLE tmdb_movie ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE tmdb_movie ADD COLUMN IF NOT EXISTS is_now_playing boolean NOT NULL DEFAULT false;
ALTER TABLE tmdb_movie ADD COLUMN IF NOT EXISTS is_upcoming boolean NOT NULL DEFAULT false;
