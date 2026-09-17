import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { SNAPSHOT_CAS } from "../src/redis.js";
import { stageFindOrCreateRun } from "../src/transactions.js";
import { expireSearch } from "./support/clock.js";
import {
  acceptFetch,
  acceptSchedule,
  createSearch,
  dispatchRun,
  fetchKey,
  mustWin,
  PROVIDER,
  runQuery,
  scheduleKey,
  seedProvider,
  stageFetchAcceptance,
  stageTerminalization,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import { Interleaver } from "./support/interleave.js";
import { session, useDatabase } from "./support/pg.js";
import { useRedis } from "./support/redis.js";

/** Tier 5 — every ordering is held by a database lock or named advisory barrier. */

const redis = useRedis();

describe("tier 5 — creation and ownership races", () => {
  const db = useDatabase();

  it("T3b: concurrent creators converge on one key and one live run", async () => {
    await seedProvider(db());
    const aRaw = await db().connect();
    const bRaw = await db().connect();
    const a = session(aRaw);
    const b = session(bRaw);
    const interleave = await Interleaver.create(db(), []);
    const bPid = await interleave.backendPid(bRaw);
    const keyValues = [
      "k_fetch_amc_st_race",
      "SHOWTIME_FETCH",
      PROVIDER,
      "seat",
      "st_race",
      null,
      null,
    ] as const;

    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await mustWin(a, B.RUN_KEY_UPSERT, keyValues);
      const bKey = runQuery(b, B.RUN_KEY_UPSERT, keyValues);
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      expect((await bKey).rows).toHaveLength(1);
      await b.query("COMMIT");

      await a.query("BEGIN");
      await b.query("BEGIN");
      await mustWin(a, B.RUN_CREATE, ["run_creator_a", keyValues[0], "obs_creator_a", null]);
      const bRun = runQuery(b, B.RUN_CREATE, [
        "run_creator_b",
        keyValues[0],
        "obs_creator_b",
        null,
      ]);
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      // S44: RUN_CREATE is now DO UPDATE ... RETURNING on conflict (dispatch_rank coalescing),
      // so the loser returns the winner's row instead of zero rows. stageFindOrCreateRun
      // detects this via run_id != own runId; the low-level boundary still converges to one live run.
      expect((await bRun).rows).toEqual([{ run_id: "run_creator_a" }]);
      await b.query("COMMIT");

      const counts = await db().one<{ keys: string; runs: string }>(
        `SELECT (SELECT count(*) FROM run_key WHERE run_key_id = $1) AS keys,
                (SELECT count(*) FROM provider_run WHERE run_key_id = $1
                  AND state IN ('PENDING','LEASED')) AS runs`,
        [keyValues[0]],
      );
      expect(counts).toEqual({ keys: "1", runs: "1" });
    } finally {
      await interleave.close();
    }
  });

  it("S30: concurrent find-or-create converges on one live run + one dispatch outbox", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_race");
    const aRaw = await db().connect();
    const bRaw = await db().connect();
    const a = session(aRaw);
    const b = session(bRaw);
    const interleave = await Interleaver.create(db(), []);
    const bPid = await interleave.backendPid(bRaw);

    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const aResult = await stageFindOrCreateRun(a, { runKeyId: key.runKeyId });
      const bPending = stageFindOrCreateRun(b, { runKeyId: key.runKeyId });
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      expect(aResult).toEqual({ runId: expect.any(String), created: true });
      expect(await bPending).toEqual({ runId: null, created: false });
      await b.query("COMMIT");

      const counts = await db().one<{ runs: string; outbox: string }>(
        `SELECT (SELECT count(*) FROM provider_run WHERE run_key_id = $1 AND state IN ('PENDING','LEASED')) AS runs,
                (SELECT count(*) FROM outbox WHERE run_id IN
                  (SELECT run_id FROM provider_run WHERE run_key_id = $1 AND state IN ('PENDING','LEASED'))) AS outbox`,
        [key.runKeyId],
      );
      expect(counts).toEqual({ runs: "1", outbox: "1" });
    } finally {
      await interleave.close();
    }
  });

  it("T9: concurrent aggregate claims and terminalizations each have exactly one winner", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t9");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    await acceptFetch(db(), await dispatchRun(db(), key));

    const aRaw = await db().connect();
    const bRaw = await db().connect();
    const a = session(aRaw);
    const b = session(bRaw);
    const interleave = await Interleaver.create(db(), []);
    const bPid = await interleave.backendPid(bRaw);

    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const firstClaim = await mustWin<{ agg_generation: number; agg_requested_rev: string }>(
        a,
        B.B7_CLAIM,
        [search.searchId, "1 minute"],
      );
      const losingClaim = runQuery(b, B.B7_CLAIM, [search.searchId, "1 minute"]);
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      expect((await losingClaim).rows).toEqual([]);
      await b.query("ROLLBACK");

      await a.query("BEGIN");
      const winner = await stageTerminalization(
        a,
        search.searchId,
        firstClaim.agg_generation,
        firstClaim.agg_requested_rev,
      );
      expect(winner).toEqual({ status: "COMPLETE", cause: null });

      await b.query("BEGIN");
      const losingTerminal = runQuery(b, B.B8_TERMINALIZE, [
        search.searchId,
        firstClaim.agg_generation,
        firstClaim.agg_requested_rev,
      ]);
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      expect((await losingTerminal).rows).toEqual([]);
      await b.query("ROLLBACK");
      await runQuery(db(), B.B7_RELEASE, [
        search.searchId,
        firstClaim.agg_requested_rev,
        firstClaim.agg_generation,
      ]);

      const final = await db().one(
        `SELECT status,
                (SELECT count(*) FROM search_result_version WHERE search_id = $1) AS versions
         FROM search WHERE search_id = $1`,
        [search.searchId],
      );
      expect(final).toEqual({ status: "COMPLETE", versions: "1" });
    } finally {
      await interleave.close();
    }
  });
});

