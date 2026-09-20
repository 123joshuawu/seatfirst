import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  poolClient,
  upsertAmcMovieCatalogue,
  upsertMovie,
  upsertTmdbMovie,
} from "@seatfirst/durability";
import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import { releaseYearFromDate } from "../src/routes/movies/search.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";
import type { TmdbClient, TmdbMovieSummary } from "../src/tmdb/client.js";

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

process.env.LOG_LEVEL = "info";

/**
 * S63.4 verification (spec S63.7) over HTTP against a real Fastify server and
 * real Postgres: default-slate browse, typed live-query union with lazy upsert,
 * and the tri-state confidence badges. The live TMDB client is a fake (never
 * real HTTP): it records calls and serves canned summaries/details, mirroring
 * how the TMDB duties tests fake the same surface.
 */

const seenAt = new Date("2026-08-01T00:00:00.000Z");

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

interface FakeTmdbOptions {
  readonly searchResults?: readonly TmdbMovieSummary[];
  readonly searchError?: Error;
  readonly detailsErrorIds?: readonly number[];
  readonly calls?: { search: string[]; details: number[] };
}

function fakeTmdbClient(options: FakeTmdbOptions = {}): TmdbClient {
  const calls = options.calls ?? { search: [], details: [] };
  return {
    searchMovie: (query) => {
      calls.search.push(query);
      if (options.searchError !== undefined) {
        return Promise.reject(options.searchError);
      }
      return Promise.resolve([...(options.searchResults ?? [])]);
    },
    movieDetails: (tmdbId) => {
      calls.details.push(tmdbId);
      if (options.detailsErrorIds?.includes(tmdbId) === true) {
        return Promise.reject(new Error(`details down for ${tmdbId}`));
      }
      return Promise.resolve({
        tmdbId,
        runtimeMinutes: 100 + tmdbId,
        genres: [`Genre ${tmdbId}`],
        releaseDate: null,
      });
    },
  };
}

