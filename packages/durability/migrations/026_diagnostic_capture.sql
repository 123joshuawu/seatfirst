-- Provider-run diagnostic captures: the standing raw/unredacted capture for exactly
-- three terminal outcomes — UPSTREAM_BLOCKED / CHALLENGE_REQUIRED (browser-runtime)
-- and UPSTREAM_CHANGED (provider parse layer). Every other outcome keeps its
-- classification-only behavior and never writes here (enforced by the CHECK below).
--
-- Deliberate choices (each deviation from 001_schema.sql is enumerated):
--   1. `run_id` is a best-effort text reference with deliberately NO foreign key.
--      Captures must outlive their runs by design (a capture is the post-mortem of
--      a dead run, and the run row may already be gone when the capture lands).
--      An FK to provider_run would either block the capture insert or block run
--      cleanup — both wrong. This mirrors observation.run_id's unenforced half
--      (001_schema.sql:195), except here even the composite pairing is absent:
--      a capture carries no run_key_id, so there is nothing to pair against.
--   2. `headers` is jsonb, not the 6-item allowlisted/scrubbed header set of ADR 0005
--      §D: this table captures ALL raw response headers, unredacted, by owner
--      decision (risk accepted by Josh Wu, not counsel-cleared). Only the small
--      fields live here — `url` as text, `headers` as jsonb; the body and
--      screenshot live in S3 (referenced by key), never in Postgres.
--   3. `screenshot_s3_key` is nullable: UPSTREAM_CHANGED fires in the pure parser
--      layer with no live Page, so it never has a screenshot; the other two
--      outcomes may carry one.
--   4. Retention is a hard 30-day delete driven by the sweeper boundary
--      DIAGNOSTIC_CAPTURE_SWEEP_EXPIRED (DELETE ... RETURNING captured_at < cutoff),
--      matching ADR 0002 §3.2's shortest class (session/IP identifiers). The
--      captured_at index exists so the sweep never seq-scans.
--   5. Guards (IF NOT EXISTS on the table and the index, explicit index name): the
--      tier-0 pending-only ledger test re-applies the last migration file in
--      isolation, so the file must be re-runnable — the same defensive posture as
--      024's DROP ... IF EXISTS and 025's ADD COLUMN IF NOT EXISTS. The
--      exact-column-shape guarantee lives in tier0.schema.test.ts, not in the
--      absence of the guard.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction).

CREATE TABLE IF NOT EXISTS provider_run_diagnostic_capture (
  capture_id        text PRIMARY KEY,
  run_id            text NOT NULL,
  outcome_kind      text NOT NULL CHECK (outcome_kind IN ('UPSTREAM_BLOCKED','CHALLENGE_REQUIRED','UPSTREAM_CHANGED')),
  url               text NOT NULL,
  headers           jsonb NOT NULL,
  body_s3_key       text NOT NULL,
  screenshot_s3_key text,             -- NULL for UPSTREAM_CHANGED rows; may be present for the other two
  captured_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostic_capture_by_captured_at
  ON provider_run_diagnostic_capture (captured_at);
