import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { markOutboxPublished } from "../src/repository.js";
import {
  cancelOrphanedWorkOnDenial,
  sweepFailExhaustedJobs,
  sweepFailExhaustedRuns,
} from "../src/transactions.js";

import {
  acceptFetch,
  acceptSchedule,
  createSearch,
  dispatchRun,
  expireSubscriptionDeadline,
  failRun,
  fetchKey,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  scheduleKey,
  seedProvider,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the effects are non-zero, and they are the counts the boundary claims.
 *
 * This is the tier that catches the expensive class of bug: a statement that parses, runs,
 * commits, and touches nothing. R4#1 (duplicate application → empty `RETURNING` → every
 * fan-in effect zero) and R5#1 (`admission_reservation` never inserted) both survived four
 * and five review rounds respectively while being one row count away from obvious.
 *
 * Every test here ends with the invariant sweep in `useDatabase()`.
 */

const admission = (db: ReturnType<typeof useDatabase>) => async () =>
  db().one<{ pending_cost: string; unresolved_schedules: number }>(
    `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
    [PROVIDER],
  );

describe("tier 2 — B1 create", () => {
  const db = useDatabase();
  const caps = admission(db);

  it("a cold create leaves an admission_reservation row behind (R5#1, T30)", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1, { reserve: 10 });
    // B1 writes the schedule job + subscription in the same transaction; the per-key
    // slot it carries is what B6 later reconciles and B8 releases.
    await subscribe(db(), search, await scheduleKey(db(), "theatre_1", "2026-08-02"));

    const r = await db().one(`SELECT * FROM admission_reservation WHERE search_id = $1`, [
      search.searchId,
    ]);
    expect(r.reserved_total).toBe("10");
    expect(r.reserved_remaining).toBe("10");
    expect((await caps()).pending_cost).toBe("10");
    expect((await caps()).unresolved_schedules).toBe(1);
  });

  it("the same key with the same spec does not create a second search; a different spec is a 409", async () => {
    await seedProvider(db());
    const first = await createSearch(db(), 0, {
      sessionId: "sess_1",
      idempotencyKey: "idem_1",
      specHash: "hash_a",
    });

    const retry = await runQuery(db(), B.B1_CREATE_SEARCH, [
      id("srch"),
      "sess_1",
      "idem_1",
      JSON.stringify({ v: 1 }),
      "hash_a",
      first.deadlineAt.toISOString(),
    ]);
    expect(retry.rows).toHaveLength(0); // → read the existing row and compare spec_hash

    const existing = await db().one<{ search_id: string; spec_hash: string }>(
      `SELECT search_id, spec_hash FROM search WHERE session_id = $1 AND idempotency_key = $2`,
      ["sess_1", "idem_1"],
    );
    expect(existing.search_id).toBe(first.searchId);
    // same hash → return the existing search; different hash → 409, and either way exactly
    // one search, one reservation, no second cost (T2b)
    expect(existing.spec_hash).toBe("hash_a");
    const count = await db().one<{ n: string }>(`SELECT count(*) AS n FROM search`);
    expect(count.n).toBe("1");
  });

  it("stage 1 denies over the limit before any quota is spent", async () => {
    await seedProvider(db(), { pendingCostLimit: 5 });
    await createSearch(db(), 0, { reserve: 5 });

    const denied = await runQuery(db(), B.B1_STAGE1_ADMISSION, [PROVIDER, 1, 0, "srch_denied", 0]);
    expect(denied.rows).toHaveLength(0);
    expect((await caps()).pending_cost).toBe("5");
  });
});

describe("tier 2 — B2/B3/B4 lease, heartbeat, dispatch", () => {
  const db = useDatabase();

  it("a second delivery of the same run claims nothing (T3)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const run = await dispatchRun(db(), key);

    const second = await runQuery(db(), B.B2_LEASE_RUN, [run.runId, "5 minutes"]);
    expect(second.rows).toHaveLength(0);
  });

  it("a heartbeat under a stale generation loses; under the live one it wins", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const run = await dispatchRun(db(), key);

    const stale = await runQuery(db(), B.B3_HEARTBEAT_RUN, [
      run.runId,
      run.generation - 1,
      "5 minutes",
    ]);
    expect(stale.rows).toHaveLength(0);

    const live = await runQuery(db(), B.B3_HEARTBEAT_RUN, [run.runId, run.generation, "5 minutes"]);
    expect(live.rows).toHaveLength(1);
  });

  it("B4 refreshes a stale epoch instead of stranding the run (R4#5, T28)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);

    // pause → reopen while the run sits PENDING. B9 bumps generations for LEASED rows only,
    // so without B4's refresh this run would carry epoch 0 forever and never accept.
    await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "PAUSED", "RATE_LIMITED", null]);
    await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "OPEN", null, null]);

    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);
    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      runId,
      leased.generation,
    ]);
    expect(dispatched.provider_epoch).toBe("2");
  });

  it("B4 refuses to dispatch into a halted scope, including one whose status row did not exist (T38)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);

    await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "HALTED", "BLOCKED", null]);

    const blocked = await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation]);
    expect(blocked.rows).toHaveLength(0);
  });

  it("PAUSED with a FUTURE not_before actually blocks B4/B5(b), and self-expires once it passes (defect 3)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);

    const fence = await mustWin<{ epoch: string }>(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    const notBefore = new Date(Date.now() + 60 * 60_000).toISOString(); // an hour out
    await mustWin(db(), B.B9_UPSERT_STATUS, [
      PROVIDER,
      "seat",
      "PAUSED",
      "RATE_LIMITED",
      notBefore,
    ]);

    // The amended predicate blocks on a NULL deadline too (an indefinite pause, S5.4), so
    // this test uses the SELF-EXPIRING shape: a concrete future not_before must stop
    // dispatch, then expire and let it resume without operator action.
    const blockedDispatch = await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation]);
    expect(blockedDispatch.rows).toHaveLength(0);

    // and must actually stop acceptance at the epoch fence (B5(b)) too
    const blockedAccept = await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, fence.epoch, "seat"]);
    expect(blockedAccept.rows).toHaveLength(0);

    // time is data: self-expire the pause by writing not_before into the past, never by
    // waiting (the ADR's "PAUSED past not_before resumes without operator action")
    await db().query(
      `UPDATE provider_status SET not_before = now() - interval '1 second'
       WHERE provider_id = $1 AND route_class = $2`,
      [PROVIDER, "seat"],
    );

    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      runId,
      leased.generation,
    ]);
    expect(dispatched.provider_epoch).toBe(fence.epoch);

    const accepted = await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, fence.epoch, "seat"]);
    expect(accepted.rows).toHaveLength(1);
  });
});

describe("tier 2 — RUN_DEFER_BUSY semaphore-busy defer", () => {
  const db = useDatabase();

  it("a busy loser returns to PENDING, preserves its next real attempt, and mints exactly one fresh outbox row", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_defer_busy");
    const run = await dispatchRun(db(), key); // LEASED; B2 bumped generation and attempt once
    const before = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1::text`,
      [run.runId],
    );

    const deferred = await mustWin<{ outbox_id: string }>(db(), B.RUN_DEFER_BUSY, [
      run.runId,
      run.generation,
    ]);

    // The fenced transition: back to PENDING, lease cleared, generation preserved, and
    // B2's unused attempt returned to the budget because no navigation was attempted.
    const row = await db().one<{
      state: string;
      generation: number;
      attempt: number;
      lease_expires_at: string | null;
    }>(
      `SELECT state, generation, attempt, lease_expires_at
       FROM provider_run WHERE run_id = $1::text`,
      [run.runId],
    );
    expect(row.state).toBe("PENDING");
    expect(row.generation).toBe(run.generation);
    expect(row.attempt).toBe(0);
    expect(row.lease_expires_at).toBeNull();

    // Exactly ONE new outbox row: the replacement delivery — RUN-targeted, pending,
    // NULL traceparent (the defer happens off the request path).
    const minted = await db().one<{
      run_id: string;
      target_kind: string;
      state: string;
      traceparent: string | null;
    }>(`SELECT run_id, target_kind, state, traceparent FROM outbox WHERE outbox_id = $1::text`, [
      deferred.outbox_id,
    ]);
    expect(minted.run_id).toBe(run.runId);
    expect(minted.target_kind).toBe("RUN");
    expect(minted.state).toBe("PENDING");
    expect(minted.traceparent).toBeNull();
    const after = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1::text`,
      [run.runId],
    );
    expect(Number(after.n)).toBe(Number(before.n) + 1);

    // Immediately durably redrivable: B2 leases the deferred run again under the next
    // generation, while restoring the same attempt number for the real navigation.
    const releasable = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      run.runId,
      "5 minutes",
    ]);
    expect(releasable.generation).toBe(run.generation + 1);
    // And now the defunct delivery's defer handle loses: a run that has already moved
    // on must not be resurrected by a stale busy delivery.
    const stale = await runQuery(db(), B.RUN_DEFER_BUSY, [run.runId, run.generation]);
    expect(stale.rows).toHaveLength(0);
  });

  it("a stale generation defers nothing and writes nothing", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_defer_stale");
    const run = await dispatchRun(db(), key);

    const lost = await runQuery(db(), B.RUN_DEFER_BUSY, [run.runId, run.generation - 1]);
    expect(lost.rows).toHaveLength(0);

    // Untouched: the live holder keeps both its state and its lease, and no duplicate
    // delivery was minted behind its back.
    const row = await db().one<{ state: string; lease_expires_at: string | null }>(
      `SELECT state, lease_expires_at FROM provider_run WHERE run_id = $1::text`,
      [run.runId],
    );
    expect(row.state).toBe("LEASED");
    expect(row.lease_expires_at).not.toBeNull();
    const count = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1::text`,
      [run.runId],
    );
    expect(count.n).toBe("1"); // only dispatchRun's original delivery row
  });

  it("a run that is not LEASED defers nothing (an already-queued PENDING run is left alone)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_defer_pending");
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]); // PENDING, never leased

    const lost = await runQuery(db(), B.RUN_DEFER_BUSY, [runId, 0]);
    expect(lost.rows).toHaveLength(0);
    const count = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1::text`,
      [runId],
    );
    expect(count.n).toBe("0"); // no duplicate delivery minted for a queued run
  });
});

describe("tier 2 — B5 acceptance fan-in", () => {
  const db = useDatabase();
  const caps = admission(db);

  it("N live subscribers produce exactly N applications, N job completions, N events, N releases (T25)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const searches = [];
    for (let i = 0; i < 3; i++) {
      const s = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), s, key);
      searches.push(s);
    }
    expect((await caps()).pending_cost).toBe("3");

    const run = await dispatchRun(db(), key);
    const { fannedIn } = await acceptFetch(db(), run);

    expect(fannedIn).toHaveLength(3);

    const counts = await db().one(
      `SELECT (SELECT count(*) FROM run_application WHERE run_id = $1) AS applications,
              (SELECT count(*) FROM search_job WHERE state = 'DONE') AS done_jobs,
              (SELECT count(*) FROM search_event WHERE type = 'FETCH_ACCEPTED') AS events,
              (SELECT count(*) FROM run_subscription WHERE state = 'SATISFIED') AS satisfied`,
      [run.runId],
    );
    expect(counts).toEqual({
      applications: "3",
      done_jobs: "3",
      events: "3",
      satisfied: "3",
    });
    // fetch capacity released once per satisfied subscriber, never twice
    expect((await caps()).pending_cost).toBe("0");
    for (const s of searches) {
      const r = await db().one(
        `SELECT reserved_remaining FROM admission_reservation WHERE search_id = $1`,
        [s.searchId],
      );
      expect(r.reserved_remaining).toBe("0");
    }
  });

  it("every seq allocated has its event: the fan-in cannot burn a sequence number (R5#3, T34)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const s = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), s, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);

    const row = await db().one(
      `SELECT s.next_seq, (SELECT count(*) FROM search_event e WHERE e.search_id = s.search_id) AS events
       FROM search s WHERE s.search_id = $1`,
      [s.searchId],
    );
    expect(row.events).toBe(row.next_seq);
  });

  it("a subscriber past its own deadline is excluded, and the run still applies to the others (T17)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const live = await createSearch(db(), 0, { reserve: 1 });
    const expired = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), live, key);
    await subscribe(db(), expired, key);
    await expireSubscriptionDeadline(db(), key.runKeyId, expired.searchId);

    const run = await dispatchRun(db(), key);
    const { fannedIn } = await acceptFetch(db(), run);

    expect(fannedIn.map((r) => r.search_id)).toEqual([live.searchId]);
    // the excluded subscriber is charged nothing and told nothing
    const events = await db().rows(`SELECT search_id FROM search_event WHERE search_id = $1`, [
      expired.searchId,
    ]);
    expect(events).toEqual([]);
  });

  it("a re-delivered run applies nobody twice (T6b)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const s = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), s, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);

    const replay = await runQuery(db(), B.B5_FANIN, [
      key.runKeyId,
      run.runId,
      PROVIDER,
      "SHOWTIME_FETCH",
      JSON.stringify({}),
    ]);
    expect(replay.rows).toHaveLength(0);
    const applications = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_application WHERE run_id = $1`,
      [run.runId],
    );
    expect(applications.n).toBe("1");
  });

  it("the fence rejects a zombie write-back in toto (T4)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const s = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), s, key);
    const run = await dispatchRun(db(), key);

    // the lease was reclaimed and the generation moved on
    await db().query(`UPDATE provider_run SET generation = generation + 1 WHERE run_id = $1`, [
      run.runId,
    ]);
    const zombie = await runQuery(db(), B.B5A_FENCE, [run.runId, run.generation]);
    expect(zombie.rows).toHaveLength(0);
    const applied = await db().rows(`SELECT * FROM run_application`);
    expect(applied).toEqual([]);
  });

  it("the epoch fence rejects an observation from before a halt (T12, T12b)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const run = await dispatchRun(db(), key);

    // route-class halt: the provider-wide fence bumps, so a numerically equal per-scope
    // epoch cannot mask it
    await mustWin(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "seat", "HALTED", "BLOCKED", null]);

    const fence = await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, run.epoch, "seat"]);
    expect(fence.rows).toHaveLength(0);
  });
});

