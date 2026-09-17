import { PassThrough } from "node:stream";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { metrics as metricsApi } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel } from "@seatfirst/config/otel";
import { createLogger } from "@seatfirst/config/logger";
import { configureOtel, OTEL_METRIC_DEFINITIONS } from "@seatfirst/config/otel";
import {
  inboundRequestLogSerializer,
  InboundSpanAttributeFilter,
} from "@seatfirst/config/redaction";

import { buildApp } from "../src/app.js";
import type { BuildAppOptions } from "../src/app.js";
import { mintSessionId } from "../src/routes/session/bootstrap.js";
import type { SessionRateLimiter } from "../src/session/limiter.js";
import {
  TEST_ASN_LOOKUP,
  TEST_COOKIE_POLICY,
  TEST_COOKIE_SECRET,
  TEST_NONCE_SECRET,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RATE_LIMIT_CONFIG,
  TEST_RECHECK_DEADLINE_MS,
  TEST_RECHECK_RECOVERY,
  TEST_RELAY_PEER_CIDR,
} from "./support/app.js";

/**
 * O5 verification items 1–5: the Fastify request logger's allowlist serializers
 * (ADR 0005 §A:168-195), the ULID request-id seam, the `seatfirst.request_id` span
 * attribute + a positive/negative `InboundSpanAttributeFilter` proof, OTel-disabled
 * parity, and the RED metrics instruments — including verification item 5's enabled
 * OTLP HTTP stub endpoint receiving an actual exported payload. Each test assembles the
 * real `buildApp` and drives it with `inject()`; the DB pool and limiter are never-queried
 * stubs because these paths touch no rows.
 */

const ULID_SHAPE = /^[0-9A-Z]{26}$/;

/** A real pg Pool that is never queried (buildApp only closes over `db` for route
 * context factories; a cookie-less inject to a non-routed path issues no query). */
function neverUsedPool(): Pool {
  return new Pool({
    connectionString: "postgresql://unused:unused@127.0.0.1:1",
    max: 1,
  });
}

/** A no-op limiter: the rate-limit suite tests the real one; these paths never call it. */
function stubLimiter(): SessionRateLimiter {
  return {
    check: () => Promise.resolve({ allowed: true }),
    charge: async () => {},
    recordBreach: async () => {},
  };
}

interface TestOverrides {
  logger: BuildAppOptions["logger"];
  mintId: () => string;
  metrics: BuildAppOptions["metrics"];
  tracer: BuildAppOptions["tracer"];
}

/** Standard O5 buildApp options with the given logger/mintId/metrics and stub db/limiter. */
function testAppOptions(overrides: TestOverrides): BuildAppOptions {
  return {
    db: neverUsedPool(),
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
    logger: overrides.logger,
    mintId: overrides.mintId,
    metrics: overrides.metrics,
    tracer: overrides.tracer,
  };
}

/** A no-op metrics handle from `configureOtel` (no readers → nothing exports). */
function noopMetrics(): BuildAppOptions["metrics"] {
  return configureOtel({ resource: { serviceName: "t", component: "app" } }).metrics;
}

/** A no-op tracer handle from `configureOtel` (no span processors → nothing exports). */
function noopTracer(): BuildAppOptions["tracer"] {
  return configureOtel({ resource: { serviceName: "t", component: "app" } }).tracer;
}

/**
 * The request logger under test — built through the ONE production construction path,
 * O4's `createLogger`, exactly as `startApp` does (O5.1): serializers baked in at
 * construction, JSON lines collected from the destination for assertions.
 */
function capturingLogger(): { lines: string[]; logger: BuildAppOptions["logger"] } {
  const lines: string[] = [];
  const destination = new PassThrough();
  destination.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim().length > 0) lines.push(line);
    }
  });
  const logger = createLogger({
    service: "seatfirst-api-test",
    component: "app",
    level: "info",
    serializers: { req: inboundRequestLogSerializer, res: inboundRequestLogSerializer },
    destination,
  });
  return { lines, logger };
}

/** Pino writes are async through the PassThrough destination — wait for at least one
 * line (or all expected lines via predicate) before asserting on the capture. */
