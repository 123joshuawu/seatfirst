import pino from "pino";
import { describe, expect, it } from "vitest";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import type { BuildAppOptions } from "../src/app.js";
import type { SessionRateLimiter } from "../src/session/limiter.js";

import type * as appTypes from "../src/app.js";
import type * as bootstrapTypes from "@seatfirst/config/otel-bootstrap";
import type * as containersTypes from "./support/containers.js";
import type * as coreTypes from "@seatfirst/core";
import type * as pgTypes from "pg";
import type * as sessionBootstrapTypes from "../src/routes/session/bootstrap.js";
import type * as supportDbTypes from "./support/db.js";
type PgModule = typeof pgTypes;

/**
 * O11.1/O11.2 verification: the request-root span (O11.1, `apps/server/src/app.ts`'s
 * `onRequest` hook) nests a downstream pg query span (O8) under it.
 *
 * Lives in its own file — not `app-logging.test.ts` — because O8.2's once-per-process
 * patch point requires `pg` to be loaded AFTER `ensurePgInstrumented()`/
 * `buildOtelFromEnv()` registers the instrumentation
 * (`packages/config/src/otel-bootstrap.ts:70-95`). Every value import below is dynamic,
 * loaded inside the test body AFTER registration — not just `pg` itself: `../src/app.js`
 * (and `./support/app.js`, `../src/routes/session/bootstrap.js`) transitively import
 * VALUE members from `@seatfirst/durability` (e.g. `poolClient`, `upsertSession`), and
 * `@seatfirst/durability`'s own package entrypoint does `export * from "./pool.js"`
 * (`packages/durability/src/index.ts:12`), which statically imports `pg`
 * (`packages/durability/src/pool.ts:1`). A static top-level `import { buildApp } from
 * "../src/app.js"` in THIS file would therefore evaluate `pg` at file-load time — before
 * any `ensurePgInstrumented()` call could run — exactly the ordering hazard O8's own
 * Verification 3 test guards (`apps/server/test/o8-pg-query-tracing.test.ts:291-314`).
 * This file follows that same file's proven pattern
 * (`apps/server/test/o8-pg-query-tracing.test.ts:150-161`): register first, dynamically
 * import every module whose graph reaches `pg` or `@seatfirst/durability` after.
 */

/** A no-op limiter: this test's route (`searches.get`'s ownership middleware) never
 * calls it — the DB query under test happens before any rate-limit check. */
function stubLimiter(): SessionRateLimiter {
  return {
    check: () => Promise.resolve({ allowed: true }),
    charge: async () => {},
    recordBreach: async () => {},
  };
}

