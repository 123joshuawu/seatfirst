-- S23: searches.cancel (ADR 0018) adds CANCELLED as a genuine terminal status.
-- The search.status CHECK was an inline column constraint (001_schema.sql) and is
-- therefore auto-named search_status_check; widen it in place rather than adding a
-- parallel, duplicative constraint.
ALTER TABLE search DROP CONSTRAINT search_status_check;
ALTER TABLE search ADD CONSTRAINT search_status_check
  CHECK (status IN ('PENDING_SCHEDULE','RUNNING',
                    'COMPLETE','PARTIAL','HALTED','CANCELLED'));
