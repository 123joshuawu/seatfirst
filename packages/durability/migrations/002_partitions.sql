-- ADR 0001 §1 — availability_snapshot partitions + maintenance function.
--
-- A partitioned parent accepts NO inserts until a matching child exists (round 5
-- finding 14: on a fresh database the first snapshot insert failed). The ADR froze a
-- literal 2026-08 partition, which is the same bug with a longer fuse — it stops being
-- true in September. Partitions are therefore generated relative to now().

-- Creates monthly partitions for the current month and the next p_months - 1 months.
-- Idempotent: safe to run from a migration, from the §5 scheduled job, and from a test.
CREATE FUNCTION ensure_snapshot_partitions(p_months integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', now())::date;
  v_from  date;
  v_to    date;
  v_name  text;
  v_made  integer := 0;
BEGIN
  IF p_months < 1 THEN
    RAISE EXCEPTION 'p_months must be >= 1, got %', p_months;
  END IF;

  FOR i IN 0..(p_months - 1) LOOP
    v_from := v_start + make_interval(months => i);
    v_to   := v_start + make_interval(months => i + 1);
    v_name := format('availability_snapshot_%s', to_char(v_from, 'YYYY_MM'));

    IF to_regclass(format('public.%I', v_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF availability_snapshot FOR VALUES FROM (%L) TO (%L)',
        v_name, v_from, v_to);
      v_made := v_made + 1;
    END IF;
  END LOOP;

  RETURN v_made;
END;
$$;

COMMENT ON FUNCTION ensure_snapshot_partitions(integer) IS
  'ADR 0001 §1/§5: create monthly availability_snapshot partitions ahead of now(). The '
  'scheduled job calls this and alarms if the furthest future partition is under 30 days out.';

-- …the default is a safety net, not the plan: rows landing there are an alarm, since
-- detaching a default partition later requires a full scan.
CREATE TABLE availability_snapshot_default
  PARTITION OF availability_snapshot DEFAULT;

-- Current month + the next two, so a fresh database accepts its first insert and a
-- month boundary crossed mid-deploy does not.
SELECT ensure_snapshot_partitions(3);
