-- Showtime offer price columns (S59, ADR 0062 §2).
--
-- Adds `currency` and `price_basis` beside the existing `performance.min_price`
-- (003_catalog.sql), so a seat-fetch acceptance can persist the parsed offer price
-- atomically with the snapshot. Both columns are nullable with CHECK constraints,
-- matching the 003_catalog.sql pattern: pre-resolution and cold schedule
-- performances legitimately remain NULL until a seat fetch completes, and existing
-- historical rows require no backfill.
--
-- Deliberate deviations from source prose: none.
--
-- Postgres 16. Text namespaced IDs, timestamptz throughout, no frozen partition month.
-- No COMMIT mid-file (applyMigrations owns the transaction).

ALTER TABLE performance
  ADD COLUMN currency text CHECK (currency IS NULL OR length(currency) = 3),
  ADD COLUMN price_basis text CHECK (price_basis IS NULL OR price_basis IN ('TICKET_ONLY', 'UNKNOWN'));
