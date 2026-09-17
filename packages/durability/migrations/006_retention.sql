-- ADR 0005 §F — retention enforcement functions. The statements inside are the ADR's
-- decided SQL (docs/adr/0005-security-privacy-operations.md:393-537), parameterized
-- exactly as the ADR requires: every drop window and TTL figure is a caller-supplied
-- bound parameter, never an inlined literal — the 13/30/90 values live at the workflow
-- call site (.github/workflows/ops-retention.yml), not in this file. The 13-month
-- figures are ADR 0002 §3.2's table (docs/adr/0002-legal-data-use.md:460-471); the
-- 30-day session and 90-day search figures are ADR 0005 §F's decided values (:442-449,
-- :491-497).
--
-- Deliberate deviations from ADR 0005 §F's literal prose:
--   1. File numbering: the ADR assigns `session`, `cost_event`, and the `search` TTL job
--      to one shared `004_security_ops.sql` migration (:998-1001). The backlog split that
--      assignment into three independent tasks (docs/backlog.md:364-371), so the pieces
--      land in separate sequential files: S16 → 004_session.sql, S17 → 005_cost_ledger.sql,
--      S18 (this file) → 006_retention.sql. This file carries the retention functions only.
--   2. Function wrapping: the ADR names `drop_snapshot_partitions(older_than_months
--      integer)` as a function but leaves every other retention statement as bare SQL
--      (:422-427, :466, :513). Wrapping each bare statement as a named function is this
--      task's declared mechanism (docs/tasks/S18-retention-redaction/spec.md, S18.2-S18.8),
--      not a policy change: every DELETE below is the ADR's verbatim statement inside the
--      function body.
--   3. maintain_partition_lookahead() computes the 30-days-out alarm on the PRE-maintenance
--      partition state, then calls ensure_snapshot_partitions()/ensure_event_partitions()
--      and returns it. S18.6's prose says "calls ensure … then checks"; with ensure FIRST
--      the alarm is unreachable (ensure tops the family up to current + 2 future months,
--      whose upper bound is always > now() + 30 days), which would make the alarm dead
--      code — and S18's verification item 5 demands the call return false after the dated
--      partitions of a family are dropped, with the partitions recreated, which is only
--      satisfiable by alarm-first-then-ensure. The return happens after ensure, preserving
--      the spec's stated order of "ensure runs in this function".
--   4. Input guards: each function rejects a non-positive window with an exception,
--      mirroring ensure_snapshot_partitions()'s own guard (002_partitions.sql:21-23). The
--      ADR's verbatim statements have no guard; this is defensive (a negative window would
--      delete nothing or everything) and is not a policy change.
--   5. _dated_partitions(): a shared private helper extracts each child's range upper
--      bound so the drop/lookahead boundary predicate is defined once, not re-derived in
--      three functions. A child whose bound does not parse raises — a retention function
--      that silently stops dropping is worse than one that fails loudly.
--
-- Postgres 16. No COMMIT mid-file (docs/tasks/README.md:165-166); one multi-statement
-- transaction, applied by applyMigrations.

-- Every dated (range-bound) child of a partitioned parent, with its TO bound. A DEFAULT
-- child's bound renders as the literal string 'DEFAULT' and is excluded here, so the
-- protected DEFAULT partitions can never be dropped by the drop functions.
CREATE FUNCTION _dated_partitions(p_parent regclass)
RETURNS TABLE (relname text, upper_bound timestamptz)
LANGUAGE plpgsql
AS $$
DECLARE
  v_child record;
  v_match text[];
BEGIN
  FOR v_child IN
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = p_parent
      AND c.relispartition
      AND c.relpartbound IS NOT NULL
      AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
  LOOP
    -- A range child's bound renders as: FOR VALUES FROM ('YYYY-MM-DD 00:00:00+00')
    -- TO ('YYYY-MM-DD 00:00:00+00') — capture the TO instant.
    v_match := regexp_match(v_child.bound, $re$TO \('([^']+)'\)$re$);
    IF v_match IS NULL THEN
      RAISE EXCEPTION 'partition % of % has an unparsable range bound: %',
        v_child.relname, p_parent::text, v_child.bound;
    END IF;
    RETURN QUERY SELECT v_child.relname::text, v_match[1]::timestamptz;
  END LOOP;
