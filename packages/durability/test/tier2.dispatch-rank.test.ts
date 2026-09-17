import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { useDatabase } from "./support/pg.js";
import { id, mustWin, runQuery, seedProvider } from "./support/fixtures.js";

describe("tier 2 — S44 dispatch_rank (ADR 0037 decisions 1-2)", () => {
  const db = useDatabase();

  it("RUN_CREATE coalesces to best rank: second writer with better rank improves, worse rank does not overwrite (both orders)", async () => {
    await seedProvider(db());
    const providerId = "amc";
    const showtimeId = "st_coalesce";
    const runKeyId = `k_fetch_${providerId}_${showtimeId}`;
    await mustWin(db(), B.RUN_KEY_UPSERT, [
      runKeyId,
      "SHOWTIME_FETCH",
      providerId,
      "seat",
      showtimeId,
      null,
      null,
    ]);

    const runA1 = id("run_a1");
    const runA2 = id("run_a2");
    await mustWin(db(), B.RUN_CREATE, [runA1, runKeyId, id("obs_a1"), 5]);
    await runQuery(db(), B.RUN_CREATE, [runA2, runKeyId, id("obs_a2"), 1]);
    let row = await db().one<{ dispatch_rank: number | null }>(
      `SELECT dispatch_rank FROM provider_run WHERE run_key_id = $1`,
      [runKeyId],
    );
    expect(row.dispatch_rank).toBe(1);
    expect(row.dispatch_rank).not.toBe(5);

    await db().query(`DELETE FROM provider_run WHERE run_key_id = $1`, [runKeyId]);
    const runB1 = id("run_b1");
    const runB2 = id("run_b2");
    await mustWin(db(), B.RUN_CREATE, [runB1, runKeyId, id("obs_b1"), 1]);
    await runQuery(db(), B.RUN_CREATE, [runB2, runKeyId, id("obs_b2"), 5]);
    row = await db().one<{ dispatch_rank: number | null }>(
      `SELECT dispatch_rank FROM provider_run WHERE run_key_id = $1`,
      [runKeyId],
    );
    expect(row.dispatch_rank).toBe(1);
    expect(row.dispatch_rank).not.toBe(5);
  });

  it("NULL as no opinion: second subscriber with real rank improves first NULL, worse NULL stays", async () => {
    await seedProvider(db());
    const providerId = "amc";
    const runKeyId = `k_fetch_${providerId}_st_null`;
    await mustWin(db(), B.RUN_KEY_UPSERT, [
      runKeyId,
      "SHOWTIME_FETCH",
      providerId,
      "seat",
      "st_null",
      null,
      null,
    ]);
    const run1 = id("run_null1");
    await mustWin(db(), B.RUN_CREATE, [run1, runKeyId, id("obs_null1"), null]);
    let row = await db().one<{ dispatch_rank: number | null }>(
      `SELECT dispatch_rank FROM provider_run WHERE run_key_id = $1`,
      [runKeyId],
    );
    expect(row.dispatch_rank).toBe(null);
    const run2 = id("run_null2");
    await runQuery(db(), B.RUN_CREATE, [run2, runKeyId, id("obs_null2"), 0]);
    row = await db().one<{ dispatch_rank: number | null }>(
      `SELECT dispatch_rank FROM provider_run WHERE run_key_id = $1`,
      [runKeyId],
    );
    expect(row.dispatch_rank).toBe(0);
    const run3 = id("run_null3");
    await runQuery(db(), B.RUN_CREATE, [run3, runKeyId, id("obs_null3"), null]);
    row = await db().one<{ dispatch_rank: number | null }>(
      `SELECT dispatch_rank FROM provider_run WHERE run_key_id = $1`,
      [runKeyId],
    );
    expect(row.dispatch_rank).toBe(0);
  });

  it("SWEEP_OVERDUE_OUTBOX drains best-rank-first within same priority tier", async () => {
    await seedProvider(db());
    const providerId = "amc";
    const keys = ["st_sweep_0", "st_sweep_1", "st_sweep_2"].map(
      (st) => `k_fetch_${providerId}_${st}`,
    );
    for (const k of keys) {
      const st = k.replace(`k_fetch_${providerId}_`, "");
      await mustWin(db(), B.RUN_KEY_UPSERT, [
        k,
        "SHOWTIME_FETCH",
        providerId,
        "seat",
        st,
        null,
        null,
      ]);
    }
    const runRanks = [2, 0, 1];
    const runIds: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const runId = id(`run_sweep_${i}`);
      runIds.push(runId);
      await mustWin(db(), B.RUN_CREATE, [runId, keys[i]!, id(`obs_sweep_${i}`), runRanks[i]!]);
      await mustWin(db(), B.OUTBOX_CREATE_RUN, [runId, null]);
    }
    const sweep = await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10]);
    const rows = sweep.rows as { run_id: string }[];
    const orderedRunIds = rows.map((r) => r.run_id);
    expect(orderedRunIds[0]).toBe(runIds[1]);
    expect(orderedRunIds[1]).toBe(runIds[2]);
    expect(orderedRunIds[2]).toBe(runIds[0]);
    const fifoOrder = [runIds[0], runIds[1], runIds[2]];
    expect(orderedRunIds).not.toEqual(fifoOrder);
  });

  it("SWEEP null rank sorts last via 32767 sentinel", async () => {
    await seedProvider(db());
    const providerId = "amc";
    const kNull = `k_fetch_${providerId}_st_null_rank`;
    const kZero = `k_fetch_${providerId}_st_zero_rank`;
    await mustWin(db(), B.RUN_KEY_UPSERT, [
      kNull,
      "SHOWTIME_FETCH",
      providerId,
      "seat",
      "st_null_rank",
      null,
      null,
    ]);
    await mustWin(db(), B.RUN_KEY_UPSERT, [
      kZero,
      "SHOWTIME_FETCH",
      providerId,
      "seat",
      "st_zero_rank",
      null,
      null,
    ]);
    const runNull = id("run_null_rank");
    const runZero = id("run_zero_rank");
    await mustWin(db(), B.RUN_CREATE, [runNull, kNull, id("obs_null_rank"), null]);
    await mustWin(db(), B.RUN_CREATE, [runZero, kZero, id("obs_zero_rank"), 0]);
    await mustWin(db(), B.OUTBOX_CREATE_RUN, [runNull, null]);
    await mustWin(db(), B.OUTBOX_CREATE_RUN, [runZero, null]);
    const sweep = await runQuery(db(), B.SWEEP_OVERDUE_OUTBOX, [10]);
    const rows = sweep.rows as { run_id: string }[];
    const ordered = rows.map((r) => r.run_id);
    expect(ordered[0]).toBe(runZero);
    expect(ordered[1]).toBe(runNull);
  });
});
