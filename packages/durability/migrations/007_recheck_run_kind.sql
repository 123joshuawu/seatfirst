-- S22: showtimes.recheck (ADR 0017) adds a third `run_key.kind`, `RECHECK`, the durable
-- recheck-outcome store, the single-use nonce ledger, and the run-priority column.
--
-- Deliberate choices (each deviation from 001_schema.sql is enumerated):
--   1. run_key.kind widens to RECHECK. run_key.route_class is NOT widened — RECHECK pairs
--      with the existing 'seat' value because the recheck navigates the showtime's seat
--      page (S22.0(b)); the kind↔route pairing CHECK is widened in place.
--   2. The key-parts CHECK gains a RECHECK row identical to SHOWTIME_FETCH's
--      (showtime_id set, theatre_id/local_date null) — a recheck targets one showtime's
--      placement, never a schedule row.
--   3. search_job.kind is deliberately NOT widened (S22.1): a recheck creates no
--      search_job and no run_subscription row — it is a direct session call, never a
--      search subscribing to a FetchKey. A search_job would force an invented NOT NULL
--      deadline_at (001_schema.sql:98), a gate-14 number nobody approved.
--   4. run_key.recheck_placement is a nullable jsonb, non-null exactly when kind='RECHECK'
--      (a CHECK, not a NOT NULL), carrying the placement being rechecked.
--   5. provider_run.priority is integer NOT NULL DEFAULT 0, populated from run_key.kind at
--      run creation (RUN_CREATE). RECHECK=2, SCHEDULE_RESOLUTION=1, SHOWTIME_FETCH=0 —
--      the decided ordering (ADR 0017; ADR 0001:1337; seatfirst-architecture.md:206).
--   6. consumed_nonce is the single-use nonce ledger (ADR 0017): the HMAC-signed recheck
--      token's own id, inserted once, replayed inserts zero-row.
--   7. recheck_outcome is the run → verdict store the worker and the API tier share through
--      Postgres (the only durable store they share). One row per run, written exactly once.
--      No retention TTL is invented here (S22.6): outcome rows live as long as their
--      provider_run rows, the same lifetime cost_event already has (S17).

-- Postgres 16. Text namespaced ids, timestamptz throughout.

-- (a) widen run_key.kind. Inline column constraint → auto-named run_key_kind_check.
ALTER TABLE run_key DROP CONSTRAINT run_key_kind_check;
ALTER TABLE run_key ADD CONSTRAINT run_key_kind_check
  CHECK (kind IN ('SHOWTIME_FETCH','SCHEDULE_RESOLUTION','RECHECK'));

-- (b) widen the kind↔route pairing. First table-level CHECK → run_key_check.
ALTER TABLE run_key DROP CONSTRAINT run_key_check;
ALTER TABLE run_key ADD CONSTRAINT run_key_check
  CHECK ((kind IN ('SHOWTIME_FETCH','RECHECK')) = (route_class = 'seat'));

-- (c) widen the key-parts CHECK. Third table-level CHECK → run_key_check2.
ALTER TABLE run_key DROP CONSTRAINT run_key_check2;
ALTER TABLE run_key ADD CONSTRAINT run_key_check2
  CHECK (
    (kind = 'SHOWTIME_FETCH'
       AND showtime_id IS NOT NULL AND theatre_id IS NULL AND local_date IS NULL)
    OR
    (kind = 'SCHEDULE_RESOLUTION'
       AND showtime_id IS NULL AND theatre_id IS NOT NULL AND local_date IS NOT NULL)
    OR
    (kind = 'RECHECK'
       AND showtime_id IS NOT NULL AND theatre_id IS NULL AND local_date IS NULL)
  );

-- (d) the placement a recheck is re-verifying, carried on the key (not the run).
ALTER TABLE run_key ADD COLUMN recheck_placement jsonb;
ALTER TABLE run_key ADD CONSTRAINT run_key_recheck_placement_check
  CHECK ((kind = 'RECHECK') = (recheck_placement IS NOT NULL));

-- (e) dispatch priority, populated from kind at run creation (RUN_CREATE).
ALTER TABLE provider_run ADD COLUMN priority integer NOT NULL DEFAULT 0;

-- (f) the single-use nonce ledger (ADR 0017).
CREATE TABLE consumed_nonce (
  nonce_id    text PRIMARY KEY,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- the run → verdict store the worker writes and the route awaits.
CREATE TABLE recheck_outcome (
  run_id     text PRIMARY KEY REFERENCES provider_run (run_id),
  status     text NOT NULL CHECK (status IN ('AVAILABLE','GONE','UNAVAILABLE')),
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
