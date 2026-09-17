import { describe, expect, it } from "vitest";

import { useDatabase, type Db } from "./support/pg.js";

/**
 * Runs a seed + function call as one multi-statement simple-protocol query and returns
 * the last statement's single row. The statements share one implicit transaction, so
 * now() is frozen across the seed INSERT and the function, and each statement takes its
 * own READ COMMITTED snapshot, so the function sees the seed rows. Reading the
 * multi-statement result array needs a raw connection — the Db.query wrapper collapses
 * to a single-result shape — hence db.connect() here.
 */
async function runSeedAndSelect<T>(db: Db, text: string): Promise<T> {
  const client = await db.connect();
  try {
    const results = (await client.query(text)) as unknown as { rows: T[] }[];
    return results.at(-1)!.rows[0]!;
  } finally {
    await client.end();
  }
}

/**
 * Tier 2 — S18 retention behavior (S18.2–S18.8), keyed to the spec's verification items:
 *   1. S18.3 drop_snapshot_partitions — strict 13-month boundary, DEFAULT protected, idempotent
 *   2. S18.4 drop_event_partitions — the same three assertions
 *   3. S18.5 the age-scoped DEFAULT deletes remove exactly the rows older than the window
 *   4. S18.5 the unconditional DEFAULT-presence checks fire the day a row lands, not N months later
 *   5. S18.6 maintain_partition_lookahead — alarm + rebuild
 *   6. S18.7 delete_expired_sessions — 30-day boundary, off-by-one both directions
 *   7. S18.8 delete_expired_searches — 90-day boundary + cost_event CASCADE + Finding F1
 *
 * House rules observed: state moves only through the functions under test; raw SQL here is
 * seed data, precondition (creating the dated partitions the drop functions then remove),
 * or cleanup of the seeds this file inserted. Every test ends with the invariant sweep the
 * harness runs in afterEach — seeded rows in the protected DEFAULT partitions are always
 * removed before the sweep (events_default_partition_empty fails on any row left there).
 *
 * Mechanics notes, recorded for the report:
 *   - Item 5: "drop the two furthest" partitions is date-flaky — the remaining current
 *     month's upper bound is within now() + 30 days only on the first days of a month, so
 *     the alarm would fire or not depending on the run date. This test drops ALL dated
 *     partitions of one family instead (max IS NULL ⇒ alarm unconditionally) — the
 *     determinism-preserving equivalent of the same precondition.
 *   - Exact-boundary assertions (29/30/31-day sessions; 90/91-day searches) run the seed
 *     INSERT and the function call as one multi-statement simple-protocol query
 *     (runSeedAndSelect): the statements share one implicit transaction, so now() is
 *     frozen across them and the off-by-one comparison is exact. (A data-modifying CTE in
 *     a single statement fails for a subtler reason: a plpgsql function's first command
 *     reuses the CALLING statement's snapshot, taken before the CTE ran, so the function
 *     cannot see same-statement CTE rows.)
 *   - Partition bounds take only literals, never bind parameters, so dated-partition
 *     preconditions are computed inside the database (a DO block).
 *   - Rows can only land in a DEFAULT partition when their timestamp falls in a month
 *     with no generated partition (the dated children cover current + 2 future months
 *     and reject everything else by constraint), so DEFAULT-row seeds use backdated or
 *     far-past timestamps — the realistic landing path, and what the alarm exists for.
 */

