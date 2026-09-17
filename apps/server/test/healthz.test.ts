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
 * I10.3 — unauthenticated liveness probe for deploy smoke checks (Task I7.5).
 * No auth logic by design (ADR 0014 no-accounts freeze): Caddy exempts /healthz
 * from edge basic auth, and the Fastify route itself performs no credential check.
 */
function stubLimiter(): SessionRateLimiter {
  return {
    check: () => Promise.resolve({ allowed: true }),
    charge: async () => {},
    recordBreach: async () => {},
  };
}

describe("GET /healthz (I10.3 liveness probe)", () => {
  it("returns 200 { status: 'ok' } without credentials", async () => {
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

    const response = await fastify.inject({ method: "GET", url: "/healthz" });
    await fastify.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