describe("tier 5 — stale aggregate race", () => {
  const db = useDatabase();

  it("T9b/T11: A reads N, B commits N+1, and A cannot freeze or mark N current", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_stale_aggregate");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    await expireSearch(db(), search.searchId);

    const aRaw = await db().connect();
    const a = session(aRaw);
    const interleave = await Interleaver.create(db(), ["aggregate-read-n"]);
    let claim: { agg_generation: number; agg_requested_rev: string } | undefined;

    try {
      const stalePass = (async () => {
        const captured = await mustWin<{ agg_generation: number; agg_requested_rev: string }>(
          a,
          B.B7_CLAIM,
          [search.searchId, "1 minute"],
        );
        claim = captured;
        await interleave.at(aRaw, "aggregate-read-n");
        return runQuery(a, B.B8_TERMINALIZE, [
          search.searchId,
          captured.agg_generation,
          captured.agg_requested_rev,
        ]);
      })();

      await interleave.reached("aggregate-read-n");
      await acceptFetch(db(), run); // commits revision N+1 while A is frozen at N
      await interleave.release("aggregate-read-n");
      expect((await stalePass).rows).toEqual([]);
      if (!claim) throw new Error("aggregate pass did not capture its claim");

      await runQuery(db(), B.B7_RELEASE, [
        search.searchId,
        claim.agg_requested_rev,
        claim.agg_generation,
      ]);
      const revisions = await db().one<{ agg_processed_rev: string; agg_requested_rev: string }>(
        `SELECT agg_processed_rev, agg_requested_rev FROM search WHERE search_id = $1`,
        [search.searchId],
      );
      expect(Number(revisions.agg_processed_rev)).toBeLessThan(Number(revisions.agg_requested_rev));
      expect(await terminalize(db(), search.searchId)).toEqual({ status: "COMPLETE", cause: null });
    } finally {
      await interleave.close();
    }
  });
});

