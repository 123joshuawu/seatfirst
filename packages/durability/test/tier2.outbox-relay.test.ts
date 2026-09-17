import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { markOutboxPublished, runStatement } from "../src/repository.js";

import { createSearch, fetchKey, seedProvider, subscribe } from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — committed effects of `OUTBOX_MARK_RETRY` (S9.4).
 *
 * The statement is the relay's publish-failure recovery boundary: fenced on
 * `outbox_id` + `state = 'PENDING'`, it increments `attempt` and advances
 * `next_attempt_at` by the caller-supplied backoff interval. Tier 1 already PREPAREs
 * it (every `ALL_STATEMENTS` entry runs through `tier1.executes.test.ts`); deleting the
 * statement breaks this file at compile time, so the "test fails without it" contract
 * holds (CONTRIBUTING.md §3).
 */
describe("tier 2 — outbox relay retry boundary", () => {
  const db = useDatabase();

  it("increments attempt and defers next_attempt_at by the injected backoff, leaving the row PENDING", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "or_retry");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const first = await db().one<{ outbox_id: string }>(
      `SELECT outbox_id FROM outbox WHERE job_id = $1`,
      [sub.jobId],
    );

    const before = await db().one<{ attempt: number; next_attempt_at: Date }>(
      `SELECT attempt, next_attempt_at FROM outbox WHERE outbox_id = $1`,
      [first.outbox_id],
    );
    expect(before.attempt).toBe(0);

    const retried = await runStatement<{
      outbox_id: string;
      attempt: number;
      next_attempt_at: Date;
    }>(db(), B.OUTBOX_MARK_RETRY, [first.outbox_id, "5 minutes"]);

    expect(retried).toHaveLength(1);
    const retriedRow = retried[0];
    if (retriedRow === undefined) {
      throw new Error("expected OUTBOX_MARK_RETRY to return exactly one row");
    }
    expect(retriedRow).toMatchObject({ outbox_id: first.outbox_id, attempt: 1 });
    // Derived independently: the caller-supplied backoff is 5 minutes, so the
    // deferral must land in (4, 6) minutes of the previous next_attempt_at.
    const advanced = retriedRow.next_attempt_at.getTime() - before.next_attempt_at.getTime();
    expect(advanced).toBeGreaterThan(4 * 60_000);
    expect(advanced).toBeLessThan(6 * 60_000);

    const after = await db().one<{ state: string; next_attempt_at: Date }>(
      `SELECT state, next_attempt_at FROM outbox WHERE outbox_id = $1`,
      [first.outbox_id],
    );
    expect(after.state).toBe("PENDING");
    expect(after.next_attempt_at.getTime()).toBe(retriedRow.next_attempt_at.getTime());
  });

  it("is fenced by state: marking a published row for retry returns zero rows and mutates nothing", async () => {
    await seedProvider(db());
    const key = await fetchKey(db(), "or_fence");
    const search = await createSearch(db(), 0, { reserve: 1 });
    const sub = await subscribe(db(), search, key);
    const first = await db().one<{ outbox_id: string }>(
      `SELECT outbox_id FROM outbox WHERE job_id = $1`,
      [sub.jobId],
    );

    // A concurrent relay/sweeper won the publish before this retry ran.
    expect(await markOutboxPublished(db(), first.outbox_id)).toHaveLength(1);

    const retried = await runStatement<{ outbox_id: string }>(db(), B.OUTBOX_MARK_RETRY, [
      first.outbox_id,
      "5 minutes",
    ]);
    expect(retried).toEqual([]);

    const unchanged = await db().one<{ attempt: number; state: string }>(
      `SELECT attempt, state FROM outbox WHERE outbox_id = $1`,
      [first.outbox_id],
    );
    expect(unchanged).toEqual({ attempt: 0, state: "PUBLISHED" });
  });
});
