import { describe, expect, inject, it } from "vitest";

import * as B from "../src/boundaries.js";
import { markOutboxPublished } from "../src/repository.js";
import {
  ALL_REDIS_SCRIPTS,
  heartbeatSemaphoreOrAbort,
  providerStateCacheKey,
  providerStateOrHalted,
  readProviderControlState,
  refreshProviderState,
  SEMAPHORE_ACQUIRE,
  SEMAPHORE_RELEASE,
  SNAPSHOT_CAS,
  TOKEN_BUCKET_INIT_EMPTY,
  type ProviderStateSource,
} from "../src/redis.js";
import {
  applyProviderControlTransition,
  findOrCreateRun,
  reopenProviderScope,
  stageProviderControlTransition,
  stageReopenProviderScope,
} from "../src/transactions.js";

import { expireAggregationLease } from "./support/clock.js";
import {
  acceptFetch,
  createSearch,
  dispatchRun,
  failRun,
  fetchKey,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  seedProvider,
  stageFetchAcceptance,
  stageTerminalization,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import { session, terminateConnection, useDatabase } from "./support/pg.js";
import { projectEvent, projectNextEvent, rebuildEventStream } from "./support/projector.js";
import { RedisClient, useRedis } from "./support/redis.js";

/**
 * Tier 4 — kill the connection at the named crash window and inspect state only from a
 * surviving connection. Redis crash windows are the cross-store points where one side
 * committed and the process vanished before advancing the other side's watermark.
 */

const redis = useRedis();

describe("tier 4 — Redis protocols load", () => {
  it("loads every authoritative Lua program into Redis 7", async () => {
    for (const script of ALL_REDIS_SCRIPTS) {
      expect(await redis().scriptLoad(script)).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("refuses FLUSHALL unless the caller explicitly marks the server disposable", async () => {
    const guarded = await RedisClient.connect(inject("redisUrl"));
    try {
      await expect(guarded.flushAll()).rejects.toThrow("FLUSHALL is disabled");
    } finally {
      await guarded.close();
    }
  });
});

describe("tier 4 — B1 crash windows", () => {
  const db = useDatabase();

  it("T1: a commit survives a crash before publish and remains relay-visible", async () => {
    await seedProvider(db());
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    const search = await createSearch(tx, 0, { reserve: 1 });
    const key = await fetchKey(tx, "st_t1");
    const sub = await subscribe(tx, search, key);
    await tx.query("COMMIT");
    await terminateConnection(db(), raw);

    const durable = await db().one(
      `SELECT s.search_id, j.job_id, o.state
       FROM search s JOIN search_job j USING (search_id) JOIN outbox o USING (job_id)
       WHERE s.search_id = $1`,
      [search.searchId],
    );
    expect(durable).toEqual({ search_id: search.searchId, job_id: sub.jobId, state: "PENDING" });
    const relay = await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10]);
    expect(relay.rows.map((row) => row.job_id)).toContain(sub.jobId);
  });

  it("T2: a backend death before commit exposes nothing; retry creates the fixed search id", async () => {
    await seedProvider(db());
    const searchId = id("srch");
    const sessionId = id("sess");
    const idempotencyKey = id("idem");
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const values = [
      searchId,
      sessionId,
      idempotencyKey,
      JSON.stringify({ v: 1 }),
      "hash_a",
      deadline,
    ] as const;

    const raw = await db().connect();
    const tx = session(raw);
    await tx.query("BEGIN");
    await mustWin(tx, B.B1_CREATE_SEARCH, values);
    await mustWin(tx, B.B1_STAGE1_ADMISSION, [PROVIDER, 1, 0, searchId, 0]);
    await terminateConnection(db(), raw);

    expect(await db().rows(`SELECT * FROM search WHERE search_id = $1`, [searchId])).toEqual([]);
    expect(
      await db().rows(`SELECT * FROM admission_reservation WHERE search_id = $1`, [searchId]),
    ).toEqual([]);

    await mustWin(db(), B.B1_CREATE_SEARCH, values);
    await mustWin(db(), B.B1_STAGE1_ADMISSION, [PROVIDER, 1, 0, searchId, 0]);
    expect(
      (await db().one(`SELECT search_id FROM search WHERE search_id = $1`, [searchId])).search_id,
    ).toBe(searchId);
  });
});

describe("tier 4 — S30 admission/dedup crash window", () => {
  const db = useDatabase();

  it("S30: a backend death between RUN_CREATE and OUTBOX_CREATE_RUN strands no PENDING run", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_crash");
    const runId = id("run");
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    // The RUN_CREATE effect has executed but OUTBOX_CREATE_RUN has not — the exact window a
    // crash would strand a PENDING run with no dispatch outbox if the two were not atomic.
    await mustWin(tx, B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    await terminateConnection(db(), raw);

    const stranded = await db().one<{ runs: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM provider_run WHERE run_key_id = $1) AS runs,
              (SELECT count(*) FROM outbox WHERE run_id = $2) AS outbox`,
      [key.runKeyId, runId],
    );
    expect(stranded).toEqual({ runs: "0", outbox: "0" });
    // The retry through the real find-or-create body recovers to exactly one live run + outbox.
    const retry = await findOrCreateRun(db(), { runKeyId: key.runKeyId });
    expect(retry).toEqual({ runId: expect.any(String), created: true });
  });
});

describe("tier 4 — B5 crash windows", () => {
  const db = useDatabase();

  it("T5/T6c: commit then connection loss leaves both durable projectors catch-up work", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t5");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    const raw = await db().connect();

    await acceptFetch(session(raw), run);
    await terminateConnection(db(), raw);

    const durable = await db().one(
      `SELECT s.projected_through, s.next_seq, k.projected_revision, k.accepted_revision
       FROM search s CROSS JOIN run_key k
       WHERE s.search_id = $1 AND k.run_key_id = $2`,
      [search.searchId, key.runKeyId],
    );
    expect(durable).toEqual({
      projected_through: "0",
      next_seq: "1",
      projected_revision: "0",
      accepted_revision: "1",
    });

    expect(await projectNextEvent(db(), redis(), search.searchId)).toBe(1);
    const snapshot = await runQuery(db(), B.B10_CLAIM_SNAPSHOT_PROJECTION, []);
    expect(snapshot.rows).toHaveLength(1);
    expect(
      await redis().eval(SNAPSHOT_CAS, [`bitmap:${key.runKeyId}`], [1, "accepted-bitmap"]),
    ).toBe(1);
    expect(
      await runQuery(db(), B.B10_ADVANCE_SNAPSHOT_WATERMARK, [key.runKeyId, 1]).then(
        (result) => result.rows,
      ),
    ).toHaveLength(1);
  });

  it("T6: killing the transaction after fan-in executes applies nobody; retry applies all", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t6");
    const searches = [];
    for (let i = 0; i < 3; i++) {
      const search = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), search, key);
      searches.push(search);
    }
    const run = await dispatchRun(db(), key);
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    expect((await stageFetchAcceptance(tx, run)).fannedIn).toHaveLength(3);
    await terminateConnection(db(), raw);

    const rolledBack = await db().one(
      `SELECT (SELECT state FROM provider_run WHERE run_id = $1) AS run_state,
              (SELECT count(*) FROM observation WHERE run_id = $1) AS observations,
              (SELECT count(*) FROM run_application WHERE run_id = $1) AS applications,
              (SELECT count(*) FROM search_event) AS events,
              (SELECT count(*) FROM search_job WHERE state = 'DONE') AS done_jobs`,
      [run.runId],
    );
    expect(rolledBack).toEqual({
      run_state: "LEASED",
      observations: "0",
      applications: "0",
      events: "0",
      done_jobs: "0",
    });

    expect((await acceptFetch(db(), run)).fannedIn).toHaveLength(searches.length);
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM run_application`)).n).toBe(
      "3",
    );
  });

  it("T12c: rollback frees the fixed observation id; recompute accepts it exactly once", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t12c");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    const fenced = await mustWin<{
      run_key_id: string;
      observation_id: string;
      provider_epoch: string;
    }>(tx, B.B5A_FENCE, [run.runId, run.generation]);
    const derived = await mustWin<{ provider_id: string; route_class: string }>(
      tx,
      B.B5A_DERIVE_KEY,
      [fenced.run_key_id],
    );
    await mustWin(tx, B.B5B_EPOCH_FENCE, [
      derived.provider_id,
      fenced.provider_epoch,
      derived.route_class,
    ]);
    await mustWin(tx, B.B5C_OBSERVATION, [
      fenced.observation_id,
      fenced.run_key_id,
      run.runId,
      new Date().toISOString(),
    ]);
    await terminateConnection(db(), raw);

    expect(
      await db().rows(`SELECT * FROM observation WHERE observation_id = $1`, [run.observationId]),
    ).toEqual([]);
    await acceptFetch(db(), run, { capturedAt: new Date(Date.now() + 1_000) });
    const count = await db().one<{ observations: string; snapshots: string }>(
      `SELECT (SELECT count(*) FROM observation WHERE observation_id = $1) AS observations,
              (SELECT count(*) FROM availability_snapshot WHERE observation_id = $1) AS snapshots`,
      [run.observationId],
    );
    expect(count).toEqual({ observations: "1", snapshots: "1" });
  });

  it("T36: a delivery cannot redirect run A's failure effects onto key B", async () => {
    await seedProvider(db());
    const keyA = await fetchKey(db(), "st_t36_a");
    const keyB = await fetchKey(db(), "st_t36_b");
    const searchA = await createSearch(db(), 0, { reserve: 1 });
    const searchB = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), searchA, keyA);
    await subscribe(db(), searchB, keyB);

    // failRun takes only run identity + generation; the key used by B5F_EFFECTS comes
    // exclusively from B5F_FENCE.RETURNING, so there is no caller slot for key B.
    await failRun(db(), await dispatchRun(db(), keyA));
    expect(
      await db().one(`SELECT state FROM search_job WHERE search_id = $1`, [searchB.searchId]),
    ).toEqual({ state: "PENDING" });
    expect(
      await db().one(`SELECT state FROM run_subscription WHERE search_id = $1`, [searchB.searchId]),
    ).toEqual({ state: "LIVE" });
    expect(
      await db().rows(`SELECT * FROM search_event WHERE search_id = $1`, [searchB.searchId]),
    ).toEqual([]);
  });
});

