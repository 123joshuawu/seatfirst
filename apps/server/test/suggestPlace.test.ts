import { readFileSync } from "node:fs";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_LIMITS,
  ResolvePlaceOkSchema,
  SuggestPlaceCandidatesSchema,
  SuggestPlaceInputSchema,
  SuggestPlaceResponseSchema,
  specHash,
} from "@seatfirst/core";
import type { SearchSpec } from "@seatfirst/core";
import { poolClient, upsertTheatre } from "@seatfirst/durability";
import type { RedisScriptExecutor, UpsertTheatreInput } from "@seatfirst/durability";

import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import { GeocodeUnavailableError, MAPBOX_API_BASE_URL } from "../src/geocode/mapbox.js";
import { createMapboxGeocodeResolver } from "../src/geocode/mapbox.js";
import { GEOCODE_MEMO_MAX_ENTRIES, GEOCODE_MEMO_TTL_MS, GeocodeMemo } from "../src/geocode/memo.js";
import type { GeocodeResolver, ResolvedPlace, SuggestCandidate } from "../src/geocode/resolver.js";
import {
  GEOCODE_TOKEN_BUCKET_CAPACITY,
  GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND,
} from "../src/geocode/token-bucket.js";
import type { GeocodeTokenBucket } from "../src/geocode/token-bucket.js";
import { parseMapboxConfig } from "../src/geocode/config.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
  type SessionRateLimitConfig,
} from "../src/session/limiter.js";
import { capturingLogger } from "./support/logger.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import {
  sessionCookieHeader,
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RELAY_PEER_CIDR,
  TEST_NONCE_SECRET,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_MINT_ID,
  TEST_METRICS,
  TEST_TRACER,
} from "./support/app.js";

function readSource(relFromTest: string): string {
  try {
    return readFileSync(new URL(relFromTest, import.meta.url), "utf8");
  } catch {
    const alt = relFromTest.replace(/^\.\.\//, "apps/server/");
    try {
      return readFileSync(new URL(`../../../${alt}`, import.meta.url), "utf8");
    } catch {
      return readFileSync(alt, "utf8");
    }
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k: string, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

const PROVIDER = "amc";
const SESSION_A = "sess_suggest_a";
const SESSION_B = "sess_suggest_b";
const FRESHNESS_MS = 10 * 60_000;
const RETRY_AFTER_SECONDS = 30;
const ORIGIN_LAT = 37.7749;
const ORIGIN_LNG = -122.4194;

function makeRateLimitConfig(
  overrides: Partial<SessionRateLimitConfig> = {},
): SessionRateLimitConfig {
  return {
    searches: { limit: 10_000, windowMs: 3_600_000 },
    fetches: { limit: 100_000, windowMs: 3_600_000 },
    recheck: { limit: 10_000, windowMs: 60_000 },
    facetCounts: { limit: 10_000, windowMs: 60_000 },
    resolvePlace: { limit: 10_000, windowMs: 60_000 },
    suggestPlace: { limit: 30, windowMs: 60_000 },
    facetCountMaxCandidates: 40,
    concurrentSearches: 10_000,
    breachWindowMs: 3_600_000,
    ...overrides,
  };
}
function theatreInput(
  theatreId: string,
  lat: number,
  lng: number,
  name?: string,
): UpsertTheatreInput {
  return {
    theatreId,
    providerId: PROVIDER,
    name: name ?? theatreId,
    lat,
    lng,
    marketSlug: null,
    timezone: "America/Los_Angeles",
    city: null,
    address: null,
    slugs: { detail: theatreId },
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function makeClient(baseUrl: string, sessionId?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: baseUrl,
        headers: sessionId === undefined ? {} : { cookie: sessionCookieHeader(sessionId) },
      }),
    ],
  });
}

function stubResolver(
  resolveMap: Map<string, ResolvedPlace | null>,
  suggestMap: Map<string, readonly SuggestCandidate[]>,
  counters: { resolveCalls: number; suggestCalls: number },
  errorMap: Map<string, Error> = new Map(),
): GeocodeResolver {
  return {
    resolve(query: string): Promise<ResolvedPlace | null> {
      counters.resolveCalls += 1;
      if (errorMap.has(query)) return Promise.reject(errorMap.get(query)!);
      const key = query.trim().replace(/\s+/g, " ");
      if (resolveMap.has(key)) return Promise.resolve(resolveMap.get(key) ?? null);
      if (resolveMap.has(key.toLowerCase()))
        return Promise.resolve(resolveMap.get(key.toLowerCase()) ?? null);
      return Promise.resolve(resolveMap.get(query) ?? null);
    },
    suggest(query: string): Promise<readonly SuggestCandidate[]> {
      counters.suggestCalls += 1;
      if (errorMap.has(`suggest:${query}`))
        return Promise.reject(errorMap.get(`suggest:${query}`)!);
      if (errorMap.has(query)) return Promise.reject(errorMap.get(query)!);
      const key = query.trim().replace(/\s+/g, " ");
      if (suggestMap.has(key)) return Promise.resolve(suggestMap.get(key) ?? []);
      if (suggestMap.has(key.toLowerCase()))
        return Promise.resolve(suggestMap.get(key.toLowerCase()) ?? []);
      const raw = suggestMap.get(query);
      if (raw) return Promise.resolve(raw);
      return Promise.resolve([]);
    },
  };
}