describe("tier 2 — B5(c) auditorium layout persistence", () => {
  const db = useDatabase();

  // Opaque bytes as far as durability is concerned — stored and read back verbatim.
  const geometryA = Buffer.from(
    JSON.stringify([
      1,
      2,
      3,
      [1, 1, 1, 1, 1, 1],
      [null, null, null, null, null, null],
      [0, 0, 0],
      [],
    ]),
  );
  const geometryB = Buffer.from(
    JSON.stringify([9, 8, 7, [0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [5, 5, 5], []]),
  );
  const layoutA = { layoutId: "amc:layout:test_a", geometry: geometryA, rows: 2, columns: 3 };
  const layoutB = { layoutId: "amc:layout:test_b", geometry: geometryB, rows: 3, columns: 3 };

  it("acceptance persists the layout, points performance at it, replays idempotently, never mutates an earlier layout", async () => {
    await seedProvider(db());
    // Schedule-acceptance precedence: the performance row must exist before a
    // SHOWTIME_FETCH acceptance can name a layout for its showtime (B5C_PERFORMANCE_LAYOUT).
    const sched = await scheduleKey(db(), "theatre_layout_1", "2026-08-04");
    await acceptSchedule(db(), await dispatchRun(db(), sched), [
      {
        showtimeId: "st_layout_1",
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      },
    ]);

    const key = await fetchKey(db(), "st_layout_1");
    await acceptFetch(db(), await dispatchRun(db(), key), { layout: layoutA });

    const stored = await db().one<{ geometry: Buffer }>(
      `SELECT geometry FROM auditorium_layout WHERE layout_id = $1`,
      [layoutA.layoutId],
    );
    expect(stored.geometry).toEqual(geometryA);
    expect(
      (
        await db().one<{ layout_id: string }>(
          `SELECT layout_id FROM performance WHERE showtime_id = $1`,
          ["st_layout_1"],
        )
      ).layout_id,
    ).toBe(layoutA.layoutId);

    // A later delivery of the same key re-states the identical layout: ON CONFLICT DO
    // NOTHING is the expected non-fatal path — no error, still exactly one layout row.
    await acceptFetch(db(), await dispatchRun(db(), key), { layout: layoutA });
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM auditorium_layout`)).n).toBe(
      "1",
    );

    // A newer observation resolves the auditorium differently: a second layout row appears,
    // performance moves to it, and the first layout's bytes are never rewritten.
    await acceptFetch(db(), await dispatchRun(db(), key), { layout: layoutB });
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM auditorium_layout`)).n).toBe(
      "2",
    );
    expect(
      (
        await db().one<{ layout_id: string }>(
          `SELECT layout_id FROM performance WHERE showtime_id = $1`,
          ["st_layout_1"],
        )
      ).layout_id,
    ).toBe(layoutB.layoutId);
    expect(
      (
        await db().one<{ geometry: Buffer }>(
          `SELECT geometry FROM auditorium_layout WHERE layout_id = $1`,
          [layoutA.layoutId],
        )
      ).geometry,
    ).toEqual(geometryA);
  });
});

