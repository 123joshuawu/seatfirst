-- Movie catalogue: the normalized, durable movie title, populated on schedule acceptance
-- (S24). Mirror of the theatre catalogue's shape and posture (003_catalog.sql:22-43).
--
-- Deliberate choices:
--   1. movie_id is a namespaced text id with the same CHECK shape as theatre_id
--      (`^[^:]+:movie:.+$`), and split_part(movie_id, ':', 1) must equal provider_id —
--      the same namespace-binding posture the theatre table applies.
--   2. title has NO length cap, mirroring theatre.name's no-cap precedent
--      (003_catalog.sql:26): a cap would be a gate-14 number nobody approved
--      (docs/open-questions.md:24).
--   3. performance.movie_id has NO FK to this table, mirroring the theatre pattern's
--      no-inbound-FK posture (003_catalog.sql:45-46): an FK would force every existing
--      write/seed path that touches movie_id (S14's handler, S21's test seeding) to upsert a
--      movie first, churning tasks that are not this one. The same-transaction write ordering
--      (movies before performances, S24.5) is the catalogue-before-reference convention;
--      without the FK it is not load-bearing.
--   4. On conflict, first_seen_at is never updated and last_seen_at is greatest(...) — the
--      exact THEATRE_UPSERT semantics (boundaries.ts:61-79), so last capture wins for title
--      (the reconciliation point for same-movie title drift) while first_seen_at stays the
--      first capture instant.
--   5. No image/poster field, column, or URL of any kind: ADR 0002 §2.8 constraint 3 forbids
--      capturing copyrighted media, and S24 ships only the factual title.
--
-- Postgres 16. Text namespaced IDs, timestamptz throughout, no frozen partition month.

CREATE TABLE movie (
  movie_id       text PRIMARY KEY
                 CHECK (movie_id ~ '^[^:]+:movie:.+$'),
  provider_id    text NOT NULL CHECK (btrim(provider_id) <> ''),
  title          text NOT NULL CHECK (btrim(title) <> ''),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  CHECK (split_part(movie_id, ':', 1) = provider_id),
  CHECK (last_seen_at >= first_seen_at)
);
