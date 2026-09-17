import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import type { SearchSpec } from "@seatfirst/core";

import { buildApp } from "../src/app.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../src/session/limiter.js";
import type { SessionRateLimitConfig, SessionRateLimiter } from "../src/session/limiter.js";

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
  TEST_LOGGER,
  TEST_MINT_ID,
  TEST_METRICS,
  TEST_TRACER,
} from "./support/app.js";
/**
 * S16 verification, items 1–7 of the spec's verification list, over HTTP (both
 * `SERVER_PG_URL`/`SERVER_REDIS_URL`): bootstrap's wire shape + Set-Cookie, the
 * Postgres concurrency gauge's 429, the searches-window 429 + Retry-After + breach
 * observation, and replay immunity.
 *
 * The rate windows ARE ADR 0006 §A.6's figures (20/hr, 600/hr weighted, 3 concurrent,
 * 10/min); `breachWindowMs` is an injected finding (S16.9) — a harness value. Cookie
 * policy values come from the shared harness policy (test plumbing, not policy claims).
 *
 * Success asserts the BODY (`status: "PENDING_SCHEDULE"`), not the HTTP status: S15's
 * shipped route emits its "202-shaped body" over HTTP 200 (a pre-existing S15 surface
 * detail, `docs/tasks/S15-search-orchestrator-create/spec.md:14,61` vs. the observed
 * wire — reported as a finding, not silently changed here).
 */

const RATE_CONFIG: SessionRateLimitConfig = {
  searches: { limit: 20, windowMs: 3_600_000 },
  fetches: { limit: 600, windowMs: 3_600_000 },
  recheck: { limit: 10, windowMs: 60_000 },
  facetCounts: { limit: 10_000, windowMs: 60_000 },
  resolvePlace: { limit: 10_000, windowMs: 60_000 },
  suggestPlace: { limit: 30, windowMs: 60_000 },
  facetCountMaxCandidates: 40,
  concurrentSearches: 3,
  breachWindowMs: 60_000,
};

const PROVIDER = "amc";
const THEATRE = `${PROVIDER}:theatre:7`;
const MOVIE = `${PROVIDER}:movie:42`;
const LOCAL_DATE = new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);

