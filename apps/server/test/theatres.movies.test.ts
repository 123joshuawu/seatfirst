import { randomUUID } from "node:crypto";

import { createTRPCClient, httpLink } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TheatreMoviesResponseSchema,
  type TheatreMovieGroup,
  type ShowtimeStatus,
} from "@seatfirst/core";
import {
  B2_LEASE_RUN,
  B4_PREDISPATCH,
  OUTBOX_CREATE_RUN,
  poolClient,
  RUN_CREATE,
  RUN_KEY_UPSERT,
  stageScheduleAcceptance,
  updatePerformanceProduct,
  upsertMovie,
  upsertTheatre,
  upsertTmdbMovie,
  withTransaction,
  type ScheduleRangeDay,
} from "@seatfirst/durability";
import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import { buildMovieGroups, dispatchPosterBackfills } from "../src/routes/theatres/movies.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";
import { capturingLogger } from "./support/logger.js";

import { startTestPostgres, startTestRedis } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RATE_LIMIT_CONFIG,
  TEST_RELAY_PEER_CIDR,
  TEST_NONCE_SECRET,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_LOGGER,
  TEST_MINT_ID,
  TEST_METRICS,
  TEST_TRACER,
} from "./support/app.js";

// The `theatres/movies` route falls back to `createLogger` when `ctx.logger` is absent;
// pin LOG_LEVEL explicitly for the whole run instead of relying on the reader's "info" default.
process.env.LOG_LEVEL = "info";

/**
 * S21 verification, items 1–7 of the spec's verification list, over HTTP against a real
 * Fastify server (tRPC fastify adapter + the `theatres` router) and real Postgres. The
 * full `buildApp` supplies a `SearchCreateContext` (this route needs only `db` +
 * `freshnessMs`, S21.1). Item 8 (zero upstream traffic) is proven by construction: the
 * route imports nothing from `packages/providers` or the dispatch actor.
 *
 * Schedules are seeded through S14's write path extended by S24 — `RUN_KEY_UPSERT` →
 * `RUN_CREATE` → outbox → lease → pre-dispatch, then `stageScheduleAcceptance` + one
 * `updatePerformanceProduct` per performance + `upsertMovie` in ONE transaction (the
 * provider fetch actor's exact composition) — never a hand-built performance row (S24.8).
 * The exact freshness ≤-edge is proven by unit-testing the exported `buildMovieGroups`
 * with a deterministic clock (the same discipline `readCachedSchedule` uses), while the
 * HTTP tests seed clearly-fresh and clearly-stale captures.
 */