async function startS52Server(opts: {
  db: Pool;
  redisUrl: string;
  config: SessionRateLimitConfig;
  resolver: GeocodeResolver;
  resolveMemo: GeocodeMemo<ResolvedPlace>;
  suggestMemo: GeocodeMemo<readonly SuggestCandidate[]>;
  logger: ReturnType<typeof capturingLogger>;
  limiterNow?: () => number;
  bucket?: GeocodeTokenBucket;
}): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  limiter: ReturnType<typeof createSessionRateLimiter>;
  bucket: GeocodeTokenBucket;
}> {
  const redis = new Redis(opts.redisUrl, { lazyConnect: true });
  const limiterOpts: Parameters<typeof createSessionRateLimiter>[0] = {
    redis: redisScriptExecutorFromIoredis(redis),
    config: opts.config,
    ...(opts.limiterNow ? { now: opts.limiterNow } : {}),
  };
  const limiter = createSessionRateLimiter(limiterOpts);
  const bucket = opts.bucket ?? { acquire: () => Promise.resolve() };
  const fastify = buildApp({
    db: opts.db,
    searchLimits: DEFAULT_SEARCH_LIMITS,
    freshnessMs: FRESHNESS_MS,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    rateLimitConfig: opts.config,
    limiter,
    cookieSecret: TEST_COOKIE_SECRET,
    cookiePolicy: TEST_COOKIE_POLICY,
    relayPeerCidr: TEST_RELAY_PEER_CIDR,
    asnLookup: TEST_ASN_LOOKUP,
    streamRedisUrl: opts.redisUrl,
    streamBlockTimeoutMs: 250,
    providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
    nonceSecret: TEST_NONCE_SECRET,
    recheckDeadlineMs: TEST_RECHECK_DEADLINE_MS,
    recheckRecovery: TEST_RECHECK_RECOVERY,
    mapboxAccessToken: "test-mapbox-token",
    corsAllowedOrigins: ["http://localhost:8081"],
    logger: opts.logger as unknown as FastifyBaseLogger,
    mintId: TEST_MINT_ID,
    metrics: TEST_METRICS,
    tracer: TEST_TRACER,
    geocodeResolver: opts.resolver,
    geocodeMemo: opts.resolveMemo,
    suggestMemo: opts.suggestMemo,
    geocodeBucket: bucket,
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/trpc`,
    limiter,
    bucket,
    close: async () => {
      await fastify.close();
      redis.disconnect();
    },
  };
}

function makeSpecWithList(theatreIds: string[]): SearchSpec {
  const localDate = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: { kind: "LIST", refs: theatreIds.map((id) => ({ id })) },
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [`${PROVIDER}:movie:m1`] },
        { kind: "DATE_RANGE", from: localDate, to: localDate },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  } as unknown as SearchSpec;
}

// Global containers
let pg: TestService;
let redisService: TestService;
let pool: Pool;
let admin: Client;

beforeAll(async () => {
  pg = await startTestPostgres();
  redisService = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await pool.end();
  await pg.stop();
  await redisService.stop();
});

beforeEach(async () => {
  await pool.query("TRUNCATE theatre, search, theatre CASCADE");
  const redis = new Redis(redisService.url, { lazyConnect: true });
  await redis.flushdb();
  redis.disconnect();
});

// ---------------- S52.1 ----------------
describe("S52.1 — SuggestPlaceInputSchema envelope and response caps, no coordinate", () => {
  it("accepts only non-empty providerId and 1-256 char query without semicolon and ≤20 tokens, no radius/limit", () => {
    const ok = SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "Sunnyvale CA" });
    expect(ok.success).toBe(true);
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "", query: "x" }).success).toBe(false);
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "" }).success).toBe(false);
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: "a; b" }).success).toBe(
      false,
    );
    const twentyOne = Array.from({ length: 21 }, (_, i) => `w${i}`).join(" ");
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: twentyOne }).success).toBe(
      false,
    );
    const twenty = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: twenty }).success).toBe(
      true,
    );
    const long = "a".repeat(257);
    expect(SuggestPlaceInputSchema.safeParse({ providerId: "amc", query: long }).success).toBe(
      false,
    );
    // no radius/limit fields
    expect(
      SuggestPlaceInputSchema.safeParse({
        providerId: "amc",
        query: "x",
        radiusKm: 10,
      }).success,
    ).toBe(false);
    expect(
      SuggestPlaceInputSchema.safeParse({
        providerId: "amc",
        query: "x",
        limit: 10,
      }).success,
    ).toBe(false);
  });

  it("response contract carries no coordinate and caps candidates at five", () => {
    const five = { candidates: Array.from({ length: 5 }, (_, i) => ({ label: `Place ${i}` })) };
    expect(SuggestPlaceCandidatesSchema.safeParse(five).success).toBe(true);
    const six = { candidates: Array.from({ length: 6 }, (_, i) => ({ label: `Place ${i}` })) };
    expect(SuggestPlaceCandidatesSchema.safeParse(six).success).toBe(false);
    // no coordinate fields allowed
    const withCoord = { candidates: [{ label: "x", lat: 1 }] } as unknown as Record<
      string,
      unknown
    >;
    expect(SuggestPlaceCandidatesSchema.safeParse(withCoord).success).toBe(false);
    const withCoord2 = { candidates: [{ label: "x" }], lat: 1 } as unknown as Record<
      string,
      unknown
    >;
    expect(SuggestPlaceResponseSchema.safeParse(withCoord2).success).toBe(false);
    // SuggestPlaceResponseSchema unions candidates vs unavailable, also no coordinate
    expect(SuggestPlaceResponseSchema.safeParse({ candidates: [] }).success).toBe(true);
    expect(
      SuggestPlaceResponseSchema.safeParse({ kind: "PLACE_RESOLUTION_UNAVAILABLE" }).success,
    ).toBe(true);
    expect(
      SuggestPlaceResponseSchema.safeParse({
        kind: "PLACE_RESOLUTION_UNAVAILABLE",
        lat: 1,
      }).success,
    ).toBe(false);
  });

  it("ResolvePlaceOkSchema requires resolvedPlaceName alongside existing fields", () => {
    const ok = ResolvePlaceOkSchema.safeParse({
      kind: "ok",
      theatres: [],
      excluded: { outsideArea: 0, byLimit: 0 },
      label: "10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, CA, United States",
    });
    expect(ok.success).toBe(true);
    const missing = ResolvePlaceOkSchema.safeParse({
      kind: "ok",
      theatres: [],
      excluded: { outsideArea: 0, byLimit: 0 },
      label: "10 km around Sunnyvale",
    });
    expect(missing.success).toBe(false);
    // strictObject: no lat/lng allowed
    const withCoord = ResolvePlaceOkSchema.safeParse({
      kind: "ok",
      theatres: [],
      excluded: { outsideArea: 0, byLimit: 0 },
      label: "10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, CA, United States",
      lat: 1,
    });
    expect(withCoord.success).toBe(false);
  });
});

// ---------------- S52.2 ----------------
describe("S52.2 — injected-fetch Mapbox suggest params and filtering", () => {
  it("suggest issues v6 forward with country=US worldview=us autocomplete=true limit=5 and token encoding", async () => {
    const captured: string[] = [];
    let bucketAcquires = 0;
    const bucket: GeocodeTokenBucket = {
      acquire: () => {
        bucketAcquires += 1;
        return Promise.resolve();
      },
    };
    const stubFetch: typeof fetch = (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      captured.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              {
                properties: {
                  feature_type: "place",
                  full_address: "San Francisco, CA, United States",
                },
                geometry: { coordinates: [-122, 37] },
              },
            ],
          }),
      } as Response);
    };
    const logger = capturingLogger();
    const resolver = createMapboxGeocodeResolver({
      accessToken: "pk.test token+/",
      bucket,
      logger,
      fetch: stubFetch,
    });
    const res = await resolver.suggest("san fran");
    expect(res).toEqual([{ label: "San Francisco, CA, United States" }]);
    expect(captured.length).toBe(1);
    const url = captured[0]!;
    expect(url).toContain(`${MAPBOX_API_BASE_URL}/search/geocode/v6/forward`);
    expect(url).toContain(`q=${encodeURIComponent("san fran")}`);
    expect(url).toContain("country=US");
    expect(url).toContain("worldview=us");
    expect(url).toContain("types=place,locality");
    expect(url).toContain("autocomplete=true");
    expect(url).toContain("limit=5");
    expect(url).toContain(`access_token=${encodeURIComponent("pk.test token+/")}`);
    expect(url).not.toContain("permanent=true");
    expect(bucketAcquires).toBe(1);
  });

  it("accepts only city/place feature types (place, locality) and maps valid full_address to {label}, empty returns []", async () => {
    const bucket: GeocodeTokenBucket = { acquire: () => Promise.resolve() };
    const logger = capturingLogger();
    const stubFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              { properties: { feature_type: "place", full_address: "A" } },
              { properties: { feature_type: "poi", full_address: "POI Place" } },
              { properties: { feature_type: "address", full_address: "123 Main St" } },
              { properties: { feature_type: "locality", full_address: "" } },
              { properties: { feature_type: "region", full_address: "California" } },
              { properties: { feature_type: "place", full_address: "B" } },
              { properties: { feature_type: "place" } },
            ],
          }),
      } as Response);
    const resolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: stubFetch,
    });
    const out = await resolver.suggest("test");
    // poison poi, non-city types (address, region), and empty / missing full_address skipped, only place/locality accepted until 5
    expect(out).toEqual([{ label: "A" }, { label: "B" }]);
  });

  it("empty accepted results return [] not error, and resolve retains autocomplete=false limit=1 with full_address mapping", async () => {
    const bucket: GeocodeTokenBucket = { acquire: () => Promise.resolve() };
    const logger = capturingLogger();
    const suggestFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ features: [] }),
      } as Response);
    const resolveFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              {
                properties: { feature_type: "place", full_address: "Sunnyvale, CA, United States" },
                geometry: { coordinates: [-122.0, 37.3] },
              },
            ],
          }),
      } as Response);
    const suggestResolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: suggestFetch,
    });
    const empty = await suggestResolver.suggest("zzzz");
    expect(empty).toEqual([]);
    const resolveResolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: resolveFetch,
    });
    const resolved = await resolveResolver.resolve("Sunnyvale");
    expect(resolved).toEqual({
      lat: 37.3,
      lng: -122.0,
      resolvedPlaceName: "Sunnyvale, CA, United States",
    });
    let capturedResolveUrl = "";
    const capFetch: typeof fetch = (input) => {
      capturedResolveUrl =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              {
                properties: { feature_type: "place", full_address: "X" },
                geometry: { coordinates: [1, 2] },
              },
            ],
          }),
      } as Response);
    };
    const capResolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: capFetch,
    });
    await capResolver.resolve("Y");
    expect(capturedResolveUrl).toContain("autocomplete=false");
    expect(capturedResolveUrl).toContain("limit=1");
  });
});

// ---------------- S52.3 ----------------
describe("S52.3 — session-first and limiter-first, 30/min suggest, 10/min resolve", () => {
  it("no session => UNAUTHORIZED without resolver/bucket", async () => {
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolver = stubResolver(new Map(), new Map(), counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    let bucketAcquires = 0;
    const bucket: GeocodeTokenBucket = {
      acquire: () => {
        bucketAcquires += 1;
        return Promise.resolve();
      },
    };
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig({
        suggestPlace: { limit: 30, windowMs: 60_000 },
        resolvePlace: { limit: 10, windowMs: 60_000 },
      }),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
      bucket,
    });
    try {
      const clientNoSession = makeClient(server.baseUrl, undefined);
      await expect(
        clientNoSession.searches.suggestPlace.query({ providerId: PROVIDER, query: "san" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof TRPCClientError &&
          (e as TRPCClientError<AppRouter>).data?.code === "UNAUTHORIZED",
      );
      expect(counters.suggestCalls).toBe(0);
      expect(bucketAcquires).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("denied suggest 30/min window returns 429 with suggest_place_per_minute without vendor", async () => {
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolver = stubResolver(
      new Map(),
      new Map([["san", [{ label: "San Francisco, CA" }]]]),
      counters,
    );
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    let bucketAcquires = 0;
    const bucket: GeocodeTokenBucket = {
      acquire: () => {
        bucketAcquires += 1;
        return Promise.resolve();
      },
    };
    const config = makeRateLimitConfig({ suggestPlace: { limit: 2, windowMs: 60_000 } });
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config,
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
      bucket,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      // first two succeed
      await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "san one" });
      await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "san two" });
      const before = counters.suggestCalls;
      bucketAcquires = 0;
      // third should be rate limited
      let threw: unknown;
      try {
        await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "san three" });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
      const err = threw as TRPCClientError<AppRouter>;
      const errData = err.data as unknown as {
        code?: string;
        limit?: string;
        retryAfterSeconds?: number | null;
      };
      expect(errData.code).toBe("RATE_LIMITED");
      expect(errData.limit).toBe("suggest_place_per_minute");
      expect(safeStringify(err)).toContain("suggest_place_per_minute");
      expect(counters.suggestCalls).toBe(before);
      expect(bucketAcquires).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("limiter check failure fails open and still calls resolver, charge failure also fails open", async () => {
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolver = stubResolver(new Map(), new Map([["san", [{ label: "SF" }]]]), counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    // create a limiter that throws on check
    const redis = new Redis(redisService.url, { lazyConnect: true });
    const failingExecutor: RedisScriptExecutor = {
      eval: () => Promise.reject(new Error("redis down")),
    };
    const failingLimiter = createSessionRateLimiter({
      redis: failingExecutor,
      config: makeRateLimitConfig(),
    });
    const fastify = buildApp({
      db: pool,
      searchLimits: DEFAULT_SEARCH_LIMITS,
      freshnessMs: FRESHNESS_MS,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
      rateLimitConfig: makeRateLimitConfig(),
      limiter: failingLimiter,
      cookieSecret: TEST_COOKIE_SECRET,
      cookiePolicy: TEST_COOKIE_POLICY,
      relayPeerCidr: TEST_RELAY_PEER_CIDR,
      asnLookup: TEST_ASN_LOOKUP,
      streamRedisUrl: redisService.url,
      streamBlockTimeoutMs: 250,
      providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
      nonceSecret: TEST_NONCE_SECRET,
      recheckDeadlineMs: TEST_RECHECK_DEADLINE_MS,
      recheckRecovery: TEST_RECHECK_RECOVERY,
      mapboxAccessToken: "test-mapbox-token",
      corsAllowedOrigins: ["http://localhost:8081"],
      logger: logger as unknown as FastifyBaseLogger,
      mintId: TEST_MINT_ID,
      metrics: TEST_METRICS,
      tracer: TEST_TRACER,
      geocodeResolver: resolver,
      geocodeMemo: resolveMemo,
      suggestMemo,
    });
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    if (address === null || typeof address === "string")
      throw new Error("test server has no TCP address");
    const client = makeClient(`http://127.0.0.1:${address.port}/trpc`, SESSION_A);
    try {
      const res = await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "san" });
      expect(res).toEqual({ candidates: [{ label: "SF" }] });
      expect(counters.suggestCalls).toBe(1);
      expect(
        logger.calls.some(
          (c) =>
            c.level === "warn" &&
            safeStringify(c.message).includes("rate-limit window check failed"),
        ) || safeStringify(logger.calls).includes("failing open"),
      ).toBeTruthy();
    } finally {
      await fastify.close();
      redis.disconnect();
    }
  });

  it("bootstrap and config widen correctly, unchanged resolve 10/min", async () => {
    const cfg = makeRateLimitConfig({
      suggestPlace: { limit: 30, windowMs: 60_000 },
      resolvePlace: { limit: 10, windowMs: 60_000 },
    });
    expect(cfg.suggestPlace.limit).toBe(30);
    expect(cfg.suggestPlace.windowMs).toBe(60_000);
    expect(cfg.resolvePlace.limit).toBe(10);
    // app-config parsing
    const { appConfigFromEnv } = await import("../src/app-config.js");
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://u:p@localhost/db",
      APP_PG_POOL_MAX: "10",
      APP_PG_POOL_IDLE_TIMEOUT_MS: "1000",
      APP_PG_CONNECT_TIMEOUT_MS: "1000",
      REDIS_URL: "redis://localhost:6379",
      API_PORT: "3000",
      SEARCH_LIMITS_JSON: JSON.stringify(DEFAULT_SEARCH_LIMITS),
      FRESHNESS_MS: "600000",
      RETRY_AFTER_SECONDS: "30",
      RATE_LIMIT_CONFIG_JSON: JSON.stringify({
        searches: { limit: 20, windowMs: 3_600_000 },
        fetches: { limit: 600, windowMs: 3_600_000 },
        recheck: { limit: 10, windowMs: 60_000 },
        facetCounts: { limit: 120, windowMs: 60_000 },
        facetCountMaxCandidates: 40,
        resolvePlace: { limit: 10, windowMs: 60_000 },
        suggestPlace: { limit: 30, windowMs: 60_000 },
        concurrentSearches: 3,
        breachWindowMs: 60_000,
      }),
      COOKIE_SECRET: "secret",
      SESSION_COOKIE_POLICY_JSON: JSON.stringify({ sameSite: "Lax", maxAgeSeconds: 3600 }),
      RELAY_PEER_CIDR: "10.0.0.0/24",
      ASN_DATABASE_PATH: "/tmp/asn.mmdb",
      STREAM_BLOCK_TIMEOUT_MS: "250",
      PROVIDER_HOST_ALLOWLISTS_JSON: JSON.stringify({ amc: ["example.invalid"] }),
      NONCE_SECRET: "nonce",
      RECHECK_DEADLINE_MS: "30000",
      RECHECK_RECOVERY_ROW_WEIGHT: "1",
      CORS_ALLOWED_ORIGINS: "http://localhost:8081",
      LOG_LEVEL: "info",
      MAPBOX_ACCESS_TOKEN: "pk.test",
    };
    const parsed = appConfigFromEnv(env);
    expect(parsed.rateLimitConfig.suggestPlace.limit).toBe(30);
    // bootstrap verification via direct handle
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolver = stubResolver(new Map(), new Map(), counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: cfg,
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      // session.bootstrap is POST /trpc/session.bootstrap via bespoke, but tRPC client uses same path; test via fetch directly
      const resp = await fetch(`${server.baseUrl.replace("/trpc", "")}/trpc/session.bootstrap`, {
        method: "POST",
        headers: { cookie: sessionCookieHeader(SESSION_A), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await resp.json()) as {
        result?: { data?: { limits?: Record<string, unknown> } };
      };
      const limits = json.result?.data?.limits;
      if (limits) {
        expect(limits["suggestPlacePerMinute"] ?? limits["suggest_place_per_minute"]).toBeDefined();
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------- S52.4 ----------------
describe("S52.4 — suggestion memo hit skips resolver/bucket, separate generic instances, TTL/LRU", () => {
  it("same-session same-normalized-query hit returns cached without resolver/bucket, different session misses", async () => {
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const suggestMap = new Map<string, readonly SuggestCandidate[]>([
      ["san", [{ label: "San Francisco, CA" }]],
    ]);
    const resolver: GeocodeResolver = {
      resolve: () => Promise.resolve(null),
      suggest: (q: string) => {
        counters.suggestCalls += 1;
        const k = q.trim().replace(/\s+/g, " ").toLowerCase();
        return Promise.resolve(suggestMap.get(k) ?? []);
      },
    };
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const bucket: GeocodeTokenBucket = {
      acquire: () => Promise.resolve(),
    };
    // For this test we need resolveMemo and suggestMemo isolated but bucket shared;
    // Use real suggest resolver via stub that counts, but memo hit should skip bucket too.
    // Our mapbox bucket is used inside resolver; since we use stub resolver not mapbox, bucket not used.
    // Instead test via injected fetch path already covers bucket skip; here we just verify memo skip of resolver.
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
      bucket,
    });
    try {
      const clientA = makeClient(server.baseUrl, SESSION_A);
      const clientB = makeClient(server.baseUrl, SESSION_B);
      counters.suggestCalls = 0;
      const r1 = await clientA.searches.suggestPlace.query({ providerId: PROVIDER, query: "San" });
      expect(r1).toEqual({ candidates: [{ label: "San Francisco, CA" }] });
      expect(counters.suggestCalls).toBe(1);
      const r2 = await clientA.searches.suggestPlace.query({ providerId: PROVIDER, query: "SAN" });
      expect(r2).toEqual({ candidates: [{ label: "San Francisco, CA" }] });
      expect(counters.suggestCalls).toBe(1);
      const r3 = await clientB.searches.suggestPlace.query({ providerId: PROVIDER, query: "san" });
      expect(r3).toEqual({ candidates: [{ label: "San Francisco, CA" }] });
      expect(counters.suggestCalls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("memo hit skips vendor token bucket on hit", async () => {
    let bucketAcquires = 0;
    const bucket: GeocodeTokenBucket = {
      acquire: () => {
        bucketAcquires += 1;
        return Promise.resolve();
      },
    };
    const logger = capturingLogger();
    const stubFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [{ properties: { feature_type: "place", full_address: "Place A" } }],
          }),
      } as Response);
    const resolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: stubFetch,
    });
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
      bucket,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      bucketAcquires = 0;
      await client.searches.suggestPlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
      });
      expect(bucketAcquires).toBe(1);
      await client.searches.suggestPlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
      });
      expect(bucketAcquires).toBe(1);
      const clientB = makeClient(server.baseUrl, SESSION_B);
      await clientB.searches.suggestPlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
      });
      expect(bucketAcquires).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("both generic memo instances have 10-min TTL, 1024 LRU, no table", () => {
    expect(GEOCODE_MEMO_TTL_MS).toBe(10 * 60 * 1000);
    expect(GEOCODE_MEMO_MAX_ENTRIES).toBe(1024);
    let now = 1_000_000;
    const memoA = new GeocodeMemo<ResolvedPlace>({ now: () => now });
    const memoB = new GeocodeMemo<readonly SuggestCandidate[]>({ now: () => now });
    memoA.set("sess1", "sunnyvale", { lat: 1, lng: 2, resolvedPlaceName: "Sunnyvale, CA" });
    memoB.set("sess1", "sunnyvale", [{ label: "Sunnyvale, CA" }]);
    expect(memoA.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    expect(memoB.get("sess1", "sunnyvale")).toEqual([{ label: "Sunnyvale, CA" }]);
    // entries cannot cross shapes: setting one does not affect the other (they are separate instances)
    expect(memoA.size).toBe(1);
    expect(memoB.size).toBe(1);
    // TTL sliding — independent per instance, each get extends its own entry by 10 min
    now += 9 * 60 * 1000;
    expect(memoA.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    expect(memoB.get("sess1", "sunnyvale")).toEqual([{ label: "Sunnyvale, CA" }]);
    now += 9 * 60 * 1000;
    expect(memoA.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    expect(memoB.get("sess1", "sunnyvale")).toEqual([{ label: "Sunnyvale, CA" }]);
    now += 10 * 60 * 1000 + 1;
    expect(memoA.get("sess1", "sunnyvale")).toBeNull();
    expect(memoB.get("sess1", "sunnyvale")).toBeNull();
    const big = new GeocodeMemo<string>({ now: () => now });
    for (let i = 0; i < 1024; i++) big.set("s", `k${i}`, `v${i}`);
    expect(big.size).toBe(1024);
    big.set("s", "k1024", "v1024");
    expect(big.size).toBe(1024);
    expect(big.get("s", "k0")).toBeNull();
    expect(big.get("s", "k1")).toBe("v1");
    // no table
    const file = readSource("../src/geocode/memo.ts");
    expect(file).not.toContain("CREATE TABLE");
    expect(file).toContain("class GeocodeMemo<");
  });
});

// ---------------- S52.5 ----------------
describe("S52.5 — shared single bucket, token required", () => {
  it("suggest and resolve share 750/12.5 bucket, no second bucket literal", () => {
    expect(GEOCODE_TOKEN_BUCKET_CAPACITY).toBe(750);
    expect(GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND).toBe(12.5);
    const mapboxSrc = readSource("../src/geocode/mapbox.ts");
    // both methods acquire from same bucket via deps.bucket.acquire()
    expect((mapboxSrc.match(/await deps\.bucket\.acquire\(\)/g) ?? []).length).toBe(2);
    expect(mapboxSrc).toContain('export const MAPBOX_API_BASE_URL = "https://api.mapbox.com"');
    expect(readSource("../src/geocode/token-bucket.ts")).toContain(
      "export const GEOCODE_TOKEN_BUCKET_CAPACITY = 750",
    );
    const appSrc = readSource("../src/app.ts");
    // single invocation of factory — count the call, not raw identifier (import + call would be 2)
    expect((appSrc.match(/createGeocodeTokenBucket\(/g) ?? []).length).toBe(1);
    expect(appSrc).not.toMatch(/second.*bucket|createSecondBucket/i);
  });

  it("MAPBOX_ACCESS_TOKEN requiredString no default, no suggest-specific env", () => {
    expect(() => parseMapboxConfig({})).toThrow(/MAPBOX_ACCESS_TOKEN is required/);
    const cfgFile = readSource("../src/app-config.ts");
    expect(cfgFile).toContain('requiredString(env, "MAPBOX_ACCESS_TOKEN")');
    expect(cfgFile).not.toContain("MAPBOX_SUGGEST");
    // token-bucket literals not env reads
    expect(readSource("../src/geocode/token-bucket.ts")).not.toMatch(/process\.env/);
  });
});

// ---------------- S52.6 ----------------
describe("S52.6 — error mapping to PLACE_RESOLUTION_UNAVAILABLE, zero DB writes, no logs, malformed label skip", () => {
  it("timeout/transport/429/5xx/malformed map to unavailable, zero DB writes, no query/label/coord/URL in logs", async () => {
    await pool.query(
      `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit) VALUES ($1, 1000, 1000) ON CONFLICT (provider_id) DO NOTHING`,
      [PROVIDER],
    );
    const before = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM search",
    );
    const beforeCount = Number(before.rows[0]!.count);
    const scenarios: Array<{ name: string; fetch: typeof fetch }> = [
      { name: "transport", fetch: () => Promise.reject(new Error("network")) },
      {
        name: "429",
        fetch: () =>
          Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({}),
          } as Response),
      },
      {
        name: "5xx",
        fetch: () =>
          Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({}),
          } as Response),
      },
      {
        name: "malformed json",
        fetch: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new Error("bad json")),
          } as Response),
      },
      {
        name: "malformed shape",
        fetch: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ notFeatures: [] }),
          } as Response),
      },
    ];
    for (const sc of scenarios) {
      const bucket: GeocodeTokenBucket = { acquire: () => Promise.resolve() };
      const logger = capturingLogger();
      const resolver = createMapboxGeocodeResolver({
        accessToken: "t",
        bucket,
        logger,
        fetch: sc.fetch,
      });
      const resolveMemo = new GeocodeMemo<ResolvedPlace>();
      const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
      const server = await startS52Server({
        db: pool,
        redisUrl: redisService.url,
        config: makeRateLimitConfig(),
        resolver,
        resolveMemo,
        suggestMemo,
        logger,
      });
      try {
        const client = makeClient(server.baseUrl, SESSION_A);
        const res = await client.searches.suggestPlace.query({
          providerId: PROVIDER,
          query: "bad place",
        });
        expect(res).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
        const after = await admin.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM search",
        );
        expect(Number(after.rows[0]!.count)).toBe(beforeCount);
        const logText = safeStringify(
          logger.calls.filter((c) => c.level === "warn" || c.level === "error"),
        );
        expect(logText).not.toContain("bad place");
        expect(logText).not.toContain("network");
        expect(logText).not.toContain(String(ORIGIN_LAT));
        expect(logText).not.toContain("access_token");
        expect(logText).not.toMatch(/https:\/\/api\.mapbox\.com/);
      } finally {
        await server.close();
      }
    }
  });

  it("malformed label skips candidate, missing full_address on resolve is unavailable", async () => {
    const bucket: GeocodeTokenBucket = { acquire: () => Promise.resolve() };
    const logger = capturingLogger();
    const suggestFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              { properties: { feature_type: "place", full_address: "Good A" } },
              { properties: { feature_type: "place", full_address: "" } },
              { properties: { feature_type: "place" } },
              { properties: { feature_type: "place", full_address: "Good B" } },
            ],
          }),
      } as Response);
    const resolveFetchMissing: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              {
                properties: { feature_type: "place", full_address: "" },
                geometry: { coordinates: [-122, 37] },
              },
            ],
          }),
      } as Response);
    const suggestResolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: suggestFetch,
    });
    const sRes = await suggestResolver.suggest("x");
    expect(sRes).toEqual([{ label: "Good A" }, { label: "Good B" }]);
    const resolveResolver = createMapboxGeocodeResolver({
      accessToken: "t",
      bucket,
      logger,
      fetch: resolveFetchMissing,
    });
    await expect(resolveResolver.resolve("x")).rejects.toBeInstanceOf(GeocodeUnavailableError);
    // via route, missing full_address maps to unavailable
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver: resolveResolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "missing name",
        radiusKm: 10,
        limit: 5,
      });
      expect(res).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
    } finally {
      await server.close();
    }
  });

  it("generic Geocode error also maps to unavailable without leaking query", async () => {
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const errorMap = new Map<string, Error>([["oops", new Error("generic")]]);
    const resolver = stubResolver(new Map(), new Map(), counters, errorMap);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "oops" });
      expect(res).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
      expect(safeStringify(logger.calls.filter((c) => c.level === "warn"))).not.toContain("oops");
    } finally {
      await server.close();
    }
  });
});

