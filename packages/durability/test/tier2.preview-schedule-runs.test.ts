import { expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { previewScheduleRuns } from "../src/transactions.js";

import {
  acceptSchedule,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  seedProvider,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";
import type { Db } from "./support/pg.js";

// Registers the per-test fresh database + afterEach invariant sweep (file scope —
// calling it inside a test body would be too late for beforeEach).
const db = useDatabase();

/**
 * Tier 2 — ADR 0039 Amendment A1: subscription-less capacity-preview schedule-resolution
 * runs (`stagePreviewScheduleRuns`) and their two proven properties:
 *
 * 1. Re-arm — `SWEEP_REARM_RUNS`' SCHEDULE_RESOLUTION-with-no-subscriptions branch
 *    recreates a lost/lost-interest outbox row for an aged PENDING preview run.
 * 2. Completion — a zero-subscriber RESOLVED run persists its B5C_PERFORMANCE snapshot and
 *    terminalizes through the ordinary acceptance composition.
 *
 * Every test ends with the full invariant sweep in `useDatabase()`, which includes
 * `preview_runs_never_stranded`. The explicit outbox DELETE below is precondition
 * simulation ("the outbox row was lost"), not a state transition — the same bucket as
 * fixtures.ts's `attempt = 5` write (CONTRIBUTING.md §2); there is deliberately no
 * boundary statement for losing an outbox row.
 */
function seedTheatre(db: Db, theatreId: string): void {
  // Seed data, not a boundary (fixtures.ts seedProvider precedent).
  void db.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Preview Theatre', 40.0, -74.0, 'UTC', now(), now())`,
    [theatreId, PROVIDER],
  );
}

const date = "2026-09-04";
const theatreId = `${PROVIDER}:theatre:preview`;

it("composition creates run_key/provider_run/outbox and zero search-side rows", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);

  const { createdRunIds } = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });

  expect(createdRunIds).toHaveLength(1);

  const runKey = await db().one<{ kind: string; theatre_id: string }>(
    `SELECT kind, theatre_id::text AS theatre_id FROM run_key WHERE run_key_id = $1`,
    [`k_sched_${PROVIDER}_${theatreId}_${date}`],
  );
  expect(runKey.kind).toBe("SCHEDULE_RESOLUTION");

  const run = await db().one<{ state: string }>(
    `SELECT state::text AS state FROM provider_run WHERE run_id = $1`,
    [createdRunIds[0]!],
  );
  expect(run.state).toBe("PENDING");

  const outbox = await db().rows<{ target_kind: string }>(
    `SELECT target_kind::text AS target_kind FROM outbox WHERE run_id = $1`,
    [createdRunIds[0]!],
  );
  expect(outbox).toEqual([{ target_kind: "RUN" }]);

  // The Amendment A1 guarantee: no durable search artifacts of any kind.
  const counts = await db().one<{ searches: number; jobs: number; subs: number; resv: number }>(
    `SELECT (SELECT count(*) FROM search)::int AS searches,
            (SELECT count(*) FROM search_job)::int AS jobs,
            (SELECT count(*) FROM run_subscription)::int AS subs,
            (SELECT count(*) FROM admission_reservation)::int AS resv`,
  );
  expect(counts).toEqual({ searches: 0, jobs: 0, subs: 0, resv: 0 });
});

it("a concurrent preview or search wins: second call creates nothing new", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);

  const first = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });
  const second = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });

  expect(second.createdRunIds).toEqual([]);
  const runs = await db().rows<{ run_id: string }>(
    `SELECT run_id FROM provider_run WHERE run_key_id = $1`,
    [`k_sched_${PROVIDER}_${theatreId}_${date}`],
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]!.run_id).toBe(first.createdRunIds[0]);
});

it("re-arm: SWEEP_REARM_RUNS recreates a deleted outbox row for an aged preview run", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);
  const { createdRunIds } = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });
  const runId = createdRunIds[0]!;

  // Precondition simulation: the outbox row was lost before the relay ever saw it.
  await db().query(`DELETE FROM outbox WHERE run_id = $1`, [runId]);
  // Time is data: age the run past the re-arm threshold instead of waiting.
  await db().query(
    `UPDATE provider_run SET created_at = now() - interval '1 hour' WHERE run_id = $1`,
    [runId],
  );

  const rearmed = await runQuery(db(), B.SWEEP_REARM_RUNS, ["30 minutes"]);
  expect(rearmed.rows).toHaveLength(1); // RETURNING outbox_id — exactly one re-arm

  const outbox = await db().rows<{ state: string }>(
    `SELECT state::text AS state FROM outbox WHERE run_id = $1`,
    [runId],
  );
  expect(outbox).toEqual([{ state: "PENDING" }]);
});

