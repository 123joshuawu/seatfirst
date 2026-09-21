/**
 * S27 verification — the AGGREGATE answer-assembler handler against real Postgres 16
 * (testcontainers, or `SERVER_PG_URL`), driving `createAggregateAnswerHandler` directly with
 * the claim acquired through the real `B7_CLAIM` statement (the consumer's ownership
 * mechanism, `dispatch.test.ts`). The transitions under test (`B7_CLAIM`,
 * `B7_UPSERT_AGGREGATE`, `B7_GROUP_EVENT`, `B7_RELEASE`, `B8_TERMINALIZE` and its tail) are
 * performed exclusively by the handler + durability helpers it calls.
 * F6 is closed (ADR 0032; landed with S41): layout rows decode through the real
 * `decodeAuditoriumLayoutGeometry`, so an encoded fixture assembles real `ResultGroup`s,
 * while garbage bytes still fail loud — via the decoder now, not a handler-side guard.
 * Raw INSERTs below are seed data (the legitimate non-boundary bucket, `CONTRIBUTING.md` §2).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildAuditoriumLayout, encodeAuditoriumLayoutGeometry } from "@seatfirst/core";

import { B7_CLAIM, poolClient } from "@seatfirst/durability";

import {
  createAggregateAnswerHandler,
  type AnswerAssemblerDeps,
} from "../src/dispatch/handlers/aggregate-answer-assembler.js";
import {
  findSearchById,
  readAggregatePerformances,
  readAggregateScheduleOutcome,
} from "../src/dispatch/queries.js";
import { startTestPostgres } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { TEST_PROVIDER_HOST_ALLOWLISTS } from "./support/app.js";
import { migrateDatabase } from "./support/db.js";
import { capturingLogger } from "./support/logger.js";

// --- constants -----------------------------------------------------------------------

const PROVIDER = "amc";
const THEATRE = `${PROVIDER}:theatre:t1`;
const MOVIE = `${PROVIDER}:movie:m1`;
const LOCAL_DATE = "2026-08-20";
const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

// --- seed helpers (raw INSERTs: seed data, not state transitions) --------------------

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

function makeSpec(): Record<string, unknown> {
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [MOVIE] },
        { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  };
}

async function seedProvider(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, 1000, 100)`,
    [PROVIDER],
  );
  await pool.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
}

async function seedSearch(
  pool: Pool,
  opts: {
    searchId?: string;
    spec?: Record<string, unknown>;
    status?: string;
    deadlineAt?: string;
    aggRequestedRev?: number;
  } = {},
): Promise<string> {
  const searchId = opts.searchId ?? uniq("search");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status,
                         deadline_at, agg_requested_rev)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      searchId,
      uniq("session"),
      uniq("idem"),
      JSON.stringify(opts.spec ?? makeSpec()),
      `hash_${searchId}`,
      opts.status ?? "RUNNING",
      opts.deadlineAt ?? FUTURE,
      opts.aggRequestedRev ?? 0,
    ],
  );
  return searchId;
}
/** Seeds a resolved SCHEDULE_RESOLUTION subscription plus `count` performances, so the
 * handler's `readAggregatePerformances` returns real rows. Returns the seeded showtime
 * ids in insertion order. */
async function seedScheduleResolution(
  pool: Pool,
  searchId: string,
  opts: { count?: number; layoutId?: string | null } = {},
): Promise<string[]> {
  const count = opts.count ?? 2;
  const theatreId = THEATRE;
  await pool.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Test Theatre', 40.0, -74.0, 'America/New_York', now(), now())`,
    [theatreId, PROVIDER],
  );
  const runKeyId = uniq("key");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
    [runKeyId, PROVIDER, theatreId, LOCAL_DATE],
  );
  const jobId = uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, 'SCHEDULE_RESOLUTION', $3, 0, 'DONE', $4)`,
    [jobId, searchId, runKeyId, FUTURE],
  );
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at, schedule_outcome)
     VALUES ($1, $2, $3, 'LIVE', $4, 'RESOLVED')`,
    [runKeyId, searchId, jobId, FUTURE],
  );
  const runId = uniq("run");
  const observationId = uniq("obs");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, observationId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, now(), 0)`,
    [observationId, runKeyId, runId],
  );
  const showtimeIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const showtimeId = `${PROVIDER}:showtime:s${index}_${uniq("")}`;
    showtimeIds.push(showtimeId);
    await pool.query(
      `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                                observation_id, movie_id, status, deep_link_url, layout_id)
       VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, 'OPEN', 'https://example.invalid/showtime', $7)`,
      [showtimeId, PROVIDER, theatreId, LOCAL_DATE, observationId, MOVIE, opts.layoutId ?? null],
    );
  }
  return showtimeIds;
}

/** Seeds a live (PENDING) SHOWTIME_FETCH job so the search is NOT terminal-ready, keeping
 * the nonterminal path reachable. */
async function seedPendingFetch(pool: Pool, searchId: string): Promise<void> {
  const runKeyId = uniq("key");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
    [runKeyId, PROVIDER, `${PROVIDER}:showtime:pending`],
  );
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'PENDING', $4)`,
    [uniq("job"), searchId, runKeyId, FUTURE],
  );
}

/** Seeds an accepted SHOWTIME_FETCH observation plus its availability_snapshot for one
 * showtime (the accepted-fetch shape proven in `snapshot-projector.test.ts`), so
 * `readLatestShowtimeSnapshots` resolves that showtime. */
async function seedAcceptedSnapshot(
  pool: Pool,
  showtimeId: string,
  bitmap: Buffer,
  freeCount: number,
): Promise<void> {
  const runKeyId = uniq("key_snap");
  const observationId = uniq("obs_snap");
  const runId = uniq("run_snap");
  const capturedAt = "2026-08-19T12:00:00.000Z";
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id,
                          accepted_revision, projected_revision, latest_observation_id,
                          latest_captured_at)
     VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3, 0, 0, $4, $5)`,
    [runKeyId, PROVIDER, showtimeId, observationId, capturedAt],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, observationId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, $4, 0)`,
    [observationId, runKeyId, runId, capturedAt],
  );
  await pool.query(
    `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [observationId, showtimeId, capturedAt, bitmap, freeCount],
  );
}

// --- S36 fresh-aware helpers -------------------------------------------------------

async function ensureTheatre(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Test Theatre', 40.0, -74.0, 'America/New_York', now(), now())
     ON CONFLICT (theatre_id) DO NOTHING`,
    [THEATRE, PROVIDER],
  );
}