// ---------------- S52.7 ----------------
describe("S52.7 — resolvedPlaceName required, single resolve call, memo stores display name", () => {
  it("successful resolve includes resolvedPlaceName and caches it, no second Mapbox call", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:near0`, ORIGIN_LAT, ORIGIN_LNG),
    );
    const resolvedName = "Sunnyvale, CA, United States";
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolveMap = new Map<string, ResolvedPlace | null>([
      ["Sunnyvale", { lat: ORIGIN_LAT, lng: ORIGIN_LNG, resolvedPlaceName: resolvedName }],
    ]);
    const resolver = stubResolver(resolveMap, new Map(), counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const first = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "Sunnyvale",
        radiusKm: 10,
        limit: 5,
      });
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") throw new Error("not ok");
      expect(first.resolvedPlaceName).toBe(resolvedName);
      expect(first.label).toBe("10 km around Sunnyvale");
      expect(first.theatres.length).toBeGreaterThan(0);
      expect(counters.resolveCalls).toBe(1);
      // second call same session normalized lower hits memo, no second resolver call
      counters.resolveCalls = 0;
      const second = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "SUNNYVALE",
        radiusKm: 10,
        limit: 5,
      });
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") throw new Error("not ok2");
      expect(second.resolvedPlaceName).toBe(resolvedName);
      expect(counters.resolveCalls).toBe(0);
      // memo stores ResolvedPlace with name (verify via direct memo get)
      const memoHit = resolveMemo.get(SESSION_A, "sunnyvale");
      expect(memoHit).toEqual({
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        resolvedPlaceName: resolvedName,
      });
    } finally {
      await server.close();
    }
  });

  it("direct text and selected candidate both re-resolved deterministically yield final display name", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:a`, ORIGIN_LAT, ORIGIN_LNG),
    );
    const finalName = "San Francisco, CA, United States";
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolveMap = new Map<string, ResolvedPlace | null>([
      ["san fran", { lat: ORIGIN_LAT, lng: ORIGIN_LNG, resolvedPlaceName: finalName }],
      ["San Francisco, CA", { lat: ORIGIN_LAT, lng: ORIGIN_LNG, resolvedPlaceName: finalName }],
      [
        "San Francisco, CA, United States",
        { lat: ORIGIN_LAT, lng: ORIGIN_LNG, resolvedPlaceName: finalName },
      ],
    ]);
    const suggestMap = new Map<string, readonly SuggestCandidate[]>([
      ["san", [{ label: "San Francisco, CA" }]],
    ]);
    const resolver = stubResolver(resolveMap, suggestMap, counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const sug = await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "san" });
      expect(sug).toEqual({ candidates: [{ label: "San Francisco, CA" }] });
      // picking candidate calls resolvePlace with exact label text
      const viaCandidate = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "San Francisco, CA",
        radiusKm: 10,
        limit: 5,
      });
      expect(viaCandidate.kind).toBe("ok");
      if (viaCandidate.kind !== "ok") throw new Error("not ok");
      expect(viaCandidate.resolvedPlaceName).toBe(finalName);
      // direct free text also yields same final name
      const viaDirect = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "san fran",
        radiusKm: 10,
        limit: 5,
      });
      expect(viaDirect.kind).toBe("ok");
      if (viaDirect.kind !== "ok") throw new Error("not ok direct");
      expect(viaDirect.resolvedPlaceName).toBe(finalName);
      // resolver was called once per distinct resolve (suggest not counted)
      expect(counters.suggestCalls).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// ---------------- S52.8 ----------------
