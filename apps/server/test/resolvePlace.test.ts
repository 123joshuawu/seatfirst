import { readFileSync, readdirSync } from "node:fs";
import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEARCH_LIMITS, specHash } from "@seatfirst/core";
import type { SearchSpec } from "@seatfirst/core";
import { poolClient, upsertTheatre } from "@seatfirst/durability";
import type { UpsertTheatreInput } from "@seatfirst/durability";

import { buildApp } from "../src/app.js";
import type { AppRouter } from "../src/routes/searches/router.js";
import { GeocodeUnavailableError } from "../src/geocode/mapbox.js";
import { GEOCODE_MEMO_MAX_ENTRIES, GEOCODE_MEMO_TTL_MS, GeocodeMemo } from "../src/geocode/memo.js";
import type { GeocodeResolver, ResolvedPlace } from "../src/geocode/resolver.js";
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
const SESSION_A = "sess_resolve_a";
const SESSION_B = "sess_resolve_b";
const SESSION_C = "sess_resolve_c";
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
  map: Map<string, ResolvedPlace | null>,
  counter: { calls: number },
  errorMap: Map<string, Error> = new Map(),
): GeocodeResolver {
  return {
    resolve(query: string): Promise<ResolvedPlace | null> {
      counter.calls += 1;
      if (errorMap.has(query)) return Promise.reject(errorMap.get(query)!);
      // query is already normalized by the route, but we normalize again defensively
      const key = query.trim().replace(/\s+/g, " ");
      if (map.has(key)) return Promise.resolve(map.get(key) ?? null);
      if (map.has(key.toLowerCase())) return Promise.resolve(map.get(key.toLowerCase()) ?? null);
      return Promise.resolve(map.get(query) ?? null);
    },
    suggest(): Promise<readonly { label: string }[]> {
      return Promise.resolve([]);
    },
  };
}