async function ensureDummyObservation(pool: Pool): Promise<string> {
  const runKeyId = uniq("key_dummy");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)
     ON CONFLICT (run_key_id) DO NOTHING`,
    [runKeyId, PROVIDER, THEATRE, "2000-01-01"],
  );
  const runId = uniq("run_dummy");
  const obsId = uniq("obs_dummy");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)
     ON CONFLICT (run_id) DO NOTHING`,
    [runId, runKeyId, obsId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, now(), 0)
     ON CONFLICT (observation_id) DO NOTHING`,
    [obsId, runKeyId, runId],
  );
  return obsId;
}

async function seedFreshShowtime(
  pool: Pool,
  searchId: string,
  showtimeId: string,
  startsAtIso: string,
  localDate: string,
  observationId: string,
  movieId = MOVIE,
): Promise<void> {
  await pool.query(
    `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                              observation_id, movie_id, status, deep_link_url, layout_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', 'https://example.invalid/showtime', null)
     ON CONFLICT (showtime_id) DO NOTHING`,
    [showtimeId, PROVIDER, THEATRE, localDate, startsAtIso, observationId, movieId],
  );
  const runKeyId = `k_fetch_${PROVIDER}_${showtimeId}`;
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)
     ON CONFLICT (run_key_id) DO NOTHING`,
    [runKeyId, PROVIDER, showtimeId],
  );
  const jobId = uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'DONE', $4)`,
    [jobId, searchId, runKeyId, FUTURE],
  );
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at)
     VALUES ($1, $2, $3, 'SATISFIED', $4)
     ON CONFLICT (run_key_id, search_id) DO NOTHING`,
    [runKeyId, searchId, jobId, FUTURE],
  );
}

async function seedColdShowtime(
  pool: Pool,
  searchId: string,
  showtimeId: string,
  startsAtIso: string,
  localDate: string,
  observationId: string,
  scheduleOutcome: string = "RESOLVED",
  movieId = MOVIE,
): Promise<string> {
  await pool.query(
    `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                              observation_id, movie_id, status, deep_link_url, layout_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', 'https://example.invalid/showtime', null)
     ON CONFLICT (showtime_id) DO NOTHING`,
    [showtimeId, PROVIDER, THEATRE, localDate, startsAtIso, observationId, movieId],
  );
  const runKeyId = uniq("key_cold");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
     VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
    [runKeyId, PROVIDER, THEATRE, localDate],
  );
  const jobId = uniq("job");
  await pool.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
     VALUES ($1, $2, 'SCHEDULE_RESOLUTION', $3, 0, 'DONE', $4)`,
    [jobId, searchId, runKeyId, FUTURE],
  );
  await pool.query(
    `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at, schedule_outcome)
     VALUES ($1, $2, $3, 'SATISFIED', $4, $5)`,
    [runKeyId, searchId, jobId, FUTURE, scheduleOutcome],
  );
  const runId = uniq("run");
  const obsId = uniq("obs");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, obsId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, now(), 0)`,
    [obsId, runKeyId, runId],
  );
  // Re-point the performance to the cold observation so the cold branch (via provider_run.observation_id)
  // resolves to this showtime — update the earlier inserted row.
  await pool.query(`UPDATE performance SET observation_id = $1 WHERE showtime_id = $2`, [
    obsId,
    showtimeId,
  ]);
  return runKeyId;
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
  await pool.query(
    "TRUNCATE search, run_key, theatre, provider_fence, provider_status, provider_admission, auditorium_layout CASCADE",
  );
});

function makeDeps(): AnswerAssemblerDeps {
  return {
    pool,
    providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
    offerStalenessMs: 120000,
  };
}

/** Claims through the real `B7_CLAIM` then invokes the handler, mirroring the consumer. */
async function runPass(deps: AnswerAssemblerDeps, searchId: string): Promise<void> {
  const claim = await pool.query(B7_CLAIM.text, [searchId, "1 minute"]);
  expect(claim.rows).toHaveLength(1);
  const { agg_generation, agg_requested_rev } = claim.rows[0] as {
    agg_generation: number;
    agg_requested_rev: string;
  };
  const sqlClient = poolClient(pool);
  const search = await findSearchById(sqlClient, searchId);
  if (search === null) throw new Error(`seed search ${searchId} not found`);
  await createAggregateAnswerHandler(deps)({
    search,
    aggGeneration: agg_generation,
    aggRequestedRev: agg_requested_rev,
    logger: capturingLogger(),
    sqlClient,
  });
}

// --- tests ---------------------------------------------------------------------------

