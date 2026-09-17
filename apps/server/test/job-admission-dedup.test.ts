import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findOrCreateRun, poolClient } from "@seatfirst/durability";

import { createPlaceholderRegistry } from "../src/dispatch/handlers.js";
import { withJobAdmissionDedup } from "../src/dispatch/handlers/job-admission-dedup.js";
import type { JobHandlerContext, JobRow, RunKeyRow, SearchRow } from "../src/dispatch/index.js";
import { capturingLogger, type CapturingLogger } from "./support/logger.js";
import { startTestPostgres } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S30 verification, items 4–9 of the spec's verification list — against real Postgres 16
 * (testcontainers, or `SERVER_PG_URL`). The JOB handler's only observable effect is
 * find-or-create through the real `withTransaction(deps.pool, …)` path; nothing here drives
 * a broker round trip, because the handler neither leases nor accepts — it only admits the
 * run whose dispatch the outbox relay then publishes.
 *
 * Raw INSERTs below are seed data (the legitimate non-boundary bucket, `CONTRIBUTING.md`
 * §2). The transition under test (`RUN_CREATE` + `OUTBOX_CREATE_RUN`, via the composed
 * `findOrCreateRun` body) is performed exclusively by the handler under test.
 */

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

let pg: TestService;
let pool: Pool;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
});

afterAll(async () => {
  await pool.end();
  await pg.stop();
});

beforeEach(async () => {
  await pool.query("TRUNCATE search, provider_admission, provider_fence, run_key CASCADE");
});

/** Seed data only: the provider fence `RUN_CREATE` joins against (no boundary statement). */
async function seedProviderFence(pool: Pool, providerId = "amc"): Promise<void> {
  await pool.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [providerId]);
}

async function seedRunKey(
  pool: Pool,
  kind: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION",
): Promise<string> {
  const runKeyId = uniq("key");
  if (kind === "SHOWTIME_FETCH") {
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
      [runKeyId, uniq("showtime")],
    );
  } else {
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
       VALUES ($1, 'SCHEDULE_RESOLUTION', 'amc', 'schedule', $2, '2026-08-20')`,
      [runKeyId, uniq("theatre")],
    );
  }
  return runKeyId;
}

/** Seed a terminal `DONE` run so the handler is forced to create a fresh one (ADR 0006 §A.1). */
async function seedDoneRun(pool: Pool, runKeyId: string): Promise<string> {
  const runId = uniq("run");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, uniq("obs")],
  );
  return runId;
}

/**
 * Seed data only: the `B2_ADMISSION_FENCE` join's two rows — a `search` in a nonterminal
 * status plus its `search_job` in a valid `LEASED` state (S60.7 / ADR 0066 §4). Without these
 * rows the fence returns 0 rows and the handler correctly no-ops. `kind` must agree with
 * the run_key's kind (`search_job`'s `(run_key_id, kind)` FK). Returns the `job_id`/`generation`
 * the handler's fence check runs against.
 */
async function seedAdmissionFence(
  pool: Pool,
  runKeyId: string,
  kind: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION",
  opts: { searchStatus?: string; jobState?: string; generation?: number } = {},
): Promise<{ jobId: string; generation: number; searchId: string }> {
  const { searchStatus = "PENDING_SCHEDULE", jobState = "LEASED", generation = 0 } = opts;
  const searchId = uniq("search");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'x', $4, now() + interval '1 hour')`,
    [searchId, uniq("sess"), uniq("idem"), searchStatus],
  );
  const jobId = uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, lease_expires_at, deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', now() + interval '1 hour')`,
    [jobId, searchId, kind, runKeyId, generation, jobState],
  );
  return { jobId, generation, searchId };
}

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return rows[0]?.n ?? "0";
}

/**
 * The handler reads `context.job.runKeyId` for find-or-create plus `context.job.jobId` /
 * `context.job.generation` for the `B2_ADMISSION_FENCE` check (S60.7); the S61
 * SHOWTIME_FETCH path additionally reads `context.job.kind` for the kind branch,
 * `context.job.searchId` for the adoption insert, and `context.runKey.providerId` for
 * the provider epoch fence — so both sides are real stubs here (S61.7). The remaining
 * context slots stay stubbed because `withJobAdmissionDedup`'s body never touches them.
 */
