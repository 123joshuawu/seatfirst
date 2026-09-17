import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { checkInvariants } from "../src/invariants.js";
import { readRecheckOutcome } from "../src/repository.js";
import {
  acceptRecheckRun,
  NonceReplayError,
  stageRecheckComplete,
  stageRecheckFail,
} from "../src/transactions.js";

import { mustWin, seedProvider } from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the S22 recheck durability surface (verification items 2 and 12).
 *
 * `stageRecheckRun` (wrapped by `acceptRecheckRun`) creates one RECHECK `run_key`, one
 * `PENDING` `provider_run` (with a minted `observation_id` and the decided `priority` 2),
 * one `RUN`-target outbox row, and consumes the nonce — in one transaction, with the nonce
 * consumed LAST so a replay rolls the whole creation back. `stageRecheckComplete` fences on
 * `state='LEASED' AND generation`, so a halted/reclaimed run yields zero rows and no
 * outcome; `stageRecheckFail` writes the UNAVAILABLE outcome for an already-FAILED run.
 *
 * Every test ends with the full invariant sweep in `useDatabase()`, so the two hand-seeded
 * S22.6 violations below are removed within the same test that names them (verification 12).
 */

const PROVIDER = "amc";

function recheckInput(nonceId: string) {
  return {
    providerId: PROVIDER,
    showtimeId: "st1",
    placementKey: "p1",
    // D1 (S31.4) — the 0-based dense geometry the recheck verdict re-verifies.
    row: 2,
    startCol: 1,
    rowSpan: 2,
    count: 4,
    nonceId,
  };
}

