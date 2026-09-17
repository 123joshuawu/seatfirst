-- TMDB runtime/genre widening (S55, ADR 0019 amendment 2026-09-02).
--
-- Widens `tmdb_movie` (created by 011_tmdb_movie.sql) with the two columns the
-- `GET /movie/{id}` details endpoint returns: `runtime_minutes` (nullable integer
-- minutes — TMDB itself returns null/0 for titles with undetermined runtime, and a
-- null propagates as "unknown," never a fabricated number) and `genres` (text array
-- of TMDB genre names, defaulting to '{}' so a first-time miss reads as "no genre
-- data yet," the same not-yet-backfilled state `poster_path IS NULL` represents).
-- `TMDB_MOVIE_UPSERT`/`MOVIE_READ_BY_ID` widen to match; no new boundary.
--
-- Postgres 16. timestamptz throughout, no frozen partition month.

ALTER TABLE tmdb_movie ADD COLUMN runtime_minutes integer;
ALTER TABLE tmdb_movie ADD COLUMN genres text[] NOT NULL DEFAULT '{}';
