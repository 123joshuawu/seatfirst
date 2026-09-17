-- Least-privilege retention scheduler execution (I12, ADR 0077 §D7).
--
-- The seven retention wrappers from 006_retention.sql plus the
-- check_default_partitions_empty() wrapper below are the scheduler's only
-- authority. Their migration owner remains the function owner; execution is
-- confined to retention_worker through SECURITY DEFINER with a fixed search
-- path, rather than table privileges on the worker role.
--
-- Postgres 16. No COMMIT mid-file (applyMigrations owns the transaction).

ALTER FUNCTION public.maintain_partition_lookahead() OWNER TO CURRENT_USER;
ALTER FUNCTION public.maintain_partition_lookahead()
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.maintain_partition_lookahead() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maintain_partition_lookahead() TO retention_worker;

ALTER FUNCTION public.drop_snapshot_partitions(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.drop_snapshot_partitions(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.drop_snapshot_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drop_snapshot_partitions(integer) TO retention_worker;

ALTER FUNCTION public.drop_event_partitions(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.drop_event_partitions(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.drop_event_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drop_event_partitions(integer) TO retention_worker;

ALTER FUNCTION public.delete_expired_snapshot_default_rows(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.delete_expired_snapshot_default_rows(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.delete_expired_snapshot_default_rows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_expired_snapshot_default_rows(integer) TO retention_worker;

ALTER FUNCTION public.delete_expired_event_default_rows(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.delete_expired_event_default_rows(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.delete_expired_event_default_rows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_expired_event_default_rows(integer) TO retention_worker;

ALTER FUNCTION public.delete_expired_sessions(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.delete_expired_sessions(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.delete_expired_sessions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_expired_sessions(integer) TO retention_worker;

ALTER FUNCTION public.delete_expired_searches(integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.delete_expired_searches(integer)
  SECURITY DEFINER
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.delete_expired_searches(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_expired_searches(integer) TO retention_worker;

-- Scheduler's only DEFAULT-partition read path (ADR 0077 §D7): true if and
-- only if both availability_snapshot_default and events_default are empty.
-- Lets retention_worker gate the TTL sweep with zero table grants.
CREATE FUNCTION public.check_default_partitions_empty()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN NOT EXISTS (SELECT 1 FROM availability_snapshot_default LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM events_default LIMIT 1);
END;
$$;

ALTER FUNCTION public.check_default_partitions_empty() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.check_default_partitions_empty() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_default_partitions_empty() TO retention_worker;
