-- ADR 0037 decision 2 — rank-ordered dispatch: ordinal position within
-- the admitting search's ranked candidate list (0 = best), stored on the
-- provider_run row so SWEEP_OVERDUE_OUTBOX can order by it. NULL for
-- RECHECK/SCHEDULE_RESOLUTION runs (no candidate rank) and for pre-feature
-- rows. No default beyond NULL; smallint range covers the 200-showtime ceiling.
ALTER TABLE provider_run ADD COLUMN dispatch_rank smallint;
