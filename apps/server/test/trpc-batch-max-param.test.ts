import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { SessionRateLimiter } from "../src/session/limiter.js";
import {
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_LOGGER,
  TEST_METRICS,
  TEST_MINT_ID,
  TEST_NONCE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RATE_LIMIT_CONFIG,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_RELAY_PEER_CIDR,
  TEST_TRACER,
} from "./support/app.js";

/**
 * BATCH-414: batched tRPC procedure names are comma-joined into a single
 * dynamic path segment matched against `fastifyTRPCPlugin`'s catch-all route.
 * Fastify's router (`find-my-way`) caps that segment at `maxParamLength`
 * (default 100) — 6x `theatres.movies` is already 101 chars and failed live
 * with 414 (`FST_ERR_MAX_PARAM_LENGTH`). `buildApp` raises the cap, so
 * realistic multi-theatre batches route instead of 414ing.
 */
function stubLimiter(): SessionRateLimiter {
  return {
    check: () => Promise.resolve({ allowed: true }),
    charge: async () => {},
    recordBreach: async () => {},
  };
}

describe("batched tRPC path segment (BATCH-414 maxParamLength fix)", () => {
  it("does not 414 on a 12-procedure batched path (>100 chars)", async () => {
    const fastify = buildApp({
      db: new Pool({
        connectionString: "postgresql://unused:unused@127.0.0.1:1",
        max: 1,
      }),
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
      freshnessMs: 10 * 60_000,
      retryAfterSeconds: 30,
      rateLimitConfig: TEST_RATE_LIMIT_CONFIG,
      limiter: stubLimiter(),
      cookieSecret: TEST_COOKIE_SECRET,
      cookiePolicy: TEST_COOKIE_POLICY,
      relayPeerCidr: TEST_RELAY_PEER_CIDR,
      asnLookup: TEST_ASN_LOOKUP,
      streamRedisUrl: "redis://127.0.0.1:1",
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

    const procedures = Array.from({ length: 12 }, () => "theatres.movies");
    const batchedPath = procedures.join(",");
    // Sanity: longer than Fastify's 100-char default cap.
    expect(batchedPath.length).toBeGreaterThan(100);
    const input = Object.fromEntries(
      procedures.map((_, i) => [
        String(i),
        { theatreId: `amc:theatre:${i + 1}`, from: "2026-09-19", to: "2026-09-19" },
      ]),
    );
    const url = `/trpc/${batchedPath}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fastify.inject({ method: "GET", url });
    await fastify.close();

    // The request may fail downstream (no session or DB behind this harness)
    // — what must not happen is the router rejecting the path segment itself.
    expect(response.statusCode).not.toBe(414);
  });
});