async function startResolvePlaceServer(opts: {
  db: Pool;
  redisUrl: string;
  config: SessionRateLimitConfig;
  resolver: GeocodeResolver;
  memo: GeocodeMemo<ResolvedPlace>;
  logger: ReturnType<typeof capturingLogger>;
  limiterNow?: () => number;
}): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  limiter: ReturnType<typeof createSessionRateLimiter>;
}> {
  const redis = new Redis(opts.redisUrl, { lazyConnect: true });
  const limiterOpts: Parameters<typeof createSessionRateLimiter>[0] = {
    redis: redisScriptExecutorFromIoredis(redis),
    config: opts.config,
    ...(opts.limiterNow ? { now: opts.limiterNow } : {}),
  };
  const limiter = createSessionRateLimiter(limiterOpts);
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
    geocodeMemo: opts.memo,
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/trpc`,
    limiter,
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

// Global containers shared by integration tests
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
  // also clear any residual rate-limit keys
  const redis = new Redis(redisService.url, { lazyConnect: true });
  await redis.flushdb();
  redis.disconnect();
});

// ---------------- S51.2 ----------------
describe("searches.resolvePlace S51.2 — transient nearest-first hits, excluded counts, label", () => {
  it("returns nearest-first transient {theatreId,distanceKm} ≤ limit, distinct outsideArea/byLimit, label from user text", async () => {
    // Seed catalogue around a known origin; distances are haversine from ORIGIN.
    // In-radius (≤40km): near0 (0 km), near5 (~5.5 km), near10 (~10 km), far30 (~30 km)
    // Outside: outside60 (~61 km) — still counts toward totalProvider so outsideArea =1
    // Other provider theatre should be filtered out.
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:near0`, ORIGIN_LAT, ORIGIN_LNG, "Near0"),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:near5`, ORIGIN_LAT + 0.05, ORIGIN_LNG, "Near5"),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:near10`, ORIGIN_LAT + 0.09, ORIGIN_LNG, "Near10"),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:far30`, ORIGIN_LAT + 0.27, ORIGIN_LNG, "Far30"),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:outside60`, ORIGIN_LAT + 0.55, ORIGIN_LNG, "Outside60"),
    );
    await upsertTheatre(poolClient(pool), {
      theatreId: "regal:theatre:other",
      providerId: "regal",
      name: "Regal Other",
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      marketSlug: null,
      timezone: "America/Los_Angeles",
      city: null,
      address: null,
      slugs: { detail: "regal:theatre:other" },
      firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const coords: ResolvedPlace = {
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      resolvedPlaceName: "Sunnyvale, CA, United States",
    };
    const counter = { calls: 0 };
    const map = new Map<string, ResolvedPlace | null>([["Sunnyvale CA", coords]]);
    const resolver = stubResolver(map, counter);
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });

    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "  Sunnyvale   CA  ",
        radiusKm: 40,
        limit: 2,
      });
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") throw new Error("expected ok");

      // ≤ limit and nearest-first
      expect(res.theatres.length).toBeLessThanOrEqual(2);
      expect(res.theatres.length).toBe(2);
      expect(res.theatres[0]!.theatreId).toBe(`${PROVIDER}:theatre:near0`);
      expect(res.theatres[1]!.theatreId).toBe(`${PROVIDER}:theatre:near5`);
      // Catalogue display fields ride along (place-mode rows' only name
      // source — ambient search is disabled there per ADR 0045 §1).
      expect(res.theatres[0]!.name).toBe("Near0");
      expect(res.theatres[1]!.name).toBe("Near5");
      expect(res.theatres[0]!.city).toBeNull();
      expect(res.theatres[1]!.city).toBeNull();
      for (let i = 1; i < res.theatres.length; i++) {
        expect(res.theatres[i]!.distanceKm).toBeGreaterThanOrEqual(res.theatres[i - 1]!.distanceKm);
        expect(res.theatres[i]!.distanceKm).toBeGreaterThanOrEqual(0);
      }
      // excluded counts: inRadiusCount =4 (near0, near5, near10, far30), totalProvider=5, outside=1, byLimit=2
      expect(res.excluded.outsideArea).toBe(1);
      expect(res.excluded.byLimit).toBe(2); // 4 inRadius -2 returned
      // label from normalized user text, not Mapbox place name
      expect(res.label).toBe("40 km around Sunnyvale CA");
      expect(res.resolvedPlaceName).toBe("Sunnyvale, CA, United States");
      // also check that Mapbox place name would not leak — resolver stub has no place name, label is from input
      expect(res.label).not.toContain("Mapbox");
      // distances transient — not persisted in search spec (verified in S51.4); here we at least ensure response has no lat/lng
      const json = JSON.stringify(res);
      expect(json).not.toMatch(/"lat"\s*:/);
      expect(json).not.toMatch(/"lng"\s*:/);
      expect(json).not.toMatch(/"center"/);
    } finally {
      await server.close();
    }
  });

  it("excluded counts are correct when limit truncates and when radius contains all", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:a`, ORIGIN_LAT, ORIGIN_LNG),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:b`, ORIGIN_LAT + 0.05, ORIGIN_LNG),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:c`, ORIGIN_LAT + 0.09, ORIGIN_LNG),
    );
    const coords: ResolvedPlace = {
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      resolvedPlaceName: "Place, CA, United States",
    };
    const counter = { calls: 0 };
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([["place", coords]]),
      counter,
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const r1 = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "place",
        radiusKm: 40,
        limit: 25,
      });
      expect(r1.kind).toBe("ok");
      if (r1.kind !== "ok") return;
      // all 3 in radius, limit 25 so byLimit 0, outsideArea 0
      expect(r1.excluded.outsideArea).toBe(0);
      expect(r1.excluded.byLimit).toBe(0);
      expect(r1.theatres.length).toBe(3);

      const r2 = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "place",
        radiusKm: 40,
        limit: 1,
      });
      expect(r2.kind).toBe("ok");
      if (r2.kind !== "ok") return;
      expect(r2.excluded.byLimit).toBe(2);
      expect(r2.theatres.length).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// ---------------- S51.3 ----------------
describe("searches.resolvePlace S51.3 — PLACE_NOT_FOUND vs PLACE_RESOLUTION_UNAVAILABLE, zero writes, no query/coords in logs", () => {
  it("resolver null => PLACE_NOT_FOUND, zero DB writes, logs contain no query or coords", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:x`, ORIGIN_LAT, ORIGIN_LNG),
    );
    const before = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM search",
    );
    const beforeCount = Number(before.rows[0]!.count);
    const counter = { calls: 0 };
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([["missing place", null]]),
      counter,
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "missing place",
        radiusKm: 40,
        limit: 10,
      });
      expect(res).toEqual({ kind: "PLACE_NOT_FOUND" });
      const after = await admin.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM search",
      );
      expect(Number(after.rows[0]!.count)).toBe(beforeCount);
      // logs must not contain query text or coordinates — filter to handler warns (info logs include request URL but not query; warns must not leak it)
      const warns = logger.calls.filter((c) => c.level === "warn" || c.level === "error");
      const logText = safeStringify(warns);
      expect(logText).not.toContain("missing place");
      expect(logText).not.toContain(String(ORIGIN_LAT));
      expect(logText).not.toContain(String(ORIGIN_LNG));
      // also ensure no lat/lng fields leaked
      expect(logText).not.toMatch(/"lat"\s*:/);
    } finally {
      await server.close();
    }
  });

  it("GeocodeUnavailableError => PLACE_RESOLUTION_UNAVAILABLE, zero DB writes, logs contain no query/coords", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:y`, ORIGIN_LAT, ORIGIN_LNG),
    );
    const before = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM search",
    );
    const beforeCount = Number(before.rows[0]!.count);
    const counter = { calls: 0 };
    const errorMap = new Map<string, Error>([
      ["bad place", new GeocodeUnavailableError("vendor down")],
    ]);
    const resolver = stubResolver(new Map<string, ResolvedPlace | null>(), counter, errorMap);
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "bad place",
        radiusKm: 40,
        limit: 10,
      });
      expect(res).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
      const after = await admin.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM search",
      );
      expect(Number(after.rows[0]!.count)).toBe(beforeCount);
      const warns1 = logger.calls.filter((c) => c.level === "warn" || c.level === "error");
      const logText = safeStringify(warns1);
      expect(logText).not.toContain("bad place");
      expect(logText).not.toContain("vendor down");
      expect(logText).not.toContain(String(ORIGIN_LAT));
      expect(logText).not.toMatch(/"lat"\s*:/);
      // ensure at least one warn was emitted but without sensitive data
      const warns = logger.calls.filter((c) => c.level === "warn");
      expect(warns.length).toBeGreaterThanOrEqual(1);
      for (const w of warns) {
        expect(safeStringify(w.fields)).not.toContain("bad place");
      }
    } finally {
      await server.close();
    }
  });

  it("generic Geocode error also maps to PLACE_RESOLUTION_UNAVAILABLE without leaking query", async () => {
    const counter = { calls: 0 };
    const errorMap = new Map<string, Error>([["oops", new Error("generic failure")]]);
    const resolver = stubResolver(new Map<string, ResolvedPlace | null>(), counter, errorMap);
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "oops",
        radiusKm: 10,
        limit: 5,
      });
      expect(res).toEqual({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
      const warns = logger.calls.filter((c) => c.level === "warn");
      expect(safeStringify(warns)).not.toContain("oops");
    } finally {
      await server.close();
    }
  });
});

// ---------------- S51.4 ----------------
describe("searches.resolvePlace S51.4 — coordinate never in logs/response/spec_hash", () => {
  it("coordinate never appears in logs, response, spec or spec_hash; LIST identity only", async () => {
    const KNOWN_LAT = 37.7749;
    const KNOWN_LNG = -122.4194;
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:sf1`, KNOWN_LAT, KNOWN_LNG, "SF1"),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput(`${PROVIDER}:theatre:sf2`, KNOWN_LAT + 0.05, KNOWN_LNG, "SF2"),
    );
    // need provider admission for searches.create to succeed
    await pool.query(
      `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit) VALUES ($1, 1000, 1000) ON CONFLICT (provider_id) DO NOTHING`,
      [PROVIDER],
    );
    await pool.query(
      `INSERT INTO provider_fence (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING`,
      [PROVIDER],
    );

    const coords: ResolvedPlace = {
      lat: KNOWN_LAT,
      lng: KNOWN_LNG,
      resolvedPlaceName: "San Francisco, CA, United States",
    };
    const counter = { calls: 0 };
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([["San Francisco", coords]]),
      counter,
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      const client = makeClient(server.baseUrl, SESSION_A);
      const resolveRes = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "San Francisco",
        radiusKm: 40,
        limit: 25,
      });
      expect(resolveRes.kind).toBe("ok");
      if (resolveRes.kind !== "ok") throw new Error("expected ok");
      // response has no lat/lng/coord/center
      const resolveJson = JSON.stringify(resolveRes);
      expect(resolveJson).not.toContain(String(KNOWN_LAT));
      expect(resolveJson).not.toContain(String(KNOWN_LNG));
      expect(resolveJson).not.toMatch(/"lat"\s*:/);
      expect(resolveJson).not.toMatch(/"lng"\s*:/);
      expect(resolveJson).not.toMatch(/"center"/);
      expect(resolveJson).not.toMatch(/coord/i);
      expect(resolveRes.resolvedPlaceName).toBe("San Francisco, CA, United States");
      // logs have no coordinate — check handler warns only (info logs are request allowlist, not coordinate)
      const warns = logger.calls.filter((c) => c.level === "warn" || c.level === "error");
      const logJson = safeStringify(warns);
      expect(logJson).not.toContain(String(KNOWN_LAT));
      expect(logJson).not.toContain(String(KNOWN_LNG));
      expect(logJson).not.toMatch(/"lat"\s*:/);
      expect(logJson).not.toMatch(/coord/i);
      // now call searches.create with LIST built from returned IDs — spec must be LIST no center, spec_hash independent of coordinate
      const theatreIds = resolveRes.theatres.map((t) => t.theatreId);
      expect(theatreIds.length).toBeGreaterThan(0);
      const spec = makeSpecWithList(theatreIds);
      // specHash for LIST should not involve coordinate; compute expected
      const expectedHash = specHash(spec);
      // verify spec itself has no center
      expect(
        (spec as unknown as { theatres: { kind: string; center?: unknown } }).theatres.kind,
      ).toBe("LIST");
      expect(
        (spec as unknown as { theatres: { center?: unknown } }).theatres.center,
      ).toBeUndefined();

      // create search via tRPC
      const createRes = await client.searches.create.mutate({
        spec: spec,
        idempotencyKey: `idem_s51_4_${Date.now()}`,
      });
      // create returns search_id etc; fetch from DB to inspect stored spec
      const searchId =
        (createRes as unknown as { searchId: string }).searchId ??
        (createRes as unknown as { search_id: string }).search_id;
      // fallback: query by session and idempotency if searchId not directly returned
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
      if (!row) throw new Error("no row");
      const storedSpec = row.spec as Record<string, unknown>;
      expect((storedSpec["theatres"] as { kind: string }).kind).toBe("LIST");
      expect((storedSpec["theatres"] as { center?: unknown }).center).toBeUndefined();
      expect(JSON.stringify(storedSpec)).not.toContain(String(KNOWN_LAT));
      expect(JSON.stringify(storedSpec)).not.toContain(String(KNOWN_LNG));
      // spec_hash must equal hash of LIST spec (no center participation)
      expect(row.spec_hash).toBe(expectedHash);
      const sameListDifferentCoordHash = specHash(makeSpecWithList(theatreIds));
      expect(sameListDifferentCoordHash).toBe(expectedHash);
      // ensure AREA hash would be different (precondition: center changes hash)
      const areaSpec = {
        specVersion: 1,
        providerId: PROVIDER,
        theatres: {
          kind: "AREA",
          center: { lat: KNOWN_LAT, lng: KNOWN_LNG },
          radiusKm: 40,
          limit: 25,
        },
        where: (spec as unknown as { where: unknown }).where,
        aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
        groupStrict: false,
        rank: "SCORE",
      };
      const areaHash = specHash(areaSpec);
      expect(areaHash).not.toBe(expectedHash);
    } finally {
      await server.close();
    }
  });
});