const PROVIDER = "amc";
const FRESHNESS_MS = 10 * 60_000; // ADR 0006 §A.1's ≤ 10-minute ceiling, injected (S21.5)
const RETRY_AFTER_SECONDS = 30; // injected — no accepted document fixes this (S15.9)

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startServer(db: Pool, redisUrl: string): Promise<TestServer> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  const fastify = buildApp({
    db,
    searchLimits: {
      maxDateSpanDays: 3,
      maxResolvedShowtimes: 200,
      maxPartySize: 8,
      maxTheatres: 50,
      areaSelectorEnabled: false,
      maxAreaRadiusKm: 40,
      splitGroupEnabled: false,
      maxPredicateDepth: 4,
      maxPredicateNodes: 8,
      maxRegionDepth: 3,
      maxRegionNodes: 8,
    },
    freshnessMs: FRESHNESS_MS,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    rateLimitConfig: TEST_RATE_LIMIT_CONFIG,
    limiter: createSessionRateLimiter({
      redis: redisScriptExecutorFromIoredis(redis),
      config: TEST_RATE_LIMIT_CONFIG,
    }),
    cookieSecret: TEST_COOKIE_SECRET,
    cookiePolicy: TEST_COOKIE_POLICY,
    relayPeerCidr: TEST_RELAY_PEER_CIDR,
    asnLookup: TEST_ASN_LOOKUP,
    streamRedisUrl: redisUrl,
    streamBlockTimeoutMs: 250,
    providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
    nonceSecret: TEST_NONCE_SECRET,
    recheckDeadlineMs: TEST_RECHECK_DEADLINE_MS,
    recheckRecovery: TEST_RECHECK_RECOVERY,
    mapboxAccessToken: "test-mapbox-token",
    corsAllowedOrigins: ["http://localhost:8081"],
    logger: TEST_LOGGER,
    mintId: TEST_MINT_ID,
    metrics: TEST_METRICS,
    tracer: TEST_TRACER,
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/trpc`,
    close: async () => {
      await fastify.close();
      redis.disconnect();
    },
  };
}

function makeClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({ links: [httpLink({ url: baseUrl })] });
}

/** Seed data: provider_admission + provider_fence rows for the provider, so RUN_CREATE's
 * `JOIN provider_fence` finds the fence (mirrors create.test.ts's `seedProvider`). */
async function seedProvider(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    [PROVIDER, 1000, 100],
  );
  await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
}

async function mustProduceRow(
  db: ReturnType<typeof poolClient>,
  statement: { text: string },
  values: readonly unknown[],
): Promise<Record<string, unknown>> {
  const result = await db.query(statement.text, values);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error("boundary returned 0 rows while seeding a cached schedule");
  }
  return row;
}

interface SeededMovieShow {
  readonly showtimeId: string;
  readonly movieId: string;
  readonly movieTitle: string;
  readonly startsAt: Date;
  readonly status: ShowtimeStatus;
  readonly formatCode: string | null;
  readonly auditorium: string | null;
  readonly runtimeMinutes: number | null;
}

/** Seeds one cached schedule day via S14's write path extended by S24 (S21.2, S24.8).
 * `preS14` skips the product write (movie_id stays NULL); `preS24` skips the movie
 * catalogue upsert (movie_id set, no movie row) — the two drop-posture rows. */
async function seedDay(
  pool: Pool,
  theatreId: string,
  localDate: string,
  capturedAt: Date,
  shows: readonly SeededMovieShow[],
  opts: { preS14?: boolean; preS24?: boolean } = {},
): Promise<void> {
  const runKeyId = `k_sched_${PROVIDER}_${theatreId}_${localDate}`;
  const runId = `run_${randomUUID()}`;
  const observationId = `obs_${randomUUID()}`;
  const sql = poolClient(pool);
  await mustProduceRow(sql, RUN_KEY_UPSERT, [
    runKeyId,
    "SCHEDULE_RESOLUTION",
    PROVIDER,
    "schedule",
    null,
    theatreId,
    localDate,
  ]);
  await mustProduceRow(sql, RUN_CREATE, [runId, runKeyId, observationId, null]);
  await mustProduceRow(sql, OUTBOX_CREATE_RUN, [runId, null]);
  const leased = (await mustProduceRow(sql, B2_LEASE_RUN, [runId, "5 minutes"])) as {
    generation: number;
  };
  await mustProduceRow(sql, B4_PREDISPATCH, [runId, leased.generation]);

  await withTransaction(pool, async (tx) => {
    await stageScheduleAcceptance(
      tx,
      { runId, generation: leased.generation },
      shows.map((show) => ({
        showtimeId: show.showtimeId,
        movieId: show.movieId,
        startsAt: show.startsAt,
        skipFetch: false,
      })),
      { capturedAt },
    );
    if (opts.preS14) return;
    if (!opts.preS24) {
      const movies = new Map<string, string>();
      for (const show of shows) movies.set(show.movieId, show.movieTitle);
      for (const [movieId, title] of movies) {
        await upsertMovie(tx, {
          movieId,
          providerId: PROVIDER,
          title,
          firstSeenAt: capturedAt,
          lastSeenAt: capturedAt,
        });
      }
    }
    for (const show of shows) {
      await updatePerformanceProduct(tx, {
        showtimeId: show.showtimeId,
        movieId: show.movieId,
        auditorium: show.auditorium,
        utcOffset: "-05:00",
        runtimeMinutes: show.runtimeMinutes,
        status: show.status,
        formatCode: show.formatCode,
        minPrice: null,
        deepLinkUrl: `https://example.invalid/showtime/${show.showtimeId}`,
        providerMeta: {},
        layoutId: null,
        updatedAt: capturedAt,
      });
    }
  });
}