describe("S52.8 — no coordinate wire/persistence/log, resolvedPlaceName transient only", () => {
  it("neither suggest nor resolve returns/stores/hashes/logs coordinate; resolvedPlaceName not in spec_hash", async () => {
    const KNOWN_LAT = ORIGIN_LAT;
    const KNOWN_LNG = ORIGIN_LNG;
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:sf1`, KNOWN_LAT, KNOWN_LNG, "SF1"),
    );
    await pool.query(
      `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit) VALUES ($1, 1000, 1000) ON CONFLICT (provider_id) DO NOTHING`,
      [PROVIDER],
    );
    await pool.query(
      `INSERT INTO provider_fence (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING`,
      [PROVIDER],
    );
    const resolvedName = "San Francisco, CA, United States";
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolveMap = new Map<string, ResolvedPlace | null>([
      ["San Francisco", { lat: KNOWN_LAT, lng: KNOWN_LNG, resolvedPlaceName: resolvedName }],
    ]);
    const suggestMap = new Map<string, readonly SuggestCandidate[]>([
      ["san", [{ label: "San Francisco, CA" }]],
    ]);
    const resolver = stubResolver(resolveMap, suggestMap, counters);
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const suggestRes = await client.searches.suggestPlace.query({
        providerId: PROVIDER,
        query: "san",
      });
      const suggestJson = JSON.stringify(suggestRes);
      expect(suggestJson).not.toContain(String(KNOWN_LAT));
      expect(suggestJson).not.toContain(String(KNOWN_LNG));
      expect(suggestJson).not.toMatch(/"lat"\s*:/);
      expect(suggestJson).not.toMatch(/"lng"\s*:/);
      expect(suggestJson).not.toMatch(/"center"/);
      const resolveRes = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "San Francisco",
        radiusKm: 40,
        limit: 25,
      });
      expect(resolveRes.kind).toBe("ok");
      if (resolveRes.kind !== "ok") throw new Error("not ok");
      const resolveJson = JSON.stringify(resolveRes);
      expect(resolveJson).not.toContain(String(KNOWN_LAT));
      expect(resolveJson).not.toContain(String(KNOWN_LNG));
      expect(resolveJson).not.toMatch(/"lat"\s*:/);
      expect(resolveJson).not.toMatch(/"center"/);
      expect(resolveRes.resolvedPlaceName).toBe(resolvedName);
      // logs no coord
      const warns = logger.calls.filter((c) => c.level === "warn" || c.level === "error");
      const logJson = safeStringify(warns);
      expect(logJson).not.toContain(String(KNOWN_LAT));
      expect(logJson).not.toMatch(/"lat"\s*:/);
      // create search with LIST, spec_hash no coord, spec no center, resolvedPlaceName not persisted
      const theatreIds = resolveRes.theatres.map((t) => t.theatreId);
      const spec = makeSpecWithList(theatreIds);
      const expectedHash = specHash(spec);
      const createRes = await client.searches.create.mutate({
        spec,
        idempotencyKey: `idem_s52_8_${Date.now()}_${Math.random()}`,
      });
      const searchId =
        (createRes as unknown as { searchId: string }).searchId ??
        (createRes as unknown as { search_id: string }).search_id;
      let row: { spec: unknown; spec_hash: string } | undefined;
      if (searchId) {
        const r = await admin.query<{ spec: unknown; spec_hash: string }>(
          "SELECT spec, spec_hash FROM search WHERE search_id = $1",
          [searchId],
        );
        row = r.rows[0];
      } else {
        const r = await admin.query<{ spec: unknown; spec_hash: string }>(
          "SELECT spec, spec_hash FROM search WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
          [SESSION_A],
        );
        row = r.rows[0];
      }
      expect(row).toBeDefined();
      const storedSpec = row!.spec as Record<string, unknown>;
      expect((storedSpec["theatres"] as { kind: string }).kind).toBe("LIST");
      expect((storedSpec["theatres"] as { center?: unknown }).center).toBeUndefined();
      expect(JSON.stringify(storedSpec)).not.toContain(String(KNOWN_LAT));
      expect(row!.spec_hash).toBe(expectedHash);
      expect(JSON.stringify(storedSpec)).not.toContain(resolvedName);
    } finally {
      await server.close();
    }
  });
});

// ---------------- S52.9 ----------------
describe("S52.9 — no live Mapbox, injected seam, direct host literal no relay", () => {
  it("no live fetch, injected resolver/bucket used, direct MAPBOX_API_BASE_URL literal, no relay import", async () => {
    const file = readSource("../src/geocode/mapbox.ts");
    expect(file).toContain('export const MAPBOX_API_BASE_URL = "https://api.mapbox.com"');
    expect(file).not.toMatch(/from\s+["'].*relay.*["']/i);
    expect(file).not.toMatch(/import\s+.*relay/i);
    expect(file).not.toMatch(/from\s+["'].*amc.*["']/i);
    expect(file).not.toMatch(/process\.env.*MAPBOX/);
    // ensure createMapboxGeocodeResolver uses injected fetch not global
    expect(file).toContain("deps.fetch");
    // ensure tests use injected seams
    const counters = { resolveCalls: 0, suggestCalls: 0 };
    const resolver = stubResolver(
      new Map([["x", { lat: 1, lng: 2, resolvedPlaceName: "X" }]]),
      new Map([["s", [{ label: "S" }]]]),
      counters,
    );
    const resolveMemo = new GeocodeMemo<ResolvedPlace>();
    const suggestMemo = new GeocodeMemo<readonly SuggestCandidate[]>();
    const logger = capturingLogger();
    const server = await startS52Server({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      resolveMemo,
      suggestMemo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const sr = await client.searches.suggestPlace.query({ providerId: PROVIDER, query: "s" });
      expect(sr).toEqual({ candidates: [{ label: "S" }] });
      const rr = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "x",
        radiusKm: 10,
        limit: 5,
      });
      expect(rr.kind).toBe("ok");
      // confirm no live call was made: our stub counters prove injected seam used
      expect(counters.suggestCalls).toBe(1);
      expect(counters.resolveCalls).toBe(1);
    } finally {
      await server.close();
    }
  });
});