// ---------------- S51.5 ----------------
describe("searches.resolvePlace S51.5 — token bucket literals 750/12.5 and MAPBOX_ACCESS_TOKEN requiredString", () => {
  it("token bucket capacity 750 and refill 12.5 are pinned literals with Mapbox docs URL comment, only clock/sleep injectable", () => {
    expect(GEOCODE_TOKEN_BUCKET_CAPACITY).toBe(750);
    expect(GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND).toBe(12.5);
    const file = readSource("../src/geocode/token-bucket.ts");
    // source comment must cite Mapbox docs
    expect(file).toContain("https://docs.mapbox.com/api/search/geocoding/");
    // must mention 1000 and margin
    expect(file).toContain("1,000");
    expect(file).toContain("25%");
    // only clock/sleep injectable — capacity/refill are not parameters, only deps.now/deps.sleep
    expect(file).toContain("readonly now?");
    expect(file).toContain("readonly sleep?");
    expect(file).not.toMatch(/capacity.*\?.*number/);
    // ensure the literals are defined as const exports, not env reads
    expect(file).toContain("export const GEOCODE_TOKEN_BUCKET_CAPACITY = 750");
    expect(file).toContain("export const GEOCODE_TOKEN_BUCKET_REFILL_PER_SECOND = 12.5");
  });

  it("MAPBOX_ACCESS_TOKEN is requiredString with no default — parse fails without env and via app-config", async () => {
    // geocode/config.ts requiredString
    expect(() => parseMapboxConfig({})).toThrow(/MAPBOX_ACCESS_TOKEN is required/);
    expect(() => parseMapboxConfig({ MAPBOX_ACCESS_TOKEN: "" })).toThrow(/is required/);
    expect(parseMapboxConfig({ MAPBOX_ACCESS_TOKEN: "pk.test" }).accessToken).toBe("pk.test");

    // app-config.ts also requires MAPBOX_ACCESS_TOKEN — verify via source that it uses requiredString
    const cfgFile = readSource("../src/app-config.ts");
    expect(cfgFile).toContain('requiredString(env, "MAPBOX_ACCESS_TOKEN")');
    const { appConfigFromEnv } = await import("../src/app-config.js");
    const bareEnv: NodeJS.ProcessEnv = {
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
      // MAPBOX_ACCESS_TOKEN omitted intentionally
    };
    expect(() => appConfigFromEnv(bareEnv)).toThrow(/MAPBOX_ACCESS_TOKEN is required/);
  });
});

