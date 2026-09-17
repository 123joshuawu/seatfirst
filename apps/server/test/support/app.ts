import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { EventSource } from "eventsource";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";

import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import type { ResultContractConfig } from "@seatfirst/core";
import { configureOtel } from "@seatfirst/config/otel";

import { buildApp } from "../../src/app.js";
import type { AppRouter } from "../../src/routes/searches/router.js";
import { mintSessionId } from "../../src/routes/session/bootstrap.js";
import { SESSION_COOKIE_NAME, signSessionId } from "../../src/session/cookie.js";
import type { SessionCookiePolicy } from "../../src/session/cookie.js";
import type { AsnLookup } from "../../src/session/extract.js";
import {
  createSessionRateLimiter,
  redisScriptExecutorFromIoredis,
} from "../../src/session/limiter.js";
import type { SessionRateLimitConfig } from "../../src/session/limiter.js";
import type { RecoverySeam } from "../../src/routes/showtimes/recheckContext.js";

/**
 * A live Fastify server assembled by the real `buildApp` (S16.15) — the session plugin,
 * both bespoke routes (`onProgress` SSE, `session.bootstrap`) and `fastifyTRPCPlugin` —
 * driven by tRPC's SSE test client. Sessions flow through the S16.10 signed cookie,
 * exactly like production: `session.bootstrap` mints; the tests sign ids with the
 * harness secret below (mechanical test plumbing, never a policy value).
 *
 * `EventSource` is the `eventsource` polyfill — Node ships no global EventSource without
 * `--experimental-eventsource`. Its init dict has no `headers` field, so the caller's
 * session cookie is injected via a custom `fetch` implementation that layers the
 * `Cookie` header onto every subscription request.
 *
 * The injected tunables are harness values, not policy numbers (gate 14): limits are
 * deliberately generous because the S15/S12 suites share one session across tests and
 * open several searches under it (create.test.ts item 7 opens five) — S16's own suites
 * inject ADR 0006 §A.6's figures (20/hr, 600/hr weighted, 3 concurrent, 10/min) and
 * tight windows themselves.
 */

export const TEST_COOKIE_SECRET = "s16-test-cookie-secret-not-a-production-value";
export const TEST_COOKIE_POLICY: SessionCookiePolicy = { sameSite: "Lax", maxAgeSeconds: 3600 };
export const TEST_RELAY_PEER_CIDR = "10.99.0.0/16";
export const TEST_ASN_LOOKUP: AsnLookup = { lookup: () => undefined };
/** S6U3.5 — the reveal validator's provider allowlists (config requires ≥1 host). */
export const TEST_PROVIDER_HOST_ALLOWLISTS: ResultContractConfig["providerHostAllowlists"] = {
  amc: ["example.invalid"],
};

export const TEST_RATE_LIMIT_CONFIG: SessionRateLimitConfig = {
  searches: { limit: 10_000, windowMs: 3_600_000 },
  fetches: { limit: 100_000, windowMs: 3_600_000 },
  recheck: { limit: 10_000, windowMs: 60_000 },
  facetCounts: { limit: 10_000, windowMs: 60_000 },
  resolvePlace: { limit: 10_000, windowMs: 60_000 },
  suggestPlace: { limit: 30, windowMs: 60_000 },
  facetCountMaxCandidates: 40,
  concurrentSearches: 10_000,
  breachWindowMs: 3_600_000,
};

export const TEST_NONCE_SECRET = "s22-test-nonce-secret-not-a-production-value";
/** The decided 30 s deadline; a recheck timeout test overrides this with a short value. */
export const TEST_RECHECK_DEADLINE_MS = 30_000;
/** Default recovery seam: never invoked except by the GONE test, which overrides it. */
export const TEST_RECHECK_RECOVERY: RecoverySeam = () => {
  return Promise.reject(new Error("recovery seam not stubbed for this test"));
};
/**
 * O5 test plumbing — the three injected O5 options every `buildApp` caller must now
 * supply. `TEST_LOGGER` is silent so the S15/S12/S16 suites stay quiet; the
 * allowlist-serializer assertion lives in its own test file (app-logging.test.ts).
 */
export const TEST_LOGGER = pino({ level: "silent" });
/** O5.2 — the real ULID seam, so request ids are well-formed in every suite. */
export const TEST_MINT_ID = mintSessionId;
/**
 * O5.6 — a no-op `SeatfirstMetrics` (configureOtel with no readers exports nowhere),
 * so the RED hook records into nothing outside app-logging.test.ts. O11.1's `tracer`
 * shares the same handle — a no-op tracer with no span processors, so request-root
 * spans are created but export nowhere outside app-logging.test.ts either.
 */
const TEST_OTEL = configureOtel({
  resource: { serviceName: "test", component: "app" },
});
export const TEST_METRICS = TEST_OTEL.metrics;
export const TEST_TRACER = TEST_OTEL.tracer;

export interface TestServer {
  readonly baseUrl: string;
  readonly url: string;
  close(): Promise<void>;
}

export async function startTestServer(opts: {
  db: Pool;
  redisUrl: string;
  blockTimeoutMs: number;
  recheckDeadlineMs?: number;
  recheckRecovery?: RecoverySeam;
}): Promise<TestServer> {
  const redis = new Redis(opts.redisUrl, { lazyConnect: true });
  const fastify = buildApp({
    db: opts.db,
    searchLimits: DEFAULT_SEARCH_LIMITS,
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
    streamRedisUrl: opts.redisUrl,
    streamBlockTimeoutMs: opts.blockTimeoutMs,
    providerHostAllowlists: TEST_PROVIDER_HOST_ALLOWLISTS,
    nonceSecret: TEST_NONCE_SECRET,
    recheckDeadlineMs: opts.recheckDeadlineMs ?? TEST_RECHECK_DEADLINE_MS,
    recheckRecovery: opts.recheckRecovery ?? TEST_RECHECK_RECOVERY,
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
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await fastify.close();
      redis.disconnect();
    },
  };
}

/** The `Cookie` header value for `sessionId`, signed with the harness secret. */
export function sessionCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${signSessionId(sessionId, TEST_COOKIE_SECRET)}`;
}

export function makeClient(baseUrl: string, sessionId: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpSubscriptionLink({
        url: baseUrl,
        EventSource,
        eventSourceOptions: () => ({
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: { ...init.headers, cookie: sessionCookieHeader(sessionId) },
            }),
        }),
      }),
    ],
  });
}

export type TestClient = ReturnType<typeof makeClient>;