describe("tier 4 — B8 crash window", () => {
  const db = useDatabase();

  it("T10: result insert and terminal status roll back together when the backend dies", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t10");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    await acceptFetch(db(), await dispatchRun(db(), key));
    const claim = await db().one<{ agg_generation: number; agg_requested_rev: string }>(
      B.B7_CLAIM.text,
      [search.searchId, "1 minute"],
    );
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    expect(
      await stageTerminalization(
        tx,
        search.searchId,
        claim.agg_generation,
        claim.agg_requested_rev,
      ),
    ).toEqual({ status: "COMPLETE", cause: null });
    await terminateConnection(db(), raw);

    const visible = await db().one(
      `SELECT status,
              (SELECT count(*) FROM search_result_version WHERE search_id = $1) AS versions
       FROM search WHERE search_id = $1`,
      [search.searchId],
    );
    expect(visible).toEqual({ status: "PENDING_SCHEDULE", versions: "0" });

    // The process died before B7_RELEASE too. Move the advisory lease into the past so
    // the next claimant can retry the still-unprocessed revision without waiting.
    await expireAggregationLease(db(), search.searchId);
    expect(await terminalize(db(), search.searchId)).toEqual({ status: "COMPLETE", cause: null });
  });
});

describe("tier 4 — sweeper recovery windows", () => {
  const db = useDatabase();

  it("T15: a PUBLISHED outbox cannot strand an aged job whose broker message vanished", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t15");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const created = await db().one<{ outbox_id: string }>(
      `SELECT outbox_id FROM outbox WHERE job_id = $1`,
      [sub.jobId],
    );
    expect(await markOutboxPublished(db(), created.outbox_id)).toHaveLength(1);
    await db().query(
      `UPDATE search_job SET created_at = now() - interval '1 hour' WHERE job_id = $1`,
      [sub.jobId],
    );

    expect(await runQuery(db(), B.SWEEP_REARM_JOBS, ["1 minute"]).then((r) => r.rows)).toHaveLength(
      1,
    );
    expect(
      await db().rows(`SELECT state FROM outbox WHERE job_id = $1 ORDER BY created_at`, [
        sub.jobId,
      ]),
    ).toEqual([{ state: "PUBLISHED" }, { state: "PENDING" }]);
  });
});

