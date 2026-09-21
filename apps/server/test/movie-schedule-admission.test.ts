import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  B2_LEASE_RUN,
  B4_PREDISPATCH,
  OUTBOX_CREATE_RUN,
  RUN_CREATE,
  poolClient,
  runStatement,
  stageMovieScheduleAcceptance,
  stageSearchCreation,
  withTransaction,
} from "@seatfirst/durability";

import { startTestPostgres } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { readAggregatePerformances } from "../src/dispatch/queries.js";

describe("movie schedule admission (S65)", () => {
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
  let pool: Pool;
  let admin: Client;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    await migrateDatabase(postgres.url);
    pool = new Pool({ connectionString: postgres.url });
    admin = new Client({ connectionString: postgres.url });
    await admin.connect();
    await admin.query(
      `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
       VALUES ('amc', 1000, 100)`,
    );
    await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ('amc')`);
  });

  afterAll(async () => {
    await admin.end();
    await pool.end();
    await postgres.stop();
  });

  it("stages one shared movie run and subscription for a market/date cluster", async () => {
    const searchId = `srch_movie_${randomUUID()}`;
    const result = await withTransaction(pool, (tx) =>
      stageSearchCreation(tx, {
        searchId,
        sessionId: "session_movie",
        idempotencyKey: `idem_movie_${randomUUID()}`,
        spec: { specVersion: 1 },
        specHash: "movie-spec-hash",
        deadlineAt: new Date(Date.now() + 60_000),
        providerId: "amc",
        reserve: 200,
        scheduleKeys: [],
        movieScheduleKeys: [
          {
            movieSlug: "dune-part-3",
            anchorTheatreId: "amc:theatre:anchor",
            candidateTheatreIds: [
              "amc:theatre:anchor",
              "amc:theatre:nearby-a",
              "amc:theatre:nearby-b",
            ],
            localDate: "2026-08-12",
          },
        ],
        showtimes: [],
        freshMatchCount: 0,
        traceparent: null,
      }),
    );

    expect(result).toMatchObject({ kind: "created", status: "PENDING_SCHEDULE" });
    const rows = await admin.query<{
      kind: string;
      route_class: string;
      movie_slug: string | null;
      movie_candidate_theatre_ids: string[] | null;
    }>(
      `SELECT sj.kind, rk.route_class, rk.movie_slug, rs.movie_candidate_theatre_ids
       FROM search_job sj
       JOIN run_key rk ON rk.run_key_id = sj.run_key_id
       JOIN run_subscription rs ON rs.job_id = sj.job_id
       WHERE sj.search_id = $1`,
      [searchId],
    );
    expect(rows.rows).toEqual([
      {
        kind: "MOVIE_SCHEDULE_RESOLUTION",
        route_class: "movie-schedule",
        movie_slug: "dune-part-3",
        movie_candidate_theatre_ids: [
          "amc:theatre:anchor",
          "amc:theatre:nearby-a",
          "amc:theatre:nearby-b",
        ],
      },
    ]);
  });
  it("admits movie performances for every returned theatre without creating theatre schedule cache keys", async () => {
    const searchId = `srch_movie_rank_${randomUUID()}`;
    const theatreA = "amc:theatre:rank-a";
    const theatreB = "amc:theatre:rank-b";
    await admin.query(
      `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
       VALUES
         ($1, 'amc', 'Rank A', 0, 0, 'UTC', now(), now()),
         ($2, 'amc', 'Rank B', 0, 0, 'UTC', now(), now())`,
      [theatreA, theatreB],
    );
    await withTransaction(pool, (tx) =>
      stageSearchCreation(tx, {
        searchId,
        sessionId: "session_movie_rank",
        idempotencyKey: `idem_movie_rank_${randomUUID()}`,
        spec: { specVersion: 1 },
        specHash: "movie-rank-spec-hash",
        deadlineAt: new Date(Date.now() + 60_000),
        providerId: "amc",
        reserve: 200,
        scheduleKeys: [],
        movieScheduleKeys: [
          {
            movieSlug: "dune-part-3",
            anchorTheatreId: theatreA,
            candidateTheatreIds: [theatreA, theatreB],
            localDate: "2026-08-12",
          },
        ],
        showtimes: [],
        freshMatchCount: 0,
        traceparent: null,
      }),
    );
    const runKey = await admin.query<{ run_key_id: string }>(
      `SELECT run_key_id FROM run_key
       WHERE kind = 'MOVIE_SCHEDULE_RESOLUTION' AND theatre_id = $1`,
      [theatreA],
    );
    const runKeyId = runKey.rows[0]?.run_key_id;
    if (runKeyId === undefined) throw new Error("movie schedule run key was not staged");
    const runId = `run_movie_${randomUUID()}`;
    const observationId = `obs_movie_${randomUUID()}`;
    await withTransaction(pool, async (tx) => {
      await runStatement(tx, RUN_CREATE, [runId, runKeyId, observationId, null]);
      await runStatement(tx, OUTBOX_CREATE_RUN, [runId, null]);
      const lease = await runStatement<{ generation: number }>(tx, B2_LEASE_RUN, [runId, "5 minutes"]);
      const generation = lease[0]?.generation;
      if (generation === undefined) throw new Error("movie run was not leased");
      await runStatement(tx, B4_PREDISPATCH, [runId, generation]);
      await stageMovieScheduleAcceptance(
        tx,
        { runId, generation },
        [
          {
            theatreId: theatreA,
            showtimeId: "amc:showtime:rank-a",
            movieId: "amc:movie:42",
            movieTitle: "Dune Part 3",
            startsAt: new Date("2026-08-12T19:00:00.000Z"),
            skipFetch: true,
            formatCode: "IMAX",
            auditorium: null,
            utcOffset: "+00:00",
            runtimeMinutes: 155,
            status: "OPEN",
            deepLinkUrl: "https://example.test/showtimes/rank-a/seats",
            providerMeta: {},
          },
          {
            theatreId: theatreB,
            showtimeId: "amc:showtime:rank-b",
            movieId: "amc:movie:42",
            movieTitle: "Dune Part 3",
            startsAt: new Date("2026-08-12T21:00:00.000Z"),
            skipFetch: true,
            formatCode: "IMAX",
            auditorium: null,
            utcOffset: "+00:00",
            runtimeMinutes: 155,
            status: "OPEN",
            deepLinkUrl: "https://example.test/showtimes/rank-b/seats",
            providerMeta: {},
          },
        ],
      );
    });

    const performances = await readAggregatePerformances(poolClient(pool), searchId);
    expect(performances.map((performance) => performance.theatreId)).toEqual([theatreA, theatreB]);
    const scheduleKeys = await admin.query(
      `SELECT 1 FROM run_key
       WHERE kind = 'SCHEDULE_RESOLUTION'
         AND theatre_id = ANY($1::text[])
         AND local_date = '2026-08-12'`,
      [[theatreA, theatreB]],
    );
    expect(scheduleKeys.rows).toEqual([]);
  });
});
