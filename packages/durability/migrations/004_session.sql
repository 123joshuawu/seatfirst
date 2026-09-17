-- ADR 0005 §F — the session table. AUTHORITATIVE for this table's shape.
--
-- The two §F statements below are the ADR's DDL verbatim
-- (docs/adr/0005-security-privacy-operations.md:456-462), including the inline comment;
-- the §F retention DELETE job (same ADR, :464-467) is S18's scheduled job, not migrated
-- here.
--
-- Deviations from ADR 0005 §F, each deliberate:
--   1. An additional partial index, search_open_per_session on search(session_id), is
--      created by this migration. S16.1 (docs/tasks/S16-session-rate-limiter/spec.md)
--      is its source of truth: S16.3's concurrency gauge (countOpenSearches) reads
--      exactly the row set this index serves, and §F enumerates indexes only on session.
--
-- Postgres 16. No IP column anywhere in this migration (docs/gates.md's trap row,
-- enforced per §F:469). No FK from search.session_id to session (session rows are
-- deleted at 30 days while search rows live 90, §F:482-497).

CREATE TABLE session (
  session_id  text PRIMARY KEY,          -- opaque, matches session.bootstrap's issued sessionId
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_retention ON session (last_seen_at);

CREATE INDEX search_open_per_session
  ON search (session_id)
  WHERE status IN ('PENDING_SCHEDULE','RUNNING');