describe("tier 2 — showtimes.recheck (S22)", () => {
  const db = useDatabase();

  it("commits one key, one PENDING run, one outbox row, and consumes the nonce", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));

    const key = await db().one<{
      kind: string;
      route_class: string;
      showtime_id: string | null;
      theatre_id: string | null;
      local_date: string | null;
      recheck_placement: unknown;
    }>(
      `SELECT kind, route_class, showtime_id, theatre_id, local_date, recheck_placement
       FROM run_key WHERE kind = 'RECHECK'`,
    );
    expect(key.kind).toBe("RECHECK");
    expect(key.route_class).toBe("seat");
    expect(key.showtime_id).toBe("st1");
    expect(key.theatre_id).toBeNull();
    expect(key.local_date).toBeNull();
    expect(key.recheck_placement).toEqual({
      placementKey: "p1",
      row: 2,
      startCol: 1,
      rowSpan: 2,
      count: 4,
    });

    const run = await db().one<{ state: string; observation_id: string | null; priority: number }>(
      `SELECT state, observation_id, priority FROM provider_run WHERE run_id = $1`,
      [runId],
    );
    expect(run.state).toBe("PENDING");
    expect(run.observation_id).not.toBeNull();
    expect(run.priority).toBe(2);

    const outbox = await db().one<{ target_kind: string }>(
      `SELECT target_kind FROM outbox WHERE run_id = $1`,
      [runId],
    );
    expect(outbox.target_kind).toBe("RUN");

    const nonce = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM consumed_nonce WHERE nonce_id = 'n1'`,
    );
    expect(nonce.n).toBe("1");
  });

  it("two rechecks of the same showtime create distinct runs (per-call keys)", async () => {
    await seedProvider(db());
    const a = await acceptRecheckRun(db(), recheckInput("n1"));
    const b = await acceptRecheckRun(db(), recheckInput("n2"));
    expect(a.runId).not.toBe(b.runId);
    const keys = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM run_key WHERE kind = 'RECHECK'`,
    );
    expect(keys.n).toBe("2");
  });

  it("a pre-consumed nonce rolls back the whole creation — no orphan key/run/outbox", async () => {
    await seedProvider(db());
    await mustWin(db(), B.NONCE_CONSUME, ["n1"]);
    await expect(acceptRecheckRun(db(), recheckInput("n1"))).rejects.toBeInstanceOf(
      NonceReplayError,
    );
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM run_key`)).n).toBe("0");
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM provider_run`)).n).toBe("0");
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM outbox`)).n).toBe("0");
  });

  it("a replayed nonce after a successful run is rejected and leaves exactly one run", async () => {
    await seedProvider(db());
    await acceptRecheckRun(db(), recheckInput("n1"));
    await expect(acceptRecheckRun(db(), recheckInput("n1"))).rejects.toBeInstanceOf(
      NonceReplayError,
    );
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM provider_run`)).n).toBe("1");
  });

  it("stageRecheckComplete fences a LEASED run to DONE and writes the AVAILABLE outcome", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);

    const fenced = await stageRecheckComplete(
      db(),
      { runId, generation: leased.generation },
      "AVAILABLE",
      { placementKey: "p1" },
    );
    expect(fenced).toBe(true);

    const run = await db().one<{ state: string }>(
      `SELECT state FROM provider_run WHERE run_id = $1`,
      [runId],
    );
    expect(run.state).toBe("DONE");
    expect(await readRecheckOutcome(db(), runId)).toEqual({
      status: "AVAILABLE",
      payload: { placementKey: "p1" },
    });
  });

  it("stageRecheckComplete with status GONE writes the GONE outcome", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);

    const fenced = await stageRecheckComplete(
      db(),
      { runId, generation: leased.generation },
      "GONE",
      { placementKey: "p1" },
    );
    expect(fenced).toBe(true);
    expect(await readRecheckOutcome(db(), runId)).toEqual({
      status: "GONE",
      payload: { placementKey: "p1" },
    });
  });

  it("stageRecheckComplete on a non-LEASED run fences to zero rows and writes no outcome", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));
    // The run is PENDING (generation 0), never leased — the fence must reject.
    const fenced = await stageRecheckComplete(db(), { runId, generation: 0 }, "AVAILABLE", {
      placementKey: "p1",
    });
    expect(fenced).toBe(false);
    expect(await readRecheckOutcome(db(), runId)).toBeNull();
  });

  it("stageRecheckFail writes the UNAVAILABLE outcome for a FAILED run", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));
    // The actor's failRun already transitioned the run to FAILED before this is called.
    await db().query(`UPDATE provider_run SET state = 'FAILED' WHERE run_id = $1`, [runId]);
    await stageRecheckFail(db(), runId, "UPSTREAM_CHANGED");
    expect(await readRecheckOutcome(db(), runId)).toEqual({
      status: "UNAVAILABLE",
      payload: { cause: "UPSTREAM_CHANGED" },
    });
  });

  it("the invariant sweep names a hand-seeded outcome whose run is not terminal", async () => {
    await seedProvider(db());
    const { runId } = await acceptRecheckRun(db(), recheckInput("n1"));
    await mustWin(db(), B.B2_LEASE_RUN, [runId, "5 minutes"]);
    // Seed the S22.6 violation: an outcome whose provider_run is LEASED, not terminal.
    await db().query(
      `INSERT INTO recheck_outcome (run_id, status, payload) VALUES ($1, 'AVAILABLE', '{}'::jsonb)`,
      [runId],
    );

    const seeded = await checkInvariants(db());
    expect(seeded.map((v) => v.invariant)).toContain("recheck_outcome_run_is_terminal");

    await db().query(`DELETE FROM recheck_outcome WHERE run_id = $1`, [runId]);
    expect((await checkInvariants(db())).map((v) => v.invariant)).toEqual([]);
  });

  it("the invariant sweep names a hand-seeded projecting RECHECK key", async () => {
    await seedProvider(db());
    await acceptRecheckRun(db(), recheckInput("n1"));
    // Seed the S22.6 violation: a RECHECK key with accepted_revision > 0.
    await db().query(`UPDATE run_key SET accepted_revision = 1 WHERE kind = 'RECHECK'`);

    const seeded = await checkInvariants(db());
    expect(seeded.map((v) => v.invariant)).toContain("recheck_key_never_projects");

    await db().query(`UPDATE run_key SET accepted_revision = 0 WHERE kind = 'RECHECK'`);
    expect((await checkInvariants(db())).map((v) => v.invariant)).toEqual([]);
  });
});