describe("O11.1/O11.2 — the request-root span nests downstream pg query spans", () => {
  it("parents a real pg auto-instrumented query span under the request's root span", async () => {
    const bootstrap: typeof bootstrapTypes = await import("@seatfirst/config/otel-bootstrap");
    // O8.2 ordering: register FIRST, import pg-touching modules after.
    bootstrap.ensurePgInstrumented();
    const [pgModule, supportDb, containers, core, app, sessionBootstrap]: [
      PgModule,
      typeof supportDbTypes,
      typeof containersTypes,
      typeof coreTypes,
      typeof appTypes,
      typeof sessionBootstrapTypes,
    ] = await Promise.all([
      import("pg"),
      import("./support/db.js"),
      import("./support/containers.js"),
      import("@seatfirst/core"),
      import("../src/app.js"),
      import("../src/routes/session/bootstrap.js"),
    ]);

    const pgService = await containers.startTestPostgres();
    try {
      await supportDb.migrateDatabase(pgService.url);
      const db = new pgModule.Pool({ connectionString: pgService.url, max: 1 });
      const exporter = new InMemorySpanExporter();
      const configured = bootstrap.buildOtelFromEnv(
        {},
        { serviceName: "t", component: "app" },
        { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
      );

      const options: BuildAppOptions = {
        db,
        searchLimits: core.DEFAULT_SEARCH_LIMITS,
        freshnessMs: 10 * 60_000,
        retryAfterSeconds: 30,
        rateLimitConfig: {
          searches: { limit: 10_000, windowMs: 3_600_000 },
          fetches: { limit: 100_000, windowMs: 3_600_000 },
          recheck: { limit: 10_000, windowMs: 60_000 },
          facetCounts: { limit: 10_000, windowMs: 60_000 },
          resolvePlace: { limit: 10_000, windowMs: 60_000 },
          suggestPlace: { limit: 30, windowMs: 60_000 },
          facetCountMaxCandidates: 40,
          concurrentSearches: 10_000,
          breachWindowMs: 3_600_000,
        },
        limiter: stubLimiter(),
        cookieSecret: "o11-test-cookie-secret-not-a-production-value",
        cookiePolicy: { sameSite: "Lax", maxAgeSeconds: 3600 },
        relayPeerCidr: "10.99.0.0/16",
        asnLookup: { lookup: () => undefined },
        streamRedisUrl: "redis://127.0.0.1:1",
        streamBlockTimeoutMs: 250,
        providerHostAllowlists: { amc: ["example.invalid"] },
        nonceSecret: "o11-test-nonce-secret-not-a-production-value",
        recheckDeadlineMs: 30_000,
        recheckRecovery: () => Promise.reject(new Error("recovery seam not stubbed")),
        corsAllowedOrigins: ["http://localhost:8081"],
        logger: pino({ level: "silent" }),
        mintId: sessionBootstrap.mintSessionId,
        metrics: configured.metrics,
        tracer: configured.tracer,
      };
      const fastify = app.buildApp(options);

      try {
        // `searches.get`'s ownership middleware (`streaming/ownership.ts:22`)
        // unconditionally queries the DB before checking anything else — no seeded
        // row or session cookie is needed to prove a query executed; a syntactically
        // valid searchId is enough.
        const input = encodeURIComponent(JSON.stringify({ searchId: "srch_o11_2_probe" }));
        const response = await fastify.inject({
          method: "GET",
          url: `/trpc/searches.get?input=${input}`,
        });
        await configured.forceFlush();

        expect(response.statusCode).toBe(401); // UNAUTHORIZED — no session owns this search.

        const finished = exporter.getFinishedSpans();
        const requestSpan = finished.find((span) => span.name === "/trpc/searches.get");
        expect(requestSpan).toBeDefined();

        // pg-derived spans nest inside their own connection-acquisition chain
        // (pg.query -> pg.connect -> pg-pool.connect — O8's own comment,
        // `o8-pg-query-tracing.test.ts:332-334`), so the assertion is ancestor
        // reachability, not a direct-parent equality check.
        const pgLeaf = finished.find(
          (span) => span.instrumentationScope.name === bootstrap.PG_INSTRUMENTATION_SCOPE,
        );
        expect(pgLeaf).toBeDefined();
        const byId = new Map(finished.map((sp) => [sp.spanContext().spanId, sp]));
        const ancestors: string[] = [];
        let cursor = pgLeaf?.parentSpanContext?.spanId;
        while (cursor !== undefined && !ancestors.includes(cursor)) {
          ancestors.push(cursor);
          cursor = byId.get(cursor)?.parentSpanContext?.spanId;
        }
        // Negative-control reasoning, inline (no separate pre-fix run needed): before
        // O11.1, `onRequest` never started a span, so this ancestor chain would be
        // empty and this assertion would fail — the pg span would export as a
        // disconnected root on its own trace (O8.7's documented pre-fix behavior).
        expect(ancestors).toContain(requestSpan?.spanContext().spanId);
        expect(pgLeaf?.spanContext().traceId).toBe(requestSpan?.spanContext().traceId);
      } finally {
        await fastify.close();
        await db.end();
      }
    } finally {
      await pgService.stop();
    }
  }, 30_000);
});