describe("tier 2 — retention enforcement", () => {
  const db = useDatabase();

  // ------------------------------------------------------------------ item 1: S18.3
  it("drop_snapshot_partitions(13) drops strictly-older months, retains the cutoff-boundary month, and never touches the DEFAULT", async () => {
    // Precondition (sanctioned): three dated partitions at 15/14/13 months back — with a
    // 13-month window, the 15-month partition's TO bound is strictly older, the 14-month
    // partition's TO bound sits exactly on the cutoff, and the 13-month partition is
    // inside the window.
    await db().query(
      `DO $do$
       DECLARE
         m record;
         v_name text;
       BEGIN
         FOR m IN
           SELECT months_ago,
                  date_trunc('month', now()) - (months_ago || ' months')::interval AS lo,
                  date_trunc('month', now()) - ((months_ago - 1) || ' months')::interval AS hi
           FROM unnest(ARRAY[15, 14, 13]) AS months_ago
         LOOP
           v_name := CASE m.months_ago
                       WHEN 15 THEN 'availability_snapshot_ret_dropped'
                       WHEN 14 THEN 'availability_snapshot_ret_cutoff'
                       WHEN 13 THEN 'availability_snapshot_ret_keep'
                     END;
           EXECUTE format('CREATE TABLE %I PARTITION OF availability_snapshot '
                          'FOR VALUES FROM (%L) TO (%L)', v_name, m.lo::date, m.hi::date);
         END LOOP;
       END
       $do$`,
    );

    const dropped = await db().one<{ drop_snapshot_partitions: number }>(
      `SELECT drop_snapshot_partitions(13)`,
    );
    expect(dropped.drop_snapshot_partitions).toBe(1);

    const survivors = await db().one<{
      dropped_gone: boolean;
      cutoff_kept: boolean;
      keep_kept: boolean;
      default_kept: boolean;
    }>(
      `SELECT
         to_regclass('availability_snapshot_ret_dropped') IS NULL  AS dropped_gone,
         to_regclass('availability_snapshot_ret_cutoff')  IS NOT NULL AS cutoff_kept,
         to_regclass('availability_snapshot_ret_keep')    IS NOT NULL AS keep_kept,
         to_regclass('availability_snapshot_default')     IS NOT NULL AS default_kept`,
    );
    expect(survivors).toEqual({
      dropped_gone: true,
      cutoff_kept: true,
      keep_kept: true,
      default_kept: true,
    });

    // The generated current + 2 future partitions are untouched.
    const generated = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM _dated_partitions('availability_snapshot')
       WHERE relname !~ '^availability_snapshot_ret_'`,
    );
    expect(generated.n).toBe(3);

    // Idempotent: a second call has nothing left in the window to drop.
    const again = await db().one<{ drop_snapshot_partitions: number }>(
      `SELECT drop_snapshot_partitions(13)`,
    );
    expect(again.drop_snapshot_partitions).toBe(0);
  });

  // ------------------------------------------------------------------ item 2: S18.4
  it("drop_event_partitions(13) holds the same boundary and never touches events_default", async () => {
    await db().query(
      `DO $do$
       DECLARE
         m record;
         v_name text;
       BEGIN
         FOR m IN
           SELECT months_ago,
                  date_trunc('month', now()) - (months_ago || ' months')::interval AS lo,
                  date_trunc('month', now()) - ((months_ago - 1) || ' months')::interval AS hi
           FROM unnest(ARRAY[15, 14, 13]) AS months_ago
         LOOP
           v_name := CASE m.months_ago
                       WHEN 15 THEN 'events_ret_dropped'
                       WHEN 14 THEN 'events_ret_cutoff'
                       WHEN 13 THEN 'events_ret_keep'
                     END;
           EXECUTE format('CREATE TABLE %I PARTITION OF events '
                          'FOR VALUES FROM (%L) TO (%L)', v_name, m.lo::date, m.hi::date);
         END LOOP;
       END
       $do$`,
    );

    const dropped = await db().one<{ drop_event_partitions: number }>(
      `SELECT drop_event_partitions(13)`,
    );
    expect(dropped.drop_event_partitions).toBe(1);

    const survivors = await db().one<{
      dropped_gone: boolean;
      cutoff_kept: boolean;
      keep_kept: boolean;
      default_kept: boolean;
    }>(
      `SELECT
         to_regclass('events_ret_dropped') IS NULL  AS dropped_gone,
         to_regclass('events_ret_cutoff')  IS NOT NULL AS cutoff_kept,
         to_regclass('events_ret_keep')    IS NOT NULL AS keep_kept,
         to_regclass('events_default')     IS NOT NULL AS default_kept`,
    );
    expect(survivors).toEqual({
      dropped_gone: true,
      cutoff_kept: true,
      keep_kept: true,
      default_kept: true,
    });

    const generated = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM _dated_partitions('events')
       WHERE relname !~ '^events_ret_'`,
    );
    expect(generated.n).toBe(3);

    const again = await db().one<{ drop_event_partitions: number }>(
      `SELECT drop_event_partitions(13)`,
    );
    expect(again.drop_event_partitions).toBe(0);
  });

  // ------------------------------------------------------------------ item 3: S18.5
  it("delete_expired_snapshot_default_rows removes exactly the rows older than the window", async () => {
    // Seed chain (tier0's raw-seed pattern): one fetch key/run/observation; two snapshot
    // rows sharing it. Both timestamps fall outside every dated partition (which cover
    // only the current and next two months), so they genuinely belong to the DEFAULT —
    // the 14-month row is outside the window, the keep row is one day inside it.
    await db().query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ('k_ret_snap','SHOWTIME_FETCH','amc','seat','st_ret_snap')`,
    );
    await db().query(
      `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
       VALUES ('r_ret_snap','k_ret_snap','o_ret_snap',0)`,
    );
    await db().query(
      `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
       VALUES ('o_ret_snap','k_ret_snap','r_ret_snap', now(), 1)`,
    );
    await db().query(
      `INSERT INTO availability_snapshot_default (observation_id, showtime_id, captured_at, bitmap, free_count)
       VALUES ('o_ret_snap','st_ret_snap', now() - interval '14 months', '\\x00', 0),
              ('o_ret_snap','st_ret_snap', now() - interval '13 months' + interval '1 day', '\\x00', 0)`,
    );
    const deleted = await db().one<{ delete_expired_snapshot_default_rows: number }>(
      `SELECT delete_expired_snapshot_default_rows(13)`,
    );
    expect(deleted.delete_expired_snapshot_default_rows).toBe(1);

    const remaining = await db().rows<{ within_window: boolean }>(
      `SELECT (captured_at > now() - interval '13 months') AS within_window
       FROM availability_snapshot_default`,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.within_window).toBe(true);

    // Cleanup (sanctioned): the keep row this test inserted must not leak into the sweep.
    await db().query(`DELETE FROM availability_snapshot_default`);
  });

  it("delete_expired_event_default_rows removes exactly the rows older than the window", async () => {
    await db().query(
      `INSERT INTO events_default (event_id, type, payload, created_at)
       VALUES ('ev_ret_old','retention-probe','{}'::jsonb, now() - interval '14 months'),
              ('ev_ret_keep','retention-probe','{}'::jsonb, now() - interval '13 months' + interval '1 day')`,
    );
    const deleted = await db().one<{ delete_expired_event_default_rows: number }>(
      `SELECT delete_expired_event_default_rows(13)`,
    );
    expect(deleted.delete_expired_event_default_rows).toBe(1);

    const remaining = await db().rows<{ event_id: string }>(`SELECT event_id FROM events_default`);
    expect(remaining).toEqual([{ event_id: "ev_ret_keep" }]);

    // Cleanup (sanctioned): the keep row must not leak into the sweep
    // (events_default_partition_empty).
    await db().query(`DELETE FROM events_default`);
  });

  // ------------------------------------------------------------------ item 4: S18.5
  it("the snapshot DEFAULT-presence check fires on the day a row lands, uncoupled from the age-scoped delete", async () => {
    await db().query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ('k_ret_alert','SHOWTIME_FETCH','amc','seat','st_ret_alert')`,
    );
    await db().query(
      `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
       VALUES ('r_ret_alert','k_ret_alert','o_ret_alert',0)`,
    );
    await db().query(
      `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
       VALUES ('o_ret_alert','k_ret_alert','r_ret_alert', now(), 1)`,
    );
    // A row lands in the DEFAULT when its timestamp falls in a month with no generated
    // partition — here a backfilled observation two months back, far younger than the
    // 13-month delete window, so the delete must leave it alone while the alert fires.
    await db().query(
      `INSERT INTO availability_snapshot_default (observation_id, showtime_id, captured_at, bitmap, free_count)
       VALUES ('o_ret_alert','st_ret_alert', now() - interval '2 months', '\\x00', 0)`,
    );

    // The workflow's verbatim check (ADR 0005 §F:436-440) — true the day the row lands.
    const onArrival = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM availability_snapshot_default LIMIT 1) AS present`,
    );
    expect(onArrival.present).toBe(true);

    // The age-scoped delete affects zero of these rows — the alert must not be tied to
    // the delete's count.
    const deleted = await db().one<{ delete_expired_snapshot_default_rows: number }>(
      `SELECT delete_expired_snapshot_default_rows(13)`,
    );
    expect(deleted.delete_expired_snapshot_default_rows).toBe(0);
    const stillPresent = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM availability_snapshot_default LIMIT 1) AS present`,
    );
    expect(stillPresent.present).toBe(true);

    // Cleanup (sanctioned): with the row gone, the check is false again.
    await db().query(`DELETE FROM availability_snapshot_default`);
    const cleared = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM availability_snapshot_default LIMIT 1) AS present`,
    );
    expect(cleared.present).toBe(false);
  });

  it("the events DEFAULT-presence check fires on the day a row lands, uncoupled from the age-scoped delete", async () => {
    // Same landing rule as the snapshot alert: the timestamp must fall in a month with no
    // generated partition, so a two-month-old row genuinely lands in the DEFAULT while
    // staying far younger than the 13-month delete window.
    await db().query(
      `INSERT INTO events_default (event_id, type, payload, created_at)
       VALUES ('ev_ret_alert','retention-probe','{}'::jsonb, now() - interval '2 months')`,
    );

    const onArrival = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM events_default LIMIT 1) AS present`,
    );
    expect(onArrival.present).toBe(true);

    const deleted = await db().one<{ delete_expired_event_default_rows: number }>(
      `SELECT delete_expired_event_default_rows(13)`,
    );
    expect(deleted.delete_expired_event_default_rows).toBe(0);
    const stillPresent = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM events_default LIMIT 1) AS present`,
    );
    expect(stillPresent.present).toBe(true);

    await db().query(`DELETE FROM events_default`);
    const cleared = await db().one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM events_default LIMIT 1) AS present`,
    );
    expect(cleared.present).toBe(false);
  });

  // ------------------------------------------------------------------ item 5: S18.6
  it("maintain_partition_lookahead alarms and rebuilds when a family loses its lookahead, and reports healthy otherwise", async () => {
    // Healthy first: both families were topped up by 002/003 (current + 2 future months).
    const healthy = await db().one<{ maintain_partition_lookahead: boolean }>(
      `SELECT maintain_partition_lookahead()`,
    );
    expect(healthy.maintain_partition_lookahead).toBe(true);

    for (const family of ["availability_snapshot", "events"]) {
      const shape = await db().one<{ n: number; lo: boolean; hi: boolean }>(
        `SELECT count(*)::int AS n,
                min(upper_bound) = date_trunc('month', now()) + interval '1 month' AS lo,
                max(upper_bound) = date_trunc('month', now()) + interval '3 months' AS hi
         FROM _dated_partitions('${family}')`,
      );
      expect(shape, family).toEqual({ n: 3, lo: true, hi: true });
    }

    // Precondition (sanctioned): remove every dated partition of the snapshot family.
    // See the header: the spec's "drop the two furthest" is date-flaky; an empty family
    // makes max(upper_bound) NULL and the alarm unconditional.
    await db().query(
      `DO $do$
       DECLARE
         r record;
       BEGIN
         FOR r IN SELECT relname FROM _dated_partitions('availability_snapshot') LOOP
           EXECUTE format('DROP TABLE %I', r.relname);
         END LOOP;
       END
       $do$`,
    );

    const alarmed = await db().one<{ maintain_partition_lookahead: boolean }>(
      `SELECT maintain_partition_lookahead()`,
    );
    expect(alarmed.maintain_partition_lookahead).toBe(false);

    // The same call recreated the lookahead (ensure runs before the function returns).
    const rebuilt = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM _dated_partitions('availability_snapshot')`,
    );
    expect(rebuilt.n).toBe(3);

    const healthyAgain = await db().one<{ maintain_partition_lookahead: boolean }>(
      `SELECT maintain_partition_lookahead()`,
    );
    expect(healthyAgain.maintain_partition_lookahead).toBe(true);
  });

  // ------------------------------------------------------------------ item 6: S18.7
  it("delete_expired_sessions(30) deletes strictly-older sessions; the boundary and the window-as-parameter both hold", async () => {
    const deleted = await runSeedAndSelect<{ delete_expired_sessions: number }>(
      db(),
      `INSERT INTO session (session_id, last_seen_at) VALUES
         ('sess_ret_29', now() - interval '29 days'),
         ('sess_ret_30', now() - interval '30 days'),
         ('sess_ret_31', now() - interval '31 days');
       SELECT delete_expired_sessions(30) AS delete_expired_sessions;`,
    );
    // Exactly the 31-day row: the 30-day row sits ON the boundary and is kept.
    expect(deleted.delete_expired_sessions).toBe(1);
    const remaining = await db().rows<{ session_id: string }>(
      `SELECT session_id FROM session ORDER BY session_id`,
    );
    expect(remaining.map((row) => row.session_id)).toEqual(["sess_ret_29", "sess_ret_30"]);

    // The window is a parameter: a 1-day window takes the remaining two.
    const tighter = await db().one<{ delete_expired_sessions: number }>(
      `SELECT delete_expired_sessions(1)`,
    );
    expect(tighter.delete_expired_sessions).toBe(2);
    const empty = await db().rows(`SELECT session_id FROM session`);
    expect(empty).toEqual([]);
  });

  // ------------------------------------------------------------------ item 7: S18.8
  it("delete_expired_searches(90) deletes strictly-older searches and keeps the boundary day", async () => {
    const deleted = await runSeedAndSelect<{ delete_expired_searches: number }>(
      db(),
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, deadline_at, created_at)
       VALUES ('search_ret_91','sess_ret_91','ik_ret_91','{}'::jsonb,'h', now(), now() - interval '91 days'),
              ('search_ret_90','sess_ret_90','ik_ret_90','{}'::jsonb,'h', now(), now() - interval '90 days');
       SELECT delete_expired_searches(90) AS delete_expired_searches;`,
    );
    expect(deleted.delete_expired_searches).toBe(1);
    const remaining = await db().rows<{ search_id: string }>(
      `SELECT search_id FROM search ORDER BY search_id`,
    );
    expect(remaining.map((row) => row.search_id)).toEqual(["search_ret_90"]);
  });

  it("a cost_event child CASCADEs with its expired search (S17's decided cascade)", async () => {
    await db().query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, deadline_at, created_at)
       VALUES ('search_ret_casc','sess_ret_casc','ik_ret_casc','{}'::jsonb,'h', now(), now() - interval '91 days')`,
    );
    await db().query(
      `INSERT INTO cost_event (event_id, event_type, search_id, units)
       VALUES ('ce_ret_casc','ADMISSION_RESERVATION','search_ret_casc',1)`,
    );
    const deleted = await db().one<{ delete_expired_searches: number }>(
      `SELECT delete_expired_searches(90)`,
    );
    expect(deleted.delete_expired_searches).toBe(1);

    const searchLeft = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM search WHERE search_id = 'search_ret_casc'`,
    );
    expect(searchLeft.n).toBe(0);
    const eventLeft = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM cost_event WHERE event_id = 'ce_ret_casc'`,
    );
    expect(eventLeft.n).toBe(0);
  });

  it("F1: the verbatim search DELETE raises FK violation 23503 against a search_event child — the falsifiable escalation record", async () => {
    // Seed in its own committed query so the failing delete below sees committed rows.
    await db().query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, deadline_at, created_at, next_seq)
       VALUES ('search_ret_fk','sess_ret_fk','ik_ret_fk','{}'::jsonb,'h', now(), now() - interval '91 days', 1);
       INSERT INTO search_event (search_id, seq, type, payload, created_at)
       VALUES ('search_ret_fk', 1, 'retention-probe', '{}'::jsonb, now() - interval '89 days')`,
    );

    // search_event references search with NO ON DELETE CASCADE (001_schema.sql:151-158),
    // one of the six tables Finding F1 names — the ADR's verbatim DELETE therefore raises
    // 23503 instead of silently orphaning or deleting the child. This test is the live
    // record of the finding: when the resolution lands (subtree delete or CASCADE), it
    // MUST be updated to assert successful, subtree-consistent deletion instead.
    await expect(db().query(`SELECT delete_expired_searches(90)`)).rejects.toMatchObject({
      code: "23503",
    });

    // Positive control: the violation — not the window, not a silent no-op — is what
    // stopped the delete; both rows survive intact.
    const searchSurvives = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM search WHERE search_id = 'search_ret_fk'`,
    );
    expect(searchSurvives.n).toBe(1);
    const eventSurvives = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM search_event WHERE search_id = 'search_ret_fk'`,
    );
    expect(eventSurvives.n).toBe(1);
  });
});