function jobContext(
  runKeyId: string,
  jobId: string,
  generation = 0,
  opts: {
    kind?: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION";
    searchId?: string;
    providerId?: string;
  } = {},
): JobHandlerContext {
  const { kind = "SHOWTIME_FETCH", searchId = "", providerId = "amc" } = opts;
  return {
    job: { runKeyId, jobId, generation, kind, searchId } as JobRow,
    search: null as unknown as SearchRow,
    runKey: {
      runKeyId,
      kind,
      providerId,
      routeClass: kind === "SHOWTIME_FETCH" ? "seat" : "schedule",
    } as RunKeyRow,
    sqlClient: poolClient(pool),
    logger: capturingLogger(),
  };
}

/**
 * S61 seed: a DONE `provider_run` with an accepted `observation` + fresh
 * `availability_snapshot` (`captured_at = now()`, inside the 30s
 * `SNAPSHOT_ADOPTION_TTL_MS`), with `run_key.latest_observation_id` pointing at it —
 * exactly the shape `B5_FIND_RECENT_SNAPSHOT` joins through. Raw INSERTs are seed data
 * (the legitimate non-boundary bucket, `CONTRIBUTING.md` §2); the adoption transitions
 * under test run exclusively inside the handler.
 */
async function seedFreshSnapshot(
  pool: Pool,
  runKeyId: string,
): Promise<{ runId: string; observationId: string }> {
  const runId = uniq("run");
  const observationId = uniq("obs");
  const key = await pool.query<{ showtime_id: string }>(
    `SELECT showtime_id FROM run_key WHERE run_key_id = $1`,
    [runKeyId],
  );
  const showtimeId = key.rows[0]?.showtime_id ?? uniq("showtime");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, observationId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, now(), 1)`,
    [observationId, runKeyId, runId],
  );
  await pool.query(
    `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
     VALUES ($1, $2, now(), $3, 7)`,
    [observationId, showtimeId, Buffer.from([0b10101010])],
  );
  await pool.query(`UPDATE run_key SET latest_observation_id = $1 WHERE run_key_id = $2`, [
    observationId,
    runKeyId,
  ]);
  return { runId, observationId };
}

describe("job admission/dedup (S30)", () => {
  it("4/5. SHOWTIME_FETCH creates a fresh PENDING run + outbox past a DONE run, never re-applying it", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    const doneRunId = await seedDoneRun(pool, keyId);
    const { jobId, generation, searchId } = await seedAdmissionFence(pool, keyId, "SHOWTIME_FETCH");

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    await registry.job.SHOWTIME_FETCH.handler(
      jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId }),
    );

    // The DONE run is untouched; a fresh PENDING run is admitted for the same key.
    expect(
      await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
    ).toBe("2");
    const fresh = await pool.query<{ run_id: string; state: string }>(
      `SELECT run_id, state FROM provider_run WHERE run_key_id = $1 AND state = 'PENDING'`,
      [keyId],
    );
    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]?.run_id).not.toBe(doneRunId);

    // Exactly one dispatch outbox, on the fresh run.
    expect(
      await count(pool, `SELECT count(*) AS n FROM outbox WHERE run_id = $1`, [
        fresh.rows[0]?.run_id,
      ]),
    ).toBe("1");

    // Find-or-create never accepts: no run_application against the DONE run, no observation
    // row, no search_event (no FETCH_ACCEPTED fan-in).
    expect(
      await count(pool, `SELECT count(*) AS n FROM run_application WHERE run_id = $1`, [doneRunId]),
    ).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM observation`)).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM search_event`)).toBe("0");
  });

  it("5/7. re-delivery coalesces: a second JOB message creates no second run or outbox", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    const { jobId, generation, searchId } = await seedAdmissionFence(pool, keyId, "SHOWTIME_FETCH");

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    const ctx = jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId });
    await registry.job.SHOWTIME_FETCH.handler(ctx); // first delivery creates
    await registry.job.SHOWTIME_FETCH.handler(ctx); // lease-loss re-delivery coalesces

    expect(
      await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
    ).toBe("1");
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM outbox WHERE run_id IN (SELECT run_id FROM provider_run WHERE run_key_id = $1)`,
        [keyId],
      ),
    ).toBe("1");
  });

  it("6. SCHEDULE_RESOLUTION find-or-creates only — no expansion, no acceptance", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SCHEDULE_RESOLUTION");
    const { jobId, generation, searchId } = await seedAdmissionFence(
      pool,
      keyId,
      "SCHEDULE_RESOLUTION",
    );

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    await registry.job.SCHEDULE_RESOLUTION.handler(
      jobContext(keyId, jobId, generation, { kind: "SCHEDULE_RESOLUTION", searchId }),
    );

    const run = await pool.query<{ state: string }>(
      `SELECT state FROM provider_run WHERE run_key_id = $1`,
      [keyId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]?.state).toBe("PENDING");
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM outbox WHERE run_id IN (SELECT run_id FROM provider_run WHERE run_key_id = $1)`,
        [keyId],
      ),
    ).toBe("1");
    expect(await count(pool, `SELECT count(*) AS n FROM run_application`)).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM observation`)).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM search_event`)).toBe("0");
  });

  it("S60.7. fence blocks admission when the search is terminal (COMPLETE)", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    // Terminal search status fails the fence's `s.status IN ('PENDING_SCHEDULE','RUNNING')`
    // predicate (here COMPLETE; CANCELLED/HALTED/PARTIAL behave identically).
    const { jobId, generation, searchId } = await seedAdmissionFence(
      pool,
      keyId,
      "SHOWTIME_FETCH",
      {
        searchStatus: "COMPLETE",
      },
    );

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    await registry.job.SHOWTIME_FETCH.handler(
      jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId }),
    );

    expect(
      await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
    ).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM outbox`)).toBe("0");
  });

  it("S60.7. fence blocks admission when the job is not validly leased (DONE)", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    // Non-LEASED job state fails the fence's `sj.state = 'LEASED'` predicate even though the
    // parent search is still live — the lease was lost or the job already finished.
    const { jobId, generation, searchId } = await seedAdmissionFence(
      pool,
      keyId,
      "SHOWTIME_FETCH",
      {
        jobState: "DONE",
      },
    );

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    await registry.job.SHOWTIME_FETCH.handler(
      jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId }),
    );

    expect(
      await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
    ).toBe("0");
    expect(await count(pool, `SELECT count(*) AS n FROM outbox`)).toBe("0");
  });

  it("S61.7. cache hit: SHOWTIME_FETCH adopts a fresh snapshot without spawning a run", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    const { runId: adoptedRunId } = await seedFreshSnapshot(pool, keyId);
    const { jobId, generation, searchId } = await seedAdmissionFence(pool, keyId, "SHOWTIME_FETCH");
    // The adoption path mirrors B5_FANIN's per-subscriber writes, so it needs the same
    // rows: a LIVE subscription plus an admission reservation for the search.
    await pool.query(
      `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at)
       VALUES ($1, $2, $3, 'LIVE', now() + interval '1 hour')`,
      [keyId, searchId, jobId],
    );
    await pool.query(
      `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining)
       VALUES ($1, 'amc', 5, 5)`,
      [searchId],
    );

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    const ctx = jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId });
    await registry.job.SHOWTIME_FETCH.handler(ctx);

    // No browser run spawned: still exactly the one seeded DONE run, and no dispatch outbox.
    expect(
      await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
    ).toBe("1");
    expect(await count(pool, `SELECT count(*) AS n FROM outbox`)).toBe("0");

    // Full B5_FANIN-mirror state check: the historical run is applied to this search.
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM run_application WHERE run_id = $1 AND search_id = $2`,
        [adoptedRunId, searchId],
      ),
    ).toBe("1");
    const job = await pool.query<{ state: string }>(
      `SELECT state FROM search_job WHERE job_id = $1`,
      [jobId],
    );
    expect(job.rows[0]?.state).toBe("DONE");
    const sub = await pool.query<{ state: string }>(
      `SELECT state FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
      [keyId, searchId],
    );
    expect(sub.rows[0]?.state).toBe("SATISFIED");
    const reservation = await pool.query<{ reserved_remaining: string }>(
      `SELECT reserved_remaining FROM admission_reservation WHERE search_id = $1`,
      [searchId],
    );
    expect(reservation.rows[0]?.reserved_remaining).toBe("4");
    const search = await pool.query<{ agg_requested_rev: string }>(
      `SELECT agg_requested_rev FROM search WHERE search_id = $1`,
      [searchId],
    );
    expect(search.rows[0]?.agg_requested_rev).toBe("1");
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM search_event WHERE search_id = $1`,
      [searchId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.type).toBe("FETCH_ACCEPTED");

    // The adoption is logged through the handler's child logger.
    const infos = (ctx.logger as CapturingLogger).calls.filter((c) => c.level === "info");
    expect(infos.some((c) => c.message.includes("adopted"))).toBe(true);
  });

  it("S61.7. provider fenced (HALTED): SHOWTIME_FETCH creates no run and writes nothing", async () => {
    await seedProviderFence(pool);
    const keyId = await seedRunKey(pool, "SHOWTIME_FETCH");
    // A fresh snapshot IS present — the fence rejects before the snapshot is even read,
    // so adoption and fallback creation are both skipped (`FENCE_REJECTED` carries no
    // run id, matching `stageAdoptOrCreateShowtimeWork`'s body in `transactions.ts`).
    await seedFreshSnapshot(pool, keyId);
    const { jobId, generation, searchId } = await seedAdmissionFence(pool, keyId, "SHOWTIME_FETCH");
    await pool.query(
      `INSERT INTO provider_status (provider_id, route_class, state) VALUES ('amc', '', 'HALTED')`,
    );

    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });
    const ctx = jobContext(keyId, jobId, generation, { kind: "SHOWTIME_FETCH", searchId });
    await registry.job.SHOWTIME_FETCH.handler(ctx);

    try {
      // Still exactly the one seeded DONE run — no fresh run, no outbox, no fan-in writes.
      expect(
        await count(pool, `SELECT count(*) AS n FROM provider_run WHERE run_key_id = $1`, [keyId]),
      ).toBe("1");
      expect(await count(pool, `SELECT count(*) AS n FROM run_application`)).toBe("0");
      expect(await count(pool, `SELECT count(*) AS n FROM search_event`)).toBe("0");
      expect(await count(pool, `SELECT count(*) AS n FROM outbox`)).toBe("0");
      const job = await pool.query<{ state: string }>(
        `SELECT state FROM search_job WHERE job_id = $1`,
        [jobId],
      );
      expect(job.rows[0]?.state).toBe("LEASED");

      const infos = (ctx.logger as CapturingLogger).calls.filter((c) => c.level === "info");
      expect(infos.some((c) => c.message.includes("fence rejected"))).toBe(true);
    } finally {
      // `provider_status` is outside the suite's TRUNCATE list — don't leak HALTED.
      await pool.query(`DELETE FROM provider_status WHERE provider_id = 'amc'`);
    }
  });

  it("8. wiring overrides only job.* — run.* and aggregate stay placeholder (S8.17 discipline)", () => {
    const registry = withJobAdmissionDedup(createPlaceholderRegistry(), { pool });

    expect(registry.job.SHOWTIME_FETCH.implemented).toBe(true);
    expect(registry.job.SCHEDULE_RESOLUTION.implemented).toBe(true);
    expect(registry.run.SHOWTIME_FETCH.implemented).toBe(false);
    expect(registry.run.SCHEDULE_RESOLUTION.implemented).toBe(false);
    expect(registry.run.RECHECK.implemented).toBe(false);
    expect(registry.aggregate.implemented).toBe(false);
  });

  it("9. type-level pool enforcement: a bare autocommitted SqlClient is rejected (S30 item 4)", () => {
    // Compile-time only: the function bodies below are type-checked but never invoked, so no
    // connection is opened. If either stops erroring, `tsc` reports the directive as unused
    // (TS2578) and `pnpm typecheck` fails — the brand, not a comment, is what blocks the
    // autocommitted adapter (pool.ts:47-57).
    function composerRejectsBareSqlClient(p: Pool): void {
      // @ts-expect-error — the composer requires a real pg.Pool, not a plain SqlClient.
      withJobAdmissionDedup(createPlaceholderRegistry(), { pool: poolClient(p) });
    }
    function findOrCreateRunRejectsBareSqlClient(p: Pool): void {
      // @ts-expect-error — findOrCreateRun takes a TransactionClient; a plain SqlClient has no brand.
      void findOrCreateRun(poolClient(p), { runKeyId: "run_never_used" });
    }
    void composerRejectsBareSqlClient;
    void findOrCreateRunRejectsBareSqlClient;
    expect(true).toBe(true);
  });
});