describe("aggregate answer assembler", () => {
  it("materializes a nonterminal aggregate and releases the claim (S27.12/S27.16)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    await seedScheduleResolution(pool, searchId);
    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);

    const aggregate = await pool.query<{ revision: string; payload: Record<string, unknown> }>(
      `SELECT revision, payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const aggregateRow = aggregate.rows[0]!;
    expect(aggregateRow.revision).toBe("1");
    const payload = aggregateRow.payload;
    expect(payload.status).toBe("RUNNING");
    expect(payload.answer).toBeNull();
    expect(payload.resolved).toBe(0);
    expect(payload.total).toBe(2);
    expect(payload.groups).toEqual([]);

    const search = await pool.query<{
      status: string;
      agg_processed_rev: string;
      agg_lease_expires: string | null;
    }>(`SELECT status, agg_processed_rev, agg_lease_expires FROM search WHERE search_id = $1`, [
      searchId,
    ]);
    const searchRow = search.rows[0]!;
    expect(searchRow.status).toBe("RUNNING");
    expect(searchRow.agg_processed_rev).toBe("1");
    expect(searchRow.agg_lease_expires).toBeNull();
    // nonterminal pass never writes a terminal result version
    const resultVersion = await pool.query(
      `SELECT 1 FROM search_result_version WHERE search_id = $1`,
      [searchId],
    );
    expect(resultVersion.rows).toHaveLength(0);
  });

  it("terminalizes a deadline-expired search with an EMPTY answer (S27.9)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });
    await seedScheduleResolution(pool, searchId);

    await runPass(makeDeps(), searchId);

    const search = await pool.query<{
      status: string;
      terminal_cause: string | null;
      agg_lease_expires: string | null;
    }>(`SELECT status, terminal_cause, agg_lease_expires FROM search WHERE search_id = $1`, [
      searchId,
    ]);
    const searchRow = search.rows[0]!;
    expect(searchRow.status).toBe("COMPLETE");
    expect(searchRow.agg_lease_expires).toBeNull();

    const version = await pool.query<{ version: number; payload: Record<string, unknown> }>(
      `SELECT version, payload FROM search_result_version WHERE search_id = $1`,
      [searchId],
    );
    expect(version.rows).toHaveLength(1);
    const versionRow = version.rows[0]!;
    expect(versionRow.version).toBe(1);
    const payload = versionRow.payload;
    expect(payload.status).toBe("COMPLETE");
    const answer = payload.answer as { mode: string; cause?: string };
    expect(answer.mode).toBe("EMPTY");
    expect(answer.cause).toBe("HALTED");

    const terminalEvent = await pool.query<{ type: string }>(
      `SELECT type FROM search_event WHERE search_id = $1 AND type = 'SEARCH_TERMINAL'`,
      [searchId],
    );
    expect(terminalEvent.rows).toHaveLength(1);
  });

  it("assembles a real ResultGroup from an encoded auditorium_layout fixture (F6 closed)", async () => {
    await seedProvider(pool);
    // A small 4×6 grid — ordinary seats plus one wheelchair cell (S41's fixture guidance).
    const built = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: index === 23 ? ("WHEELCHAIR" as const) : ("STANDARD" as const),
        visible: true,
        available: true,
      })),
    });
    // Content-addressed: the row's layout_id IS the geometry fingerprint, or the
    // decoder would reject the row on read (FINGERPRINT_MISMATCH).
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 4, 6)`,
      [built.layout.layoutId, encodeAuditoriumLayoutGeometry(built.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    const showtimeIds = await seedScheduleResolution(pool, searchId, {
      count: 2,
      layoutId: built.layout.layoutId,
    });
    // The legacy column default is `{}` (not an array); the writer's real shape is a JSON
    // array of attribute strings, so the fixture carries that.
    await pool.query(
      `UPDATE performance SET attributes = $1::jsonb, format_code = $2 WHERE layout_id = $3`,
      [JSON.stringify(["RESERVED_SEATING"]), "STANDARD", built.layout.layoutId],
    );
    // One showtime carries an accepted snapshot (24 cells → 3 bytes, every bit free);
    // the other stays snapshot-less so both wire variants are exercised.
    await seedAcceptedSnapshot(pool, showtimeIds[0]!, Buffer.from([0xff, 0xff, 0xff]), 24);
    await seedPendingFetch(pool, searchId);

    // The pass resolves: the old NO_GEOMETRY_DECODER guard is gone (S41).
    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      groups: {
        layoutId: string;
        theatreId: string;
        showtimes: { resolved: boolean; showtimeId: string }[];
        seatScores: number[];
        groupHits: unknown[] | undefined;
      }[];
    };
    expect(payload.total).toBe(2);
    expect(payload.resolved).toBe(1);
    expect(payload.groups).toHaveLength(1);
    const group = payload.groups[0]!;
    expect(group.layoutId).toBe(built.layout.layoutId);
    expect(group.theatreId).toBe(THEATRE);
    expect(group.seatScores).toHaveLength(24);
    expect(group.seatScores.every((score) => Number.isFinite(score))).toBe(true);
    expect(group.groupHits).toBeDefined();
    expect(group.groupHits!.length).toBeGreaterThan(0);

    // Both showtime variants present; exactly the snapshot-carrying one is resolved.
    expect(group.showtimes).toHaveLength(2);
    expect(
      group.showtimes.filter((showtime) => showtime.resolved).map((s) => s.showtimeId),
    ).toEqual([showtimeIds[0]]);
  });

  it("populates ShowtimeOffer.minPrice as Money for priced performances, null otherwise (S59, ADR 0062 §4)", async () => {
    await seedProvider(pool);
    const built = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 4, 6)`,
      [built.layout.layoutId, encodeAuditoriumLayoutGeometry(built.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    const showtimeIds = await seedScheduleResolution(pool, searchId, {
      count: 2,
      layoutId: built.layout.layoutId,
    });
    await pool.query(
      `UPDATE performance SET attributes = $1::jsonb, format_code = $2 WHERE layout_id = $3`,
      [JSON.stringify(["RESERVED_SEATING"]), "STANDARD", built.layout.layoutId],
    );
    // Seed data: the priced state a seat-fetch acceptance would have persisted via
    // B5C_PERFORMANCE_PRICE — only the first showtime carries a price.
    await pool.query(
      `UPDATE performance SET min_price = $1::numeric, currency = $2, price_basis = $3
       WHERE showtime_id = $4`,
      ["16.99", "USD", "TICKET_ONLY", showtimeIds[0]],
    );
    await seedAcceptedSnapshot(pool, showtimeIds[0]!, Buffer.from([0xff, 0xff, 0xff]), 24);
    await seedPendingFetch(pool, searchId);

    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      groups: { showtimes: { resolved: boolean; showtimeId: string; minPrice: unknown }[] }[];
    };
    expect(payload.groups).toHaveLength(1);
    const showtimes = payload.groups[0]!.showtimes;
    expect(showtimes).toHaveLength(2);
    const priced = showtimes.find((showtime) => showtime.showtimeId === showtimeIds[0]);
    expect(priced?.resolved).toBe(true);
    // Delete the assembler's Money mapping (back to `minPrice: null`) and this fails.
    expect(priced?.minPrice).toEqual({ amount: 16.99, currency: "USD", basis: "TICKET_ONLY" });
    const unpriced = showtimes.find((showtime) => showtime.showtimeId === showtimeIds[1]);
    expect(unpriced?.resolved).toBe(false);
    expect(unpriced?.minPrice).toBeNull();
  });

  it("ADR 0033 addendum: a layout-unknown unresolved showtime is not dropped — it joins every same-theatre group as UNRESOLVED_SHOWTIMES", async () => {
    await seedProvider(pool);
    // A small 4×6 grid, every cell free — enough room for a RUN of 2 with room to spare.
    const built = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 4, 6)`,
      [built.layout.layoutId, encodeAuditoriumLayoutGeometry(built.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    // Three performances seeded with no layout (the SCHEDULE_RESOLUTION-only default) —
    // only the first is then promoted to a real, resolved showtime; the other two stay
    // exactly as a showtime whose seat-map fetch never established a layout at all.
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 3 });
    await pool.query(
      `UPDATE performance SET layout_id = $1, format_code = 'STANDARD', attributes = $2::jsonb
       WHERE showtime_id = $3`,
      [built.layout.layoutId, JSON.stringify(["RESERVED_SEATING"]), showtimeIds[0]],
    );
    await seedAcceptedSnapshot(pool, showtimeIds[0]!, Buffer.from([0xff, 0xff, 0xff]), 24);
    await seedPendingFetch(pool, searchId);

    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      groups: {
        layoutId: string;
        showtimes: { resolved: boolean; showtimeId: string }[];
        groupHits: { relaxed?: { kind: string; count?: number }[] }[] | undefined;
      }[];
      answer: { mode: string } | null;
    };
    expect(payload.total).toBe(3);
    expect(payload.resolved).toBe(1);
    // Still exactly one group (the two layout-unknown showtimes never form — or join — a
    // second group; ADR 0029's theatreId+layoutId key is untouched).
    expect(payload.groups).toHaveLength(1);
    const group = payload.groups[0]!;
    // All three showtimes are present on the one real group — the two layout-unknown ones
    // are no longer silently dropped.
    expect(group.showtimes).toHaveLength(3);
    expect(new Set(group.showtimes.map((s) => s.showtimeId))).toEqual(new Set(showtimeIds));
    expect(group.showtimes.filter((s) => s.resolved).map((s) => s.showtimeId)).toEqual([
      showtimeIds[0],
    ]);
  });
  it("handles multi-geometry theatre where an unresolved showtime bitmap mismatches a group's layout (bitmap length regression)", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    // Two distinct auditorium geometries in the SAME theatre: 4x6 (3 bytes) and 6x11 (9 bytes).
    // Mirrors seeded dev theatre where 6x11, 10x23, 11x18 coexist and the ADR 0033 addendum's
    // unresolved bucket previously caused `bitmap byte length does not match bitLength` when a
    // 9-byte bitmap was presented to a 3-byte group's layout.
    const small = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    const medium = buildAuditoriumLayout({
      rows: 6,
      columns: 11,
      cells: Array.from({ length: 66 }, (_, index) => ({
        row: Math.floor(index / 11) + 1,
        column: (index % 11) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns) VALUES ($1, $2::bytea, 4, 6)`,
      [small.layout.layoutId, encodeAuditoriumLayoutGeometry(small.layout)],
    );
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns) VALUES ($1, $2::bytea, 6, 11)`,
      [medium.layout.layoutId, encodeAuditoriumLayoutGeometry(medium.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    const theatreId = THEATRE;
    const obsId = await ensureDummyObservation(pool);
    const showtimeSmall = `${PROVIDER}:showtime:small_${uniq("")}`;
    const showtimeMedium = `${PROVIDER}:showtime:medium_${uniq("")}`;
    const showtimeUnresolved = `${PROVIDER}:showtime:unres_${uniq("")}`;
    for (const [sid, layoutId] of [
      [showtimeSmall, small.layout.layoutId],
      [showtimeMedium, medium.layout.layoutId],
      [showtimeUnresolved, null],
    ] as const) {
      await pool.query(
        `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at, observation_id, movie_id, status, deep_link_url, layout_id, format_code, attributes)
         VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, 'OPEN', 'https://example.invalid/showtime', $7, 'STANDARD', '[]'::jsonb)`,
        [sid, PROVIDER, theatreId, LOCAL_DATE, obsId, MOVIE, layoutId],
      );
      const runKeyId = `k_fetch_${PROVIDER}_${sid}`;
      await pool.query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id) VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3) ON CONFLICT DO NOTHING`,
        [runKeyId, PROVIDER, sid],
      );
      const jobId = uniq("job");
      await pool.query(
        `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at) VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'DONE', $4)`,
        [jobId, searchId, runKeyId, FUTURE],
      );
      await pool.query(
        `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at) VALUES ($1, $2, $3, 'SATISFIED', $4)`,
        [runKeyId, searchId, jobId, FUTURE],
      );
    }
    // Resolved snapshots: small (3 bytes) and medium (9 bytes) match their own layout;
    // the unresolved showtime carries a 9-byte bitmap (matches medium, mismatches small).
    // Use direct inserts reusing the existing SHOWTIME_FETCH run_keys to avoid
    // duplicate (provider_id, showtime_id) violation from seedAcceptedSnapshot.
    for (const [sid, bmp, free] of [
      [showtimeSmall, Buffer.from([0xff, 0xff, 0xff]), 24],
      [showtimeMedium, Buffer.alloc(9, 0xff), 66],
      [showtimeUnresolved, Buffer.alloc(9, 0xff), 66],
    ] as const) {
      const runKeyId = `k_fetch_${PROVIDER}_${sid}`;
      const obsId = uniq("obs_snap");
      const runId = uniq("run_snap");
      const capturedAt = "2026-08-19T12:00:00.000Z";
      await pool.query(
        `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch) VALUES ($1, $2, $3, 'DONE', 0, 0)`,
        [runId, runKeyId, obsId],
      );
      await pool.query(
        `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision) VALUES ($1, $2, $3, $4, 0)`,
        [obsId, runKeyId, runId, capturedAt],
      );
      await pool.query(
        `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count) VALUES ($1, $2, $3, $4, $5)`,
        [obsId, sid, capturedAt, bmp, free],
      );
      await pool.query(
        `UPDATE run_key SET latest_observation_id = $1, latest_captured_at = $2, accepted_revision = 0, projected_revision = 0 WHERE run_key_id = $3`,
        [obsId, capturedAt, runKeyId],
      );
    }
    await seedPendingFetch(pool, searchId);
    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      groups: { layoutId: string; showtimes: { showtimeId: string; resolved: boolean }[] }[];
    };
    expect(payload.total).toBe(3);
    expect(payload.resolved).toBe(3);
    expect(payload.groups).toHaveLength(2);
    const smallGroup = payload.groups.find((g) => g.layoutId === small.layout.layoutId)!;
    const mediumGroup = payload.groups.find((g) => g.layoutId === medium.layout.layoutId)!;
    expect(smallGroup.showtimes).toHaveLength(2);
    expect(mediumGroup.showtimes).toHaveLength(2);
    expect(smallGroup.showtimes.find((s) => s.showtimeId === showtimeUnresolved)?.resolved).toBe(
      false,
    );
    expect(mediumGroup.showtimes.find((s) => s.showtimeId === showtimeUnresolved)?.resolved).toBe(
      false,
    );
  });
  it("terminalizes deadline-expired search with multi-geometry mismatch (adjacent lifecycle check)", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    const small = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    const medium = buildAuditoriumLayout({
      rows: 6,
      columns: 11,
      cells: Array.from({ length: 66 }, (_, index) => ({
        row: Math.floor(index / 11) + 1,
        column: (index % 11) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns) VALUES ($1, $2::bytea, 4, 6)`,
      [small.layout.layoutId, encodeAuditoriumLayoutGeometry(small.layout)],
    );
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns) VALUES ($1, $2::bytea, 6, 11)`,
      [medium.layout.layoutId, encodeAuditoriumLayoutGeometry(medium.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
      deadlineAt: "2020-01-01T00:00:00.000Z",
    });
    const theatreId = THEATRE;
    const obsId = await ensureDummyObservation(pool);
    const s1 = `${PROVIDER}:showtime:dl_small_${uniq("")}`;
    const s2 = `${PROVIDER}:showtime:dl_med_${uniq("")}`;
    const s3 = `${PROVIDER}:showtime:dl_unres_${uniq("")}`;
    for (const [sid, layoutId] of [
      [s1, small.layout.layoutId],
      [s2, medium.layout.layoutId],
      [s3, null],
    ] as const) {
      await pool.query(
        `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at, observation_id, movie_id, status, deep_link_url, layout_id, format_code, attributes)
         VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, 'OPEN', 'https://example.invalid/showtime', $7, 'STANDARD', '[]'::jsonb)`,
        [sid, PROVIDER, theatreId, LOCAL_DATE, obsId, MOVIE, layoutId],
      );
      const rk = `k_fetch_${PROVIDER}_${sid}`;
      await pool.query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id) VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3) ON CONFLICT DO NOTHING`,
        [rk, PROVIDER, sid],
      );
      const jid = uniq("job");
      await pool.query(
        `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at) VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'DONE', $4)`,
        [jid, searchId, rk, "2020-01-01T00:00:00.000Z"],
      );
      await pool.query(
        `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at) VALUES ($1, $2, $3, 'SATISFIED', $4)`,
        [rk, searchId, jid, "2020-01-01T00:00:00.000Z"],
      );
    }
    // Real accepted-fetch shape for the two known layouts — inserts run_application so B8 counts them.
    // Keep the null-layout showtime's 9-byte bitmap but do NOT create its run_application, mirroring
    // the ADR 0033 addendum's unresolved bucket: it remains an unaccepted fetch.
    const runIds: Record<string, string> = {};
    for (const [sid, bmp, free] of [
      [s1, Buffer.from([0xff, 0xff, 0xff]), 24],
      [s2, Buffer.alloc(9, 0xff), 66],
      [s3, Buffer.alloc(9, 0xff), 66],
    ] as const) {
      const rk = `k_fetch_${PROVIDER}_${sid}`;
      const oid = uniq("obs_snap");
      const rid = uniq("run_snap");
      runIds[sid] = rid;
      const cap = "2026-08-19T12:00:00.000Z";
      await pool.query(
        `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch) VALUES ($1, $2, $3, 'DONE', 0, 0)`,
        [rid, rk, oid],
      );
      await pool.query(
        `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision) VALUES ($1, $2, $3, $4, 0)`,
        [oid, rk, rid, cap],
      );
      await pool.query(
        `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count) VALUES ($1, $2, $3, $4, $5)`,
        [oid, sid, cap, bmp, free],
      );
      await pool.query(
        `UPDATE run_key SET latest_observation_id = $1, latest_captured_at = $2, accepted_revision = 0, projected_revision = 0 WHERE run_key_id = $3`,
        [oid, cap, rk],
      );
    }
    // Accepted-fetch fixture: application rows for the two known layouts only.
    for (const sid of [s1, s2] as const) {
      await pool.query(`INSERT INTO run_application (run_id, search_id) VALUES ($1, $2)`, [
        runIds[sid]!,
        searchId,
      ]);
    }
    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();
    const search = await pool.query<{ status: string; terminal_cause: string | null }>(
      `SELECT status, terminal_cause FROM search WHERE search_id = $1`,
      [searchId],
    );
    // Deadline past with 2 accepted fetches (real run_application) must terminalize to the B8-derived
    // exact status for this world. With both fetch jobs DONE and 2/3 accepted, B8 yields COMPLETE.
    expect(search.rows[0]!.status).toBe("COMPLETE");
    expect(search.rows[0]!.terminal_cause).toBeNull();
  });

  it("coerces the `{}` jsonb attribute default to [] so a normal AGGREGATE pass assembles", async () => {
    await seedProvider(pool);
    const built = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: index === 23 ? ("WHEELCHAIR" as const) : ("STANDARD" as const),
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 4, 6)`,
      [built.layout.layoutId, encodeAuditoriumLayoutGeometry(built.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    // The seeding helper writes NO attributes column value on purpose: the only real
    // writer (`stageScheduleAcceptance`) hardcodes `{}`, so the rows below carry the
    // jsonb DEFAULT '{}'::jsonb — exactly what schedule acceptance leaves behind.
    const showtimeIds = await seedScheduleResolution(pool, searchId, {
      count: 2,
      layoutId: built.layout.layoutId,
    });
    const rawAttributes = await pool.query<{ attributes: unknown }>(
      `SELECT attributes FROM performance WHERE showtime_id = $1`,
      [showtimeIds[0]!],
    );
    expect(rawAttributes.rows[0]!.attributes).toEqual({});
    // Unlike the F6 fixture above, NO attributes array is written here on purpose —
    // only `format_code`, which the result schema requires but acceptance never fills.
    await pool.query(`UPDATE performance SET format_code = $1 WHERE layout_id = $2`, [
      "STANDARD",
      built.layout.layoutId,
    ]);
    const perfs = await readAggregatePerformances(poolClient(pool), searchId);
    expect(perfs).toHaveLength(2);
    for (const perf of perfs) {
      expect(perf.attributes).toEqual([]);
    }

    // And the full pass must assemble instead of throwing
    // (`TypeError: input.attributes is not iterable` in group assembly).
    await seedAcceptedSnapshot(pool, showtimeIds[0]!, Buffer.from([0xff, 0xff, 0xff]), 24);
    await seedPendingFetch(pool, searchId);
    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      groups: { layoutId: string; attributes: string[] }[];
    };
    expect(payload.total).toBe(2);
    expect(payload.resolved).toBe(1);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]!.attributes).toEqual([]);
  });

  it("still fails loud on undecodable geometry bytes, writing nothing (S41/ADR 0032)", async () => {
    await seedProvider(pool);
    const layoutId = `${PROVIDER}:layout:garbage`;
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 10, 20)`,
      [layoutId, Buffer.from([1, 2, 3])],
    );
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    await seedScheduleResolution(pool, searchId, { count: 1, layoutId });

    // The handler-side NO_GEOMETRY_DECODER guard is gone, but garbage bytes now throw
    // from `decodeAuditoriumLayoutGeometry` itself — fail loud either way.
    await expect(runPass(makeDeps(), searchId)).rejects.toThrow();
    const aggregate = await pool.query(`SELECT 1 FROM search_aggregate WHERE search_id = $1`, [
      searchId,
    ]);
    expect(aggregate.rows).toHaveLength(0);
    const resultVersion = await pool.query(
      `SELECT 1 FROM search_result_version WHERE search_id = $1`,
      [searchId],
    );
    expect(resultVersion.rows).toHaveLength(0);
  });

  it("fails closed on an invalid spec with zero writes (S27.5)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { spec: { v: 1 }, aggRequestedRev: 1 });

    await expect(runPass(makeDeps(), searchId)).rejects.toThrow();
    const aggregate = await pool.query(`SELECT 1 FROM search_aggregate WHERE search_id = $1`, [
      searchId,
    ]);
    expect(aggregate.rows).toHaveLength(0);
    const resultVersion = await pool.query(
      `SELECT 1 FROM search_result_version WHERE search_id = $1`,
      [searchId],
    );
    expect(resultVersion.rows).toHaveLength(0);
    const search = await pool.query<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [searchId],
    );
    expect(search.rows[0]!.status).toBe("RUNNING");
  });

  // --- S36 fresh-aware aggregation -------------------------------------------------
  it("S36 all-fresh: union includes fresh SHOWTIME_FETCH performances when fresh_match_seed >0 (previously empty)", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    const spec = {
      specVersion: 1,
      providerId: PROVIDER,
      theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: "2026-08-21", to: "2026-08-21" },
          { kind: "TIME_WINDOW", days: ["FRIDAY"], startLocal: "17:00", endLocal: "23:59" },
        ],
      },
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    // fresh seed >0 ensures scheduleOutcome fresh-aware returns RESOLVED even with zero schedule rows
    await pool.query(
      `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled, released)
       VALUES ($1, $2, 1, 1, false, 1, false, false)`,
      [searchId, PROVIDER],
    );
    const obsId = await ensureDummyObservation(pool);
    // inside window: Friday 17:00 EDT -> 21:00 UTC
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:fresh1`,
      "2026-08-21T21:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    await seedPendingFetch(pool, searchId);

    // direct query proves union includes fresh
    const perfs = await readAggregatePerformances(poolClient(pool), searchId);
    expect(perfs).toHaveLength(1);
    expect(perfs[0]!.showtimeId).toBe(`${PROVIDER}:showtime:fresh1`);
    // fresh-aware scheduleOutcome is RESOLVED (not null/FAILED)
    const outcome = await readAggregateScheduleOutcome(poolClient(pool), searchId);
    expect(outcome).toBe("RESOLVED");

    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      status: string;
    };
    expect(payload.total).toBe(1);
    expect(payload.status).toBe("RUNNING");
  });

  it("S36 mixed: union dedupes fresh SHOWTIME_FETCH plus cold SCHEDULE_RESOLUTION by showtime_id", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    const spec = {
      specVersion: 1,
      providerId: PROVIDER,
      theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: "2026-08-21", to: "2026-08-21" },
        ],
      },
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    await pool.query(
      `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled, released)
       VALUES ($1, $2, 200, 200, true, 1, false, false)`,
      [searchId, PROVIDER],
    );
    const obsId = await ensureDummyObservation(pool);
    const sharedShowtime = `${PROVIDER}:showtime:shared`;
    // cold performance for shared showtime (via SCHEDULE_RESOLUTION)
    await seedColdShowtime(
      pool,
      searchId,
      sharedShowtime,
      "2026-08-21T21:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    // fresh duplicate of same showtime plus a distinct fresh showtime
    await seedFreshShowtime(
      pool,
      searchId,
      sharedShowtime,
      "2026-08-21T21:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:fresh2`,
      "2026-08-21T22:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    await seedPendingFetch(pool, searchId);

    const perfs = await readAggregatePerformances(poolClient(pool), searchId);
    const ids = perfs.map((p) => p.showtimeId).sort();
    expect(ids).toEqual([`${PROVIDER}:showtime:fresh2`, sharedShowtime].sort());
    expect(perfs).toHaveLength(2); // deduped, not 3

    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as { total: number };
    expect(payload.total).toBe(2);
  });

  it("S36 out-of-window: shared evaluator filters 16:59 and adjacent weekday before snapshots/counts", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    const spec = {
      specVersion: 1,
      providerId: PROVIDER,
      theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: "2026-08-21", to: "2026-08-22" },
          { kind: "TIME_WINDOW", days: ["FRIDAY"], startLocal: "17:00", endLocal: "23:59" },
        ],
      },
      aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
      groupStrict: false,
      rank: "SCORE",
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    await pool.query(
      `INSERT INTO admission_reservation (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled, released)
       VALUES ($1, $2, 200, 200, true, 1, false, false)`,
      [searchId, PROVIDER],
    );
    const obsId = await ensureDummyObservation(pool);
    // inside: Friday 17:00 EDT -> 21:00 UTC (should pass)
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:inside`,
      "2026-08-21T21:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    // outside time: Friday 16:59 EDT -> 20:59 UTC (same date, before window)
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:outside_time`,
      "2026-08-21T20:59:00.000Z",
      "2026-08-21",
      obsId,
    );
    // outside weekday: Saturday 17:00 EDT -> 21:00 UTC on 2026-08-22 (wrong weekday)
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:outside_day`,
      "2026-08-22T21:00:00.000Z",
      "2026-08-22",
      obsId,
    );
    await seedPendingFetch(pool, searchId);

    const raw = await readAggregatePerformances(poolClient(pool), searchId);
    expect(raw).toHaveLength(3);

    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      excluded: Record<string, unknown>;
    };
    // only the inside window performance survives filtering before total/resolved/excluded
    expect(payload.total).toBe(1);
  });

  it("filters other movies before aggregate counts", async () => {
    await seedProvider(pool);
    await ensureTheatre(pool);
    const spec = {
      ...makeSpec(),
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: "2026-08-21", to: "2026-08-21" },
        ],
      },
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    const obsId = await ensureDummyObservation(pool);
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:selected`,
      "2026-08-21T21:00:00.000Z",
      "2026-08-21",
      obsId,
    );
    await seedFreshShowtime(
      pool,
      searchId,
      `${PROVIDER}:showtime:other`,
      "2026-08-21T22:00:00.000Z",
      "2026-08-21",
      obsId,
      `${PROVIDER}:movie:other`,
    );
    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: { total: number } }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows[0]!.payload.total).toBe(1);
  });

  // --- ADR 0029 §5 item 3: per-theatre excluded breakdown -----------------------------

  it("byTheatre: two theatres produce two entries with independently correct bucket counts (ADR 0029 §5.3)", async () => {
    await seedProvider(pool);
    const theatreA = `${PROVIDER}:theatre:ta`;
    const theatreB = `${PROVIDER}:theatre:tb`;
    // Ensure both theatres exist
    for (const tid of [theatreA, theatreB]) {
      await pool.query(
        `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'Test Theatre', 40.0, -74.0, 'America/New_York', now(), now())
         ON CONFLICT (theatre_id) DO NOTHING`,
        [tid, PROVIDER],
      );
    }
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    // Helper to seed a SCHEDULE_RESOLUTION bundle for a specific theatre with given statuses
    async function seedTheatrePerformances(theatreId: string, statuses: string[]): Promise<void> {
      const runKeyId = uniq("key");
      await pool.query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, theatre_id, local_date)
         VALUES ($1, 'SCHEDULE_RESOLUTION', $2, 'schedule', $3, $4)`,
        [runKeyId, PROVIDER, theatreId, LOCAL_DATE],
      );
      const jobId = uniq("job");
      await pool.query(
        `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at)
         VALUES ($1, $2, 'SCHEDULE_RESOLUTION', $3, 0, 'DONE', $4)`,
        [jobId, searchId, runKeyId, FUTURE],
      );
      await pool.query(
        `INSERT INTO run_subscription (run_key_id, search_id, job_id, state, deadline_at, schedule_outcome)
         VALUES ($1, $2, $3, 'LIVE', $4, 'RESOLVED')`,
        [runKeyId, searchId, jobId, FUTURE],
      );
      const runId = uniq("run");
      const obsId = uniq("obs");
      await pool.query(
        `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
         VALUES ($1, $2, $3, 'DONE', 0, 0)`,
        [runId, runKeyId, obsId],
      );
      await pool.query(
        `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
         VALUES ($1, $2, $3, now(), 0)`,
        [obsId, runKeyId, runId],
      );
      for (const status of statuses) {
        const showtimeId = `${PROVIDER}:showtime:${theatreId.replace(/[^a-z0-9]/gi, "_")}_${uniq("")}`;
        await pool.query(
          `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                                   observation_id, movie_id, status, deep_link_url, layout_id)
           VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, $7, 'https://example.invalid/showtime', null)`,
          [showtimeId, PROVIDER, theatreId, LOCAL_DATE, obsId, MOVIE, status],
        );
      }
    }
    // theatreA: 2 SOLD_OUT, 1 OPEN (3 total); theatreB: 1 SOLD_OUT, 2 OPEN (3 total would be 6 total but we want distinct)
    // Use: A => 2 soldOut + 1 open, B => 1 soldOut + 1 open (total 2+1=3 soldOut, aggregate 5 total)
    await seedTheatrePerformances(theatreA, ["SOLD_OUT", "SOLD_OUT", "OPEN"]);
    await seedTheatrePerformances(theatreB, ["SOLD_OUT", "OPEN"]);

    // Seed fetch failures per theatre — need performance-backed SHOWTIME_FETCH jobs so the
    // LEFT JOIN in readAggregateFetchFailures attributes them to a theatre.
    const dummyObs = await ensureDummyObservation(pool);
    async function seedFetchFailure(theatreId: string, failCause: string | null): Promise<void> {
      const showtimeId = `${PROVIDER}:showtime:fail_${theatreId.replace(/[^a-z0-9]/gi, "_")}_${uniq("")}`;
      // Performance row gives the theatre attribution
      await pool.query(
        `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                                 observation_id, movie_id, status, deep_link_url, layout_id)
         VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, 'OPEN', 'https://example.invalid/showtime', null)
         ON CONFLICT (showtime_id) DO NOTHING`,
        [showtimeId, PROVIDER, theatreId, LOCAL_DATE, dummyObs, MOVIE],
      );
      const rk = uniq("rk_fail");
      await pool.query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
         VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
        [rk, PROVIDER, showtimeId],
      );
      await pool.query(
        `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at, fail_cause)
         VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'FAILED', $4, $5)`,
        [uniq("job"), searchId, rk, FUTURE, failCause],
      );
    }
    // A: 2 TIMEOUT failures, B: 1 NETWORK failure (TIMEOUT total 2, NETWORK 1, fetchFailed 3)
    await seedFetchFailure(theatreA, "TIMEOUT");
    await seedFetchFailure(theatreA, "TIMEOUT");
    await seedFetchFailure(theatreB, "NETWORK");

    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      excluded: {
        soldOut: number;
        outsideArea: number;
        fetchFailed: number;
        fetchFailedByCause: Record<string, number>;
        byTheatre: Record<
          string,
          {
            soldOut: number;
            outsideArea: number;
            outsideWindow: number;
            outsideRegion: number;
            wrongAttributes: number;
            overPrice: number;
            notReservedSeating: number;
            fetchFailed: number;
            fetchFailedByCause: Record<string, number>;
          }
        >;
      };
    };
    // aggregate total includes all performances (schedule + the fetch-failure performance dummies)
    // but soldOut only counts statuses that are SOLD_OUT / CANCELED
    expect(payload.excluded.soldOut).toBe(3);
    expect(payload.excluded.fetchFailed).toBe(3);
    expect(payload.excluded.fetchFailedByCause).toEqual({ TIMEOUT: 2, NETWORK: 1 });
    expect(payload.excluded.outsideArea).toBe(0);
    // byTheatre has exactly two keys
    expect(Object.keys(payload.excluded.byTheatre).sort()).toEqual([theatreA, theatreB].sort());
    expect(payload.excluded.byTheatre[theatreA]!.soldOut).toBe(2);
    expect(payload.excluded.byTheatre[theatreB]!.soldOut).toBe(1);
    expect(payload.excluded.byTheatre[theatreA]!.fetchFailed).toBe(2);
    expect(payload.excluded.byTheatre[theatreA]!.fetchFailedByCause).toEqual({ TIMEOUT: 2 });
    expect(payload.excluded.byTheatre[theatreB]!.fetchFailed).toBe(1);
    expect(payload.excluded.byTheatre[theatreB]!.fetchFailedByCause).toEqual({ NETWORK: 1 });
    // five zero buckets + outsideArea remain 0 per theatre
    for (const tid of [theatreA, theatreB]) {
      const entry = payload.excluded.byTheatre[tid]!;
      expect(entry.outsideArea).toBe(0);
      expect(entry.outsideWindow).toBe(0);
      expect(entry.outsideRegion).toBe(0);
      expect(entry.wrongAttributes).toBe(0);
      expect(entry.overPrice).toBe(0);
      expect(entry.notReservedSeating).toBe(0);
    }
    // top-level aggregate equals sum of per-theatre soldOut/fetchFailed
    const sumSoldOut = Object.values(payload.excluded.byTheatre).reduce((s, v) => s + v.soldOut, 0);
    expect(sumSoldOut).toBe(payload.excluded.soldOut);
    const sumFetch = Object.values(payload.excluded.byTheatre).reduce(
      (s, v) => s + v.fetchFailed,
      0,
    );
    expect(sumFetch).toBe(payload.excluded.fetchFailed);
  });

  it("byTheatre: single theatre produces one entry equal to the aggregate (backward-compat)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    // single theatre via existing helper: 2 OPEN performances (0 soldOut)
    await seedScheduleResolution(pool, searchId, { count: 2 });
    // One failed fetch with UNKNOWN cause (NULL) — should be keyed UNKNOWN
    const dummyObs = await ensureDummyObservation(pool);
    const failShowtime = `${PROVIDER}:showtime:single_fail_${uniq("")}`;
    await pool.query(
      `INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date, starts_at,
                               observation_id, movie_id, status, deep_link_url, layout_id)
       VALUES ($1, $2, $3, $4, '2026-08-20T20:00:00.000Z', $5, $6, 'OPEN', 'https://example.invalid/showtime', null)`,
      [failShowtime, PROVIDER, THEATRE, LOCAL_DATE, dummyObs, MOVIE],
    );
    const rk = uniq("rk_single_fail");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
      [rk, PROVIDER, failShowtime],
    );
    await pool.query(
      `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at, fail_cause)
       VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'FAILED', $4, $5)`,
      [uniq("job"), searchId, rk, FUTURE, null],
    );
    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      excluded: {
        soldOut: number;
        fetchFailed: number;
        fetchFailedByCause: Record<string, number>;
        byTheatre: Record<
          string,
          { soldOut: number; fetchFailed: number; fetchFailedByCause: Record<string, number> }
        >;
      };
    };
    expect(Object.keys(payload.excluded.byTheatre)).toHaveLength(1);
    expect(Object.keys(payload.excluded.byTheatre)[0]).toBe(THEATRE);
    const entry = payload.excluded.byTheatre[THEATRE]!;
    expect(entry.soldOut).toBe(payload.excluded.soldOut);
    expect(entry.fetchFailed).toBe(payload.excluded.fetchFailed);
    expect(entry.fetchFailedByCause).toEqual(payload.excluded.fetchFailedByCause);
    // NULL fail_cause was keyed UNKNOWN — still reconciles
    expect(payload.excluded.fetchFailedByCause).toEqual({ UNKNOWN: 1 });
    expect(payload.excluded.fetchFailed).toBe(1);
  });

  it("FORMAT predicate narrows total and populates wrongAttributes (S42.4/S42.5 positive case)", async () => {
    await seedProvider(pool);
    const spec = {
      ...makeSpec(),
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
          { kind: "FORMAT", code: "imax" },
        ],
      },
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 3 });
    // Tag performances with real format codes: first two match, third does not
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "imax",
      showtimeIds[0]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "imax",
      showtimeIds[1]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      null,
      showtimeIds[2]!,
    ]);
    await seedPendingFetch(pool, searchId);
    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      excluded: { wrongAttributes: number; byTheatre: Record<string, { wrongAttributes: number }> };
    };
    // Only the 2 imax performances are in total; the standard one is excluded as wrongAttributes
    expect(payload.total).toBe(2);
    expect(payload.excluded.wrongAttributes).toBe(1);
    expect(payload.excluded.byTheatre[THEATRE]!.wrongAttributes).toBe(1);
  });

  it("FORMAT: unbound tree (no FORMAT leaf) yields wrongAttributes 0 (negative control)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 3 });
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "imax",
      showtimeIds[0]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      null,
      showtimeIds[1]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "dolbycinemaatamcprime",
      showtimeIds[2]!,
    ]);
    await seedPendingFetch(pool, searchId);
    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      excluded: { wrongAttributes: number; byTheatre: Record<string, { wrongAttributes: number }> };
    };
    expect(payload.total).toBe(3);
    expect(payload.excluded.wrongAttributes).toBe(0);
    expect(payload.excluded.byTheatre[THEATRE]!.wrongAttributes).toBe(0);
  });

  it("FORMAT STANDARD sentinel matches only null formatCode (S42.2)", async () => {
    await seedProvider(pool);
    const spec = {
      ...makeSpec(),
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: [MOVIE] },
          { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
          { kind: "FORMAT", code: "STANDARD" },
        ],
      },
    };
    const searchId = await seedSearch(pool, { spec, aggRequestedRev: 1 });
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 3 });
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      null,
      showtimeIds[0]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "imax",
      showtimeIds[1]!,
    ]);
    await pool.query(`UPDATE performance SET format_code = $1 WHERE showtime_id = $2`, [
      "dolbycinemaatamcprime",
      showtimeIds[2]!,
    ]);
    await seedPendingFetch(pool, searchId);
    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      excluded: { wrongAttributes: number };
    };
    expect(payload.total).toBe(1);
    expect(payload.excluded.wrongAttributes).toBe(2);
  });

  it("byTheatre: zero performances yields empty byTheatre map (wire-shape stability)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    // No schedule resolution, no performances, only a pending fetch to keep nonterminal
    await seedPendingFetch(pool, searchId);
    await runPass(makeDeps(), searchId);
    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      excluded: { soldOut: number; byTheatre: Record<string, unknown> };
    };
    expect(payload.excluded.soldOut).toBe(0);
    expect(payload.excluded.byTheatre).toEqual({});
  });

  it("fetchStatus: resolved flips carry OK for OPEN and SOLD_OUT for SOLD_OUT/CANCELED (S58)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 3 });
    const [openId, soldOutId, canceledId] = showtimeIds as [string, string, string];
    await pool.query(`UPDATE performance SET status = 'SOLD_OUT' WHERE showtime_id = $1`, [
      soldOutId,
    ]);
    await pool.query(`UPDATE performance SET status = 'CANCELED' WHERE showtime_id = $1`, [
      canceledId,
    ]);
    for (const sid of showtimeIds) {
      await seedAcceptedSnapshot(pool, sid, Buffer.from([0xff, 0xff, 0xff]), 24);
    }
    // Initial skeleton as creation would have written it: every entry unresolved.
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES ($1, 0, 'skeleton', $2::jsonb)`,
      [
        searchId,
        JSON.stringify({
          scheduleSkeleton: showtimeIds.map((sid, index) => ({
            showtimeId: sid,
            theatreId: THEATRE,
            showDateTimeLocal: "2026-08-20T20:00:00",
            formatCode: null,
            distanceKm: null,
            rank: index,
            admitted: true,
            resolved: false,
          })),
        }),
      ],
    );
    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);

    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_event WHERE search_id = $1 AND type = 'skeleton' ORDER BY seq DESC LIMIT 1`,
      [searchId],
    );
    expect(rows.rows).toHaveLength(1);
    const entries = (rows.rows[0]!.payload as { scheduleSkeleton: unknown }).scheduleSkeleton as {
      showtimeId: string;
      resolved: boolean;
      fetchStatus: unknown;
    }[];
    expect(entries).toHaveLength(3);
    const byId = new Map(entries.map((e) => [e.showtimeId, e]));
    expect(byId.get(openId)).toMatchObject({ resolved: true, fetchStatus: "OK" });
    expect(byId.get(soldOutId)).toMatchObject({ resolved: true, fetchStatus: "SOLD_OUT" });
    expect(byId.get(canceledId)).toMatchObject({ resolved: true, fetchStatus: "SOLD_OUT" });
  });

  it("fetchStatus: FAILED job emits a resolved:false FAILED patch once, never re-emitted (S58)", async () => {
    await seedProvider(pool);
    const searchId = await seedSearch(pool, { aggRequestedRev: 1 });
    const showtimeIds = await seedScheduleResolution(pool, searchId, { count: 2 });
    const [okId, failedId] = showtimeIds as [string, string];
    await seedAcceptedSnapshot(pool, okId, Buffer.from([0xff, 0xff, 0xff]), 24);
    // FAILED SHOWTIME_FETCH job for the failed showtime (run_key + search_job pattern).
    const rk = uniq("rk_fail");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', $2, 'seat', $3)`,
      [rk, PROVIDER, failedId],
    );
    await pool.query(
      `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, deadline_at, fail_cause)
       VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'FAILED', $4, $5)`,
      [uniq("job"), searchId, rk, FUTURE, "TIMEOUT"],
    );
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES ($1, 0, 'skeleton', $2::jsonb)`,
      [
        searchId,
        JSON.stringify({
          scheduleSkeleton: showtimeIds.map((sid, index) => ({
            showtimeId: sid,
            theatreId: THEATRE,
            showDateTimeLocal: "2026-08-20T20:00:00",
            formatCode: null,
            distanceKm: null,
            rank: index,
            admitted: true,
            resolved: false,
          })),
        }),
      ],
    );
    await seedPendingFetch(pool, searchId);

    await runPass(makeDeps(), searchId);

    const first = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_event WHERE search_id = $1 AND type = 'skeleton' ORDER BY seq DESC LIMIT 1`,
      [searchId],
    );
    const firstEntries = (first.rows[0]!.payload as { scheduleSkeleton: unknown })
      .scheduleSkeleton as { showtimeId: string; resolved: boolean; fetchStatus: unknown }[];
    expect(firstEntries).toHaveLength(2);
    const firstById = new Map(firstEntries.map((e) => [e.showtimeId, e]));
    expect(firstById.get(okId)).toMatchObject({ resolved: true, fetchStatus: "OK" });
    expect(firstById.get(failedId)).toMatchObject({ resolved: false, fetchStatus: "FAILED" });

    // Second pass with new work: the already-flagged FAILED row must not re-emit.
    await pool.query(`UPDATE search SET agg_requested_rev = 2 WHERE search_id = $1`, [searchId]);
    await runPass(makeDeps(), searchId);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM search_event WHERE search_id = $1 AND type = 'skeleton'`,
      [searchId],
    );
    // Manual seed row + first-pass patch only: the second pass emitted nothing.
    expect(count.rows[0]!.count).toBe("2");
  });
  it("maps a null formatCode to the STANDARD sentinel instead of crashing the pass (2026-09-21 incident)", async () => {
    await seedProvider(pool);
    const built = buildAuditoriumLayout({
      rows: 4,
      columns: 6,
      cells: Array.from({ length: 24 }, (_, index) => ({
        row: Math.floor(index / 6) + 1,
        column: (index % 6) + 1,
        kind: "STANDARD" as const,
        visible: true,
        available: true,
      })),
    });
    await pool.query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2::bytea, 4, 6)`,
      [built.layout.layoutId, encodeAuditoriumLayoutGeometry(built.layout)],
    );
    const searchId = await seedSearch(pool, {
      aggRequestedRev: 1,
      spec: { ...makeSpec(), group: { kind: "RUN", count: 2 } },
    });
    const showtimeIds = await seedScheduleResolution(pool, searchId, {
      count: 2,
      layoutId: built.layout.layoutId,
    });
    // Standard format: no premium format tag, so format_code stays NULL (the
    // legacy seed helper never sets it). Only attributes need the real writer
    // shape (JSON array) for assembly to proceed.
    await pool.query(
      `UPDATE performance SET attributes = $1::jsonb, format_code = NULL WHERE layout_id = $2`,
      [JSON.stringify(["RESERVED_SEATING"]), built.layout.layoutId],
    );
    await seedAcceptedSnapshot(pool, showtimeIds[0]!, Buffer.from([0xff, 0xff, 0xff]), 24);
    await seedPendingFetch(pool, searchId);

    // Pre-fix this threw out of assembleResultGroup
    // ("Invalid input: expected string, received null"), crashing the whole
    // AGGREGATE pass with no retry and stalling the search.
    await expect(runPass(makeDeps(), searchId)).resolves.toBeUndefined();

    const aggregate = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM search_aggregate WHERE search_id = $1`,
      [searchId],
    );
    expect(aggregate.rows).toHaveLength(1);
    const payload = aggregate.rows[0]!.payload as {
      total: number;
      resolved: number;
      groups: { layoutId: string; formatCode: string }[];
    };
    expect(payload.total).toBe(2);
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]!.formatCode).toBe("STANDARD");
  });
});