describe("tier 2 — B5 schedule branch and B6 expansion", () => {
  const db = useDatabase();
  const caps = admission(db);

  it("a schedule acceptance writes performance rows, not snapshots, and expands (T12d)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 4 });
    await subscribe(db(), search, key);

    const run = await dispatchRun(db(), key);
    const result = await acceptSchedule(db(), run, [
      { showtimeId: "st_a", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
      { showtimeId: "st_b", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
      { showtimeId: "st_c", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
      { showtimeId: "st_d", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
    ]);

    expect(result.expandedFor).toEqual([search.searchId]);
    const counts = await db().one(
      `SELECT (SELECT count(*) FROM performance) AS performances,
              (SELECT count(*) FROM availability_snapshot) AS snapshots,
              (SELECT count(*) FROM search_job WHERE kind = 'SHOWTIME_FETCH') AS fetch_jobs,
              (SELECT count(*) FROM run_subscription WHERE state = 'LIVE') AS live_subs,
              (SELECT count(*) FROM outbox WHERE target_kind = 'JOB') AS job_outbox`,
    );
    expect(counts).toEqual({
      performances: "4",
      snapshots: "0",
      fetch_jobs: "4",
      live_subs: "4",
      job_outbox: "5", // the schedule job + four fetch jobs
    });

    const s = await db().one(`SELECT status FROM search WHERE search_id = $1`, [search.searchId]);
    expect(s.status).toBe("RUNNING");
  });

  it("a schedule application moves no fetch capacity (R4#3, T27)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 2 });
    await subscribe(db(), search, key);

    const run = await dispatchRun(db(), key);
    // stage1Share = 2 and the real count is 2, so stage 2 is a no-op delta; anything that
    // moves is B5(f) releasing fetch capacity for a schedule, which it must not do
    await acceptSchedule(db(), run, [
      { showtimeId: "st_a", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
      { showtimeId: "st_b", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
    ]);

    expect((await caps()).pending_cost).toBe("2");
    const r = await db().one(
      `SELECT reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [search.searchId],
    );
    expect(r.reserved_remaining).toBe("2");
  });

  it("reserving 10 and reconciling to 4 drops pending_cost by exactly 6 (R5#2, T31)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 10 });
    await subscribe(db(), search, key);
    expect((await caps()).pending_cost).toBe("10");

    const run = await dispatchRun(db(), key);
    await acceptSchedule(
      db(),
      run,
      ["a", "b", "c", "d"].map((x) => ({
        showtimeId: `st_${x}`,
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      })),
      { stage1Share: 10 },
    );

    // `RETURNING` observes the UPDATED row: computing the delta inside the updating CTE
    // yields a constant zero and leaks the difference permanently.
    expect((await caps()).pending_cost).toBe("4");
    expect((await caps()).unresolved_schedules).toBe(0);
    const r = await db().one(
      `SELECT reserved_total, reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [search.searchId],
    );
    expect(r.reserved_total).toBe("4");
    expect(r.reserved_remaining).toBe("4");
  });

  it("policy-skipped showtimes expand no fetch work and reserve no capacity (ADR 0009)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 4 });
    await subscribe(db(), search, key);
    expect((await caps()).pending_cost).toBe("4");

    const run = await dispatchRun(db(), key);
    const result = await acceptSchedule(
      db(),
      run,
      [
        {
          showtimeId: "st_keep_a",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
        {
          showtimeId: "st_skip_b",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: true,
        },
        {
          showtimeId: "st_keep_c",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
        {
          showtimeId: "st_skip_d",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: true,
        },
      ],
      { stage1Share: 4 },
    );
    expect(result.expandedFor).toEqual([search.searchId]);

    // B5C_PERFORMANCE is unconditional: every showtime, skipped or not, gets its row.
    const counts = await db().one(
      `SELECT (SELECT count(*) FROM performance) AS performances,
              (SELECT count(*) FROM run_key WHERE kind = 'SHOWTIME_FETCH') AS fetch_keys,
              (SELECT count(*) FROM search_job WHERE kind = 'SHOWTIME_FETCH') AS fetch_jobs,
              (SELECT count(*) FROM run_subscription WHERE state = 'LIVE') AS live_subs,
              (SELECT count(*) FROM outbox WHERE target_kind = 'JOB') AS job_outbox`,
    );
    expect(counts).toEqual({
      performances: "4",
      fetch_keys: "2",
      fetch_jobs: "2",
      live_subs: "2",
      job_outbox: "3", // the schedule job + the two non-skipped fetch jobs
    });

    // The skipped showtimes have no fetch-key row at all — not merely no job.
    const skippedKeys = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_key WHERE showtime_id IN ('st_skip_b', 'st_skip_d')`,
    );
    expect(skippedKeys.n).toBe("0");

    // Capacity reconciles against the two real showtimes, not the four reported ones:
    // reserving for skipped showtimes would leak cost no B5_FANIN cap release can return
    // (ADR 0009).
    expect((await caps()).pending_cost).toBe("2");
    const r = await db().one(
      `SELECT reserved_total, reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [search.searchId],
    );
    expect(r.reserved_total).toBe("2");
    expect(r.reserved_remaining).toBe("2");
    expect((await caps()).unresolved_schedules).toBe(0);
  });

  it("an unobtainable shortfall persists the denial rather than silently leaking (T26)", async () => {
    await seedProvider(db(), { pendingCostLimit: 6 });
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 2 });
    await subscribe(db(), search, key);

    const run = await dispatchRun(db(), key);
    await acceptSchedule(
      db(),
      run,
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({
        showtimeId: `st_${x}`,
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      })),
      { stage1Share: 2 },
    );

    const s = await db().one(
      `SELECT capacity_denied_at, agg_requested_rev FROM search WHERE search_id = $1`,
      [search.searchId],
    );
    expect(s.capacity_denied_at).not.toBeNull();
    expect(Number(s.agg_requested_rev)).toBeGreaterThan(0);
  });

  it("cancel-on-denial leaves no PENDING jobs and no unpublished outbox rows for the denied search (defect 2)", async () => {
    await seedProvider(db(), { pendingCostLimit: 6 });
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 2 });
    await subscribe(db(), search, key);

    const run = await dispatchRun(db(), key);
    await acceptSchedule(
      db(),
      run,
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({
        showtimeId: `st_${x}`,
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      })),
      { stage1Share: 2 },
    );

    const s = await db().one<{ capacity_denied_at: Date | null }>(
      `SELECT capacity_denied_at FROM search WHERE search_id = $1`,
      [search.searchId],
    );
    expect(s.capacity_denied_at).not.toBeNull();

    // The S36 cumulative gate denies before it creates SHOWTIME_FETCH work. The
    // SCHEDULE_RESOLUTION job was already DONE through B5_FANIN.
    const jobs = await db().rows<{ state: string; kind: string }>(
      `SELECT state, kind FROM search_job WHERE search_id = $1`,
      [search.searchId],
    );
    expect(jobs.filter((j) => j.kind === "SHOWTIME_FETCH")).toHaveLength(0);
    expect(jobs.filter((j) => j.state === "PENDING" || j.state === "LEASED")).toHaveLength(0);

    // their subscriptions are no longer LIVE — B5_FANIN's `locked` CTE can never pick them
    // up again, which is what closes the pending_cost/reserved_remaining asymmetry (see
    // src/transactions.ts `cancelOrphanedWorkOnDenial`)
    const subs = await db().rows<{ state: string }>(
      `SELECT state FROM run_subscription WHERE search_id = $1`,
      [search.searchId],
    );
    expect(subs.filter((r) => r.state === "LIVE")).toHaveLength(0);

    // and no unpublished outbox row survives for any of this search's jobs
    const outbox = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox o
       JOIN search_job j ON j.job_id = o.job_id
       WHERE j.search_id = $1 AND o.state = 'PENDING'`,
      [search.searchId],
    );
    expect(outbox.n).toBe("0");

    // the search can terminalize immediately — HALTED, not stranded waiting on jobs that
    // will never be worked
    const terminal = await terminalize(db(), search.searchId);
    expect(terminal?.status).toBe("HALTED");
    expect(terminal?.cause).toBe("CAPACITY");
  });

  it("an outbox row a publisher already claimed before denial is left alone, and still terminates cleanly (defect 2 residual)", async () => {
    await seedProvider(db(), { pendingCostLimit: 0 });
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    // reserve 0 with limit 0: any positive filtered count (1) makes pendingCost+delta>limit, guaranteeing denial via search-wide gate
    const search = await createSearch(db(), 1, { reserve: 0 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);

    // Built at the statement level (not via the acceptSchedule fixture) so a PUBLISHED
    // write can be injected between expansion and B6 search-wide reconciliation/denial —
    // exactly the ordering the residual describes: a publisher claims the row before the
    // denial (and its cancel-on-denial cleanup) ever runs.
    await db().query("BEGIN");
    try {
      const fenced = await mustWin<{ run_key_id: string; observation_id: string }>(
        db(),
        B.B5A_FENCE,
        [run.runId, run.generation],
      );
      const keyRow = await mustWin<{ kind: string; provider_id: string; route_class: string }>(
        db(),
        B.B5A_DERIVE_KEY,
        [fenced.run_key_id],
      );
      await mustWin(db(), B.B5B_EPOCH_FENCE, [keyRow.provider_id, run.epoch, keyRow.route_class]);
      const capturedAt = new Date().toISOString();
      await mustWin(db(), B.B5C_OBSERVATION, [
        fenced.observation_id,
        fenced.run_key_id,
        run.runId,
        capturedAt,
      ]);
      const rk = await db().one<{ theatre_id: string; local_date: string }>(
        `SELECT theatre_id, local_date FROM run_key WHERE run_key_id = $1`,
        [fenced.run_key_id],
      );
      await mustWin(db(), B.B5C_PERFORMANCE, [
        "st_only",
        keyRow.provider_id,
        rk.theatre_id,
        rk.local_date,
        new Date().toISOString(),
        fenced.observation_id,
        JSON.stringify({}),
      ]);
      await mustWin(db(), B.B5D_ACCEPTED_REVISION, [
        fenced.run_key_id,
        fenced.observation_id,
        capturedAt,
      ]);
      const fanIn = await runQuery(db(), B.B5_FANIN, [
        fenced.run_key_id,
        run.runId,
        keyRow.provider_id,
        keyRow.kind,
        JSON.stringify({ observationId: fenced.observation_id, outcome: "RESOLVED" }),
      ]);
      expect(fanIn.rows).toHaveLength(1);

      const fk = await fetchKey(db(), "st_only", keyRow.provider_id);
      const jobId = id("job");
      await mustWin(db(), B.JOB_CREATE, [
        jobId,
        search.searchId,
        "SHOWTIME_FETCH",
        fk.runKeyId,
        search.deadlineAt.toISOString(),
      ]);
      await mustWin(db(), B.SUBSCRIPTION_CREATE, [
        fk.runKeyId,
        search.searchId,
        jobId,
        search.deadlineAt.toISOString(),
      ]);
      const created = await mustWin<{ outbox_id: string }>(db(), B.OUTBOX_CREATE_JOB, [
        jobId,
        null,
      ]);

      // the publisher claims this row BEFORE the denial (and cancel-on-denial) run
      expect(await markOutboxPublished(db(), created.outbox_id)).toHaveLength(1);

      // S36 clean cutover: per-schedule count then search-wide reconciliation.
      await mustWin(db(), B.B6_SET_SCHEDULE_MATCH_COUNT, [fenced.run_key_id, search.searchId, 1]);
      const reconciled = await runQuery(db(), B.B6_RECONCILE_SEARCH_WIDE, [
        keyRow.provider_id,
        search.searchId,
      ]);
      expect(reconciled.rows).toHaveLength(0); // unobtainable: pending headroom 0 vs delta 1

      await mustWin(db(), B.B6_DENY_CAPACITY, [search.searchId]);
      const cleanup = await cancelOrphanedWorkOnDenial(db(), search.searchId);
      // the PUBLISHED row is not "unpublished" — B6_VOID_ORPHANED_OUTBOX must not claim it
      // (a separate, still-PENDING outbox row for the already-DONE schedule job may
      // legitimately be voided too — it names a job that will never be leased again)
      expect(cleanup.voidedOutboxIds).not.toContain(created.outbox_id);
      expect(cleanup.cancelledJobIds).toContain(jobId);

      await mustWin(db(), B.B6_SUBSCRIPTION_OUTCOME, [
        fenced.run_key_id,
        search.searchId,
        "RESOLVED",
      ]);
      await mustWin(db(), B.B6_SEARCH_RUNNING, [search.searchId, "RESOLVED"]);
      await db().query("COMMIT");
    } catch (err) {
      await db().query("ROLLBACK");
      throw err;
    }

    const outboxRow = await db().one<{ state: string }>(
      `SELECT state FROM outbox WHERE job_id = (
         SELECT job_id FROM search_job WHERE search_id = $1 AND kind = 'SHOWTIME_FETCH'
       )`,
      [search.searchId],
    );
    expect(outboxRow.state).toBe("PUBLISHED"); // untouched by B6_VOID_ORPHANED_OUTBOX

    // the worker eventually acts on the stale delivery: leasing the job it names
    const staleJob = await db().one<{ job_id: string }>(
      `SELECT job_id FROM search_job WHERE search_id = $1 AND kind = 'SHOWTIME_FETCH'`,
      [search.searchId],
    );
    const lease = await runQuery(db(), B.B2_LEASE_JOB, [staleJob.job_id, "5 minutes"]);
    expect(lease.rows).toHaveLength(0); // dropped: the job is CANCELLED, not PENDING

    const terminal = await terminalize(db(), search.searchId);
    expect(terminal?.status).toBe("HALTED");
    expect(terminal?.cause).toBe("CAPACITY");
    // useDatabase()'s afterEach runs the full invariant sweep, including
    // admission_conservation — a stale PUBLISHED row for an already-cancelled job must not
    // leave pending_cost/reserved_remaining out of balance.
  });

  it("two cold searches share one schedule run and both expand (T7b)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const a = await createSearch(db(), 1, { reserve: 1 });
    const b = await createSearch(db(), 1, { reserve: 1 });
    await subscribe(db(), a, key);
    await subscribe(db(), b, key);

    const run = await dispatchRun(db(), key);
    const result = await acceptSchedule(db(), run, [
      { showtimeId: "st_a", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
    ]);

    expect(new Set(result.expandedFor)).toEqual(new Set([a.searchId, b.searchId]));
    const runs = await db().one<{ n: string }>(`SELECT count(*) AS n FROM provider_run`);
    expect(runs.n).toBe("1"); // one upstream request, two searches served
    const jobs = await db().rows(
      `SELECT search_id, count(*) AS n FROM search_job WHERE kind = 'SHOWTIME_FETCH'
       GROUP BY search_id ORDER BY search_id`,
    );
    expect(jobs).toHaveLength(2);
  });
  it("re-observing the same showtime on a different local_date updates performance.local_date (seed refresh regression)", async () => {
    await seedProvider(db());
    const keyA = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const keyB = await scheduleKey(db(), "theatre_1", "2026-08-03");
    const searchA = await createSearch(db(), 1, { reserve: 2 });
    const searchB = await createSearch(db(), 1, { reserve: 2 });
    await subscribe(db(), searchA, keyA);
    await subscribe(db(), searchB, keyB);

    const runA = await dispatchRun(db(), keyA);
    await acceptSchedule(db(), runA, [
      {
        showtimeId: "st_same",
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T18:00:00Z"),
        skipFetch: false,
      },
    ]);
    let row = await db().one<{ ld: string }>(
      `SELECT local_date::text AS ld FROM performance WHERE showtime_id = 'st_same'`,
    );
    expect(row.ld).toBe("2026-08-02");

    const runB = await dispatchRun(db(), keyB);
    await acceptSchedule(db(), runB, [
      {
        showtimeId: "st_same",
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-03T19:00:00Z"),
        skipFetch: false,
      },
    ]);
    row = await db().one<{ ld: string }>(
      `SELECT local_date::text AS ld FROM performance WHERE showtime_id = 'st_same'`,
    );
    expect(row.ld).toBe("2026-08-03");
  });
});
describe("tier 2 — B5F failure acceptance", () => {
  const db = useDatabase();
  const caps = admission(db);

  it("an exhausted run fails its subscribers promptly rather than waiting out the deadline (T9d)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);

    const { affected } = await failRun(db(), run);
    expect(affected).toHaveLength(1);

    const state = await db().one(
      `SELECT (SELECT state FROM search_job WHERE search_id = $1) AS job,
              (SELECT state FROM run_subscription WHERE search_id = $1) AS sub,
              (SELECT count(*) FROM search_event WHERE search_id = $1 AND type = 'FETCH_FAILED') AS events`,
      [search.searchId],
    );
    expect(state).toEqual({ job: "FAILED", sub: "CANCELLED", events: "1" });
    expect((await caps()).pending_cost).toBe("0");
  });

  it("a failed schedule run records FAILED per subscription, unblocking the B8 guard", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);

    await failRun(db(), run);
    const sub = await db().one(
      `SELECT schedule_outcome FROM run_subscription WHERE search_id = $1`,
      [search.searchId],
    );
    expect(sub.schedule_outcome).toBe("FAILED");
  });
});

describe("tier 2 — B7/B8 claim and terminalization", () => {
  const db = useDatabase();
  const caps = admission(db);

  it("a warm search that completes derives COMPLETE, not HALTED (T21 — the vacuous NOT EXISTS)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);

    const terminal = await terminalize(db(), search.searchId);
    expect(terminal).toEqual({ status: "COMPLETE", cause: null });

    const version = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM search_result_version WHERE search_id = $1`,
      [search.searchId],
    );
    expect(version.n).toBe("1");
    // capacity returns to baseline: no leak, no underflow (T18c)
    expect(await caps()).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
  });

  it("terminalization releases exactly the outstanding remainder, and only once", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 3 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await failRun(db(), run); // schedule FAILED → B8 guard satisfied, nothing satisfied it

    const terminal = await terminalize(db(), search.searchId);
    expect(terminal?.status).toBe("HALTED");
    expect(await caps()).toEqual({ pending_cost: "0", unresolved_schedules: 0 });

    // a second attempt finds nothing to claim and releases nothing a second time
    expect(await terminalize(db(), search.searchId)).toBeNull();
    expect(await caps()).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
  });

  it("a cold search that resolves, fetches and completes returns capacity to baseline (T18c)", async () => {
    await seedProvider(db());
    const sched = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 4 });
    await subscribe(db(), search, sched);

    const schedRun = await dispatchRun(db(), sched);
    await acceptSchedule(
      db(),
      schedRun,
      ["a", "b"].map((x) => ({
        showtimeId: `st_${x}`,
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      })),
      { stage1Share: 4 },
    );
    // stage 2 reconciled 4 → 2 and returned this key's schedule slot
    expect(await caps()).toEqual({ pending_cost: "2", unresolved_schedules: 0 });

    for (const st of ["st_a", "st_b"]) {
      const key = await fetchKey(db(), st);
      await acceptFetch(db(), await dispatchRun(db(), key));
    }

    expect((await terminalize(db(), search.searchId))?.status).toBe("COMPLETE");
    // The whole point of the two-flag design: the slot B6 already returned must not be
    // returned a second time by B8, and the units satisfaction drew down must not be
    // released again either.
    expect(await caps()).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
  });

  it("a search holding N schedule keys releases one search-wide slot (S36)", async () => {
    await seedProvider(db());
    // One cold search holds one slot regardless of its two schedule keys.
    const search = await createSearch(db(), 1, { reserve: 6 });
    const first = await scheduleKey(db(), "theatre_1", "2026-08-02");
    const second = await scheduleKey(db(), "theatre_2", "2026-08-02");
    await subscribe(db(), search, first);
    await subscribe(db(), search, second);

    await failRun(db(), await dispatchRun(db(), first));
    await failRun(db(), await dispatchRun(db(), second));
    expect((await caps()).unresolved_schedules).toBe(0);

    expect((await terminalize(db(), search.searchId))?.status).toBe("HALTED");
    expect(await caps()).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
  });

  it("the stale-aggregate fence rejects a terminalization computed from a superseded revision (T9b)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);

    const claim = await db().one<{ agg_generation: number; agg_requested_rev: string }>(
      B.B7_CLAIM.text,
      [search.searchId, "1 minute"],
    );

    // the last fetch commits revision N+1 while the aggregator holds N
    await db().query(
      `UPDATE search SET agg_requested_rev = agg_requested_rev + 1 WHERE search_id = $1`,
      [search.searchId],
    );

    const stale = await runQuery(db(), B.B8_TERMINALIZE, [
      search.searchId,
      claim.agg_generation,
      claim.agg_requested_rev,
    ]);
    expect(stale.rows).toHaveLength(0);

    // …and the follow-up pass terminalizes including the late observation
    await runQuery(db(), B.B7_RELEASE, [
      search.searchId,
      claim.agg_requested_rev,
      claim.agg_generation,
    ]);
    expect((await terminalize(db(), search.searchId))?.status).toBe("COMPLETE");
  });

  it("B7 claims a caught-up search whose deadline passed, instead of stalling forever (T19)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);
    // aggregation caught up: processed == requested, and no counter will ever move again
    await db().query(
      `UPDATE search SET agg_processed_rev = agg_requested_rev,
                         deadline_at = now() - interval '1 second'
       WHERE search_id = $1`,
      [search.searchId],
    );

    const claim = await runQuery(db(), B.B7_CLAIM, [search.searchId, "1 minute"]);
    expect(claim.rows).toHaveLength(1);
  });
});