it("a SHOWTIME_FETCH key with expired subscriptions is still never re-armed", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);
  await mustWin(db(), B.RUN_KEY_UPSERT, [
    `k_fetch_${PROVIDER}_st_shown`,
    "SHOWTIME_FETCH",
    PROVIDER,
    "seat",
    `${PROVIDER}:showtime:shown`,
    null,
    null,
  ]);
  const runId = id("run");
  await mustWin(db(), B.RUN_CREATE, [runId, `k_fetch_${PROVIDER}_st_shown`, id("obs"), null]);
  await db().query(
    `UPDATE provider_run SET created_at = now() - interval '1 hour' WHERE run_id = $1`,
    [runId],
  );
  // Precondition simulation again: its outbox row is gone.
  await db().query(`DELETE FROM outbox WHERE run_id = $1`, [runId]);

  const rearmed = await runQuery(db(), B.SWEEP_REARM_RUNS, ["30 minutes"]);
  expect(rearmed.rows).toEqual([]);
});

it("completion: a zero-subscriber preview run resolves, persists the snapshot, terminalizes", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);
  const { createdRunIds } = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });
  const runId = createdRunIds[0]!;

  // Dispatch exactly as fixtures.dispatchRun does — lease + pre-dispatch fence.
  const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [runId, "00:05:00"]);
  await mustWin(db(), B.B4_PREDISPATCH, [runId, leased.generation]);

  await acceptSchedule(db(), { runId, generation: leased.generation }, [
    {
      showtimeId: `${PROVIDER}:showtime:p1`,
      movieId: `${PROVIDER}:movie:m1`,
      startsAt: new Date(`${date}T19:00:00.000Z`),
      skipFetch: false,
    },
    {
      showtimeId: `${PROVIDER}:showtime:p2`,
      movieId: `${PROVIDER}:movie:m1`,
      startsAt: new Date(`${date}T21:30:00.000Z`),
      skipFetch: true,
    },
  ]);

  // Snapshot persisted (both performances, including the skipFetch one).
  const perfs = await db().rows<{ showtime_id: string }>(
    `SELECT showtime_id FROM performance WHERE theatre_id = $1 AND local_date = $2 ORDER BY showtime_id`,
    [theatreId, date],
  );
  expect(perfs.map((p) => p.showtime_id)).toEqual([
    `${PROVIDER}:showtime:p1`,
    `${PROVIDER}:showtime:p2`,
  ]);

  // Run terminalized despite zero fan-in subscribers.
  const run = await db().one<{ state: string }>(
    `SELECT state::text AS state FROM provider_run WHERE run_id = $1`,
    [runId],
  );
  expect(["DONE", "EMPTY_RESOLVED"]).toContain(run.state);
});

it("invariant: a stranded preview run (no outbox row) is named by preview_runs_never_stranded", async () => {
  await seedProvider(db());
  seedTheatre(db(), theatreId);
  const { createdRunIds } = await previewScheduleRuns(db(), {
    providerId: PROVIDER,
    keys: [{ theatreId, localDate: date }],
  });
  // Precondition simulation: lose the outbox row before any dispatch/re-arm.
  await db().query(`DELETE FROM outbox WHERE run_id = $1`, [createdRunIds[0]!]);

  const violations = await db().rows<{ run_id: string }>(
    `SELECT r.run_id FROM provider_run r
     JOIN run_key k ON k.run_key_id = r.run_key_id
     WHERE k.kind = 'SCHEDULE_RESOLUTION'
       AND r.state = 'PENDING'
       AND NOT EXISTS (SELECT 1 FROM run_subscription rs WHERE rs.run_key_id = r.run_key_id)
       AND NOT EXISTS (SELECT 1 FROM outbox ob WHERE ob.run_id = r.run_id)`,
  );
  expect(violations.map((v) => v.run_id)).toEqual([createdRunIds[0]]);

  // Restore conservation before the afterEach invariant sweep: the re-arm duty is the
  // system's own repair for exactly this precondition.
  await runQuery(db(), B.SWEEP_REARM_RUNS, ["0 seconds"]);
});
