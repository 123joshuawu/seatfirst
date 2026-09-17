-- ADR 0005 §I — gate 19's cost ledger (`cost_event`). AUTHORITATIVE.
--
-- The DDL is ADR 0005 §I's schema (`docs/adr/0005-security-privacy-operations.md:697-738`)
-- verbatim, including the four-value event_type CHECK, the per-type nullability CHECK, and
-- the four partial unique indexes — the decided shape of gate 19's three distinct counters
-- (`docs/gates.md:24`): unique provider work, subscriber-weighted abuse cost, and admission
-- reservations (`ADMISSION_RESERVATION` + per-key `ADMISSION_RECONCILED` compose to one
-- counter; they are not a fourth, `docs/adr/0005-security-privacy-operations.md:691-695`).
-- `search_id` takes `ON DELETE CASCADE`, the decided consequence of the 90-day `search`
-- retention (`docs/adr/0005-security-privacy-operations.md:517-529,1058-1074`).
--
-- Deviations from ADR 0005 §I's literal prose, each deliberate:
--   1. File numbering: the ADR assigns the `session` and `cost_event` tables to one shared
--      `004_security_ops.sql` migration (`docs/adr/0005-security-privacy-operations.md:552-555,
--      925-926,998-1001`). The backlog split that assignment into three independent tasks
--      (`docs/backlog.md:364-371`), so the tables land in separate sequential files:
--      S16 → 004_session.sql, S17 → 005_cost_ledger.sql (this file), S18 → 006_retention.sql.
--      This file declares the `cost_event` half only.
--   2. Event ids are generated SQL-side with `gen_random_uuid()`, exactly the shipped outbox
--      precedent (`src/boundaries.ts`, OUTBOX_CREATE_JOB / OUTBOX_CREATE_RUN). The ADR's
--      "ULID" comment is not normative — the repo's own practice already deviates
--      (`001_schema.sql:17` says "text ULIDs" while outbox ids are UUIDs).
--
-- Postgres 16. Text ids, timestamptz throughout, enum-like columns as text + CHECK.

CREATE TABLE cost_event (
  event_id       text PRIMARY KEY,       -- SQL-side gen_random_uuid() (see header deviation 2)
  event_type     text NOT NULL CHECK (event_type IN
                    ('PROVIDER_WORK', 'ABUSE_WEIGHTED', 'ADMISSION_RESERVATION', 'ADMISSION_RECONCILED')),
  run_id         text REFERENCES provider_run (run_id),
  attempt        integer,                -- provider_run.attempt AS OF this event; PROVIDER_WORK/ABUSE_WEIGHTED only
  search_id      text REFERENCES search (search_id) ON DELETE CASCADE,
  run_key_id     text REFERENCES run_key (run_key_id),  -- ADMISSION_RECONCILED only: the schedule key B6 reconciled
  units          bigint NOT NULL,        -- logical navigations; weighted count for ABUSE_WEIGHTED;
                                         -- stage-1 reserved_total for ADMISSION_RESERVATION; signed
                                         -- delta ($real - $stage1Share, ADR 0001 B6) for ADMISSION_RECONCILED
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'PROVIDER_WORK'         AND run_id IS NOT NULL AND attempt IS NOT NULL AND search_id IS NULL     AND run_key_id IS NULL) OR
    (event_type = 'ABUSE_WEIGHTED'        AND run_id IS NOT NULL AND attempt IS NOT NULL AND search_id IS NOT NULL AND run_key_id IS NULL) OR
    (event_type = 'ADMISSION_RESERVATION' AND run_id IS NULL     AND attempt IS NULL     AND search_id IS NOT NULL AND run_key_id IS NULL) OR
    (event_type = 'ADMISSION_RECONCILED'  AND run_id IS NULL     AND attempt IS NULL     AND search_id IS NOT NULL AND run_key_id IS NOT NULL)
  )
);
-- Idempotency per counter, enforced by unique partial indexes rather than a single
-- UNIQUE(event_type, run_id, search_id) — the four event types have different natural keys.
-- Keyed on (run_id, attempt), not run_id alone: provider_run rows are re-leased and
-- retried IN PLACE ("attempt = attempt + 1" on the SAME run_id, ADR 0001 B2/B4 —
-- `provider_epoch` is documented as "refreshed," not merely stamped once). One run_id
-- can therefore pass B4 more than once over its lifetime; each real dispatch is its
-- own fact. Keying on run_id alone would collapse every dispatch after the first
-- retry out of the ledger — undercounting exactly the repeated-attempt case gate 19
-- exists to capture.
CREATE UNIQUE INDEX cost_event_provider_work
  ON cost_event (run_id, attempt) WHERE event_type = 'PROVIDER_WORK';
CREATE UNIQUE INDEX cost_event_abuse_weighted
  ON cost_event (run_id, attempt, search_id) WHERE event_type = 'ABUSE_WEIGHTED';
CREATE UNIQUE INDEX cost_event_admission_reservation
  ON cost_event (search_id) WHERE event_type = 'ADMISSION_RESERVATION';
-- Keyed on (search_id, run_key_id), matching ADR 0001 B6_RECONCILE_STAGE2's own
-- per-key idempotency guard (`run_subscription.admission_counted` cleared once per
-- key, in the same statement) — a search with N schedule keys reconciles N times,
-- once per key, not once per search.
CREATE UNIQUE INDEX cost_event_admission_reconciled
  ON cost_event (search_id, run_key_id) WHERE event_type = 'ADMISSION_RECONCILED';
