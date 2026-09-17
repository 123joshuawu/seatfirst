-- Retire the restore-drill sentinel heartbeat and its prune entry point
-- (I22, ADR 0090 §§3-5, superseding 023 / ADR 0081 §8 / BAK-03).
--
-- The proportional backup posture no longer generates hourly synthetic sentinel
-- transactions to prove recovery-target attainment, so the evidence table and
-- the parameterless SECURITY DEFINER prune function have no readers or writers
-- left: the scheduler heartbeat and the nightly prune call are removed from
-- `infra/config/scheduler/crontab` in the same task. Drop the function first —
-- it depends on the table — then the table itself.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction).
-- timestamptz throughout, matching the house convention.

DROP FUNCTION IF EXISTS public.prune_restore_sentinel();
DROP TABLE IF EXISTS public.restore_sentinel;
