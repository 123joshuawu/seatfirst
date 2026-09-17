import IORedis from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  B10_ADVANCE_SNAPSHOT_WATERMARK,
  SNAPSHOT_CAS,
  poolClient,
  runStatement,
} from "@seatfirst/durability";
import type { RedisScriptExecutor, SqlClient } from "@seatfirst/durability";

import { redisScriptExecutorFromIoredis } from "../src/session/limiter.js";
import { advanceStaleSnapshotProjections } from "../src/sweeper/duties.js";
import { createSnapshotProjector, UnprojectableRunKeyKindError } from "../src/sweeper/projector.js";

import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S33 verification, items 1–4 of the spec — the snapshot projection producer against real
 * Postgres 16 and Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`), never
 * mocks and never live AMC. The Redis write goes through the existing `SNAPSHOT_CAS` Lua
 * (the same audited artifact the durability tier races at tier 4/tier 5); the watermark
 * advance is the durability boundary `B10_ADVANCE_SNAPSHOT_WATERMARK`.
 *
 * Raw INSERTs below are seed data / precondition simulation (the two legitimate
 * non-boundary buckets, `CONTRIBUTING.md` §2) — the transitions under test are performed
 * exclusively by the named boundary statements and the existing `SNAPSHOT_CAS` script.
 */

// --- seed helpers (raw INSERTs: seed data, not state transitions) -------------------

const PAST = "2026-08-15T00:00:00.000Z";

/** A SHOWTIME_FETCH key with an accepted observation + availability_snapshot. */
async function seedAcceptedShowtimeFetch(
  pool: Pool,
  opts: {
    readonly runKeyId: string;
    readonly showtimeId: string;
    readonly acceptedRevision: number;
    readonly projectedRevision: number;
    readonly bitmap: Buffer;
    readonly freeCount: number;
  },
): Promise<{ observationId: string; capturedAt: string }> {
  const observationId = `${opts.runKeyId}_obs`;
  const runId = `${opts.runKeyId}_run`;
  const capturedAt = "2026-08-16T00:00:00.000Z";
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id,
                          accepted_revision, projected_revision, latest_observation_id,
                          latest_captured_at)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2, $3, $4, $5, $6)`,
    [
      opts.runKeyId,
      opts.showtimeId,
      opts.acceptedRevision,
      opts.projectedRevision,
      observationId,
      capturedAt,
    ],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation,
                               lease_expires_at, attempt, provider_epoch, created_at)
     VALUES ($1, $2, $3, 'DONE', 1, NULL, 1, 0, $4)`,
    [runId, opts.runKeyId, observationId, capturedAt],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, $4, $5)`,
    [observationId, opts.runKeyId, runId, capturedAt, opts.acceptedRevision],
  );
  await pool.query(
    `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [observationId, opts.showtimeId, capturedAt, opts.bitmap, opts.freeCount],
  );
  return { observationId, capturedAt };
}

// --- fixtures -----------------------------------------------------------------------

let pg: TestService;
let redis: TestService;
let pool: Pool;
let redisAdmin: IORedis.Redis;
let executor: RedisScriptExecutor;

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);

  pool = new Pool({ connectionString: pg.url });
  redisAdmin = new IORedis.Redis(redis.url, { lazyConnect: true });
  await redisAdmin.connect();
  executor = redisScriptExecutorFromIoredis(redisAdmin);
});

afterAll(async () => {
  await Promise.allSettled([pool.end()]);
  redisAdmin.disconnect();
  await Promise.allSettled([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await pool.query("TRUNCATE search, run_key CASCADE");
});

const db = () => poolClient(pool);

/** Resolves the rejection reason, or fails loudly if the promise fulfilled. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject, but it fulfilled");
    },
    (cause: unknown) => cause,
  );
}

describe("snapshot projection producer (S33)", () => {
  it("projects an accepted SHOWTIME_FETCH snapshot through SNAPSHOT_CAS, then the watermark advances", async () => {
    const runKeyId = uniq("key_proj");
    const showtimeId = uniq("showtime");
    const { observationId } = await seedAcceptedShowtimeFetch(pool, {
      runKeyId,
      showtimeId,
      acceptedRevision: 3,
      projectedRevision: 1,
      bitmap: Buffer.from([0xaa, 0xbb]),
      freeCount: 9,
    });

    const compute = createSnapshotProjector(db(), executor);
    await compute({ runKeyId, acceptedRevision: "3", latestObservationId: observationId });

    const cacheKey = `bitmap:${runKeyId}`;
    expect(await redisAdmin.hget(cacheKey, "rev")).toBe("3");
    // Golden value: the serialization is pinned by the module header — bitmap hex-encoded,
    // free_count verbatim, captured_at as its UTC ISO-8601 string. Hand-derived here, never
    // recomputed with the implementation's own serializer.
    expect(await redisAdmin.hget(cacheKey, "bitmap")).toBe(
      '{"bitmap":"aabb","free_count":9,"captured_at":"2026-08-16T00:00:00.000Z"}',
    );

    // The producer does NOT advance the watermark; the orchestrator does.
    expect(
      (
        await pool.query<{ projected_revision: string }>(
          `SELECT projected_revision FROM run_key WHERE run_key_id = $1`,
          [runKeyId],
        )
      ).rows[0]?.projected_revision,
    ).toBe("1");

    const advanced = await runStatement<{ projected_revision: string }>(
      db(),
      B10_ADVANCE_SNAPSHOT_WATERMARK,
      [runKeyId, "3"],
    );
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.projected_revision).toBe("3");
  });

  it("a stale (lower-revision) CAS write is rejected and leaves the cache unchanged", async () => {
    const runKeyId = uniq("key_fence");
    const { observationId } = await seedAcceptedShowtimeFetch(pool, {
      runKeyId,
      showtimeId: uniq("showtime"),
      acceptedRevision: 3,
      projectedRevision: 1,
      bitmap: Buffer.from([0xaa, 0xbb]),
      freeCount: 9,
    });

    await createSnapshotProjector(
      db(),
      executor,
    )({
      runKeyId,
      acceptedRevision: "3",
      latestObservationId: observationId,
    });

    const cacheKey = `bitmap:${runKeyId}`;
    const before = await redisAdmin.hgetall(cacheKey);

    // The exact certified-stale rejection the ADR's CAS exists for (T20): a projector
    // holding revision 2 loses at the cache as well as at the watermark.
    expect(await executor.eval(SNAPSHOT_CAS, [cacheKey], [2, "stale-payload"])).toBe(0);
    expect(await redisAdmin.hgetall(cacheKey)).toEqual(before);
    expect(await redisAdmin.hget(cacheKey, "rev")).toBe("3");
  });

  it("never selects a stale SCHEDULE_RESOLUTION key — resolves to 0, watermark untouched", async () => {
    // A SCHEDULE_RESOLUTION key CAN reach the stale state: its acceptance bumps
    // accepted_revision without ever writing an availability_snapshot. It is therefore
    // structurally unadvanceable by this duty (S33 scoped real writes to SHOWTIME_FETCH),
    // so SWEEP_STALE_SNAPSHOT_PROJECTIONS excludes it from candidate selection entirely —
    // specifically so a permanently-stale row of this kind can never poison-pill its
    // sibling SHOWTIME_FETCH rows in the same batch.
    const runKeyId = uniq("key_sched");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id,
                            theatre_id, local_date, accepted_revision, projected_revision,
                            latest_observation_id, latest_captured_at)
       VALUES ($1, 'SCHEDULE_RESOLUTION', 'amc', 'schedule', NULL, 'theatre_1', '2026-08-03',
               1, 0, NULL, $2)`,
      [runKeyId, PAST],
    );

    expect(
      await advanceStaleSnapshotProjections(db(), {
        age: "1 minute",
        compute: createSnapshotProjector(db(), executor),
      }),
    ).toBe(0);
    expect(
      (
        await pool.query<{ projected_revision: string }>(
          `SELECT projected_revision FROM run_key WHERE run_key_id = $1`,
          [runKeyId],
        )
      ).rows[0]?.projected_revision,
    ).toBe("0");
  });

  it("never selects a synthetic stale RECHECK key — resolves to 0, watermark untouched", async () => {
    // Defensive mirror of the SHOWTIME_FETCH-only filter: RECHECK never advances
    // accepted_revision, so it cannot reach the stale state in practice; seeded stale here
    // to prove the SQL excludes the kind from candidate selection entirely rather than
    // failing loud on attempt.
    const runKeyId = uniq("key_recheck");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id,
                            theatre_id, local_date, accepted_revision, projected_revision,
                            latest_observation_id, latest_captured_at, recheck_placement)
       VALUES ($1, 'RECHECK', 'amc', 'seat', $2, NULL, NULL, 1, 0, NULL, $3, '{}'::jsonb)`,
      [runKeyId, uniq("showtime"), PAST],
    );

    expect(
      await advanceStaleSnapshotProjections(db(), {
        age: "1 minute",
        compute: createSnapshotProjector(db(), executor),
      }),
    ).toBe(0);
    expect(
      (
        await pool.query<{ projected_revision: string }>(
          `SELECT projected_revision FROM run_key WHERE run_key_id = $1`,
          [runKeyId],
        )
      ).rows[0]?.projected_revision,
    ).toBe("0");
  });

  it("fails loud on an unrecognized run_key kind (exhaustiveness)", async () => {
    // The DB CHECK only admits the three known kinds, so the exhaustiveness default is
    // unreachable through real Postgres; a stub read surface is the honest way to reach it.
    const fakeDb: SqlClient = {
      query: () =>
        Promise.resolve({
          rows: [
            {
              kind: "FUTURE_KIND",
              showtime_id: null,
              bitmap: null,
              free_count: null,
              captured_at: null,
            },
          ],
        }),
    };
    const compute = createSnapshotProjector(fakeDb, executor);
    const error = await rejectionOf(
      compute({ runKeyId: "k_future", acceptedRevision: "1", latestObservationId: null }),
    );
    expect(error).toBeInstanceOf(UnprojectableRunKeyKindError);
    expect((error as UnprojectableRunKeyKindError).kind).toBe("FUTURE_KIND");
  });
});