describe("tier 5 — fan-in versus terminalization", () => {
  const db = useDatabase();

  it("T35: terminalization commits while fan-in waits; only the live subscriber is charged", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_fanin_race");
    const terminalSearch = await createSearch(db(), 0, { reserve: 1 });
    const liveSearch = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), terminalSearch, key);
    await subscribe(db(), liveSearch, key);
    const run = await dispatchRun(db(), key);
    await expireSearch(db(), terminalSearch.searchId);
    const claim = await db().one<{ agg_generation: number; agg_requested_rev: string }>(
      B.B7_CLAIM.text,
      [terminalSearch.searchId, "1 minute"],
    );

    const terminalRaw = await db().connect();
    const fanInRaw = await db().connect();
    const terminalTx = session(terminalRaw);
    const fanInTx = session(fanInRaw);
    const interleave = await Interleaver.create(db(), []);
    const fanInPid = await interleave.backendPid(fanInRaw);

    try {
      await terminalTx.query("BEGIN");
      expect(
        await stageTerminalization(
          terminalTx,
          terminalSearch.searchId,
          claim.agg_generation,
          claim.agg_requested_rev,
        ),
      ).toEqual({ status: "PARTIAL", cause: null });

      await fanInTx.query("BEGIN");
      const accepting = stageFetchAcceptance(fanInTx, run);
      await interleave.waitUntilBlocked(fanInPid);
      await terminalTx.query("COMMIT");
      const accepted = await accepting;
      await fanInTx.query("COMMIT");
      expect(accepted.fannedIn.map((row) => row.search_id)).toEqual([liveSearch.searchId]);

      await runQuery(db(), B.B7_RELEASE, [
        terminalSearch.searchId,
        claim.agg_requested_rev,
        claim.agg_generation,
      ]);
      expect(
        await db().rows(`SELECT search_id FROM run_application WHERE run_id = $1`, [run.runId]),
      ).toEqual([{ search_id: liveSearch.searchId }]);
      expect(
        await db().rows(
          `SELECT type FROM search_event WHERE search_id = $1 AND type = 'FETCH_ACCEPTED'`,
          [terminalSearch.searchId],
        ),
      ).toEqual([]);
      expect(
        (
          await db().one(`SELECT pending_cost FROM provider_admission WHERE provider_id = $1`, [
            PROVIDER,
          ])
        ).pending_cost,
      ).toBe("0");
    } finally {
      await interleave.close();
    }
  });

  it("T7: a schedule response after one parent terminalizes still expands the other parent", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_t7", "2026-08-02");
    const terminalSearch = await createSearch(db(), 1, { reserve: 1 });
    const liveSearch = await createSearch(db(), 1, { reserve: 1 });
    await subscribe(db(), terminalSearch, key);
    await subscribe(db(), liveSearch, key);
    const run = await dispatchRun(db(), key);

    await expireSearch(db(), terminalSearch.searchId);
    expect((await terminalize(db(), terminalSearch.searchId))?.status).toBe("PARTIAL");
    const accepted = await acceptSchedule(db(), run, [
      {
        showtimeId: "st_t7_expanded",
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      },
    ]);
    expect(accepted.expandedFor).toEqual([liveSearch.searchId]);

    expect(
      await db().rows(
        `SELECT search_id FROM search_job
         WHERE kind = 'SHOWTIME_FETCH' ORDER BY search_id`,
      ),
    ).toEqual([{ search_id: liveSearch.searchId }]);
    expect(
      await db().rows(
        `SELECT search_id FROM run_application WHERE run_id = $1 ORDER BY search_id`,
        [run.runId],
      ),
    ).toEqual([{ search_id: liveSearch.searchId }]);
  });
});