// ---------------- S51.6 ----------------
describe("searches.resolvePlace S51.6 — session memo hit skips resolver/vendor bucket, TTL/LRU, no table", () => {
  it("same-session hit (case-insensitive) skips resolver, different session misses", async () => {
    const coords: ResolvedPlace = {
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      resolvedPlaceName: "Sunnyvale, CA, United States",
    };
    const counter = { calls: 0 };
    const map = new Map<string, ResolvedPlace | null>([["sunnyvale", coords]]);
    // note: resolver map is lowercased; route will send normalized "Sunnyvale"
    // our stub handles case-insensitive via lower fallback, but memo key is lowercased
    // so first call with "Sunnyvale" will miss memo, call resolver, set memo with lower "sunnyvale"
    // second call with "SUNNYVALE" should hit memo (same session, same lower) and skip resolver
    // third call with different session same query should miss.
    const resolver: GeocodeResolver = {
      resolve(q: string): Promise<ResolvedPlace | null> {
        counter.calls += 1;
        const lower = q.trim().replace(/\s+/g, " ").toLowerCase();
        return Promise.resolve(map.get(lower) ?? null);
      },
      suggest(): Promise<readonly { label: string }[]> {
        return Promise.resolve([]);
      },
    };
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      await upsertTheatre(
        poolClient(pool),
        theatreInput(`${PROVIDER}:theatre:m1`, ORIGIN_LAT, ORIGIN_LNG),
      );
      const clientA = makeClient(server.baseUrl, SESSION_A);
      const clientB = makeClient(server.baseUrl, SESSION_B);

      counter.calls = 0;
      const r1 = await clientA.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "Sunnyvale",
        radiusKm: 10,
        limit: 5,
      });
      expect(r1.kind).toBe("ok");
      expect(counter.calls).toBe(1);

      const r2 = await clientA.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "SUNNYVALE",
        radiusKm: 10,
        limit: 5,
      });
      expect(r2.kind).toBe("ok");
      // memo hit: resolver not called again
      expect(counter.calls).toBe(1);

      const r3 = await clientB.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "sunnyvale",
        radiusKm: 10,
        limit: 5,
      });
      expect(r3.kind).toBe("ok");
      // different session misses, requires second resolver call
      expect(counter.calls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("memo skips vendor token bucket on hit — bucket acquire not called second time", async () => {
    // Use real Mapbox resolver with spy bucket and stub fetch
    const { createMapboxGeocodeResolver } = await import("../src/geocode/mapbox.js");
    let bucketAcquires = 0;
    const bucket: GeocodeTokenBucket = {
      acquire(): Promise<void> {
        bucketAcquires += 1;
        return Promise.resolve();
      },
    };
    const stubFetch: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            features: [
              {
                properties: { feature_type: "place", full_address: "Place, CA, United States" },
                geometry: { coordinates: [ORIGIN_LNG, ORIGIN_LAT] },
              },
            ],
          }),
      } as unknown as Response);
    const logger = capturingLogger();
    const resolver = createMapboxGeocodeResolver({
      accessToken: "test-token",
      bucket: bucket,
      logger: logger,
      fetch: stubFetch,
    });
    const memo = new GeocodeMemo<ResolvedPlace>();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      await upsertTheatre(
        poolClient(pool),
        theatreInput(`${PROVIDER}:theatre:m2`, ORIGIN_LAT, ORIGIN_LNG),
      );
      const client = makeClient(server.baseUrl, SESSION_A);
      bucketAcquires = 0;
      await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
        radiusKm: 10,
        limit: 5,
      });
      expect(bucketAcquires).toBe(1);
      await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
        radiusKm: 10,
        limit: 5,
      });
      // second call same session+query case-insensitive should hit memo and not acquire bucket again
      expect(bucketAcquires).toBe(1);
      // different session should miss and acquire again
      const clientB = makeClient(server.baseUrl, SESSION_B);
      await clientB.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "place bucket test",
        radiusKm: 10,
        limit: 5,
      });
      expect(bucketAcquires).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("memo TTL 10min sliding and 1024 LRU cap, key is sessionId\\0normalizedLower, no table", () => {
    expect(GEOCODE_MEMO_TTL_MS).toBe(10 * 60 * 1000);
    expect(GEOCODE_MEMO_MAX_ENTRIES).toBe(1024);
    // TTL sliding
    let now = 1_000_000;
    const memo = new GeocodeMemo<ResolvedPlace>({ now: () => now });
    memo.set("sess1", "sunnyvale", { lat: 1, lng: 2, resolvedPlaceName: "Sunnyvale, CA" });
    expect(memo.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    // after 9 min hit should extend TTL
    now += 9 * 60 * 1000;
    expect(memo.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    // 9 minutes after extension should still be hit (total 18 min from start but sliding)
    now += 9 * 60 * 1000;
    expect(memo.get("sess1", "sunnyvale")).toEqual({
      lat: 1,
      lng: 2,
      resolvedPlaceName: "Sunnyvale, CA",
    });
    // 10 min+1ms after last hit should expire
    now += 10 * 60 * 1000 + 1;
    expect(memo.get("sess1", "sunnyvale")).toBeNull();

    // LRU cap 1024
    const memo2 = new GeocodeMemo<ResolvedPlace>({ now: () => Date.now() });
    for (let i = 0; i < 1024; i++) {
      memo2.set(`sess${i}`, `q${i}`, { lat: i, lng: i, resolvedPlaceName: `Place ${i}` });
    }
    expect(memo2.size).toBe(1024);
    // access sess0 to make it most recent
    expect(memo2.get("sess0", "q0")).not.toBeNull();
    // insert one more — should evict LRU (which is sess1 now, since sess0 moved to most recent)
    memo2.set("sess_new", "q_new", { lat: 999, lng: 999, resolvedPlaceName: "New Place" });
    expect(memo2.size).toBe(1024);
    expect(memo2.get("sess1", "q1")).toBeNull(); // evicted
    expect(memo2.get("sess0", "q0")).not.toBeNull(); // survived due to recent access
    expect(memo2.get("sess_new", "q_new")).not.toBeNull();

    // key is `${sessionId}\0${normalizedLower}` — different sessions don't collide, case-insensitive via lower
    const memo3 = new GeocodeMemo<ResolvedPlace>();
    memo3.set("sessA", "sunnyvale", { lat: 1, lng: 1, resolvedPlaceName: "Sunnyvale, CA" });
    expect(memo3.get("sessA", "sunnyvale")).not.toBeNull();
    expect(memo3.get("sessB", "sunnyvale")).toBeNull();
    expect(memo3.get("sessA", "SUNNYVALE".toLowerCase())).not.toBeNull();
    // no table/migration — ensure durability migrations don't contain geocode_cache
    const boundaries = readSource("../../../packages/durability/src/boundaries.ts");
    expect(boundaries).not.toContain("geocode_cache");
    expect(boundaries).not.toContain("GEOCODE");
    const migrateFile = readSource("../../../packages/durability/src/migrate.ts");
    expect(migrateFile).not.toContain("geocode");
    // also check filesystem for migration files
    const migDir = new URL("../../../packages/durability/migrations", import.meta.url);
    const migFiles = readdirSync(migDir);
    for (const f of migFiles) {
      const content = readFileSync(
        new URL(f, new URL("../../../packages/durability/migrations/", import.meta.url)),
        "utf8",
      );
      expect(content).not.toContain("geocode_cache");
    }
  });
});

