-- ADR 0029 §7 — catalog-side `city` column for free-text place-name search (option (a)).
--
-- Deliberate choices and deviations from product prose:
--   1. `city` is nullable `text` with no `CHECK` — not every historical row will have it
--      backfilled, and AMC's own address data may not always yield one (ADR 0029 §7).
--      `NULL` means "unknown", not an empty string; the parser trims and nulls empty.
--   2. No index on `city` — `THEATRE_NAME_SEARCH` already has no index on `name`
--      (S20.2), and the 50-result cap is applied route-side after the nearest-first sort
--      (ADR 0016, S20.2/S20.4). A dedicated trigram/GIN index is a future optimization,
--      not this ADR's scope.
--   3. No backfill — existing rows keep `NULL`; the crawl's next pass populates via
--      `upsertTheatre` (S26.11, ADR 0029 §6 no-production-caller precondition).
--
-- Postgres 16. Text namespaced IDs, timestamptz throughout, no frozen partition month.

ALTER TABLE theatre ADD COLUMN city text;