describe("tier 2 — B7_GROUP_EVENT", () => {
  const db = useDatabase();

  it("writes one group event at the next gapless seq, bumping only next_seq (S27.17)", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 0, { reserve: 1 });

    const before = await db().one<{ next_seq: string; agg_requested_rev: string }>(
      `SELECT next_seq, agg_requested_rev FROM search WHERE search_id = $1`,
      [search.searchId],
    );

    const rows = await runQuery(db(), B.B7_GROUP_EVENT, [
      search.searchId,
      JSON.stringify({ group: {}, resolved: 0, total: 0 }),
    ]);
    expect(rows.rows).toHaveLength(1);

    const event = await db().one<{ seq: string; type: string; payload: unknown }>(
      `SELECT seq, type, payload FROM search_event WHERE search_id = $1`,
      [search.searchId],
    );
    expect(event.type).toBe("group");
    expect(event.seq).toBe(String(Number(before.next_seq) + 1));

    const after = await db().one<{ next_seq: string; agg_requested_rev: string }>(
      `SELECT next_seq, agg_requested_rev FROM search WHERE search_id = $1`,
      [search.searchId],
    );
    expect(after.next_seq).toBe(String(Number(before.next_seq) + 1));
    // negative control: the event is an effect of the pass, not a fact — agg_requested_rev
    // must NOT advance, or every pass would re-trigger itself forever (S27.16).
    expect(after.agg_requested_rev).toBe(before.agg_requested_rev);
  });

  it("returns zero rows on a terminalized or missing search (S27.17)", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 0, { reserve: 1 });
    // A terminalized search: status COMPLETE plus its result version, because B8 writes
    // both in one transaction and `terminal_has_result_version` enforces the pair.
    await db().query(`UPDATE search SET status = 'COMPLETE' WHERE search_id = $1`, [
      search.searchId,
    ]);
    await db().query(
      `INSERT INTO search_result_version (search_id, version, payload) VALUES ($1, 1, '{}'::jsonb)`,
      [search.searchId],
    );

    const terminalized = await runQuery(db(), B.B7_GROUP_EVENT, [
      search.searchId,
      JSON.stringify({ group: {}, resolved: 0, total: 0 }),
    ]);
    expect(terminalized.rows).toHaveLength(0);

    const missing = await runQuery(db(), B.B7_GROUP_EVENT, [
      "srch_does_not_exist",
      JSON.stringify({ group: {}, resolved: 0, total: 0 }),
    ]);
    expect(missing.rows).toHaveLength(0);
  });
});