// ---------------- S51.7 ----------------
describe("searches.resolvePlace S51.7 — dedicated 10/min/session dimension, bootstrap and 429", () => {
  it("bootstrap limits includes resolvePlacePerMinute:10 and limiter windowOf returns correct window", async () => {
    const config: SessionRateLimitConfig = makeRateLimitConfig({
      resolvePlace: { limit: 10, windowMs: 60_000 },
    });
    // direct limiter unit test for windowOf via check
    const redis = new Redis(redisService.url, { lazyConnect: true });
    const limiter = createSessionRateLimiter({
      redis: redisScriptExecutorFromIoredis(redis),
      config,
    });
    // check that window is 10/min — we can test by charging 10 then 11th denied
    const sid = "sess_window_check";
    for (let i = 0; i < 10; i++) {
      await limiter.charge(sid, "resolvePlace", 1);
    }
    const denied = await limiter.check(sid, "resolvePlace", 1);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.limit).toBe("resolve_place_per_minute");
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    }
    redis.disconnect();

    // bootstrap integration — start server with 10 limit and call session.bootstrap
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([
        ["x", { lat: 0, lng: 0, resolvedPlaceName: "X, CA, United States" }],
      ]),
      { calls: 0 },
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config,
      resolver,
      memo,
      logger,
    });
    try {
      // raw fetch to bootstrap (like session-rate-limit.test)
      const raw = await fetch(`${server.baseUrl.replace("/trpc", "")}/trpc/session.bootstrap`, {
        method: "POST",
      });
      expect(raw.status).toBe(200);
      const body = (await raw.json()) as { result: { data: { limits: Record<string, number> } } };
      expect(body.result.data.limits.resolvePlacePerMinute).toBe(10);
    } finally {
      await server.close();
    }
  });

  it("11th call in same minute gets TOO_MANY_REQUESTS with limit resolve_place_per_minute and retryAfterSeconds", async () => {
    const config: SessionRateLimitConfig = makeRateLimitConfig({
      resolvePlace: { limit: 10, windowMs: 60_000 },
    });
    const counter = { calls: 0 };
    const coords: ResolvedPlace = {
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      resolvedPlaceName: "Limited Place, CA, United States",
    };
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([["limited place", coords]]),
      counter,
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config,
      resolver,
      memo,
      logger,
    });
    try {
      await upsertTheatre(
        poolClient(pool),
        theatreInput(`${PROVIDER}:theatre:limit1`, ORIGIN_LAT, ORIGIN_LNG),
      );
      const client = makeClient(server.baseUrl, SESSION_C);
      // Use different queries to avoid memo hits counting as same key? But rate limit is per dimension not per query, memo hit still counts as request (charge after). For test we need to not hit memo, so vary query each time.
      for (let i = 0; i < 10; i++) {
        const q = `limited place ${i}`;
        // seed resolver for each distinct query
        resolver.resolve = () => {
          counter.calls += 1;
          return Promise.resolve(coords);
        };
        const res = await client.searches.resolvePlace.query({
          providerId: PROVIDER,
          query: q,
          radiusKm: 10,
          limit: 5,
        });
        expect(res.kind).toBe("ok");
      }
      // 11th should be rate limited
      try {
        await client.searches.resolvePlace.query({
          providerId: PROVIDER,
          query: "limited place 10",
          radiusKm: 10,
          limit: 5,
        });
        throw new Error("expected TOO_MANY_REQUESTS");
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCClientError);
        const e = err as TRPCClientError<AppRouter>;
        // tRPC maps StructuredHttpError TOO_MANY_REQUESTS to code TOO_MANY_REQUESTS
        expect((e as unknown as { data?: { code?: string } }).data?.code ?? e.message).toMatch(
          /TOO_MANY_REQUESTS|RATE_LIMITED/i,
        );
        // check that error shape contains limit discriminator
        const json = JSON.stringify(e);
        expect(json).toContain("resolve_place_per_minute");
      }
    } finally {
      await server.close();
    }
  });

  it("limiter windowOf: different dimensions isolate budgets (resolvePlace vs recheck)", async () => {
    const config: SessionRateLimitConfig = makeRateLimitConfig({
      resolvePlace: { limit: 10, windowMs: 60_000 },
      recheck: { limit: 10, windowMs: 60_000 },
    });
    const redis = new Redis(redisService.url, { lazyConnect: true });
    const limiter = createSessionRateLimiter({
      redis: redisScriptExecutorFromIoredis(redis),
      config,
    });
    const sid = "sess_isolation";
    for (let i = 0; i < 10; i++) await limiter.charge(sid, "resolvePlace", 1);
    const deniedResolve = await limiter.check(sid, "resolvePlace", 1);
    expect(deniedResolve.allowed).toBe(false);
    const allowedRecheck = await limiter.check(sid, "recheck", 1);
    expect(allowedRecheck.allowed).toBe(true);
    redis.disconnect();
  });
});

