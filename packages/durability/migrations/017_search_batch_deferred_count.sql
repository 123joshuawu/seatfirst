-- ADR 0037 decision 3 — batch-of-20 admission: count of matched showtimes
-- deferred beyond the admitted 20, so B8_TERMINALIZE can distinguish
-- "we checked everything matched" (0) from "we checked 20 of 24" (4).
-- Set once at admission to matchedCount - min(matchedCount, 20). Non-negative,
-- defaults to 0 for pre-feature rows.
ALTER TABLE search ADD COLUMN batch_deferred_count integer NOT NULL DEFAULT 0;