describe("tier 2 — B9/B10 halt fencing and projection", () => {
  const db = useDatabase();

  it("a halt bumps the fence, fences live work, and makes affected searches claimable (R3#1)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    await mustWin(db(), B.B2_LEASE_JOB, [sub.jobId, "5 minutes"]);
    const run = await dispatchRun(db(), key);
    const before = await db().one(`SELECT agg_requested_rev FROM search WHERE search_id = $1`, [
      search.searchId,
    ]);

    const fence = await mustWin<{ epoch: string }>(db(), B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db(), B.B9_UPSERT_STATUS, [PROVIDER, "", "HALTED", "BLOCKED", null]);
    const jobs = await runQuery(db(), B.B9_FENCE_JOBS, [PROVIDER]);
    const runs = await runQuery(db(), B.B9_FENCE_RUNS, [PROVIDER]);
    const requested = await runQuery(db(), B.B9_REQUEST_AGGREGATION, [PROVIDER]);

    expect(fence.epoch).toBe("1");
    expect(jobs.rows).toHaveLength(1);
    expect(runs.rows).toHaveLength(1);
    expect(requested.rows).toHaveLength(1);

    const after = await db().one(`SELECT agg_requested_rev FROM search WHERE search_id = $1`, [
      search.searchId,
    ]);
    expect(Number(after.agg_requested_rev)).toBe(Number(before.agg_requested_rev) + 1);

    // the run's write-back is now unfenceable at B5(b)
    const late = await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, run.epoch, "seat"]);
    expect(late.rows).toHaveLength(0);
  });

  it("the event watermark advances only contiguously, and the snapshot watermark is a work queue (T6c)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await acceptFetch(db(), run);

    const pending = await runQuery(db(), B.B10_UNPROJECTED_EVENTS, [search.searchId]);
    expect(pending.rows).toHaveLength(1);

    const skip = await runQuery(db(), B.B10_ADVANCE_EVENT_WATERMARK, [search.searchId, 2]);
    expect(skip.rows).toHaveLength(0); // a gap is not projectable
    const step = await runQuery(db(), B.B10_ADVANCE_EVENT_WATERMARK, [search.searchId, 1]);
    expect(step.rows).toHaveLength(1);

    // the snapshot projection is a watermark, and B5(d) left work on it
    const claim = await runQuery(db(), B.B10_CLAIM_SNAPSHOT_PROJECTION, []);
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0].run_key_id).toBe(key.runKeyId);

    const advanced = await runQuery(db(), B.B10_ADVANCE_SNAPSHOT_WATERMARK, [
      key.runKeyId,
      claim.rows[0].accepted_revision,
    ]);
    expect(advanced.rows).toHaveLength(1);
    // a projector holding the older revision loses (the stale-cache race, T20)
    const stale = await runQuery(db(), B.B10_ADVANCE_SNAPSHOT_WATERMARK, [key.runKeyId, 1]);
    expect(stale.rows).toHaveLength(0);

    expect(await runQuery(db(), B.B10_CLAIM_SNAPSHOT_PROJECTION, []).then((r) => r.rows)).toEqual(
      [],
    );
  });

  it("SNAPSHOT_READ_FOR_PROJECTION returns the accepted snapshot and resolved performance rows", async () => {
    await seedProvider(db());

    // SHOWTIME_FETCH: one availability_snapshot row for the claimed observation.
    const fetch = await fetchKey(db(), "st_proj_read");
    await acceptFetch(db(), await dispatchRun(db(), fetch), {
      bitmap: Buffer.from([0xbe, 0xef]),
      freeCount: 7,
    });
    const fetchObs = (
      await db().one<{ latest_observation_id: string }>(
        `SELECT latest_observation_id FROM run_key WHERE run_key_id = $1`,
        [fetch.runKeyId],
      )
    ).latest_observation_id;

    const fetchRows = await runQuery(db(), B.SNAPSHOT_READ_FOR_PROJECTION, [
      fetch.runKeyId,
      fetchObs,
    ]);
    expect(fetchRows.rows).toHaveLength(1);
    expect(fetchRows.rows[0]).toMatchObject({
      kind: "SHOWTIME_FETCH",
      showtime_id: fetch.showtimeId,
      free_count: 7,
    });
    expect(fetchRows.rows[0].bitmap).toEqual(Buffer.from([0xbe, 0xef]));
    expect(fetchRows.rows[0].captured_at).toBeInstanceOf(Date);
    expect(fetchRows.rows[0].performance_showtime_id).toBeNull();

    // SCHEDULE_RESOLUTION: one performance row per resolved showtime, snapshot columns NULL.
    const sched = await scheduleKey(db(), "theatre_proj_read", "2026-08-03");
    await acceptSchedule(db(), await dispatchRun(db(), sched), [
      { showtimeId: "st_x", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
      { showtimeId: "st_y", movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false },
    ]);
    const schedObs = (
      await db().one<{ latest_observation_id: string }>(
        `SELECT latest_observation_id FROM run_key WHERE run_key_id = $1`,
        [sched.runKeyId],
      )
    ).latest_observation_id;

    const schedRows = await runQuery(db(), B.SNAPSHOT_READ_FOR_PROJECTION, [
      sched.runKeyId,
      schedObs,
    ]);
    expect(schedRows.rows).toHaveLength(2);
    expect(schedRows.rows.map((r) => r.kind)).toEqual([
      "SCHEDULE_RESOLUTION",
      "SCHEDULE_RESOLUTION",
    ]);
    expect(schedRows.rows.map((r) => r.performance_showtime_id).sort()).toEqual(["st_x", "st_y"]);
    expect(schedRows.rows[0].bitmap).toBeNull();
  });
});