describe("tier 4 — Redis crash/fence windows", () => {
  const db = useDatabase();

  it("T13: losing the semaphore fence aborts the in-flight owner and admits a successor", async () => {
    expect(
      await redis().eval(SEMAPHORE_ACQUIRE, ["sem:amc", "sem:amc:gen"], ["worker-a", 60_000]),
    ).toBe(1);
    await redis().command("DEL", "sem:amc");
    expect(
      await redis().eval(SEMAPHORE_ACQUIRE, ["sem:amc", "sem:amc:gen"], ["worker-b", 60_000]),
    ).toBe(2);

    const request = new AbortController();
    expect(
      await heartbeatSemaphoreOrAbort(redis(), "sem:amc", "worker-a", 1, 60_000, request),
    ).toBe(false);
    expect(request.signal.aborted).toBe(true);
    expect(await redis().eval(SEMAPHORE_RELEASE, ["sem:amc"], ["worker-a", 1])).toBe(0);
    expect(await redis().eval(SEMAPHORE_RELEASE, ["sem:amc"], ["worker-b", 2])).toBe(1);
  });

  it("T40-crash: a backend death mid-halt leaves nothing partial; the retry halts fully", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t40crash");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    const staged = await stageProviderControlTransition(tx, PROVIDER, {
      kind: "UPSTREAM_QUEUED",
    });
    expect(staged.state).toBe("HALTED");
    await terminateConnection(db(), raw);

    // all-or-nothing: the fence, the status upsert, the generation bumps, and the
    // aggregation request rolled back together with the killed backend
    const after = await db().one(
      `SELECT (SELECT epoch FROM provider_fence WHERE provider_id = $1) AS epoch,
              (SELECT count(*) FROM provider_status) AS status_rows,
              (SELECT generation FROM provider_run WHERE run_id = $2) AS run_generation,
              (SELECT agg_requested_rev FROM search WHERE search_id = $3) AS agg_rev`,
      [PROVIDER, run.runId, search.searchId],
    );
    expect(after).toEqual({
      epoch: "0",
      status_rows: "0",
      run_generation: run.generation,
      agg_rev: "0",
    });

    const retried = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "UPSTREAM_QUEUED",
    });
    expect(retried.state).toBe("HALTED");
    expect(Number(retried.epoch)).toBe(1);
    expect(retried.fencedRunIds).toContain(run.runId);
    expect(retried.aggregatedSearchIds).toContain(search.searchId);
  });

  it("T44-crash: a backend death between fence bump and scope open fails closed; the retry reopens", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t44crash");
    await applyProviderControlTransition(db(), PROVIDER, { kind: "LEGAL_KILL_SWITCH" });
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    const staged = await stageReopenProviderScope(tx, PROVIDER, "");
    expect(Number(staged.epoch)).toBe(2);
    await terminateConnection(db(), raw);

    // the bump rolled back with the transaction: still halted under the old epoch
    const after = await db().one(
      `SELECT (SELECT epoch FROM provider_fence WHERE provider_id = $1) AS epoch,
              (SELECT state FROM provider_status WHERE provider_id = $1) AS state`,
      [PROVIDER],
    );
    expect(after).toEqual({ epoch: "1", state: "HALTED" });

    const reopened = await reopenProviderScope(db(), PROVIDER, "");
    expect(Number(reopened.epoch)).toBe(2);
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
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

  it("a stale OPEN control copy never dispatches: Postgres authority corrects it, B4 stays closed", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_stale");
    const stateKey = providerStateCacheKey(PROVIDER, "seat");
    await redis().hset(stateKey, { state: "OPEN" }); // written before the halt: stale by definition
    await applyProviderControlTransition(db(), PROVIDER, { kind: "UPSTREAM_BLOCKED" });

    // the stale copy still reads OPEN — the copy is a fast pre-check, not the authority
    expect(providerStateOrHalted(await redis().hget(stateKey, "state"))).toBe("OPEN");
    // refreshing against Postgres authority corrects the copy
    expect(await refreshProviderState(redis(), db(), PROVIDER, "seat")).toBe("HALTED");
    expect(await redis().hget(stateKey, "state")).toBe("HALTED");

    // and even while the copy was stale, the durable authority blocked dispatch
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);
    expect((await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows).toHaveLength(
      0,
    );
  });

  it("missing, malformed, and unreadable control reads fail closed, never OPEN", async () => {
    // a missing copy is refreshed from Postgres authority
    await seedProvider(db());
    expect(await readProviderControlState(redis(), db(), PROVIDER, "seat")).toBe("OPEN");
    expect(await redis().hget(providerStateCacheKey(PROVIDER, "seat"), "state")).toBe("OPEN");

    // an unrecognized cached value is treated as HALTED, never refreshed into a guess
    await redis().hset(providerStateCacheKey(PROVIDER, "seat"), { state: "banana" });
    expect(await readProviderControlState(redis(), db(), PROVIDER, "seat")).toBe("HALTED");

    // an unreadable authority fails the read HALTED rather than defaulting to OPEN
    const unreachable: ProviderStateSource = {
      query: () => {
        throw new Error("Postgres unreachable");
      },
    };
    await redis().flushAll();
    expect(await readProviderControlState(redis(), unreachable, PROVIDER, "seat")).toBe("HALTED");
  });

  it("T18: full Redis loss is fail-closed, never an implicit OPEN", async () => {
    await seedProvider(db());
    const stateKey = providerStateCacheKey(PROVIDER, "seat");
    await redis().hset(stateKey, { state: "OPEN" });
    expect(providerStateOrHalted(await redis().hget(stateKey, "state"))).toBe("OPEN");

    await redis().flushAll();
    expect(providerStateOrHalted(await redis().hget(stateKey, "state"))).toBe("HALTED");
    expect(await refreshProviderState(redis(), db(), PROVIDER, "seat")).toBe("OPEN");
    expect(providerStateOrHalted(await redis().hget(stateKey, "state"))).toBe("OPEN");

    expect(await redis().eval(TOKEN_BUCKET_INIT_EMPTY, ["bucket:amc"], [Date.now()])).toBe(1);
    expect(await redis().hget("bucket:amc", "tokens")).toBe("0");
    // Re-initialization never grants a fresh burst or overwrites live pacing state.
    expect(await redis().eval(TOKEN_BUCKET_INIT_EMPTY, ["bucket:amc"], [Date.now()])).toBe(0);
  });

  it("T18b: full Redis loss resets a nonterminal watermark and rebuilds its stream", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t18b");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    await acceptFetch(db(), await dispatchRun(db(), key));
    expect(await projectNextEvent(db(), redis(), search.searchId)).toBe(1);

    await redis().flushAll();
    expect(await runQuery(db(), B.B10_RESET_EVENT_WATERMARK, []).then((r) => r.rows)).toEqual([
      { search_id: search.searchId },
    ]);
    expect(await projectNextEvent(db(), redis(), search.searchId)).toBe(1);
    expect(await redis().xrange(`search:${search.searchId}`, "-", "+")).toHaveLength(1);
  });

  it("T23: retry after XADD-before-watermark detects the exact entry and continues", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t23");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    await acceptFetch(db(), await dispatchRun(db(), key));

    const event = (await runQuery(db(), B.B10_UNPROJECTED_EVENTS, [search.searchId])).rows[0] as {
      seq: string;
      type: string;
      payload: unknown;
    };
    // The process disappears here: Redis has seq 1, Postgres still says projected 0.
    await redis().xadd(`search:${search.searchId}`, "1-0", {
      type: "FETCH_ACCEPTED",
      payload: "{}",
    });
    expect(await projectEvent(db(), redis(), search.searchId, event)).toBe(1);
    // A second projector that read the same event before the first advanced is also a
    // success: it observes the existing entry and the winner's watermark.
    expect(await projectEvent(db(), redis(), search.searchId, event)).toBe(1);
    expect(await redis().xrange(`search:${search.searchId}`, "-", "+")).toHaveLength(1);
    expect(
      (
        await db().one(`SELECT projected_through FROM search WHERE search_id = $1`, [
          search.searchId,
        ])
      ).projected_through,
    ).toBe("1");
  });

  it("T39: an interior stream gap rebuilds through a replacement key and atomic rename", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 0, { reserve: 2 });
    for (const showtimeId of ["st_t39_a", "st_t39_b"]) {
      const key = await fetchKey(db(), showtimeId);
      await subscribe(db(), search, key);
      await acceptFetch(db(), await dispatchRun(db(), key));
    }
    const unrelated = await createSearch(db(), 0, { reserve: 1 });
    const unrelatedKey = await fetchKey(db(), "st_t39_unrelated");
    await subscribe(db(), unrelated, unrelatedKey);
    await acceptFetch(db(), await dispatchRun(db(), unrelatedKey));
    expect(await projectNextEvent(db(), redis(), unrelated.searchId)).toBe(1);

    // A live stream with seq 2 but no seq 1 cannot accept replay-in-place: XADD rejects 1.
    await redis().xadd(`search:${search.searchId}`, "2-0", { type: "FETCH_ACCEPTED" });
    await expect(projectNextEvent(db(), redis(), search.searchId)).rejects.toThrow(
      "interior stream gap",
    );
    expect(await rebuildEventStream(db(), redis(), search.searchId, "test")).toBe(2);
    expect(await redis().xrange(`search:${search.searchId}`, "-", "+")).toHaveLength(2);
    expect(
      (
        await db().one(`SELECT projected_through FROM search WHERE search_id = $1`, [
          search.searchId,
        ])
      ).projected_through,
    ).toBe("2");
    expect(
      (
        await db().one(`SELECT projected_through FROM search WHERE search_id = $1`, [
          unrelated.searchId,
        ])
      ).projected_through,
    ).toBe("1");
    expect(await redis().xrange(`search:${unrelated.searchId}`, "-", "+")).toHaveLength(1);
  });
});
