-- S25.3/S25.4/S25.5 (ADR 0019 + amendment 2026-08-16): the TMDB metadata fetch machinery.
--
-- The read-time cache-miss dispatch (amendment decision 2) enqueues a single-movie
-- TMDB_METADATA_FETCH job through the existing outbox mechanism. The outbox's two targets
-- (JOB -> search_job, RUN -> provider_run) are both FK'd through to `search`
-- (001_schema.sql:88, :115); a TMDB fetch belongs to no search, so it gets its own
-- searchless target table and a third outbox target_kind (amendment decision 5).
--
-- Deliberate choices (each deviation from 001_schema.sql is enumerated):
--   1. `tmdb_fetch` mirrors `search_job`'s lifecycle columns where they make sense for a
--      searchless job (state, attempt, fail_cause, created_at) and DROPS the
--      search-lifecycle machinery: no search_id/run_key_id/kind (no fence, no key), no
--      generation (no lease/generation fencing), no deadline_at (a poster fetch has no
--      deadline), no LEASED state or lease_expires_at (BullMQ owns at-least-once delivery
--      and the upsert is idempotent — a durable lease is search-lifecycle machinery the
--      amendment explicitly forbids copying). State is PENDING/DONE/FAILED only.
--   2. `movie_title` (not movie_id) is the fetch key: the read path holds the AMC title in
--      hand, the worker searches TMDB by that title, and the join key is
--      lower(movie.title) = tmdb_movie.normalized_title — the title, not the id, is what
--      the worker needs.
--   3. `one_live_tmdb_fetch_per_title` is a partial UNIQUE index on movie_title WHERE
--      state = 'PENDING' — a second read of the same movie while a fetch is still pending
--      does not enqueue a duplicate (mirrors one_live_run_per_key, 001_schema.sql:128-129).
--      A FAILED row does not block a later re-dispatch (poster still null).
--   4. `tmdb_prewarm_state` is the pre-warm cron's single-row checkpoint (decision 1),
--      mirroring catalogue_crawl_state (010_catalogue_crawl_state.sql) minus the provider
--      key and cursor: TMDB is a single upstream, and the pre-warm pass has no resumeable
--      cursor. `last_completed_at` null (or no row) means "never run" -> immediately due.
--
-- Postgres 16. Text ids, timestamptz throughout, no frozen literals.

-- (a) the searchless fetch job state (amendment decision 5).
CREATE TABLE tmdb_fetch (
  tmdb_fetch_id    text PRIMARY KEY,          -- ULID fixed at dispatch: idempotency key
  movie_title      text NOT NULL CHECK (btrim(movie_title) <> ''),
  state            text NOT NULL DEFAULT 'PENDING'
                   CHECK (state IN ('PENDING','DONE','FAILED')),
  attempt          integer NOT NULL DEFAULT 0,
  fail_cause       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_live_tmdb_fetch_per_title ON tmdb_fetch (movie_title)
  WHERE state = 'PENDING';

-- (b) widen outbox.target_kind. Inline column CHECK -> auto-named
--     outbox_target_kind_check; DROP/ADD mirrors 007_recheck_run_kind.sql:29-32.
ALTER TABLE outbox DROP CONSTRAINT outbox_target_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_target_kind_check
  CHECK (target_kind IN ('JOB','RUN','TMDB_FETCH'));

-- (c) the nullable FK + the (target_kind = X) = (id IS NOT NULL) pair, mirroring
--     001_schema.sql:137-145 exactly.
ALTER TABLE outbox ADD COLUMN tmdb_fetch_id text REFERENCES tmdb_fetch (tmdb_fetch_id);
ALTER TABLE outbox ADD CONSTRAINT outbox_tmdb_fetch_target_check
  CHECK ((target_kind = 'TMDB_FETCH') = (tmdb_fetch_id IS NOT NULL));

-- (d) the pre-warm checkpoint (decision 1).
CREATE TABLE tmdb_prewarm_state (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_completed_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