describe("tier 2 — sweeper duties", () => {
  const db = useDatabase();

  it("publishes one outbox identity without hiding a re-armed delivery for the same job", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_publish_identity");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const first = await db().one<{ outbox_id: string }>(
      `SELECT outbox_id FROM outbox WHERE job_id = $1`,
      [sub.jobId],
    );

    // Clock manipulation creates the stranded-job precondition that makes the sweeper re-arm it.
    await db().query(
      `UPDATE search_job SET created_at = now() - interval '1 hour' WHERE job_id = $1`,
      [sub.jobId],
    );
    const rearmed = await runQuery(db(), B.SWEEP_REARM_JOBS, ["1 minute"]);
    expect(rearmed.rows).toHaveLength(1);
    const second = rearmed.rows[0] as { outbox_id: string };
    expect(second.outbox_id).not.toBe(first.outbox_id);

    const published = await markOutboxPublished(db(), first.outbox_id);
    expect(published).toEqual([{ outbox_id: first.outbox_id, state: "PUBLISHED" }]);
    expect(await markOutboxPublished(db(), first.outbox_id)).toEqual([]);

    const overdue = await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10]);
    expect(overdue.rows).toHaveLength(1);
    expect(overdue.rows[0]).toMatchObject({ outbox_id: second.outbox_id, job_id: sub.jobId });

    expect(await markOutboxPublished(db(), second.outbox_id)).toEqual([
      { outbox_id: second.outbox_id, state: "PUBLISHED" },
    ]);
    expect(await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10])).toMatchObject({ rows: [] });
  });

  it("OUTBOX_CREATE_JOB carries a given traceparent and writes NULL when no span is active (O7.8)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_trace_job");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const deadline = search.deadlineAt.toISOString();

    // Positive branch: the W3C traceparent captured at the HTTP boundary round-trips.
    const traced = id("job");
    await mustWin(db(), B.JOB_CREATE, [traced, search.searchId, key.kind, key.runKeyId, deadline]);
    const tracedOutbox = await mustWin<{ outbox_id: string }>(db(), B.OUTBOX_CREATE_JOB, [
      traced,
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ]);

    // Negative branch: no active request span means NULL, never a fabricated parent.
    const untraced = id("job");
    await mustWin(db(), B.JOB_CREATE, [
      untraced,
      search.searchId,
      key.kind,
      key.runKeyId,
      deadline,
    ]);
    await mustWin(db(), B.OUTBOX_CREATE_JOB, [untraced, null]);

    const tracedRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE job_id = $1::text`,
      [traced],
    );
    expect(tracedRow.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const untracedRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE job_id = $1::text`,
      [untraced],
    );
    expect(untracedRow.traceparent).toBeNull();

    // SWEEP_OVERDUE_OUTBOX widens over the column: the relay hands the worker the parent
    // span it needs to continue the caller's trace (O7.6).
    const overdue = await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10]);
    expect(overdue.rows).toHaveLength(2);
    expect(overdue.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outbox_id: tracedOutbox.outbox_id,
          job_id: traced,
          target_kind: "JOB",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        }),
        expect.objectContaining({
          outbox_id: expect.any(String),
          job_id: untraced,
          target_kind: "JOB",
          traceparent: null,
        }),
      ]),
    );
  });

  it("a reclaimed lease returns to PENDING with a fresh outbox row (R5#9, T37)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    // The HTTP-boundary delivery carried a real traceparent; the reclaim below must not
    // copy it forward onto the sweeper's replacement row (ADR 0031).
    const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await db().query(`UPDATE outbox SET traceparent = $1::text WHERE job_id = $2::text`, [
      TRACEPARENT,
      sub.jobId,
    ]);
    await mustWin(db(), B.B2_LEASE_JOB, [sub.jobId, "5 minutes"]);
    // time is data: expire the lease by writing it, never by waiting
    await db().query(
      `UPDATE search_job SET lease_expires_at = now() - interval '1 second' WHERE job_id = $1`,
      [sub.jobId],
    );

    const reclaimed = await runQuery(db(), B.SWEEP_RECLAIM_JOBS, [5]);
    expect(reclaimed.rows).toHaveLength(1);

    const job = await db().one(`SELECT state, lease_expires_at FROM search_job WHERE job_id = $1`, [
      sub.jobId,
    ]);
    expect(job.state).toBe("PENDING");
    expect(job.lease_expires_at).toBeNull();

    const outbox = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE job_id = $1`,
      [sub.jobId],
    );
    expect(outbox.n).toBe("2"); // the original and the sweeper's replacement

    const rows = await db().rows<{ outbox_id: string; traceparent: string | null }>(
      `SELECT outbox_id, traceparent FROM outbox WHERE job_id = $1::text ORDER BY created_at`,
      [sub.jobId],
    );
    // Both rows are PENDING here (this test never publishes the original), so the
    // original is identified by its captured traceparent, not by outbox state.
    const original = rows.find((row) => row.traceparent === TRACEPARENT);
    const replacement = rows.filter((row) => row.traceparent === null);
    // The sweeper's fresh row writes NULL explicitly — a fabricated parent would graft
    // this retry onto a stale trace (ADR 0031) — while the original keeps its own.
    expect(replacement.map((row) => row.traceparent)).toEqual([null]);
    expect(original).toBeDefined();
  });

  it("re-arm skips jobs whose parent search is terminal (re-arm is not resurrection)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    await db().query(
      `UPDATE search_job SET created_at = now() - interval '1 hour' WHERE search_id = $1`,
      [search.searchId],
    );

    expect(await runQuery(db(), B.SWEEP_REARM_JOBS, ["1 minute"]).then((r) => r.rows)).toHaveLength(
      1,
    );

    const run = await dispatchRun(db(), key);
    await failRun(db(), run);
    await terminalize(db(), search.searchId);

    expect(await runQuery(db(), B.SWEEP_REARM_JOBS, ["1 minute"]).then((r) => r.rows)).toEqual([]);
  });

  it("an attempts-exhausted, expired-lease RUN is terminalized through B5F, not stranded LEASED (defect 1)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);

    // SWEEP_RECLAIM_RUNS deliberately excludes this run (attempt >= max): simulate the
    // sweeper discovering it stuck LEASED past its lease with no attempts left, exactly
    // the case its own comment says is NOT a bare reclaim.
    await db().query(
      `UPDATE provider_run SET attempt = 5, lease_expires_at = now() - interval '1 second'
       WHERE run_id = $1`,
      [run.runId],
    );

    // Reclaim does not touch it: still under-budget filter excludes it.
    expect(await runQuery(db(), B.SWEEP_RECLAIM_RUNS, [5]).then((r) => r.rows)).toEqual([]);

    const results = await sweepFailExhaustedRuns(db(), 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.runId).toBe(run.runId);
    expect(results[0]!.affected).toHaveLength(1);
    expect(results[0]!.affected[0]!.search_id).toBe(search.searchId);

    const runRow = await db().one<{ state: string; fail_cause: string }>(
      `SELECT state, fail_cause FROM provider_run WHERE run_id = $1`,
      [run.runId],
    );
    expect(runRow.state).toBe("FAILED");
    expect(runRow.fail_cause).toBe("ATTEMPTS_EXHAUSTED");

    const jobRow = await db().one<{ state: string }>(
      `SELECT state FROM search_job WHERE job_id = $1`,
      [sub.jobId],
    );
    expect(jobRow.state).toBe("FAILED");

    const subRow = await db().one<{ state: string }>(
      `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
      [key.runKeyId, search.searchId],
    );
    expect(subRow.state).toBe("CANCELLED");

    // capacity released (fetch-only), and this search can terminalize immediately —
    // the whole point: it does not have to wait out the deadline.
    const terminal = await terminalize(db(), search.searchId);
    expect(terminal?.status).toBe("HALTED"); // zero accepted fetch observations (ADR 0003 A12)
    expect(terminal?.cause).toBeNull();

    // A second sweep pass finds nothing left to do — not double-processed.
    expect(await sweepFailExhaustedRuns(db(), 5)).toEqual([]);
  });

  it("an attempts-exhausted, expired-lease JOB fails just its own subscription, not the whole run (defect 1)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_1");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);

    // A second search sharing the same run key, to prove its subscription is untouched:
    // job-level exhaustion is scoped to the one search whose job stalled, never the run.
    const other = await createSearch(db(), 0, { reserve: 1 });
    const otherSub = await subscribe(db(), other, key);

    await mustWin(db(), B.B2_LEASE_JOB, [sub.jobId, "5 minutes"]);
    // SWEEP_RECLAIM_JOBS deliberately excludes this job (attempt >= max) once exhausted.
    await db().query(
      `UPDATE search_job SET attempt = 5, lease_expires_at = now() - interval '1 second'
       WHERE job_id = $1`,
      [sub.jobId],
    );
    expect(await runQuery(db(), B.SWEEP_RECLAIM_JOBS, [5]).then((r) => r.rows)).toEqual([]);

    const results = await sweepFailExhaustedJobs(db(), 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.jobId).toBe(sub.jobId);
    expect(results[0]!.affected).toHaveLength(1);
    expect(results[0]!.affected[0]!.search_id).toBe(search.searchId);

    const jobRow = await db().one<{ state: string; fail_cause: string }>(
      `SELECT state, fail_cause FROM search_job WHERE job_id = $1`,
      [sub.jobId],
    );
    expect(jobRow.state).toBe("FAILED");
    expect(jobRow.fail_cause).toBe("ATTEMPTS_EXHAUSTED");

    const subRow = await db().one<{ state: string }>(
      `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
      [key.runKeyId, search.searchId],
    );
    expect(subRow.state).toBe("CANCELLED");

    // the OTHER search's subscription to the same key is untouched
    const otherRow = await db().one<{ state: string }>(
      `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
      [key.runKeyId, other.searchId],
    );
    expect(otherRow.state).toBe("LIVE");
    const otherJobRow = await db().one<{ state: string }>(
      `SELECT state FROM search_job WHERE job_id = $1`,
      [otherSub.jobId],
    );
    expect(otherJobRow.state).toBe("PENDING");

    // A second sweep pass finds nothing left to do — not double-processed.
    expect(await sweepFailExhaustedJobs(db(), 5)).toEqual([]);
  });
});
