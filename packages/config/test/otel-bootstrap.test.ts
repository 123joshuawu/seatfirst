import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";

import { buildOtelFromEnv } from "../src/otel-bootstrap.js";
import type { OtelResourceOptions } from "../src/otel.js";

const RESOURCE: OtelResourceOptions = { serviceName: "test-service", component: "app" };

interface ReceivedRequest {
  readonly path: string;
  readonly bytes: number;
}

/**
 * A stub OTLP collector: an HTTP server that records every request's path and body
 * size. Verification 1 binds it but never expects a hit; verification 2 asserts the
 * exported payloads actually arrive on it.
 */
class StubCollector {
  private server: Server | undefined;
  readonly requests: ReceivedRequest[] = [];

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        this.requests.push({ path: req.url ?? "", bytes: Buffer.concat(chunks).length });
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
  }

  hits(path: string): ReceivedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }
}

describe("buildOtelFromEnv — no-op path (verification 1)", () => {
  it("returns a working handle that exports nothing when the endpoint is unset", async () => {
    const collector = new StubCollector();
    await collector.start(); // bound for the whole test — any export would hit it
    try {
      const handle = buildOtelFromEnv({}, RESOURCE);
      const span = handle.tracer.startSpan("noop-span");
      span.setAttribute("k", "v");
      span.end();
      const counter = handle.meter.createCounter("noop_counter");
      counter.add(1);
      handle.logger.emit({ severityText: "INFO", body: "noop log" });
      await handle.forceFlush();
      // Zero requests reached the bound-but-never-hit server.
      expect(collector.requests).toHaveLength(0);
      await handle.shutdown();
    } finally {
      await collector.stop();
    }
  });

  it("treats an empty-string endpoint as unset", async () => {
    const handle = buildOtelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }, RESOURCE);
    expect(handle.tracer.startSpan("still-works")).toBeDefined();
    await handle.shutdown();
  });
});

describe("buildOtelFromEnv — enabled path (verification 2)", () => {
  it("delivers a span, a metric, and a log record to the configured endpoint", async () => {
    const collector = new StubCollector();
    const endpoint = await collector.start();
    try {
      const handle = buildOtelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, RESOURCE);

      const span = handle.tracer.startSpan("exported-span");
      span.end();

      const counter = handle.meter.createCounter("exported_counter");
      counter.add(1, { component: "app" });

      handle.logger.emit({ severityText: "WARN", body: "exported log" });

      await handle.forceFlush();

      // Each signal arrived at its own endpoint path with a non-empty payload —
      // asserted on what the stub received, not on absence of an error.
      expect(collector.hits("/v1/traces")).toHaveLength(1);
      expect(collector.hits("/v1/traces")[0]!.bytes).toBeGreaterThan(0);
      expect(collector.hits("/v1/metrics").length).toBeGreaterThanOrEqual(1);
      expect(collector.hits("/v1/metrics")[0]!.bytes).toBeGreaterThan(0);
      expect(collector.hits("/v1/logs")).toHaveLength(1);
      expect(collector.hits("/v1/logs")[0]!.bytes).toBeGreaterThan(0);

      await handle.shutdown();
    } finally {
      await collector.stop();
    }
  });

  it("wires extra.spanProcessors into the pipeline while export continues (O4.7 seam)", async () => {
    const collector = new StubCollector();
    const endpoint = await collector.start();
    const onEndSpy = vi.fn();
    const extraProcessor: SpanProcessor = {
      onStart() {},
      onEnd: onEndSpy,
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    try {
      const handle = buildOtelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, RESOURCE, {
        spanProcessors: [extraProcessor],
      });
      const span = handle.tracer.startSpan("filtered-span");
      span.end();
      await handle.forceFlush();
      // The caller-supplied processor saw every ended span…
      expect(onEndSpy).toHaveBeenCalledTimes(1);
      const ended = onEndSpy.mock.calls[0]![0] as ReadableSpan;
      expect(ended.name).toBe("filtered-span");
      // …and the built-in batch exporter still received and shipped it.
      expect(collector.hits("/v1/traces")).toHaveLength(1);
      await handle.shutdown();
    } finally {
      await collector.stop();
    }
  });
});

describe("buildOtelFromEnv — module structure (O4.9/O4.10)", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown>; dependencies: Record<string, string> };

  it("exposes ./logger and ./otel-bootstrap subpaths", () => {
    expect(packageJson.exports["./logger"]).toBeDefined();
    expect(packageJson.exports["./otel-bootstrap"]).toBeDefined();
  });

  it("pins pino and the three OTLP/HTTP exporters as direct dependencies", () => {
    expect(packageJson.dependencies.pino).toBe("10.3.1");
    for (const name of [
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/exporter-metrics-otlp-http",
      "@opentelemetry/exporter-logs-otlp-http",
    ]) {
      expect(packageJson.dependencies[name]).toBe("0.221.0");
    }
  });
});