describe("tier 5 — admission headroom race", () => {
  const db = useDatabase();

  it("T32: two upward reconciliations serialize and cannot both consume the same headroom", async () => {
    await seedProvider(db(), { pendingCostLimit: 4 });
    const firstSearch = await createSearch(db(), 1, { reserve: 1 });
    const secondSearch = await createSearch(db(), 1, { reserve: 1 });
    const firstKey = await scheduleKey(db(), "theatre_headroom_a", "2026-08-02");
    const secondKey = await scheduleKey(db(), "theatre_headroom_b", "2026-08-02");
    await subscribe(db(), firstSearch, firstKey);
    await subscribe(db(), secondSearch, secondKey);

    // S36 clean cutover: per-schedule filtered count is recorded first (single writer
    // WHERE schedule_match_count IS NULL), then the search-wide reconciliation serializes
    // on provider_admission + admission_reservation exactly as B6_RECONCILE_STAGE2 once did.
    await mustWin(db(), B.B6_SET_SCHEDULE_MATCH_COUNT, [
      firstKey.runKeyId,
      firstSearch.searchId,
      3,
    ]);
    await mustWin(db(), B.B6_SET_SCHEDULE_MATCH_COUNT, [
      secondKey.runKeyId,
      secondSearch.searchId,
      3,
    ]);

    const aRaw = await db().connect();
    const bRaw = await db().connect();
    const a = session(aRaw);
    const b = session(bRaw);
    const interleave = await Interleaver.create(db(), []);
    const bPid = await interleave.backendPid(bRaw);

    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const first = await runQuery(a, B.B6_RECONCILE_SEARCH_WIDE, [PROVIDER, firstSearch.searchId]);
      expect(first.rows).toHaveLength(1);

      const second = runQuery(b, B.B6_RECONCILE_SEARCH_WIDE, [PROVIDER, secondSearch.searchId]);
      await interleave.waitUntilBlocked(bPid);
      await a.query("COMMIT");
      expect((await second).rows).toEqual([]);
      await mustWin(b, B.B6_DENY_CAPACITY, [secondSearch.searchId]);
      await b.query("COMMIT");

      const admission = await db().one<{ pending_cost: string; pending_cost_limit: string }>(
        `SELECT pending_cost, pending_cost_limit FROM provider_admission WHERE provider_id = $1`,
        [PROVIDER],
      );
      expect(admission).toEqual({ pending_cost: "4", pending_cost_limit: "4" });
      const reservations = await db().rows(
        `SELECT search_id, reserved_total FROM admission_reservation ORDER BY reserved_total DESC`,
      );
      expect(reservations.map((row) => row.reserved_total)).toEqual(["3", "1"]);
    } finally {
      await interleave.close();
    }
  });
});

describe("tier 5 — snapshot projector race", () => {
  const db = useDatabase();

  it("T20: Redis CAS and the Postgres watermark both reject A after B projects N+1", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_projector_race");
    const firstSearch = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), firstSearch, key);
    const first = await acceptFetch(db(), await dispatchRun(db(), key));

    const aRaw = await db().connect();
    const a = session(aRaw);
    const interleave = await Interleaver.create(db(), ["projector-a-read-n"]);

    try {
      const staleProjection = (async () => {
        await interleave.at(aRaw, "projector-a-read-n");
        const cacheWrite = await redis().eval(
          SNAPSHOT_CAS,
          [`bitmap:${key.runKeyId}`],
          [first.acceptedRevision, "bitmap-n"],
        );
        const watermark = await runQuery(a, B.B10_ADVANCE_SNAPSHOT_WATERMARK, [
          key.runKeyId,
          first.acceptedRevision,
        ]);
        return { cacheWrite, watermark: watermark.rows };
      })();

      await interleave.reached("projector-a-read-n");
      const secondSearch = await createSearch(db(), 0, { reserve: 1 });
      await subscribe(db(), secondSearch, key);
      const second = await acceptFetch(db(), await dispatchRun(db(), key));
      expect(second.acceptedRevision).toBe("2");
      expect(
        await redis().eval(SNAPSHOT_CAS, [`bitmap:${key.runKeyId}`], [2, "bitmap-n-plus-1"]),
      ).toBe(1);
      expect(
        await runQuery(db(), B.B10_ADVANCE_SNAPSHOT_WATERMARK, [key.runKeyId, 2]).then(
          (result) => result.rows,
        ),
      ).toHaveLength(1);

      await interleave.release("projector-a-read-n");
      expect(await staleProjection).toEqual({ cacheWrite: 0, watermark: [] });
      expect(await redis().hget(`bitmap:${key.runKeyId}`, "rev")).toBe("2");
      expect(await redis().hget(`bitmap:${key.runKeyId}`, "bitmap")).toBe("bitmap-n-plus-1");
      expect(
        (
          await db().one(`SELECT projected_revision FROM run_key WHERE run_key_id = $1`, [
            key.runKeyId,
          ])
        ).projected_revision,
      ).toBe("2");
    } finally {
      await interleave.close();
    }
  });
});