END;
$$;
COMMENT ON FUNCTION _dated_partitions(regclass) IS
  'S18 helper: the dated (non-DEFAULT) children of a partitioned parent with each range '
  'TO bound. DEFAULT children render as ''DEFAULT'' and are excluded by construction.';

-- ADR 0005 §F (:402): drop availability_snapshot month partitions older than the caller
-- window. The boundary is strict: a partition whose TO bound sits exactly at
-- date_trunc(now) - N months is retained — a row younger than the window must never be
-- droppable (S18.2).
CREATE FUNCTION drop_snapshot_partitions(older_than_months integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_part    record;
  v_dropped integer := 0;
BEGIN
  IF older_than_months < 1 THEN
    RAISE EXCEPTION 'older_than_months must be >= 1, got %', older_than_months;
  END IF;

  v_cutoff := date_trunc('month', now()) - (older_than_months || ' months')::interval;

  FOR v_part IN SELECT relname, upper_bound FROM _dated_partitions('availability_snapshot') LOOP
    IF v_part.upper_bound < v_cutoff THEN
      EXECUTE format('DROP TABLE %I', v_part.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$$;

COMMENT ON FUNCTION drop_snapshot_partitions(integer) IS
  'ADR 0005 §F: drop availability_snapshot month partitions whose range upper bound is '
  'strictly older than date_trunc of now() minus the caller-supplied window. Never drops '
  'availability_snapshot_default.';

-- ADR 0005 §F: the same boundary for first-party events.
CREATE FUNCTION drop_event_partitions(older_than_months integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_part    record;
  v_dropped integer := 0;
BEGIN
  IF older_than_months < 1 THEN
    RAISE EXCEPTION 'older_than_months must be >= 1, got %', older_than_months;
  END IF;

  v_cutoff := date_trunc('month', now()) - (older_than_months || ' months')::interval;

  FOR v_part IN SELECT relname, upper_bound FROM _dated_partitions('events') LOOP
    IF v_part.upper_bound < v_cutoff THEN
      EXECUTE format('DROP TABLE %I', v_part.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$$;

COMMENT ON FUNCTION drop_event_partitions(integer) IS
  'ADR 0005 §F: drop events month partitions whose range upper bound is strictly older '
  'than date_trunc of now() minus the caller-supplied window. Never drops events_default.';

-- ADR 0005 §F (:408-440): the DEFAULT partitions are a safety net, not storage — rows
-- that land there are an alarm the workflow reads (presence checks), and the age-scoped
-- delete below prevents accumulation. The DELETE is the ADR's verbatim statement.
CREATE FUNCTION delete_expired_snapshot_default_rows(older_than_months integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF older_than_months < 1 THEN
    RAISE EXCEPTION 'older_than_months must be >= 1, got %', older_than_months;
  END IF;

  DELETE FROM availability_snapshot_default
    WHERE captured_at < now() - (older_than_months || ' months')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION delete_expired_snapshot_default_rows(integer) IS
  'ADR 0005 §F: age-scoped delete for the safety-net DEFAULT partition. The unconditional '
  'presence check stays the workflow''s verbatim SELECT EXISTS (S18.9), never this function.';

-- ADR 0005 §F: the same delete for first-party events.
CREATE FUNCTION delete_expired_event_default_rows(older_than_months integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF older_than_months < 1 THEN
    RAISE EXCEPTION 'older_than_months must be >= 1, got %', older_than_months;
  END IF;

  DELETE FROM events_default
    WHERE created_at < now() - (older_than_months || ' months')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION delete_expired_event_default_rows(integer) IS
  'ADR 0005 §F: age-scoped delete for the safety-net DEFAULT partition. The unconditional '
  'presence check stays the workflow''s verbatim SELECT EXISTS (S18.9), never this function.';

-- ADR 0001 §1/§5: "a scheduled job creates months ahead and alarms if the furthest future
-- partition is under 30 days out" (docs/adr/0001-durability-search-lifecycle.md:431-433).
-- Returns false when either family needs attention, after running both ensures — see
-- header deviation 3 for why the alarm is computed on the pre-maintenance state.
CREATE FUNCTION maintain_partition_lookahead()
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_alarm_at timestamptz := now() + interval '30 days';
  v_max      timestamptz;
  v_alarm    boolean := false;
BEGIN
  SELECT max(upper_bound) INTO v_max FROM _dated_partitions('availability_snapshot');
  IF v_max IS NULL OR v_max < v_alarm_at THEN
    v_alarm := true;
  END IF;

  SELECT max(upper_bound) INTO v_max FROM _dated_partitions('events');
  IF v_max IS NULL OR v_max < v_alarm_at THEN
    v_alarm := true;
  END IF;

  PERFORM ensure_snapshot_partitions();
  PERFORM ensure_event_partitions();

  RETURN NOT v_alarm;
END;
$$;

COMMENT ON FUNCTION maintain_partition_lookahead() IS
  'ADR 0001 §1/§5: alarm when either family has no dated partition at least 30 days out, '
  'then ensure current + 2 future months in both families. False means the caller (the '
  'scheduled workflow) must fail the job.';

-- ADR 0005 §F (:442-449, :463-466): the decided session window is 30 days. The DELETE is
-- the ADR's verbatim statement with the window as a bound parameter.
CREATE FUNCTION delete_expired_sessions(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days < 1 THEN
    RAISE EXCEPTION 'p_retention_days must be >= 1, got %', p_retention_days;
  END IF;

  DELETE FROM session
    WHERE last_seen_at < now() - (p_retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION delete_expired_sessions(integer) IS
  'ADR 0005 §F: delete sessions whose last_seen_at is strictly older than the '
  'caller-supplied window (the decided figure is 30 days, at the workflow call site).';

-- ADR 0005 §F (:491-497, :513): the decided search window is 90 days. The DELETE is the
-- ADR's verbatim statement with the window as a bound parameter — deliberately nothing
-- else. Finding F1 (docs/tasks/S18-retention-redaction/spec.md, S18.8): six child tables
-- reference `search` without ON DELETE CASCADE, so this DELETE raises an FK violation
-- (SQLSTATE 23503) against any search with such children. The resolution mechanism is
-- undecided (a dependency-ordered subtree delete, or adding CASCADE) and therefore NOT
-- invented here: until it resolves, a retention run against a home database holding such
-- children fails loudly under ON_ERROR_STOP — that failure is the escalation's alert
-- surface, deliberately never papered over.
CREATE FUNCTION delete_expired_searches(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days < 1 THEN
    RAISE EXCEPTION 'p_retention_days must be >= 1, got %', p_retention_days;
  END IF;

  DELETE FROM search
    WHERE created_at < now() - (p_retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION delete_expired_searches(integer) IS
  'ADR 0005 §F: delete searches whose created_at is strictly older than the '
  'caller-supplied window (the decided figure is 90 days, at the workflow call site). '
  'Verbatim DELETE — see the Finding F1 note in this file''s header for the escalated '
  'FK-violation gap and its deliberate fail-loud posture.';

-- S18 lands the retention policy that 003_catalog.sql:99-101 left gate-blocked; refresh
-- the stale comment so the catalog no longer claims the policy is undecided.
COMMENT ON FUNCTION ensure_event_partitions(integer) IS
  'Create monthly first-party event partitions ahead of now(); the drop/retention side '
  'lives in drop_event_partitions()/delete_expired_event_default_rows() (006_retention.sql, '
  'ADR 0005 §F) and runs from the scheduled retention workflow.';