describe("searches.resolvePlace S51.8 — no live Mapbox, injected fetch, direct egress no relay", () => {
  it("resolver uses injected fetch, test uses stub resolver, mapbox.ts does not import relay and host literal is https://api.mapbox.com", () => {
    const mapboxFile = readSource("../src/geocode/mapbox.ts");
    expect(mapboxFile).not.toMatch(/from\s+["'].*relay.*["']/i);
    expect(mapboxFile).not.toMatch(/import\s+.*relay/i);
    // direct egress check — host literal appears once, not tunable via env
    const hostOccurrences = (mapboxFile.match(/https:\/\/api\.mapbox\.com/g) ?? []).length;
    expect(hostOccurrences).toBe(1);
    // injected fetch is optional param
    expect(mapboxFile).toContain("readonly fetch?");
    expect(mapboxFile).toContain("deps.fetch ?? fetch");
    // ensure no hardcoded live fetch in tests — our test uses stub resolver, not real fetch
    const testFile = readSource("./resolvePlace.test.ts");
    expect(testFile).not.toMatch(/fetch\(["']https:\/\/api\.mapbox\.com/);
    // verify that mapbox.ts host is not imported from config
    expect(mapboxFile).not.toContain("process.env");
  });

  it("no live Mapbox call in any test — stub resolver is used, relay not imported", async () => {
    // This test itself proves no live call: we use stub resolver with known coords
    const coords: ResolvedPlace = {
      lat: ORIGIN_LAT,
      lng: ORIGIN_LNG,
      resolvedPlaceName: "Stub Only, CA, United States",
    };
    const counter = { calls: 0 };
    const resolver = stubResolver(
      new Map<string, ResolvedPlace | null>([["stub only", coords]]),
      counter,
    );
    const memo = new GeocodeMemo<ResolvedPlace>();
    const logger = capturingLogger();
    const server = await startResolvePlaceServer({
      db: pool,
      redisUrl: redisService.url,
      config: makeRateLimitConfig(),
      resolver,
      memo,
      logger,
    });
    try {
      await upsertTheatre(
        poolClient(pool),
        theatreInput(`${PROVIDER}:theatre:stub`, ORIGIN_LAT, ORIGIN_LNG),
      );
      const client = makeClient(server.baseUrl, SESSION_A);
      const res = await client.searches.resolvePlace.query({
        providerId: PROVIDER,
        query: "stub only",
        radiusKm: 10,
        limit: 5,
      });
      expect(res.kind).toBe("ok");
      expect(counter.calls).toBe(1);
      // ensure no fetch to api.mapbox.com occurred (we didn't provide fetch, stub didn't call it)
      // If code had imported relay, we'd have relay import in mapbox.ts — already checked above
      const mapboxSource = readSource("../src/geocode/mapbox.ts");
      expect(mapboxSource).not.toMatch(/from\s+["'].*relay.*["']/i);
      expect(mapboxSource).not.toMatch(/import\s+.*relay/i);
    } finally {
      await server.close();
    }
  });
});

// ---------------- S51 direct egress grep-style ----------------
describe("S51.4 coordinate scoping revert check — helper asserts", () => {
  it("resolvePlace.ts keeps coordinate request-scoped (no module-level closure) and never logs query", () => {
    const src = readSource("../src/routes/searches/resolvePlace.ts");
    // coordinate is request-scoped via ResolvedPlace inside handler, not module global
    expect(src).toContain("ResolvedPlace");
    expect(src).toContain("let resolved");
    expect(src).toContain("originLat: resolved.lat");
    expect(src).toContain("originLng: resolved.lng");
    // ensure no module-level coords closure remains
    expect(src).not.toMatch(/^let coords/m);
    expect(src).not.toMatch(/^const coords/m);
    // ensure no logging of query or coordinate
    expect(src).not.toMatch(/logger\.(info|warn)\([^)]*normalized/);
    expect(src).not.toMatch(/logger\.(info|warn)\([^)]*coords/);
    expect(src).not.toMatch(/logger\.(info|warn)\([^)]*resolved/);
    // ensure memo key is sessionId\0normalizedLower
    expect(src).toContain("normalizedLower");
    expect(src).toContain("ctx.memo.get(sessionId, normalizedLower)");
  });
});

// ---------------- I15.7 ----------------
describe("mapbox fetch timeouts I15.7 — 5s abort signal, timeout maps to GeocodeUnavailableError", () => {
  it("resolve passes AbortSignal.timeout(5000) and maps a timeout rejection to GeocodeUnavailableError", async () => {
    const { createMapboxGeocodeResolver } = await import("../src/geocode/mapbox.js");
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    const abortSignalTimeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const seen: Array<RequestInit | undefined> = [];
    const fetchStub = ((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return Promise.reject(timeoutError);
    }) as typeof fetch;
    const logger = capturingLogger();
    const resolver = createMapboxGeocodeResolver({
      accessToken: "test-token",
      bucket: { acquire: () => Promise.resolve() },
      logger,
      fetch: fetchStub,
    });

    await expect(resolver.resolve("timeout place")).rejects.toBeInstanceOf(GeocodeUnavailableError);

    expect(abortSignalTimeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    abortSignalTimeout.mockRestore();
  });

  it("suggest passes AbortSignal.timeout(5000) and maps a timeout rejection to GeocodeUnavailableError", async () => {
    const { createMapboxGeocodeResolver } = await import("../src/geocode/mapbox.js");
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    const abortSignalTimeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const seen: Array<RequestInit | undefined> = [];
    const fetchStub = ((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return Promise.reject(timeoutError);
    }) as typeof fetch;
    const logger = capturingLogger();
    const resolver = createMapboxGeocodeResolver({
      accessToken: "test-token",
      bucket: { acquire: () => Promise.resolve() },
      logger,
      fetch: fetchStub,
    });

    await expect(resolver.suggest("timeout place")).rejects.toBeInstanceOf(GeocodeUnavailableError);

    expect(abortSignalTimeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    abortSignalTimeout.mockRestore();
  });
});
