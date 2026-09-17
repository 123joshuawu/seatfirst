-- S26: single-row-per-provider catalogue-crawl checkpoint state (ADR 0022). The monthly
-- theatre-catalogue crawl worker writes this row to survive process restarts: the last
-- pass start/completion instants (due-ness, S26.7) and the jsonb cursor that lets it resume
-- mid-pass without re-fetching the directory page (S26.10).
--
-- Deliberate choices:
--   1. provider_id is the primary key, one row per provider. ADR 0022 is AMC-specific
--      today, but the worker is provider-scoped and this mirrors the theatre/movie
--      catalogue's per-provider posture (003_catalog.sql, 009_movie_catalog.sql).
--   2. last_pass_started_at and last_pass_completed_at are nullable: no row (or a null
--      started_at) means the provider has never run a pass and is immediately due (S26.7).
--   3. cursor is a nullable jsonb, opaque to the schema layer. The worker owns its exact
--      shape ({ slugs, nextIndex }) and it round-trips through jsonb untouched; a CHECK on
--      its contents would couple this schema to a shape the spec explicitly leaves to the
--      worker ("exact cursor shape is implementation detail", S26.10).
--   4. updated_at is housekeeping (DEFAULT now()), not load-bearing: due-ness reads only
--      the two pass timestamps, never updated_at.
--   5. No `last_pass_completed_at >= last_pass_started_at` CHECK. Unlike movie's
--      first_seen/last_seen pair, started_at resets to now() at each new pass while
--      completed_at still carries the PREVIOUS pass's completion instant until the new pass
--      finishes — so during an in-flight pass, completed_at < started_at by design.
--
-- Postgres 16. Text ids, timestamptz throughout, no frozen literals.

CREATE TABLE catalogue_crawl_state (
  provider_id            text PRIMARY KEY CHECK (btrim(provider_id) <> ''),
  last_pass_started_at   timestamptz,
  last_pass_completed_at timestamptz,
  cursor                 jsonb,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
