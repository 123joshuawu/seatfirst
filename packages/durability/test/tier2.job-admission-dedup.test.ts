import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import {
  findOrCreateRun,
  SNAPSHOT_ADOPTION_TTL_MS,
  stageAdoptOrCreateShowtimeWork,
  stageFindOrCreateRun,
} from "../src/transactions.js";

import {
  acceptFetch,
  createSearch,
  dispatchRun,
  fetchKey,
  mustWin,
  PROVIDER,
  seedProvider,
  subscribe,
} from "./support/fixtures.js";
import { session, useDatabase } from "./support/pg.js";
/**
 * Tier 2 — S30 job-branch admission/dedup: `findOrCreateRun` creates exactly one live
 * `provider_run` plus its dispatch outbox, or coalesces onto the existing live run, and never
 * reuses a completed (`DONE`) observation (ADR 0006 §A.1 "seats: never cached").
 *
 * Every test ends with the invariant sweep in `useDatabase()`.
 */

describe("tier 2 — job admission/dedup (S30)", () => {
  const db = useDatabase();

  it("creates a PENDING run + RUN outbox when no live run exists (S30 item 1)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_create");

    const result = await findOrCreateRun(db(), { runKeyId: key.runKeyId });

    expect(result.created).toBe(true);
    expect(result.runId).toEqual(expect.any(String));
    const run = await db().one<{ state: string; observation_id: string | null }>(
      `SELECT state, observation_id FROM provider_run WHERE run_id = $1`,
      [result.runId],
    );
    expect(run.state).toBe("PENDING");
    expect(run.observation_id).toEqual(expect.any(String));
    const outbox = await db().one<{ target_kind: string; state: string }>(
      `SELECT target_kind, state FROM outbox WHERE run_id = $1`,
      [result.runId],
    );
    expect(outbox.target_kind).toBe("RUN");
    expect(outbox.state).toBe("PENDING");
  });

  it("coalesces an existing live run — no second run and no second outbox (S30 item 2)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_live");
    const live = await dispatchRun(db(), key); // LEASED, outbox already created by the fixture

    const result = await findOrCreateRun(db(), { runKeyId: key.runKeyId });

    expect(result).toEqual({ runId: null, created: false });
    const runs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(runs.n).toBe("1");
    const outboxes = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1`,
      [live.runId],
    );
    expect(outboxes.n).toBe("1");
  });

  it("creates a fresh run past a DONE run — never reuses the completed observation (ADR 0006 §A.1)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_done");
    const done = await dispatchRun(db(), key);
    await acceptFetch(db(), done); // accepted → DONE, no live run remains

    const before = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(before.n).toBe("1"); // exactly the DONE run

    const result = await findOrCreateRun(db(), { runKeyId: key.runKeyId });

    expect(result.created).toBe(true);
    expect(result.runId).not.toBe(done.runId);
    const after = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(after.n).toBe("2"); // the DONE run + a fresh PENDING run

    const fresh = await db().one<{ state: string }>(
      `SELECT state FROM provider_run WHERE run_id = $1`,
      [result.runId],
    );
    expect(fresh.state).toBe("PENDING");

    // The DONE run's observation was not re-applied: no run_application row points at it.
    const applications = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_application WHERE run_id = $1`,
      [done.runId],
    );
    expect(applications.n).toBe("0");
  });

  it("stageFindOrCreateRun is the BEGIN/COMMIT-free body findOrCreateRun wraps (S30.3)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_foc_stage");
    const raw = await db().connect();
    const tx = session(raw);

    await tx.query("BEGIN");
    const result = await stageFindOrCreateRun(tx, { runKeyId: key.runKeyId });
    // Both effects exist inside the open transaction…
    const inTx = await tx.query(`SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [
      key.runKeyId,
    ]);
    expect(inTx.rows[0]).toEqual({ n: "1" });
    // …and are invisible to the outside until COMMIT.
    const outside = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(outside.n).toBe("0");
    await tx.query("COMMIT");
    expect(result).toEqual({ runId: expect.any(String), created: true });
    const durable = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(durable.n).toBe("1");
  });
});

/**
 * Tier 2 — S61 showtime run micro-cache adoption (ADR 0065): `stageAdoptOrCreateShowtimeWork`
 * adopts a fresh authoritative snapshot without a browser worker run, or falls back to a
 * fresh run when the snapshot is stale or the TTL override excludes it.
 *
 * `stageAdoptOrCreateShowtimeWork` and `SNAPSHOT_ADOPTION_TTL_MS` are imported DIRECTLY
 * from `src/transactions.ts` — not through `support/fixtures.ts` — so these tests bind to
 * the production home of the composition: deleting the S61 transaction would fail this
 * file, not silently re-route through a fixture (same convention as
 * `tier2.provider-fetch-acceptance.test.ts`'s header comment).
 *
 * Every test ends with the invariant sweep in `useDatabase()`.
 */
describe("tier 2 — S61 showtime run micro-cache adoption (ADR 0065)", () => {
  const db = useDatabase();

  /**
   * The shared S61 scenario, built only out of fixtures (boundary statements
   * themselves, per `support/fixtures.ts`'s header comment): search A fetches live and
   * accepts, leaving a just-captured snapshot as the key's latest observation; search B
   * subscribes to the same key and leases its job, ready for adoption. Returns the
   * adoption result plus the handles the assertions need.
   */
  async function adoptScenario(showtimeId: string, ttlOverride?: number) {
    await seedProvider(db());
    const key = await fetchKey(db(), showtimeId);
    const searchA = await createSearch(db(), 1);
    await subscribe(db(), searchA, key);
    const runA = await dispatchRun(db(), key);
    await acceptFetch(db(), runA, { freeCount: 7 });
    const searchB = await createSearch(db(), 1);
    const subB = await subscribe(db(), searchB, key);
    // B5_ADOPT_SHOWTIME_JOB_DONE fences on `state = 'LEASED' AND generation`, so the
    // job must be leased first; the lease bumps generation 0 → 1, and the adoption
    // call carries the post-lease generation.
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_JOB, [
      subB.jobId,
      "5 minutes",
    ]);
    const preReserved = await db().one<{ reserved_remaining: number }>(
      `SELECT reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [searchB.searchId],
    );
    const preSearch = await db().one<{ agg_requested_rev: string }>(
      `SELECT agg_requested_rev FROM search WHERE search_id = $1`,
      [searchB.searchId],
    );
    const result = await stageAdoptOrCreateShowtimeWork(db(), {
      jobId: subB.jobId,
      jobGeneration: leased.generation,
      searchId: searchB.searchId,
      runKeyId: key.runKeyId,
      providerId: PROVIDER,
      ...(ttlOverride !== undefined ? { snapshotAdoptionTtlMs: ttlOverride } : {}),
    });
    return { key, runA, searchA, searchB, subB, preReserved, preSearch, result };
  }

  it("adopts a fresh snapshot with no browser worker run (S61.8)", async () => {
    const { key, runA, searchB, subB, preReserved, preSearch, result } =
      await adoptScenario("st_adopt_hit");

    if (result.outcome !== "ADOPTED") throw new Error(`expected ADOPTED, got ${result.outcome}`);
    expect(result.runId).toBe(runA.runId);
    expect(result.freeCount).toBe(7);

    // No second/browser run was ever dispatched for the key.
    const runs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(runs.n).toBe("1");

    // The historical run is applied to search B …
    const applied = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_application WHERE run_id = $1 AND search_id = $2`,
      [result.runId, searchB.searchId],
    );
    expect(applied.n).toBe("1");

    // … the B5_FANIN mirror transitions all landed: job DONE, subscription SATISFIED …
    const job = await db().one<{ state: string }>(
      `SELECT state FROM search_job WHERE job_id = $1`,
      [subB.jobId],
    );
    expect(job.state).toBe("DONE");
    const sub = await db().one<{ state: string }>(
      `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
      [key.runKeyId, searchB.searchId],
    );
    expect(sub.state).toBe("SATISFIED");

    // … the reservation released exactly one slot …
    const postReserved = await db().one<{ reserved_remaining: number }>(
      `SELECT reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [searchB.searchId],
    );
    expect(Number(postReserved.reserved_remaining)).toBe(
      Number(preReserved.reserved_remaining) - 1,
    );

    // … and FETCH_ACCEPTED fired with gapless rev accounting.
    const event = await db().one<{ type: string; payload: { adopted: boolean } }>(
      `SELECT type, payload FROM search_event WHERE search_id = $1 AND type = 'FETCH_ACCEPTED'`,
      [searchB.searchId],
    );
    expect(event.type).toBe("FETCH_ACCEPTED");
    expect(event.payload.adopted).toBe(true);
    const postSearch = await db().one<{ agg_requested_rev: string }>(
      `SELECT agg_requested_rev FROM search WHERE search_id = $1`,
      [searchB.searchId],
    );
    expect(Number(postSearch.agg_requested_rev)).toBe(Number(preSearch.agg_requested_rev) + 1);
  });

  it("the adopted search is B7-claimable: adoption triggers downstream aggregation (S61.8)", async () => {
    const { searchB, preSearch } = await adoptScenario("st_adopt_b7");

    // agg_requested_rev > agg_processed_rev now holds, so B7's claim boundary picks up
    // the newly-adopted fetch. mustWin throws on zero rows, so reaching the expect
    // proves claimability.
    const claim = await mustWin<{ agg_generation: number; agg_requested_rev: string }>(
      db(),
      B.B7_CLAIM,
      [searchB.searchId, "30 seconds"],
    );
    expect(Number(claim.agg_requested_rev)).toBe(Number(preSearch.agg_requested_rev) + 1);
  });

  it("a stale snapshot (older than SNAPSHOT_ADOPTION_TTL_MS) falls back to a fresh run (S61.6)", async () => {
    // S61.1 policy pin: backend adoption uses the 30s TTL, never the 120s presentation one.
    expect(SNAPSHOT_ADOPTION_TTL_MS).toBe(30_000);
    const { key, runA, result } = await adoptScenario("st_adopt_stale");
    if (result.outcome !== "ADOPTED") throw new Error(`setup adoption failed: ${result.outcome}`);

    // Age the snapshot 1 minute past capture — well beyond the 30s TTL. Only
    // `availability_snapshot.captured_at` needs backdating: B5_FIND_RECENT_SNAPSHOT
    // joins `run_key.latest_observation_id → observation → availability_snapshot` and
    // filters on `snap.captured_at` directly. (This is the one hand-written UPDATE the
    // scenario needs — no fixture backdates a snapshot.)
    await db().query(
      `UPDATE availability_snapshot SET captured_at = now() - interval '1 minute'
       WHERE observation_id = $1`,
      [runA.observationId],
    );

    const searchC = await createSearch(db(), 1);
    const subC = await subscribe(db(), searchC, key);
    const leasedC = await mustWin<{ generation: number }>(db(), B.B2_LEASE_JOB, [
      subC.jobId,
      "5 minutes",
    ]);
    const retry = await stageAdoptOrCreateShowtimeWork(db(), {
      jobId: subC.jobId,
      jobGeneration: leasedC.generation,
      searchId: searchC.searchId,
      runKeyId: key.runKeyId,
      providerId: PROVIDER,
    });

    if (retry.outcome !== "RUN_CREATED")
      throw new Error(`expected RUN_CREATED, got ${retry.outcome}`);
    expect(retry.runId).not.toBeNull();
    expect(retry.runId).not.toBe(runA.runId);
    // The stale cache correctly triggered a live fetch: a second provider_run exists.
    const runs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(runs.n).toBe("2");
  });

  it("snapshotAdoptionTtlMs override disables adoption even for a fresh snapshot", async () => {
    // A negative TTL puts the cutoff in the future, so even the just-captured snapshot
    // is excluded — no dependence on real-clock timing, unlike TTL 0.
    const { key, runA, result } = await adoptScenario("st_adopt_override", -1);

    if (result.outcome !== "RUN_CREATED")
      throw new Error(`expected RUN_CREATED, got ${result.outcome}`);
    expect(result.runId).not.toBeNull();
    expect(result.runId).not.toBe(runA.runId);
    const runs = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`,
      [key.runKeyId],
    );
    expect(runs.n).toBe("2");
  });
});
