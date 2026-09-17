import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { checkInvariants } from "../src/invariants.js";
import {
  applyProviderControlTransition,
  reopenProviderScope,
  stageFetchAcceptance,
  type ProviderControlTrigger,
} from "../src/transactions.js";

import {
  createSearch,
  dispatchRun,
  fetchKey,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  scheduleKey,
  seedProvider,
  subscribe,
} from "./support/fixtures.js";
import { session, useDatabase } from "./support/pg.js";

/**
 * Tier 2 — provider control state and browser-navigation fencing (S5, ADR 0001 B9 as
 * amended 2026-08-11).
 *
 * The typed transaction facade (`applyProviderControlTransition` / `reopenProviderScope`)
 * is the only caller-facing provider-control surface: callers supply a closed trigger,
 * never raw `{ state, routeClass, cause }` values, and the persisted scope/state/deadline
 * are DERIVED from the trigger (S5.1). These tests cover T40 (queue on one route halts
 * all routes), T41 (corridor drift mutates nothing, with a positive-control halt through
 * the same facade), T43 (kill-switch fences the leased heartbeat and stale acceptance),
 * and T44 (a route reopen cannot weaken a global halt) — each negative assertion paired
 * with a positive control, per the spec's verification note.
 */

describe("tier 2 — provider-control halts", () => {
  const db = useDatabase();

  it("T40: UPSTREAM_QUEUED on one route halts every AMC route provider-wide", async () => {
    await seedProvider(db());
    const search = await createSearch(db(), 1, { reserve: 2 });
    const seatKey = await fetchKey(db(), "st_t40_seat");
    const schedKey = await scheduleKey(db(), "theatre_t40", "2026-08-02");
    await subscribe(db(), search, schedKey); // carries the cold-path schedule slot
    await subscribe(db(), search, seatKey);
    // work leased on both route classes before the queue signal lands
    const seatRun = await dispatchRun(db(), seatKey);
    const schedRun = await dispatchRun(db(), schedKey);
    const before = await db().one<{ epoch: string }>(
      `SELECT epoch FROM provider_fence WHERE provider_id = $1`,
      [PROVIDER],
    );

    const outcome = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "UPSTREAM_QUEUED",
    });
    expect(outcome).toMatchObject({ routeClass: "", state: "HALTED", cause: "UPSTREAM_QUEUED" });
    expect(Number(outcome.epoch)).toBe(Number(before.epoch) + 1);

    // the unscoped row is what every route's effective-state read sees — not a per-route row
    expect(
      await db().one(
        `SELECT state, cause, route_class, not_before FROM provider_status WHERE provider_id = $1`,
        [PROVIDER],
      ),
    ).toEqual({ state: "HALTED", cause: "UPSTREAM_QUEUED", route_class: "", not_before: null });

    // aggregation was requested for the live search by the same transaction
    expect(outcome.aggregatedSearchIds).toContain(search.searchId);

    // leased work on BOTH routes lost its fence — the heartbeat-generation-loss signal
    expect(outcome.fencedRunIds).toEqual(expect.arrayContaining([seatRun.runId, schedRun.runId]));
    expect(
      (await runQuery(db(), B.B3_HEARTBEAT_RUN, [seatRun.runId, seatRun.generation, "5 minutes"]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await runQuery(db(), B.B3_HEARTBEAT_RUN, [schedRun.runId, schedRun.generation, "5 minutes"]))
        .rows,
    ).toHaveLength(0);

    // no replacement navigation: fresh dispatches on every route refuse B4. Fresh keys —
    // the pre-halt runs above are still LEASED, and a key admits one live run at a time.
    const freshKeys = [
      await fetchKey(db(), "st_t40_seat_after"),
      await scheduleKey(db(), "theatre_t40_after", "2026-08-03"),
    ];
    for (const key of freshKeys) {
      const runId = id("run");
      await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
      const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
        runId,
        "5 minutes",
      ]);
      expect(
        (await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows,
      ).toHaveLength(0);
    }
  });

  it("T41: corridor drift mutates nothing — with a positive-control halt through the same facade", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t41");
    const search = await createSearch(db(), 0, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);

    // Drift has NO entry point here: the closed trigger union (see the compile-time fences
    // at the bottom of this file) excludes CORRIDOR_GUARD_DRIFT, so its only representable
    // form in this seam is "no call" — which mutates nothing.
    expect(await db().rows(`SELECT * FROM provider_status`)).toEqual([]);

    // Positive control: the SAME facade with a real block trigger halts the provider.
    const halted = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "UPSTREAM_BLOCKED",
    });
    expect(halted).toMatchObject({ routeClass: "", state: "HALTED", cause: "UPSTREAM_BLOCKED" });
    expect(halted.fencedRunIds).toContain(run.runId);

    // The halt is a traffic-control transition, not a parser event: exactly one status
    // row — the unscoped halt — and no parser-incompatibility page, no breaker state.
    expect(await db().rows(`SELECT * FROM provider_status`)).toEqual([
      {
        provider_id: PROVIDER,
        route_class: "",
        state: "HALTED",
        cause: "UPSTREAM_BLOCKED",
        not_before: null,
        changed_at: expect.any(Date),
      },
    ]);
    expect(
      await db().rows(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'provider_status'
           AND column_name = 'parser_breaker'`,
      ),
    ).toEqual([]);
  });

  it("T43: the legal kill switch fences the leased heartbeat and rejects stale acceptance atomically", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t43");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    const job = await mustWin<{ generation: number }>(db(), B.B2_LEASE_JOB, [
      sub.jobId,
      "5 minutes",
    ]);

    const outcome = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "LEGAL_KILL_SWITCH",
    });
    expect(outcome).toMatchObject({ routeClass: "", state: "HALTED", cause: "LEGAL_KILL_SWITCH" });

    // the generation bump makes every leased heartbeat lose — the worker's abort signal
    expect(
      (await runQuery(db(), B.B3_HEARTBEAT_RUN, [run.runId, run.generation, "5 minutes"])).rows,
    ).toHaveLength(0);
    expect(
      (await runQuery(db(), B.B3_HEARTBEAT_JOB, [sub.jobId, job.generation, "5 minutes"])).rows,
    ).toHaveLength(0);

    // late acceptance under the old fence loses at B5(a) (generation) and B5(b) (epoch)
    expect((await runQuery(db(), B.B5A_FENCE, [run.runId, run.generation])).rows).toHaveLength(0);
    expect(
      (await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, run.epoch, "seat"])).rows,
    ).toHaveLength(0);

    // ...and loses ATOMICALLY: a staged stale acceptance writes nothing before it aborts
    const raw = await db().connect();
    const tx = session(raw);
    await tx.query("BEGIN");
    await expect(stageFetchAcceptance(tx, run)).rejects.toThrow("B5A_FENCE");
    await tx.query("ROLLBACK");
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM observation`)).n).toBe("0");
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM run_application`)).n).toBe(
      "0",
    );
    expect((await db().one<{ n: string }>(`SELECT count(*) AS n FROM search_event`)).n).toBe("0");

    // no dispatch until an authorized manual reopen... (a fresh key: the pre-halt run is
    // still LEASED, and a key admits one live run at a time)
    const key2 = await fetchKey(db(), "st_t43_after");
    const run2 = id("run");
    await mustWin(db(), B.RUN_CREATE, [run2, key2.runKeyId, id("obs"), null]);
    const leased2 = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      run2,
      "5 minutes",
    ]);
    expect((await runQuery(db(), B.B4_PREDISPATCH, [run2, leased2.generation])).rows).toHaveLength(
      0,
    );

    // ...which must target the scope that halted: the authorized global reopen restores
    const reopened = await reopenProviderScope(db(), PROVIDER, "");
    expect(Number(reopened.epoch)).toBe(Number(outcome.epoch) + 1);
    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      run2,
      leased2.generation,
    ]);
    expect(dispatched.provider_epoch).toBe(reopened.epoch);
    expect(
      await db().one(
        `SELECT state, cause, not_before FROM provider_status
         WHERE provider_id = $1 AND route_class = ''`,
        [PROVIDER],
      ),
    ).toEqual({ state: "OPEN", cause: null, not_before: null });
  });

  it("T44: reopening one route beneath an unscoped halt cannot weaken the global stop", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_t44");

    // a scoped row exists for the route (a rate-limit pause), then the provider halts above it
    await applyProviderControlTransition(db(), PROVIDER, {
      kind: "RATE_LIMITED",
      routeClass: "seat",
      notBefore: new Date(Date.now() + 60_000),
    });
    const halted = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "UPSTREAM_BLOCKED",
    });

    // a fresh dispatch refuses B4 while the global halt governs
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);
    expect((await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows).toHaveLength(
      0,
    );

    // reopening only the route scope below the halt succeeds for that scope...
    const scoped = await reopenProviderScope(db(), PROVIDER, "seat");
    expect(Number(scoped.epoch)).toBe(Number(halted.epoch) + 1);
    expect(
      await db().one(
        `SELECT state, cause, not_before FROM provider_status
         WHERE provider_id = $1 AND route_class = 'seat'`,
        [PROVIDER],
      ),
    ).toEqual({ state: "OPEN", cause: null, not_before: null });

    // ...but the unscoped halt still governs: effective state stays halted
    expect((await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows).toHaveLength(
      0,
    );

    // positive control: an authorized GLOBAL reopen restores effective OPEN
    await reopenProviderScope(db(), PROVIDER, "");
    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      runId,
      leased.generation,
    ]);
    expect(Number(dispatched.provider_epoch)).toBe(Number(halted.epoch) + 2);

    // a reopen of a scope that was never persisted is a fence loss, not a creation — and
    // it rolls back atomically (the fence does not advance on the failed reopen)
    await expect(reopenProviderScope(db(), PROVIDER, "never")).rejects.toThrow("B9_REOPEN_SCOPE");
    expect(
      (
        await db().one<{ epoch: string }>(
          `SELECT epoch FROM provider_fence WHERE provider_id = $1`,
          [PROVIDER],
        )
      ).epoch,
    ).toBe(dispatched.provider_epoch);
  });
});

describe("tier 2 — cause-sensitive nonterminal pauses (S5.3/S5.4)", () => {
  const db = useDatabase();

  it("RATE_LIMITED pauses only the requested scope with a concrete not_before, then self-resumes", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_rl");
    const notBefore = new Date(Date.now() + 60 * 60_000);
    const outcome = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "RATE_LIMITED",
      routeClass: "seat",
      notBefore,
    });
    expect(outcome).toMatchObject({ routeClass: "seat", state: "PAUSED", cause: "RATE_LIMITED" });
    expect(
      await db().one(
        `SELECT state, cause, not_before FROM provider_status
         WHERE provider_id = $1 AND route_class = 'seat'`,
        [PROVIDER],
      ),
    ).toEqual({ state: "PAUSED", cause: "RATE_LIMITED", not_before: notBefore });

    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);
    // blocks while the deadline is in the future
    expect((await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows).toHaveLength(
      0,
    );
    expect(
      (await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, outcome.epoch, "seat"])).rows,
    ).toHaveLength(0);

    // time is data: a concrete expired deadline self-resumes without operator action
    await db().query(
      `UPDATE provider_status SET not_before = now() - interval '1 second'
       WHERE provider_id = $1 AND route_class = 'seat'`,
      [PROVIDER],
    );
    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      runId,
      leased.generation,
    ]);
    expect(dispatched.provider_epoch).toBe(outcome.epoch);
    expect(
      (await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, outcome.epoch, "seat"])).rows,
    ).toHaveLength(1);
  });

  it("a validated PARSER_SCHEMA_INCOMPATIBLE pause is indefinite: a NULL deadline blocks", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "st_parser");
    const outcome = await applyProviderControlTransition(db(), PROVIDER, {
      kind: "PARSER_SCHEMA_INCOMPATIBLE",
      routeClass: "seat",
    });
    expect(outcome).toMatchObject({
      routeClass: "seat",
      state: "PAUSED",
      cause: "PARSER_SCHEMA_INCOMPATIBLE",
    });
    expect(
      await db().one(
        `SELECT state, cause, not_before FROM provider_status
         WHERE provider_id = $1 AND route_class = 'seat'`,
        [PROVIDER],
      ),
    ).toEqual({ state: "PAUSED", cause: "PARSER_SCHEMA_INCOMPATIBLE", not_before: null });

    // PAUSED with a NULL deadline blocks (S5.4): the pre-amendment predicate
    // `PAUSED AND not_before > now()` was SQL-unknown for NULL and silently opened traffic.
    const runId = id("run");
    await mustWin(db(), B.RUN_CREATE, [runId, key.runKeyId, id("obs"), null]);
    const leased = await mustWin<{ generation: number }>(db(), B.B2_LEASE_RUN, [
      runId,
      "5 minutes",
    ]);
    expect((await runQuery(db(), B.B4_PREDISPATCH, [runId, leased.generation])).rows).toHaveLength(
      0,
    );
    expect(
      (await runQuery(db(), B.B5B_EPOCH_FENCE, [PROVIDER, outcome.epoch, "seat"])).rows,
    ).toHaveLength(0);

    // there is no deadline to expire — only the manual reopen restores dispatch
    const reopened = await reopenProviderScope(db(), PROVIDER, "seat");
    const dispatched = await mustWin<{ provider_epoch: string }>(db(), B.B4_PREDISPATCH, [
      runId,
      leased.generation,
    ]);
    expect(dispatched.provider_epoch).toBe(reopened.epoch);
  });

  it("the effective-state read is Postgres authority: a global halt wins over a scoped OPEN", async () => {
    await seedProvider(db());
    // a fresh provider with no status rows is OPEN
    expect(
      (await runQuery(db(), B.PROVIDER_EFFECTIVE_STATE, [PROVIDER, "seat"])).rows[0].state,
    ).toBe("OPEN");
    await applyProviderControlTransition(db(), PROVIDER, {
      kind: "PARSER_SCHEMA_INCOMPATIBLE",
      routeClass: "seat",
    });
    expect(
      (await runQuery(db(), B.PROVIDER_EFFECTIVE_STATE, [PROVIDER, "seat"])).rows[0].state,
    ).toBe("PAUSED");
    // halt provider-wide, then reopen ONLY the route: the read must still say HALTED
    await applyProviderControlTransition(db(), PROVIDER, { kind: "UPSTREAM_BLOCKED" });
    await reopenProviderScope(db(), PROVIDER, "seat");
    expect(
      (await runQuery(db(), B.PROVIDER_EFFECTIVE_STATE, [PROVIDER, "seat"])).rows[0].state,
    ).toBe("HALTED");
  });
});

describe("tier 2 — provider-control invariants (S5.8)", () => {
  const db = useDatabase();

  it("the sweep flags a HALTED row carrying a retry deadline", async () => {
    await seedProvider(db());
    // Seed data, not a boundary: this row is exactly the impossible combination the
    // invariant exists to catch — no boundary statement can produce it.
    await db().query(
      `INSERT INTO provider_status (provider_id, route_class, state, cause, not_before)
       VALUES ($1, '', 'HALTED', 'UPSTREAM_BLOCKED', now() + interval '1 hour')`,
      [PROVIDER],
    );
    const violations = await checkInvariants(db());
    expect(violations.map((v) => v.invariant)).toContain("halted_row_has_no_retry_deadline");
    // restore a legal world for the afterEach sweep
    await db().query(`DELETE FROM provider_status`);
    expect(await checkInvariants(db())).toEqual([]);
  });

  it("the sweep flags a RATE_LIMITED pause with no concrete deadline", async () => {
    await seedProvider(db());
    await db().query(
      `INSERT INTO provider_status (provider_id, route_class, state, cause, not_before)
       VALUES ($1, 'seat', 'PAUSED', 'RATE_LIMITED', NULL)`,
      [PROVIDER],
    );
    const violations = await checkInvariants(db());
    expect(violations.map((v) => v.invariant)).toContain("rate_limited_pause_has_not_before");
    await db().query(`DELETE FROM provider_status`);
    expect(await checkInvariants(db())).toEqual([]);
  });

  it("the sweep flags a PARSER_SCHEMA_INCOMPATIBLE pause with a deadline", async () => {
    await seedProvider(db());
    await db().query(
      `INSERT INTO provider_status (provider_id, route_class, state, cause, not_before)
       VALUES ($1, 'seat', 'PAUSED', 'PARSER_SCHEMA_INCOMPATIBLE', now() + interval '1 hour')`,
      [PROVIDER],
    );
    const violations = await checkInvariants(db());
    expect(violations.map((v) => v.invariant)).toContain("parser_pause_has_no_not_before");
    await db().query(`DELETE FROM provider_status`);
    expect(await checkInvariants(db())).toEqual([]);
  });
});

// --- Closed-trigger compile-time fences (S5.1/S5.3) --------------------------------
// These declarations are assertions, not values: if any construct were ever admitted to
// the trigger union, its `@ts-expect-error` would become unused and `pnpm typecheck`
// would fail. `void` keeps them referenced without inventing runtime behavior.

// @ts-expect-error CORRIDOR_GUARD_DRIFT is deliberately absent: drift mutates no provider
// state and must be unable to reach the traffic-control entry point (T41).
const drift: ProviderControlTrigger = { kind: "CORRIDOR_GUARD_DRIFT" };
void drift;

const nullDeadline: ProviderControlTrigger = {
  kind: "RATE_LIMITED",
  routeClass: "seat",
  // @ts-expect-error RATE_LIMITED requires a concrete notBefore — a null deadline is the
  // parser pause's indefinite shape, not the rate limiter's.
  notBefore: null,
};
void nullDeadline;

// @ts-expect-error the halt triggers accept no route class: the transaction derives the
// empty scope so one signal halts every route (T40).
const scopedHalt: ProviderControlTrigger = { kind: "LEGAL_KILL_SWITCH", routeClass: "seat" };
void scopedHalt;