const seenAt = new Date("2026-08-01T00:00:00.000Z");

async function seedTheatre(pool: Pool, theatreId: string, timezone = "America/Chicago") {
  await upsertTheatre(poolClient(pool), {
    theatreId,
    providerId: PROVIDER,
    name: "Movie Theatre",
    lat: 41,
    lng: -87,
    marketSlug: null,
    timezone,
    city: null,
    address: null,
    slugs: { detail: theatreId },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
}

const DAY1 = "2026-08-20";
const DAY2 = "2026-08-21";
const DAY3 = "2026-08-22";
const THEATRE = `${PROVIDER}:theatre:movie`;

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let redis: Awaited<ReturnType<typeof startTestRedis>>;
let server: TestServer;
let pool: Pool;
let admin: Client;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  server = await startServer(pool, redis.url);
});

afterAll(async () => {
  await server.close();
  await admin.end();
  await pool.end();
  await Promise.all([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await admin.query(
    `TRUNCATE search, run_key, performance, outbox, provider_admission, provider_fence,
     provider_run, observation, admission_reservation, search_job, run_subscription,
     theatre, movie, tmdb_movie, tmdb_fetch, tmdb_prewarm_state CASCADE`,
  );
  await seedProvider(admin);
});

describe("theatres.movies (S21)", () => {
  it("404s for an unknown theatre with the boundary's zeroRowsMeans, and proceeds for a known one (item 1)", async () => {
    await seedTheatre(pool, THEATRE);
    const client = makeClient(server.baseUrl);

    await expect(
      client.theatres.movies.query({ theatreId: "amc:theatre:missing", from: DAY1, to: DAY1 }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND", httpStatus: 404 } });

    // Positive control: the seeded theatre proceeds (cold span → movies: []).
    const body = await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY1 });
    expect(body).toMatchObject({ theatreId: THEATRE, movies: [] });
  });

  it("rejects unnamespaced and foreign-kind ids by the input schema before any DB read (item 1)", async () => {
    const client = makeClient(server.baseUrl);
    await expect(
      client.theatres.movies.query({ theatreId: "not-namespaced", from: DAY1, to: DAY1 }),
    ).rejects.toMatchObject({ data: { httpStatus: 400 } });
    await expect(
      client.theatres.movies.query({ theatreId: "amc:showtime:123", from: DAY1, to: DAY1 }),
    ).rejects.toMatchObject({ data: { httpStatus: 400 } });
  });

  it("happy path: multi-day, multi-movie grouping with verbatim fields, ordering, and theatre timezone (item 2)", async () => {
    await seedTheatre(pool, THEATRE, "America/Chicago");
    const capturedAt = new Date();
    await seedDay(pool, THEATRE, DAY1, capturedAt, [
      {
        showtimeId: "amc:showtime:m1d1",
        movieId: "amc:movie:one",
        movieTitle: "The Odyssey",
        startsAt: new Date(`${DAY1}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: "DIGITAL",
        auditorium: "7",
        runtimeMinutes: 120,
      },
    ]);
    await seedDay(pool, THEATRE, DAY2, capturedAt, [
      {
        showtimeId: "amc:showtime:m2d2",
        movieId: "amc:movie:two",
        movieTitle: "Reloaded",
        startsAt: new Date(`${DAY2}T20:00:00.000Z`),
        status: "SOLD_OUT",
        formatCode: "IMAX",
        auditorium: "8",
        runtimeMinutes: 95,
      },
    ]);
    await seedDay(pool, THEATRE, DAY3, capturedAt, [
      {
        showtimeId: "amc:showtime:m1d3",
        movieId: "amc:movie:one",
        movieTitle: "The Odyssey",
        startsAt: new Date(`${DAY3}T21:00:00.000Z`),
        status: "CANCELED",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({
      theatreId: THEATRE,
      from: DAY1,
      to: DAY3,
    });

    expect(body.theatreId).toBe(THEATRE);
    expect(body.timezone).toBe("America/Chicago");
    expect(body.from).toBe(DAY1);
    expect(body.to).toBe(DAY3);
    // Exactly two movie groups, ordered by movieId.
    expect(body.movies.map((movie) => movie.movieId)).toEqual(["amc:movie:one", "amc:movie:two"]);
    // Each group carries its title and its showtimes ordered by showDateTimeUtc.
    expect(body.movies[0]).toEqual({
      movieId: "amc:movie:one",
      title: "The Odyssey",
      posterPath: null,
      runtimeMinutes: null,
      genres: [],
      showtimes: [
        {
          showtimeId: "amc:showtime:m1d1",
          showDateTimeUtc: new Date(`${DAY1}T19:00:00.000Z`).toISOString(),
          status: "OPEN",
          formatCode: "DIGITAL",
          auditorium: "7",
          runtimeMinutes: 120,
          deepLinkUrl: "https://example.invalid/showtime/amc:showtime:m1d1",
          attributes: [],
        },
        {
          showtimeId: "amc:showtime:m1d3",
          showDateTimeUtc: new Date(`${DAY3}T21:00:00.000Z`).toISOString(),
          status: "CANCELED",
          formatCode: null,
          auditorium: null,
          runtimeMinutes: null,
          deepLinkUrl: "https://example.invalid/showtime/amc:showtime:m1d3",
          attributes: [],
        },
      ],
    });
    expect(body.movies[1]).toEqual({
      movieId: "amc:movie:two",
      title: "Reloaded",
      posterPath: null,
      runtimeMinutes: null,
      genres: [],
      showtimes: [
        {
          showtimeId: "amc:showtime:m2d2",
          showDateTimeUtc: new Date(`${DAY2}T20:00:00.000Z`).toISOString(),
          status: "SOLD_OUT",
          formatCode: "IMAX",
          auditorium: "8",
          runtimeMinutes: 95,
          deepLinkUrl: "https://example.invalid/showtime/amc:showtime:m2d2",
          attributes: [],
        },
      ],
    });
    // The transported body validates against the wire schema.
    expect(TheatreMoviesResponseSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(
      true,
    );
  });

  it("range edges: days outside [from, to] appear nowhere, endpoints inclusive (item 3)", async () => {
    await seedTheatre(pool, THEATRE);
    const capturedAt = new Date();
    for (const [day, showtimeId] of [
      [DAY1, "amc:showtime:edge1"],
      [DAY2, "amc:showtime:edge2"],
      [DAY3, "amc:showtime:edge3"],
    ] as const) {
      await seedDay(pool, THEATRE, day, capturedAt, [
        {
          showtimeId,
          movieId: "amc:movie:edge",
          movieTitle: "Edge",
          startsAt: new Date(`${day}T19:00:00.000Z`),
          status: "OPEN",
          formatCode: null,
          auditorium: null,
          runtimeMinutes: null,
        },
      ]);
    }

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY2 });
    const showtimes = body.movies.flatMap((movie) => movie.showtimes);
    expect(showtimes.map((showtime) => showtime.showtimeId)).toEqual([
      "amc:showtime:edge1",
      "amc:showtime:edge2",
    ]);
  });

  it("freshness: a fresh day serves, a stale day disappears, a NULL-capture day drops, a fully cold span is [] (item 4)", async () => {
    await seedTheatre(pool, THEATRE);
    const now = Date.now();
    // Fresh day (captured just now) and a stale day (well past the 10-minute ceiling).
    await seedDay(pool, THEATRE, DAY1, new Date(now), [
      {
        showtimeId: "amc:showtime:fresh",
        movieId: "amc:movie:fresh",
        movieTitle: "Fresh",
        startsAt: new Date(`${DAY1}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);
    await seedDay(pool, THEATRE, DAY2, new Date(now - FRESHNESS_MS - 60_000), [
      {
        showtimeId: "amc:showtime:stale",
        movieId: "amc:movie:stale",
        movieTitle: "Stale",
        startsAt: new Date(`${DAY2}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);
    // A NULL-capture day: the key exists but never accepted (latest_captured_at IS NULL).
    await mustProduceRow(poolClient(pool), RUN_KEY_UPSERT, [
      `k_sched_${PROVIDER}_${THEATRE}_${DAY3}`,
      "SCHEDULE_RESOLUTION",
      PROVIDER,
      "schedule",
      null,
      THEATRE,
      DAY3,
    ]);

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({
      theatreId: THEATRE,
      from: DAY1,
      to: DAY3,
    });
    expect(body.movies).toHaveLength(1);
    expect(body.movies[0]?.movieId).toBe("amc:movie:fresh");
    expect(body.movies[0]?.showtimes.map((showtime) => showtime.showtimeId)).toEqual([
      "amc:showtime:fresh",
    ]);

    // A fully cold span (no keys at all) → honest `movies: []`.
    const cold = await client.theatres.movies.query({
      theatreId: THEATRE,
      from: "2026-09-01",
      to: "2026-09-03",
    });
    expect(cold.movies).toEqual([]);
  });

  it("drops pre-S14 (NULL movie_id) and pre-S24 (no movie row) performances without error (item 7)", async () => {
    await seedTheatre(pool, THEATRE);
    const capturedAt = new Date();
    // pre-S14: bare acceptSchedule, no product write → movie_id NULL.
    await seedDay(
      pool,
      THEATRE,
      DAY1,
      capturedAt,
      [
        {
          showtimeId: "amc:showtime:pres14",
          movieId: "amc:movie:pres14",
          movieTitle: "PreS14",
          startsAt: new Date(`${DAY1}T19:00:00.000Z`),
          status: "OPEN",
          formatCode: null,
          auditorium: null,
          runtimeMinutes: null,
        },
      ],
      { preS14: true },
    );
    // pre-S24: product write sets movie_id, but no movie catalogue row (title NULL).
    await seedDay(
      pool,
      THEATRE,
      DAY2,
      capturedAt,
      [
        {
          showtimeId: "amc:showtime:pres24",
          movieId: "amc:movie:orphan",
          movieTitle: "Orphan",
          startsAt: new Date(`${DAY2}T19:00:00.000Z`),
          status: "OPEN",
          formatCode: null,
          auditorium: null,
          runtimeMinutes: null,
        },
      ],
      { preS24: true },
    );

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY2 });
    // Neither dropped-worthy row contributes; no title is fabricated.
    expect(body.movies).toEqual([]);
  });

  it("rejects from > to as BAD_REQUEST (item 5)", async () => {
    const client = makeClient(server.baseUrl);
    await expect(
      client.theatres.movies.query({ theatreId: THEATRE, from: DAY2, to: DAY1 }),
    ).rejects.toMatchObject({ data: { httpStatus: 400 } });
  });

  it("accepts a 30-day span and rejects a 31-day span as BAD_REQUEST (item 6, ADR 0016)", async () => {
    await seedTheatre(pool, THEATRE);
    const client = makeClient(server.baseUrl);
    // Exactly 30 days (from + 30 = to) → accepted (theatre exists → 200 with movies: []).
    const accepted = await client.theatres.movies.query({
      theatreId: THEATRE,
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(accepted.movies).toEqual([]);
    // 31 days → rejected by the span refine.
    await expect(
      client.theatres.movies.query({
        theatreId: THEATRE,
        from: "2026-08-01",
        to: "2026-09-01",
      }),
    ).rejects.toMatchObject({ data: { httpStatus: 400 } });
  });
});

describe("theatres.movies poster resolution and cache-miss dispatch (S25.4)", () => {
  it("resolves a poster through the tmdb_movie LEFT JOIN when one exists", async () => {
    await seedTheatre(pool, THEATRE);
    const capturedAt = new Date();
    await seedDay(pool, THEATRE, DAY1, capturedAt, [
      {
        showtimeId: "amc:showtime:poster",
        movieId: "amc:movie:poster",
        movieTitle: "The Odyssey",
        startsAt: new Date(`${DAY1}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);
    await upsertTmdbMovie(poolClient(pool), {
      tmdbId: 42,
      normalizedTitle: "the odyssey",
      posterPath: "/poster.jpg",
      runtimeMinutes: 128,
      genres: ["Action", "Adventure"],
    });

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY1 });
    expect(body.movies).toHaveLength(1);
    expect(body.movies[0]).toMatchObject({
      movieId: "amc:movie:poster",
      posterPath: "/poster.jpg",
      runtimeMinutes: 128,
      genres: ["Action", "Adventure"],
    });
    // A resolved poster never enqueues a fetch.
    const fetches = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM tmdb_fetch`);
    expect(fetches.rows[0]?.n).toBe(0);
  });

  it("returns null and enqueues one TMDB_FETCH on a first-time cache miss", async () => {
    await seedTheatre(pool, THEATRE);
    const capturedAt = new Date();
    await seedDay(pool, THEATRE, DAY1, capturedAt, [
      {
        showtimeId: "amc:showtime:miss",
        movieId: "amc:movie:miss",
        movieTitle: "Uncatalogued",
        startsAt: new Date(`${DAY1}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY1 });
    // S55 — a movie with no tmdb_movie row resolves runtimeMinutes: null, genres: [],
    // exactly like posterPath: null — never undefined, never fabricated.
    expect(body.movies[0]).toMatchObject({
      movieId: "amc:movie:miss",
      posterPath: null,
      runtimeMinutes: null,
      genres: [],
    });
    const fetch = await admin.query(
      `SELECT tf.tmdb_fetch_id, tf.movie_title, tf.state, o.target_kind
       FROM tmdb_fetch tf
       LEFT JOIN outbox o ON o.tmdb_fetch_id = tf.tmdb_fetch_id`,
    );
    expect(fetch.rows).toHaveLength(1);
    expect(fetch.rows[0]).toMatchObject({
      movie_title: "Uncatalogued",
      state: "PENDING",
      target_kind: "TMDB_FETCH",
    });
  });

  it("does not enqueue a duplicate fetch when the same movie misses twice while PENDING", async () => {
    await seedTheatre(pool, THEATRE);
    const capturedAt = new Date();
    await seedDay(pool, THEATRE, DAY1, capturedAt, [
      {
        showtimeId: "amc:showtime:dedup",
        movieId: "amc:movie:dedup",
        movieTitle: "Dedup",
        startsAt: new Date(`${DAY1}T19:00:00.000Z`),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);

    const client = makeClient(server.baseUrl);
    await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY1 });
    await client.theatres.movies.query({ theatreId: THEATRE, from: DAY1, to: DAY1 });

    const fetchCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tmdb_fetch WHERE movie_title = 'Dedup'`,
    );
    expect(fetchCount.rows[0]?.n).toBe(1);
    const outboxCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE target_kind = 'TMDB_FETCH'`,
    );
    expect(outboxCount.rows[0]?.n).toBe(1);
  });
});

describe("buildMovieGroups freshness ≤-edge and grouping (S21.5/S21.7)", () => {
  const day = (
    localDate: string,
    capturedAt: Date | null,
    movieId: string,
    title: string | null,
    showtimeId: string,
    startsAt: Date,
  ): ScheduleRangeDay => ({
    localDate,
    capturedAt,
    performances: [
      {
        showtimeId,
        localDate,
        movieId,
        title,
        startsAt,
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
        deepLinkUrl: "https://example.invalid/showtime",
        layoutId: null,
        attributes: [],
      },
    ],
  });

  it("a capture exactly at the injected ceiling is served; one second past disappears (item 4)", () => {
    const capturedAt = new Date("2026-08-14T12:00:00.000Z");
    const days = [day(DAY1, capturedAt, "amc:movie:edge", "Edge", "amc:showtime:edge", new Date())];

    // exactly AT the ceiling → served.
    const atCeiling = buildMovieGroups(
      days,
      FRESHNESS_MS,
      new Date(capturedAt.getTime() + FRESHNESS_MS),
    );
    expect(atCeiling).toHaveLength(1);
    expect(atCeiling[0]?.movieId).toBe("amc:movie:edge");

    // one second past → dropped.
    const oneSecondPast = buildMovieGroups(
      days,
      FRESHNESS_MS,
      new Date(capturedAt.getTime() + FRESHNESS_MS + 1_000),
    );
    expect(oneSecondPast).toEqual([]);
  });

  it("a NULL-capture day contributes nothing (item 4)", () => {
    const days = [day(DAY1, null, "amc:movie:nullcap", "Null", "amc:showtime:nullcap", new Date())];
    expect(buildMovieGroups(days, FRESHNESS_MS, new Date())).toEqual([]);
  });
});

describe("dispatchPosterBackfills (O6.5 seam)", () => {
  it("logs warn with structured movie_title on dispatch failure via injected logger, not console", async () => {
    const logger = capturingLogger();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let calls = 0;
    const fakeDb = {
      query: () => {
        calls++;
        if (calls === 1) throw new Error("outbox boom");
        return { rows: [], rowCount: 0 } as unknown as { rows: unknown[] };
      },
    } as unknown as Pool;

    const movies = [
      {
        movieId: "amc:movie:a" as TheatreMovieGroup["movieId"],
        title: "Alpha",
        showtimes: [],
        posterPath: null,
      },
      {
        movieId: "amc:movie:b" as TheatreMovieGroup["movieId"],
        title: "Beta",
        showtimes: [],
        posterPath: null,
      },
    ] as unknown as readonly TheatreMovieGroup[];

    await dispatchPosterBackfills(fakeDb, movies, logger);

    // One warn for the first movie that threw, none for the second
    const warns = logger.calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.movie_title).toBe("Alpha");
    expect(warns[0]?.fields.error).toBeInstanceOf(Error);
    expect((warns[0]?.fields.error as Error).message).toBe("outbox boom");
    expect(warns[0]?.message).toBe("TMDB_FETCH dispatch failed (best-effort)");
    // No console side effect
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(calls).toBe(2);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("does nothing for movies whose posterPath is already present", async () => {
    const logger = capturingLogger();
    const fakeDb = {
      query: () => {
        throw new Error("should not be called — poster present, no dispatch");
      },
    } as unknown as Pool;

    const movies = [
      {
        movieId: "amc:movie:a" as TheatreMovieGroup["movieId"],
        title: "Alpha",
        showtimes: [],
        posterPath: "/poster.jpg",
      },
    ] as unknown as readonly TheatreMovieGroup[];

    await dispatchPosterBackfills(fakeDb, movies, logger);
    expect(logger.calls).toHaveLength(0);
  });

  it("does not swallow successes — dispatch is attempted for every null-poster movie", async () => {
    const logger = capturingLogger();
    const queriedTitles: string[] = [];
    const fakeDb = {
      query: (_text: string, values?: unknown[]) => {
        // dispatchTmdbFetch passes [tmdbFetchId, movieTitle] — second param is the title
        if (Array.isArray(values) && values.length >= 2) queriedTitles.push(String(values[1]));
        return { rows: [], rowCount: 0 } as unknown as { rows: unknown[] };
      },
    } as unknown as Pool;

    const movies = [
      {
        movieId: "amc:movie:a" as TheatreMovieGroup["movieId"],
        title: "One",
        showtimes: [],
        posterPath: null,
      },
      {
        movieId: "amc:movie:b" as TheatreMovieGroup["movieId"],
        title: "Two",
        showtimes: [],
        posterPath: null,
      },
    ] as unknown as readonly TheatreMovieGroup[];

    await dispatchPosterBackfills(fakeDb, movies, logger);
    expect(logger.calls).toHaveLength(0);
    expect(queriedTitles).toHaveLength(2);
    expect(queriedTitles).toEqual(expect.arrayContaining(["One", "Two"]));
  });
});
