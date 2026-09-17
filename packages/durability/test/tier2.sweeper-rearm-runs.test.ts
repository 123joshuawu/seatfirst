import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { markOutboxPublished } from "../src/repository.js";

import {
  createSearch,
  dispatchRun,
  failRun,
  fetchKey,
  id,
  mustWin,
  runQuery,
  seedProvider,
  subscribe,
  terminalize,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — committed effects of `SWEEP_REARM_RUNS`, the sweeper duty-2 statement for
 * `provider_run` (ADR 0001 §5 duty 6: "duties 2–3 apply verbatim to both run kinds").
 *
 * Added in-scope by S10 (`docs/tasks/S10-sweeper-process/spec.md` S10.3), following the
 * exact pattern S3 established for the other single-statement additions: tier 1 prepares
 * it automatically (it is registered in `ALL_STATEMENTS`), and this file asserts its
 * committed effects. Deleting the statement breaks this file's compile (the
 * `B.SWEEP_REARM_RUNS` reference vanishes) — the regression check that would otherwise
 * leave tier 1 silently one-statement-lighter.
 */
describe("tier 2 — SWEEP_REARM_RUNS", () => {
  const db = useDatabase();

  it("re-arms an aged PENDING run regardless of its outbox row's state (S10.3)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_rearm_runs");
    const search = await createSearch(db(), 0, { reserve: 1 });
    // subscribe() leaves a LIVE run_subscription for this key — the run's "parent search
    // is live" precondition — and creates the key's search_job/outbox row.
    await subscribe(db(), search, key);

    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const first = await mustWin<{ outbox_id: string }>(db(), B.OUTBOX_CREATE_RUN, [
      runId,
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ]);

    // Negative control first (CONTRIBUTING.md §3: a negative assertion needs the positive
    // one beside it): a fresh run is not aged, so nothing is re-armed yet.
    expect(await runQuery(db(), B.SWEEP_REARM_RUNS, ["1 minute"]).then((r) => r.rows)).toEqual([]);

    // Clock manipulation creates the aged-PENDING precondition (time is data, never a wait).
    await db().query(
      `UPDATE provider_run SET created_at = now() - interval '1 hour' WHERE run_id = $1`,
      [runId],
    );
    // Simulate the dead-lettered delivery the re-arm exists for: the broker message was
    // published and lost, so the outbox row is PUBLISHED while the run is still PENDING.
    expect(await markOutboxPublished(db(), first.outbox_id)).toEqual([
      { outbox_id: first.outbox_id, state: "PUBLISHED" },
    ]);

    const rearmed = await runQuery(db(), B.SWEEP_REARM_RUNS, ["1 minute"]);
    expect(rearmed.rows).toHaveLength(1);
    const second = rearmed.rows[0] as { outbox_id: string };
    expect(second.outbox_id).not.toBe(first.outbox_id);

    // The re-armed delivery has no HTTP origin of its own: its traceparent is NULL
    // explicitly, never copied forward from the dead-lettered original (ADR 0031).
    const secondRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE outbox_id = $1::text`,
      [second.outbox_id],
    );
    expect(secondRow.traceparent).toBeNull();
    const firstRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE outbox_id = $1::text`,
      [first.outbox_id],
    );
    expect(firstRow.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    // The run itself is untouched: reconciliation re-arms the RUN row via the outbox, it
    // does not transition the run.
    const run = await db().one<{ state: string }>(
      `SELECT state FROM provider_run WHERE run_id = $1`,
      [runId],
    );
    expect(run.state).toBe("PENDING");

    // Two RUN-targeted outbox rows now exist: the dead-lettered original and the fresh one.
    const outbox = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM outbox WHERE run_id = $1`,
      [runId],
    );
    expect(outbox.n).toBe("2");
  });

  it("OUTBOX_CREATE_RUN carries a given traceparent and writes NULL when no span is active (O7.8)", async () => {
    await seedProvider(db());
    const tracedKey = await fetchKey(db(), "st_trace_run_traced");
    const untracedKey = await fetchKey(db(), "st_trace_run_untraced");

    // Positive branch: the W3C traceparent captured at the HTTP boundary round-trips.
    const traced = id("run");
    await mustWin(db(), B.RUN_CREATE, [traced, tracedKey.runKeyId, id("obs"), null]);
    await mustWin(db(), B.OUTBOX_CREATE_RUN, [
      traced,
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ]);

    // Negative branch: no active request span means NULL, never a fabricated parent.
    const untraced = id("run");
    await mustWin(db(), B.RUN_CREATE, [untraced, untracedKey.runKeyId, id("obs"), null]);
    await mustWin(db(), B.OUTBOX_CREATE_RUN, [untraced, null]);

    const tracedRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE run_id = $1::text`,
      [traced],
    );
    expect(tracedRow.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const untracedRow = await db().one<{ traceparent: string | null }>(
      `SELECT traceparent FROM outbox WHERE run_id = $1::text`,
      [untraced],
    );
    expect(untracedRow.traceparent).toBeNull();
  });

  it("re-arm is not resurrection: a terminal search's aged PENDING run is skipped (S10.3)", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_rearm_runs_terminal");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);

    const run = await dispatchRun(db(), key);
    await failRun(db(), run);
    await terminalize(db(), search.searchId);

    // Precondition simulation (not a transition): a run row still PENDING and aged under a
    // terminal search — the residual the guard exists to leave stranded rather than
    // resurrect. With the search terminal and no LIVE subscription left, this is the only
    // thing the re-arm could act on, and it must not.
    await db().query(
      `UPDATE provider_run SET state = 'PENDING', created_at = now() - interval '1 hour'
       WHERE run_id = $1`,
      [run.runId],
    );
    expect(await runQuery(db(), B.SWEEP_REARM_RUNS, ["1 minute"]).then((r) => r.rows)).toEqual([]);
  });
});