async function drainUntil(lines: string[], predicate?: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if ((predicate ? predicate() : lines.length > 0) === false) {
        throw new Error("capture not flushed yet");
      }
    },
    { timeout: 2_000, interval: 10 },
  );
}

function parsedLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A stub OTLP collector: records every request's path, body size, and content type. */
class StubCollector {
  private server: Server | undefined;
  readonly requests: {
    path: string;
    bytes: number;
    contentType: string | undefined;
  }[] = [];

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        this.requests.push({
          path: req.url ?? "",
          bytes: Buffer.concat(chunks).length,
          contentType: req.headers["content-type"],
        });
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end(Buffer.alloc(0));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }

  hits(path: string): { path: string; bytes: number; contentType: string | undefined }[] {
    return this.requests.filter((request) => request.path === path);
  }
}

/** Reset OTel globals between tests so each span/metric recording is isolated. */
afterEach(() => {
  metricsApi.disable();
});

describe("O5.1 — request-log allowlist (both directions)", () => {
  it("logs exactly the allowlisted req/res fields and no forbidden ones", async () => {
    const { lines, logger } = capturingLogger();
    const fastify = buildApp(
      testAppOptions({
        logger,
        mintId: mintSessionId,
        metrics: noopMetrics(),
        tracer: noopTracer(),
      }),
    );

    await fastify.inject({ method: "GET", url: "/healthz" });
    await fastify.close();
    await drainUntil(lines);

    const all = parsedLines(lines);

    // Fastify v5 splits the pair across its own two request-log lines: the
    // "incoming request" line carries the serialized req, the completion line the
    // serialized res (+ responseTime). Assert each against its own allowlist.
    const incoming = all.find((l) => typeof l.req === "object" && l.req !== null);
    const completed = all.find((l) => typeof l.res === "object" && l.res !== null);
    expect(incoming).toBeDefined();
    expect(completed).toBeDefined();

    const req = incoming!.req as Record<string, unknown>;
    const res = completed!.res as Record<string, unknown>;
    // Allowlist: exactly these four req fields; res carries exactly statusCode
    // (fastify v5 logs responseTime as a top-level completion-line field, not inside
    // res — assert it exists there as a number).
    expect(Object.keys(req).sort()).toEqual(["hostname", "method", "protocol", "url"]);
    expect(Object.keys(res).sort()).toEqual(["statusCode"]);
    expect(typeof completed!.responseTime).toBe("number");

    // Forbidden fields must not appear anywhere in the captured output.
    for (const forbidden of ["remoteAddress", "headers", "X-Forwarded-For", "x-forwarded-for"]) {
      expect(lines.join("\n")).not.toContain(forbidden);
    }
  });

  it("shows the forbidden fields WOULD appear when the serializer is removed (positive control)", async () => {
    const lines: string[] = [];
    const destination = new PassThrough();
    destination.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim().length > 0) lines.push(line);
      }
    });
    // Same ONE construction path (createLogger), only the allowlist serializers removed —
    // proving the absence above comes from the serializer, not from the construction.
    const plainLogger = createLogger({
      service: "seatfirst-api-test",
      component: "app",
      level: "info",
      destination,
    });

    const fastify = buildApp(
      testAppOptions({
        logger: plainLogger,
        mintId: mintSessionId,
        metrics: noopMetrics(),
        tracer: noopTracer(),
      }),
    );

    await fastify.inject({ method: "GET", url: "/healthz" });
    await fastify.close();
    await drainUntil(lines);

    const raw = lines.join("\n");
    expect(raw).toContain("remoteAddress");
    expect(raw).toContain("headers");
  });
});

