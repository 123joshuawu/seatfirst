-- Restore-drill sentinel heartbeat and retention-bounded prune entry point
-- (I16, ADR 0081 §8 / BAK-03).
--
-- A scheduled heartbeat inserts one row per hour, so at any moment the last
-- 30-plus days carry a dense series of rows with known timestamps; the
-- restore drill picks its recovery target between two known rows and asserts
-- the earlier one is present and the later one absent. Rows older than §6's
-- 37-day floor (30-day PITR window + 7-day backup interval) cannot bracket
-- any promised target and are pruned through the parameterless SECURITY
-- DEFINER function below — never by direct DELETE, which no role holds.
--
-- Privilege shape: retention_worker holds INSERT + SELECT (the heartbeat's
-- writer) and EXECUTE on prune_restore_sentinel() (the nightly job's only
-- delete path). seatfirst_app is explicitly revoked at the end: §9's ALTER
-- DEFAULT PRIVILEGES grants it DML on every table postgres creates, so
-- without the trailing REVOKE the application tier could rewrite the
-- evidence the drill verifies. retention_worker deliberately holds no
-- DELETE — a role that can delete sentinel rows directly can erase the
-- evidence that a restore drill failed.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction).
-- timestamptz throughout, matching the house convention.

CREATE TABLE public.restore_sentinel (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  written_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.restore_sentinel IS
  'ADR 0081 §8: hourly restore-drill heartbeat rows. Pruned only through '
  'prune_restore_sentinel(); no role holds a direct DELETE.';

GRANT INSERT, SELECT ON public.restore_sentinel TO retention_worker;

CREATE FUNCTION public.prune_restore_sentinel() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER
  -- 37 days = §6's floor (30-day PITR window + 7-day backup interval). Fixed, not a
  -- parameter: a caller-supplied window would let retention_worker delete the very
  -- rows that prove a restore drill failed.
  SET search_path = pg_catalog, public
AS $$
  WITH deleted AS (
    DELETE FROM public.restore_sentinel
     WHERE written_at < now() - interval '37 days'
    RETURNING 1
  ) SELECT count(*) FROM deleted;
$$;

COMMENT ON FUNCTION public.prune_restore_sentinel() IS
  'ADR 0081 §8: delete sentinel rows older than the fixed 37-day floor. '
  'Parameterless by design; EXECUTE is granted to retention_worker alone.';

ALTER FUNCTION public.prune_restore_sentinel() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.prune_restore_sentinel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_restore_sentinel() TO retention_worker;

-- Must stay last: §9's default privileges grant seatfirst_app DML on this
-- table at CREATE TABLE time above, so only a trailing REVOKE keeps the
-- runtime role off the drill evidence.
REVOKE ALL ON public.restore_sentinel FROM seatfirst_app;