/** A crockford-base32 ULID: 26 chars, no I/L/O/U. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function makeSpec(): SearchSpec {
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

interface TestApp {
  readonly baseUrl: string;
  readonly url: string;
  close(): Promise<void>;
}

interface RunningApp {
  readonly app: TestApp;
  readonly redis: Redis;
}

async function startApp(opts: {
  limiter: SessionRateLimiter;
  config?: SessionRateLimitConfig;
}): Promise<RunningApp> {
  const redis = new Redis(redisService.url, { lazyConnect: true });
  const config = opts.config ?? RATE_CONFIG;
  const fastify = buildApp({
    db: pool,
    searchLimits: DEFAULT_SEARCH_LIMITS,
    freshnessMs: 10 * 60_000,
    retryAfterSeconds: 30,
    rateLimitConfig: config,
    limiter: opts.limiter,
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
  const url = `http://127.0.0.1:${address.port}`;
  return {
    app: {
      baseUrl: `${url}/trpc`,
      url,
      close: () => fastify.close(),
    },
    redis,
  };
}

async function bootstrapRaw(url: string, cookie?: string): Promise<Response> {
  return fetch(`${url}/trpc/session.bootstrap`, {
    method: "POST",
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function createRaw(
  baseUrl: string,
  sessionId: string,
  input: { spec: SearchSpec; idempotencyKey: string },
): Promise<Response> {
  return fetch(`${baseUrl}/searches.create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookieHeader(sessionId) },
    body: JSON.stringify(input),
  });
}

async function seedProvider(admin: Client, pendingCostLimit = 10_000): Promise<void> {
  await admin.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    [PROVIDER, pendingCostLimit, 1000],
  );
  await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
  await admin.query(
    `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'Test Theatre', 40.0, -74.0, 'UTC', now(), now())
     ON CONFLICT (theatre_id) DO NOTHING`,
    [THEATRE, PROVIDER],
  );
}

async function seedOpenSearch(
  admin: Client,
  searchId: string,
  sessionId: string,
  status = "RUNNING",
): Promise<void> {
  await admin.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, now() + interval '10 minutes')`,
    [searchId, sessionId, `idem_${searchId}`, `hash_${searchId}`, status],
  );
}

let pg: TestService;
let redisService: TestService;
let pool: Pool;
let admin: Client;
let main: RunningApp;
let mainLimiter: SessionRateLimiter;

beforeAll(async () => {
  pg = await startTestPostgres();
  redisService = await startTestRedis();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  admin = new Client({ connectionString: pg.url });
  await admin.connect();
  mainLimiter = createSessionRateLimiter({
    redis: redisScriptExecutorFromIoredis(new Redis(redisService.url, { lazyConnect: true })),
    config: RATE_CONFIG,
  });
  main = await startApp({ limiter: mainLimiter });
});

afterAll(async () => {
  await main.app.close();
  await admin.end();
  await pool.end();
  await Promise.all([pg.stop(), redisService.stop()]);
});

beforeEach(async () => {
  await admin.query(
    `TRUNCATE search, run_key, performance, outbox, provider_admission, provider_fence,
     provider_run, observation, admission_reservation, search_job, run_subscription,
     session CASCADE`,
  );
});

describe("session.bootstrap (S16.11, item 8)", () => {
  it("no cookie → fresh ULID, session row exists, Set-Cookie carries the decided attributes, limits echo the injected config", async () => {
    const raw = await bootstrapRaw(main.app.url);
    expect(raw.status).toBe(200);

    const body = (await raw.json()) as {
      result: { data: { sessionId: string; limits: Record<string, number> } };
    };
    const { sessionId, limits } = body.result.data;
    expect(sessionId).toMatch(ULID_PATTERN);
    expect(limits).toEqual({
      searchesPerHour: 20,
      upstreamFetchesPerHour: 600,
      concurrentSearches: 3,
      recheckCallsPerMinute: 10,
      facetCountsPerMinute: 10_000,
      resolvePlacePerMinute: 10_000,
      suggestPlacePerMinute: 30,
    });

    const setCookie = raw.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`seatfirst_session=${sessionId}.`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");

    const rows = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("with the minted cookie → same id, still one row, last_seen_at advanced, no cookie re-set", async () => {
    const first = await bootstrapRaw(main.app.url);
    const firstBody = (await first.json()) as {
      result: { data: { sessionId: string } };
    };
    const sessionId = firstBody.result.data.sessionId;
    const before = await admin.query<{ created_at: Date; last_seen_at: Date }>(
      `SELECT created_at, last_seen_at FROM session WHERE session_id = $1`,
      [sessionId],
    );
    expect(before.rows).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await bootstrapRaw(main.app.url, sessionCookieHeader(sessionId));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      result: { data: { sessionId: string } };
    };
    expect(secondBody.result.data.sessionId).toBe(sessionId);
    // No mint happened: no Set-Cookie header.
    expect(second.headers.get("set-cookie")).toBeNull();

    const after = await admin.query<{ created_at: Date; last_seen_at: Date }>(
      `SELECT created_at, last_seen_at FROM session WHERE session_id = $1`,
      [sessionId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.created_at.getTime()).toBe(before.rows[0]!.created_at.getTime());
    expect(after.rows[0]!.last_seen_at.getTime()).toBeGreaterThan(
      before.rows[0]!.last_seen_at.getTime(),
    );
  });

  it("a tampered signature mints a fresh session and never writes the forged id", async () => {
    const raw = await bootstrapRaw(
      main.app.url,
      `seatfirst_session=${signSessionIdForged("sess_forged")}`,
    );
    expect(raw.status).toBe(200);
    const body = (await raw.json()) as { result: { data: { sessionId: string } } };
    expect(body.result.data.sessionId).not.toBe("sess_forged");
    expect(raw.headers.get("set-cookie")).not.toBeNull();

    const forged = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE session_id = 'sess_forged'`,
    );
    expect(forged.rows[0]!.n).toBe("0");
    const minted = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE session_id = $1`,
      [body.result.data.sessionId],
    );
    expect(minted.rows[0]!.n).toBe("1");
  });
});

describe("searches.create rate limits (S16.13, items 6–7)", () => {
  it("concurrency: 3 open searches → 429 with the schema body, retryAfterSeconds null, no Retry-After; terminalizing one lets create through", async () => {
    await seedProvider(admin);
    const sessionId = "sess_concurrency";
    for (const suffix of ["a", "b", "c"]) {
      await seedOpenSearch(admin, `srch_open_${suffix}`, sessionId);
    }

    const raw = await createRaw(main.app.baseUrl, sessionId, {
      spec: makeSpec(),
      idempotencyKey: "item6_blocked",
    });
    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toBeNull();
    const body = (await raw.json()) as { error: { data: unknown } };
    expect(body.error.data).toEqual({
      code: "RATE_LIMITED",
      limit: "concurrent_searches",
      retryAfterSeconds: null,
    });

    // The breach was observed in the session window (no IP extractable: the test
    // request's socket peer is outside the injected relay CIDR).
    expect(await main.redis.zcard(`rl:breach:session:${sessionId}`)).toBe(1);
    expect(await main.redis.exists("rl:breach:ip:sess_concurrency")).toBe(0);

    // Terminalize one search → the gauge drops to 2 → create succeeds (cold, 202).
    await admin.query(`UPDATE search SET status = 'COMPLETE' WHERE search_id = 'srch_open_a'`);
    const ok = await createRaw(main.app.baseUrl, sessionId, {
      spec: makeSpec(),
      idempotencyKey: "item6_allowed",
    });
    expect(ok.status).toBe(200); // S15 ships the 202-shaped body with HTTP 200 (see suite doc comment)
    const okBody = (await ok.json()) as {
      result: { data: { searchId: string; status: string } };
    };
    expect(okBody.result.data.searchId).toMatch(/^srch_/);
    expect(okBody.result.data.status).toBe("PENDING_SCHEDULE");
  });

  it("searches window: pre-filled to the 20/hr limit → 429 with the derived retryAfterSeconds + Retry-After header", async () => {
    await seedProvider(admin);
    const sessionId = "sess_window_full";
    for (let i = 0; i < 20; i++) {
      await mainLimiter.charge(sessionId, "searches", 1);
    }

    const raw = await createRaw(main.app.baseUrl, sessionId, {
      spec: makeSpec(),
      idempotencyKey: "item7_window",
    });
    expect(raw.status).toBe(429);
    const body = (await raw.json()) as {
      error: { data: { code: string; limit: string; retryAfterSeconds: number } };
    };
    const data = body.error.data;
    expect(data).toEqual({
      code: "RATE_LIMITED",
      limit: "searches_per_hour",
      retryAfterSeconds: data.retryAfterSeconds,
    });
    expect(data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // The Retry-After header is derived from the same window mechanics.
    expect(raw.headers.get("retry-after")).toBe(String(data.retryAfterSeconds));
    expect(await main.redis.zcard(`rl:breach:session:${sessionId}`)).toBe(1);
  });

  it("replay immunity: a create charges once; the identical replay returns the same id and never charges or 429s, even with a full window", async () => {
    await seedProvider(admin);
    const sessionId = "sess_replay";
    const input = { spec: makeSpec(), idempotencyKey: "item7_replay" };

    const first = await createRaw(main.app.baseUrl, sessionId, input);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      result: { data: { searchId: string; status: string } };
    };
    const searchId = firstBody.result.data.searchId;
    expect(firstBody.result.data.status).toBe("PENDING_SCHEDULE");
    expect(await main.redis.zcard(`rl:searches:${sessionId}`)).toBe(1);

    // The identical replay: same id, and the window is untouched.
    const replay = await createRaw(main.app.baseUrl, sessionId, input);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { result: { data: { searchId: string } } };
    expect(replayBody.result.data.searchId).toBe(searchId);
    expect(await main.redis.zcard(`rl:searches:${sessionId}`)).toBe(1);

    // Per-session isolation: another session's creates grow ITS window, not this one's.
    const otherSession = "sess_replay_other";
    for (let i = 0; i < 3; i++) {
      const other = await createRaw(main.app.baseUrl, otherSession, {
        spec: makeSpec(),
        idempotencyKey: `item7_other_${i}`,
      });
      expect(other.status).toBe(200);
    }
    expect(await main.redis.zcard(`rl:searches:${otherSession}`)).toBe(3);
    expect(await main.redis.zcard(`rl:searches:${sessionId}`)).toBe(1);

    // Fill THIS session's window to the limit directly (window mechanics are the unit
    // suite's subject; filling via 19 more creates would instead trip the 3-open
    // concurrency gauge, which is the adjacent limit, not this test's).
    for (let i = 0; i < 19; i++) {
      await mainLimiter.charge(sessionId, "searches", 1);
    }
    expect(await main.redis.zcard(`rl:searches:${sessionId}`)).toBe(20);

    // A replay is never 429'd and never charged — the pre-read short-circuits the rate
    // checks even though the window is full.
    const fullWindowReplay = await createRaw(main.app.baseUrl, sessionId, input);
    expect(fullWindowReplay.status).toBe(200);
    const fullReplayBody = (await fullWindowReplay.json()) as {
      result: { data: { searchId: string } };
    };
    expect(fullReplayBody.result.data.searchId).toBe(searchId);
    expect(await main.redis.zcard(`rl:searches:${sessionId}`)).toBe(20);

    // Sanity: NEW work under the full window is denied (the limit is real).
    const newWork = await createRaw(main.app.baseUrl, sessionId, {
      spec: makeSpec(),
      idempotencyKey: "item7_new_after_full",
    });
    expect(newWork.status).toBe(429);
  });

  it("fail-open: with the Redis window unavailable the create still succeeds (S16.16)", async () => {
    await seedProvider(admin);
    const downLimiter = createSessionRateLimiter({
      redis: {
        eval: () => {
          throw new Error("redis down");
        },
      },
      config: RATE_CONFIG,
    });
    const down = await startApp({ limiter: downLimiter });
    try {
      const raw = await createRaw(down.app.baseUrl, "sess_fail_open", {
        spec: makeSpec(),
        idempotencyKey: "item7_fail_open",
      });
      expect(raw.status).toBe(200);
    } finally {
      await down.app.close();
    }
  });
});

/** A deliberately-unsigned value: the forged id never carries a valid signature. */
function signSessionIdForged(sessionId: string): string {
  return `${sessionId}.deadbeef${"0".repeat(56)}`;
}