describe("O5.2 — ULID request ids through the injected seam", () => {
  it("produces distinct 26-char Crockford base32 ids across injects", async () => {
    const { lines, logger } = capturingLogger();
    const fastify = buildApp(
      testAppOptions({
        logger,
        mintId: mintSessionId,
        metrics: noopMetrics(),
        tracer: noopTracer(),
      }),
    );

    await fastify.inject({ method: "GET", url: "/a" });
    await fastify.inject({ method: "GET", url: "/b" });
    await fastify.close();
    await drainUntil(lines);

    // Request ids surface on every request-log line via the O5.3 child binding.
    const ids = [
      ...new Set(
        parsedLines(lines)
          .map((l) => l.requestId)
          .filter((v): v is string => typeof v === "string"),
      ),
    ];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(id).toMatch(ULID_SHAPE);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("calls the injected mintId seam (not crypto.randomUUID or a counter)", async () => {
    const mintId = vi.fn(() => "MOCKEDULID");
    const { lines, logger } = capturingLogger();
    const fastify = buildApp(
      testAppOptions({ logger, mintId, metrics: noopMetrics(), tracer: noopTracer() }),
    );

    await fastify.inject({ method: "GET", url: "/c" });
    await fastify.close();
    await drainUntil(lines);

    expect(mintId).toHaveBeenCalledTimes(1);
    const ids = parsedLines(lines)
      .map((l) => l.requestId)
      .filter((v): v is string => typeof v === "string");
    expect(ids).toContain("MOCKEDULID");
  });
});

describe("O5.3 — seatfirst.request_id span attribute + InboundSpanAttributeFilter proof", () => {
  /**
   * Drives one inject inside an active span that explicitly carries the filter's target
   * attributes — absence after export must be the processor's doing, never an accident of
   * the request shape. Returns nothing; callers assert on `exporter.getFinishedSpans()`.
   */
  async function injectWithForbiddenSpanAttrs(configured: ConfiguredOtel): Promise<void> {
    const fastify = buildApp(
      testAppOptions({
        logger: capturingLogger().logger,
        mintId: mintSessionId,
        metrics: configured.metrics,
        tracer: configured.tracer,
      }),
    );
    await configured.tracer.startActiveSpan("test", async (active: Span) => {
      active.setAttribute("client.address", "192.0.2.7");
      active.setAttribute("client.port", 44444);
      active.setAttribute("network.peer.address", "192.0.2.7");
      active.setAttribute("http.request.header.x_forwarded_for", "203.0.113.9");
      // Positive-control attribute: not inbound metadata, must survive the filter.
      active.setAttribute("seatfirst.keepme", "survives");
      try {
        await fastify.inject({ method: "GET", url: "/d" });
      } finally {
        active.end();
      }
    });
    await fastify.close();
    await configured.forceFlush();
  }

  function mergedExportedAttributes(exporter: InMemorySpanExporter): Record<string, unknown> {
    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThanOrEqual(1);
    const merged: Record<string, unknown> = {};
    for (const span of finished) {
      Object.assign(merged, span.attributes as Record<string, unknown>);
    }
    return merged;
  }

  it("strips forbidden inbound attributes when InboundSpanAttributeFilter is installed", async () => {
    const exporter = new InMemorySpanExporter();
    const configured = configureOtel({
      resource: { serviceName: "t", component: "app" },
      spanProcessors: [new InboundSpanAttributeFilter(), new SimpleSpanProcessor({ exporter })],
    });

    await injectWithForbiddenSpanAttrs(configured);

    const attrs = mergedExportedAttributes(exporter);
    expect(attrs["client.address"]).toBeUndefined();
    expect(attrs["client.port"]).toBeUndefined();
    expect(attrs["network.peer.address"]).toBeUndefined();
    expect(attrs["http.request.header.x_forwarded_for"]).toBeUndefined();
    // Positive control on the same run: a non-inbound attribute survives.
    expect(attrs["seatfirst.keepme"]).toBe("survives");
  });

  it("keeps the same attributes when the filter is absent (negative control)", async () => {
    const exporter = new InMemorySpanExporter();
    const configured = configureOtel({
      resource: { serviceName: "t", component: "app" },
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });

    await injectWithForbiddenSpanAttrs(configured);

    const attrs = mergedExportedAttributes(exporter);
    expect(attrs["client.address"]).toBe("192.0.2.7");
    expect(attrs["network.peer.address"]).toBe("192.0.2.7");
    expect(attrs["http.request.header.x_forwarded_for"]).toBe("203.0.113.9");
  });

  it("sets seatfirst.request_id on the exported request span", async () => {
    const exporter = new InMemorySpanExporter();
    const configured = configureOtel({
      resource: { serviceName: "t", component: "app" },
      spanProcessors: [new InboundSpanAttributeFilter(), new SimpleSpanProcessor({ exporter })],
    });

    await injectWithForbiddenSpanAttrs(configured);

    const attrs = mergedExportedAttributes(exporter);
    expect(attrs["seatfirst.request_id"]).toMatch(ULID_SHAPE);
  });
});

describe("O5.4 — OTel-disabled parity", () => {
  it("runs the identical inject flow when OTel is not configured", async () => {
    const noop = buildOtelFromEnv({}, { serviceName: "t", component: "app" });
    const fastify = buildApp(
      testAppOptions({
        logger: capturingLogger().logger,
        mintId: mintSessionId,
        metrics: noop.metrics,
        tracer: noop.tracer,
      }),
    );

    const response = await fastify.inject({ method: "GET", url: "/__no-such-route__" });
    await fastify.close();

    expect(response.statusCode).toBe(404);
  });
});

describe("O5.6 — RED metrics (in-memory reader)", () => {
  it("increments the duration histogram and count counter once, labeled by route and status", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter });
    const configured = configureOtel({
      resource: { serviceName: "t", component: "app" },
      metricReaders: [reader],
    });

    const fastify = buildApp(
      testAppOptions({
        logger: capturingLogger().logger,
        mintId: mintSessionId,
        metrics: configured.metrics,
        tracer: configured.tracer,
      }),
    );

    await fastify.inject({ method: "GET", url: "/healthz" });
    await fastify.close();
    await configured.shutdown();

    const [resourceMetrics] = exporter.getMetrics();
    const allMetrics = resourceMetrics?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];

    const duration = allMetrics.find(
      (m) => m.descriptor.name === OTEL_METRIC_DEFINITIONS.httpRequestDuration.name,
    );
    const count = allMetrics.find(
      (m) => m.descriptor.name === OTEL_METRIC_DEFINITIONS.httpRequestCount.name,
    );

    expect(duration).toBeDefined();
    expect(duration?.descriptor.unit).toBe(OTEL_METRIC_DEFINITIONS.httpRequestDuration.unit);
    expect(duration?.dataPoints).toHaveLength(1);
    expect(duration?.dataPoints[0]?.attributes.route).toBeDefined();
    expect(duration?.dataPoints[0]?.attributes.statusCode).toBeDefined();

    expect(count).toBeDefined();
    expect(count?.descriptor.unit).toBe(OTEL_METRIC_DEFINITIONS.httpRequestCount.unit);
    expect(count?.dataPoints).toHaveLength(1);
    expect(count?.dataPoints[0]?.attributes.route).toBeDefined();
    expect(count?.dataPoints[0]?.attributes.statusCode).toBeDefined();
  });
});