async function startServer(
  db: Pool,
  redisUrl: string,
  tmdbClient?: TmdbClient,
): Promise<TestServer> {
  const redis = new Redis(redisUrl, { lazyConnect: true });
  const fastify = buildApp({
    db,
    searchLimits: {
      maxDateSpanDays: 3,
      maxResolvedShowtimes: 200,
      maxPartySize: 8,
      maxTheatres: 50,
      areaSelectorEnabled: false,
      maxRegionDepth: 3,
      maxRegionNodes: 8,
      maxPredicateDepth: 4,
      maxPredicateNodes: 8,
      maxAreaRadiusKm: 40,
      splitGroupEnabled: false,
    },
    freshnessMs: 10 * 60_000,
    retryAfterSeconds: 30,
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
    ...(tmdbClient === undefined ? {} : { tmdbClient }),
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

async function seedAmc(pool: Pool, movieId: string, title: string): Promise<void> {
  await upsertMovie(poolClient(pool), {
    movieId,
    providerId: "amc",
    title,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
}

async function seedAmcCatalogue(
  pool: Pool,
  row: {
    movieId: number;
    slug?: string;
    name: string;
    releaseDate?: string | null;
  },
): Promise<void> {
  await upsertAmcMovieCatalogue(poolClient(pool), {
    movieId: row.movieId,
    slug: row.slug ?? `movie-${row.movieId}`,
    name: row.name,
    mpaaRating: null,
    runtimeMinutes: null,
    releaseDate: row.releaseDate ?? null,
    status: null,
    imageUrl: null,
    detailsPath: null,
    showtimesPath: null,
  });
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let redis: Awaited<ReturnType<typeof startTestRedis>>;
let server: TestServer;
let pool: Pool;
let admin: Client;
let tmdbCalls: { search: string[]; details: number[] };
let liveResults: TmdbMovieSummary[];
let searchError: Error | undefined;

function resetFake() {
  tmdbCalls = { search: [], details: [] };
  liveResults = [];
  searchError = undefined;
}

async function restartServer(): Promise<void> {
  await server.close();
  server = await startServer(
    pool,
    redis.url,
    fakeTmdbClient({
      searchResults: liveResults,
      ...(searchError === undefined ? {} : { searchError }),
      calls: tmdbCalls,
    }),
  );
}

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  resetFake();
  server = await startServer(pool, redis.url, fakeTmdbClient({ calls: tmdbCalls }));
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
     theatre, movie, tmdb_movie, tmdb_fetch, amc_movie_catalogue,
     amc_movie_catalogue_state CASCADE`,
  );
  resetFake();
  await restartServer();
});

describe("movies.search default slate (S63.4 empty query)", () => {
  it("serves catalogue rows locally with zero TMDB calls", async () => {
    await seedAmcCatalogue(pool, {
      movieId: 101,
      slug: "dune-part-two",
      name: "Dune: Part Two",
      releaseDate: "2024-03-01",
    });
    await seedAmcCatalogue(pool, {
      movieId: 102,
      slug: "mickey-17",
      name: "Mickey 17",
      releaseDate: "2025-03-07",
    });
    // Observed on an AMC schedule but absent from the catalogue: never surfaces
    // on the default slate (catalogue membership IS the slate now, ADR 0102).
    await seedAmc(pool, "amc:movie:off-slate", "Off Slate");
    await seedAmc(pool, "amc:movie:dune2", "Dune: Part Two");

    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({});

    expect(tmdbCalls.search).toEqual([]);
    expect(tmdbCalls.details).toEqual([]);
    expect(res.movies).toHaveLength(2);
    // Catalogue order (`ORDER BY name, movie_id`): Dune before Mickey.
    expect(res.movies[0]).toEqual({
      id: "amc:movie:dune2",
      title: "Dune: Part Two",
      releaseYear: 2024,
      // ADR 0102 decision 5: the catalogue never supplies a compliant poster.
      posterPath: null,
      confidence: "VERIFIED_AMC",
      badge: null,
      seenAtAmc: true,
    });
    expect(res.movies[1]).toEqual({
      id: "amc:catalogue:102",
      // No AMC schedule match: falls back to the catalogue name.
      title: "Mickey 17",
      releaseYear: 2025,
      posterPath: null,
      confidence: "WIDE_THEATRICAL",
      badge: null,
      seenAtAmc: false,
    });
  });

  it("treats blank and single-character queries as default browse", async () => {
    await seedAmcCatalogue(pool, { movieId: 111, slug: "sinners", name: "Sinners" });
    const client = makeClient(server.baseUrl);
    for (const query of [undefined, "", "   ", "a"]) {
      const res =
        query === undefined
          ? await client.movies.search.query({})
          : await client.movies.search.query({ query });
      expect(res.movies.map((m) => m.id)).toEqual(["amc:catalogue:111"]);
    }
    expect(tmdbCalls.search).toEqual([]);
  });

  it("reads an empty slate as an empty list (never an error)", async () => {
    const client = makeClient(server.baseUrl);
    await expect(client.movies.search.query({})).resolves.toEqual({ movies: [] });
  });

  it("caps the slate at the requested limit", async () => {
    await seedAmcCatalogue(pool, { movieId: 121, slug: "alpha", name: "Alpha" });
    await seedAmcCatalogue(pool, { movieId: 122, slug: "beta", name: "Beta" });
    await seedAmcCatalogue(pool, { movieId: 123, slug: "gamma", name: "Gamma" });
    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({ limit: 2 });
    expect(res.movies.map((m) => m.id)).toEqual(["amc:catalogue:121", "amc:catalogue:122"]);
  });
});

describe("movies.search typed query (S63.4 live union + lazy upsert)", () => {
  it("unions live TMDB hits with AMC events, upserts each hit, and badges tri-state", async () => {
    // A catalogue row the live query will also return: typed-query
    // `WIDE_THEATRICAL` keys off catalogue membership now (ADR 0102), while the
    // lazy upsert must preserve the pre-seeded TMDB release date it never sets
    // and refresh the poster.
    await seedAmcCatalogue(pool, {
      movieId: 502,
      slug: "dune-messiah",
      name: "Dune Messiah",
      releaseDate: "2026-12-18",
    });
    await upsertTmdbMovie(poolClient(pool), {
      tmdbId: 202,
      normalizedTitle: "dune messiah",
      title: "Dune Messiah",
      posterPath: "/old.jpg",
      runtimeMinutes: null,
      genres: [],
      releaseDate: "2026-12-18",
    });
    await seedAmc(pool, "amc:movie:dune2", "Dune: Part Two");
    await seedAmc(pool, "amc:movie:dune-event", "Dune Sneak Peek Event");
    liveResults = [
      { tmdbId: 201, title: "Dune: Part Two", posterPath: "/d.jpg", releaseDate: null },
      { tmdbId: 202, title: "Dune Messiah", posterPath: "/new202.jpg", releaseDate: null },
      { tmdbId: 203, title: "Dune: The Deep Cut", posterPath: null, releaseDate: null },
    ];
    await restartServer();

    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({ query: "dune" });

    expect(tmdbCalls.search).toEqual(["dune"]);
    expect(tmdbCalls.details.sort((a, b) => a - b)).toEqual([201, 202, 203]);

    // Lazy upsert persisted every live hit with details enrichment...
    const stored = await pool.query(
      `SELECT tmdb_id, normalized_title, title, poster_path, runtime_minutes, genres,
              release_date::text AS release_date
       FROM tmdb_movie WHERE tmdb_id = ANY($1) ORDER BY tmdb_id`,
      [[201, 202, 203]],
    );
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows[0]).toMatchObject({
      tmdb_id: 201,
      normalized_title: "dune: part two",
      title: "Dune: Part Two",
      poster_path: "/d.jpg",
      runtime_minutes: 301,
      genres: ["Genre 201"],
    });
    // ...while preserving the pre-seeded release date it never sets.
    expect(stored.rows[1]).toMatchObject({
      tmdb_id: 202,
      poster_path: "/new202.jpg",
      release_date: "2026-12-18",
    });

    // ...and the union carries the tri-state confidence.
    expect(res.movies).toEqual([
      {
        id: "tmdb:movie:201",
        title: "Dune: Part Two",
        releaseYear: null,
        posterPath: "/d.jpg",
        confidence: "VERIFIED_AMC",
        badge: null,
        seenAtAmc: true,
      },
      {
        id: "tmdb:movie:202",
        title: "Dune Messiah",
        releaseYear: 2026,
        posterPath: "/new202.jpg",
        confidence: "WIDE_THEATRICAL",
        badge: null,
        seenAtAmc: false,
      },
      {
        id: "tmdb:movie:203",
        title: "Dune: The Deep Cut",
        releaseYear: null,
        posterPath: null,
        confidence: "UNVERIFIED",
        badge: "May not be playing here",
        seenAtAmc: false,
      },
      {
        id: "amc:movie:dune-event",
        title: "Dune Sneak Peek Event",
        releaseYear: null,
        posterPath: null,
        confidence: "VERIFIED_AMC",
        badge: "AMC Event",
        seenAtAmc: true,
      },
    ]);
  });

  it("degrades to local AMC results when the live TMDB query fails", async () => {
    await seedAmc(pool, "amc:movie:opera1", "Met Opera Live: Aida");
    searchError = new Error("tmdb down");
    await restartServer();

    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({ query: "opera" });

    expect(res.movies).toEqual([
      {
        id: "amc:movie:opera1",
        title: "Met Opera Live: Aida",
        releaseYear: null,
        posterPath: null,
        confidence: "VERIFIED_AMC",
        badge: "AMC Event",
        seenAtAmc: true,
      },
    ]);
    const count = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tmdb_movie`);
    expect(count.rows[0]?.n).toBe(0);
  });

  it("skips persistence for entries whose details fetch fails, still serving them", async () => {
    liveResults = [
      { tmdbId: 301, title: "Details Down", posterPath: "/dd.jpg", releaseDate: null },
    ];
    await restartServer();
    // Rebuild the server with a details outage for 301 (restartServer uses the
    // shared fake options; details errors need a dedicated server).
    await server.close();
    server = await startServer(
      pool,
      redis.url,
      fakeTmdbClient({ searchResults: liveResults, detailsErrorIds: [301], calls: tmdbCalls }),
    );

    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({ query: "details" });

    expect(res.movies).toEqual([
      {
        id: "tmdb:movie:301",
        title: "Details Down",
        releaseYear: null,
        // Falls back to the live summary poster when nothing was persisted.
        posterPath: "/dd.jpg",
        confidence: "UNVERIFIED",
        badge: "May not be playing here",
        seenAtAmc: false,
      },
    ]);
    const count = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tmdb_movie`);
    expect(count.rows[0]?.n).toBe(0);
  });

  it("dedupes AMC-only rows sharing one normalized title (first catalogue row wins)", async () => {
    await seedAmc(pool, "amc:movie:odyssey1", "The Odyssey (2026)");
    await seedAmc(pool, "amc:movie:odyssey2", "The Odyssey (2026)");

    const client = makeClient(server.baseUrl);
    const res = await client.movies.search.query({ query: "odyssey" });

    expect(res.movies).toEqual([
      {
        id: "amc:movie:odyssey1",
        title: "The Odyssey (2026)",
        releaseYear: null,
        posterPath: null,
        confidence: "VERIFIED_AMC",
        badge: "AMC Event",
        seenAtAmc: true,
      },
    ]);
  });

  it("fails closed on a typed query when no TMDB client is wired", async () => {
    await seedAmcCatalogue(pool, { movieId: 401, slug: "wired", name: "Wired?" });
    // An assembly without the client: slate browse works, typed queries cannot.
    await server.close();
    server = await startServer(pool, redis.url);

    const client = makeClient(server.baseUrl);
    await expect(client.movies.search.query({})).resolves.toMatchObject({
      movies: [{ id: "amc:catalogue:401" }],
    });
    const failure = await client.movies.search.query({ query: "wired" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TRPCClientError);
    expect((failure as TRPCClientError<AppRouter>).message).toMatch(/wired TmdbClient/);
  });
});

describe("releaseYearFromDate", () => {
  it("parses YYYY-MM-DD and rejects everything else without fabricating", () => {
    expect(releaseYearFromDate("2024-03-01")).toBe(2024);
    expect(releaseYearFromDate(null)).toBeNull();
    expect(releaseYearFromDate(undefined)).toBeNull();
    expect(releaseYearFromDate("")).toBeNull();
    expect(releaseYearFromDate("2024")).toBeNull();
    expect(releaseYearFromDate("not-a-date")).toBeNull();
  });
});