describe("O5.6 / verification item 5 — RED metrics reach a real OTLP HTTP endpoint", () => {
  it("exports actual metric payloads to a stub collector when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    const collector = new StubCollector();
    const endpoint = await collector.start();
    try {
      const configured = buildOtelFromEnv(
        { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
        { serviceName: "t", component: "app" },
      );

      const fastify = buildApp(
        testAppOptions({
          logger: capturingLogger().logger,
          mintId: mintSessionId,
          metrics: configured.metrics,
          tracer: configured.tracer,
        }),
      );
      await fastify.inject({ method: "GET", url: "/healthz" });
      await fastify.inject({ method: "GET", url: "/other" });
      await fastify.close();

      // shutdown() forces the periodic metric reader to collect and export now — the
      // assertion is on what actually left the process, not on SDK internals.
      await configured.shutdown();

      const hits = collector.hits("/v1/metrics");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      let totalBytes = 0;
      for (const hit of hits) {
        expect(hit.bytes).toBeGreaterThan(0);
        // The repo's no-native-builds policy keeps protobufjs out, so OTel 2.x's
        // HTTP exporter emits the JSON encoding of OTLP (application/json); accept
        // either encoding — the contract under test is a real exported payload.
        expect(hit.contentType ?? "").toMatch(/json|protobuf/);
        totalBytes += hit.bytes;
      }
      expect(totalBytes).toBeGreaterThan(0);
    } finally {
      await collector.stop();
    }
  });
});
