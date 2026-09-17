import { readFileSync } from "node:fs";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { logs as logsApi, SeverityNumber } from "@opentelemetry/api-logs";
import { metrics as metricsApi, trace as traceApi } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import { ATTR_SEATFIRST_COMPONENT, OTEL_METRIC_DEFINITIONS, configureOtel } from "../src/otel.js";

describe("configureOtel — traces", () => {
  it("is a no-op with no span processor configured, and a span reaches a processor when one is given", () => {
    // Falsifiability: this test fails in three independent ways if the behavior
    // regresses — (1) if the unset path throws instead of no-op'ing, (2) if the
    // wired path never reaches the exporter (e.g. `spanProcessors` stops being
    // threaded through), or (3) if the unset path secretly shares state with the
    // wired path (its span would show up in `exporter`).
    const exporter = new InMemorySpanExporter();

    const unset = configureOtel({ resource: { serviceName: "otel-test", component: "app" } });
    const wired = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });

    expect(() => {
      const span = unset.tracer.startSpan("unset-span");
      span.setAttribute("probe", true);
      span.end();
    }).not.toThrow();

    // Nothing was ever wired to `exporter` for the unset provider, so it stays empty.
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    const wiredSpan = wired.tracer.startSpan("wired-span");
    wiredSpan.end();

    // Positive control: the same kind of call, through a tracer actually wired to
    // the exporter, does reach it — and only it, never the unset span.
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished.map((span) => span.name)).toEqual(["wired-span"]);
  });

  it("attaches no span processor at all when unset — not merely 'the caller's own exporter never saw one'", () => {
    // B1: the test above proves the unset path never reached *this test's* stub
    // exporter, but that is not the guarantee O1.3 makes. The unset provider must
    // be structurally incapable of exporting *anywhere*, including to a processor
    // the unset path might attach on its own. Reviewer proof: temporarily making
    // the unset path attach `new SimpleSpanProcessor(new InMemorySpanExporter())` —
    // exactly the default-to-a-destination behavior O1.3 forbids — left the test
    // above green, because that processor's exporter was never the one the test
    // asserted against.
    //
    // `SdkTracerProvider` (`@opentelemetry/sdk-trace`) exposes its processor list
    // through no public getter — the only place it appears is the
    // `nodejs.util.inspect.custom` formatter it defines for itself
    // (`TracerProvider.js`'s `[inspectCustom]`), which node:util's `inspect` invokes.
    // That is the one honest, non-private way to observe "nothing is registered."
    const unset = configureOtel({ resource: { serviceName: "otel-test", component: "app" } });

    const rendered = inspect(unset.tracerProvider, { depth: null });
    expect(rendered).toContain("spanProcessors: []");

    // Positive control: this probe only proves something if the same rendering path
    // is also capable of showing a *non-empty* list. Without this, a future
    // `sdk-trace` release could keep emitting the literal `spanProcessors: []` for
    // every provider — including ones that HAVE acquired a processor by some other
    // route — and the assertion above would pass vacuously forever. Rendering a
    // provider actually wired to a processor and checking it looks different closes
    // that gap: if the SDK ever changes what `[inspectCustom]` reports, this
    // assertion is what fails, and it says plainly "the probe stopped observing what
    // it claims" rather than leaving the empty-case assertion to pass on regardless.
    const wired = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
    });
    const wiredRendered = inspect(wired.tracerProvider, { depth: null });
    expect(wiredRendered).toContain("spanProcessors: [ 'SimpleSpanProcessor' ]");
  });
});

interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** True when `value` is a plain `{ [name: string]: string }` map — a dependency block shape. */
function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Narrows `unknown` JSON to the two dependency blocks this test reads, verifying each
 * field at runtime rather than trusting an assumed shape (`JSON.parse` itself returns
 * `any`, which this function's caller never touches directly).
 */
function isDependencyManifest(value: unknown): value is DependencyManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { dependencies, devDependencies }: DependencyManifest = value as DependencyManifest;
  return (
    (dependencies === undefined || isStringRecord(dependencies)) &&
    (devDependencies === undefined || isStringRecord(devDependencies))
  );
}

describe("configureOtel — module structure", () => {
  it("imports no @opentelemetry/exporter-* module, so configureOtel itself stays structurally incapable of constructing an export destination", () => {
    // The honest test of O1.3's real invariant: not "an exporter happened not to
    // run in this test," but "configureOtel cannot import one to begin with." Since
    // O4 added OTLP/HTTP exporters to this package for `buildOtelFromEnv`
    // (`src/otel-bootstrap.ts`, ADR 0004 + ADR 0006 §C.3 now authorize them), the
    // package-level dependency assertion this test once made no longer holds by
    // design — so it narrows to the module that actually carries the invariant:
    // `src/otel.ts` must not import any `@opentelemetry/exporter-*` module, keeping
    // `configureOtel` incapable of defaulting to a destination.
    const source = readFileSync(new URL("../src/otel.ts", import.meta.url), "utf8");
    const exporterImports = source
      .split("\n")
      .filter((line) => /import\b/.test(line) && line.includes("@opentelemetry/exporter-"));
    expect(exporterImports).toEqual([]);

    // And the exporters that DO exist in the package are confined to the bootstrap
    // module — never reachable from `configureOtel`'s module graph.
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (!isDependencyManifest(packageJson)) {
      throw new Error("packages/config/package.json did not parse as a dependency manifest");
    }
    expect(
      Object.keys(packageJson.dependencies ?? {}).filter((name) =>
        name.startsWith("@opentelemetry/exporter-"),
      ),
    ).toEqual([
      "@opentelemetry/exporter-logs-otlp-http",
      "@opentelemetry/exporter-metrics-otlp-http",
      "@opentelemetry/exporter-trace-otlp-http",
    ]);
  });
});

describe("configureOtel — global registration", () => {
  it("registers the first call's providers as the process-wide globals; a later call in the same process cannot displace them, and both facts are visible on the returned handle and by reading back through the global API", async () => {
    // B2: `configureOtel`'s own JSDoc said the providers were registered "as the
    // process-wide global providers," unqualified — but `@opentelemetry/api`'s
    // `registerGlobal` refuses a second registration per process by default, and
    // nothing checked or surfaced the three ignored return values. Proven against the
    // built `dist/`: after a second `configureOtel`, `trace.getTracer()` still
    // resolved to the FIRST provider. A worker process where something calls
    // `configureOtel({component:"worker"})` after an earlier call would have every
    // span from library code using `trace.getTracer()` silently mis-tagged
    // `component=app`.
    //
    // `@opentelemetry/api`'s global registry is a real process-wide singleton, not a
    // mock, and it outlives any one `configureOtel` call — including calls made by
    // earlier tests in this file. `disable()` is the SDK's own public reset (used by
    // `TraceAPI`/`MetricsAPI`/`LogsAPI` themselves for exactly this purpose), so this
    // test forces a known-clean starting state instead of assuming it is first.
    traceApi.disable();
    metricsApi.disable();
    logsApi.disable();

    try {
      const firstSpanExporter = new InMemorySpanExporter();
      const secondSpanExporter = new InMemorySpanExporter();
      const firstMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const secondMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const firstLogExporter = new InMemoryLogRecordExporter();
      const secondLogExporter = new InMemoryLogRecordExporter();

      const first = configureOtel({
        resource: { serviceName: "global-probe-first", component: "app" },
        spanProcessors: [new SimpleSpanProcessor({ exporter: firstSpanExporter })],
        metricReaders: [new PeriodicExportingMetricReader({ exporter: firstMetricExporter })],
        logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: firstLogExporter })],
      });

      // Positive control: with a clean global registry, the first call wins all
      // three signals.
      expect(first.globalRegistration).toEqual({ trace: true, metrics: true, logs: true });

      const second = configureOtel({
        resource: { serviceName: "global-probe-second", component: "worker" },
        spanProcessors: [new SimpleSpanProcessor({ exporter: secondSpanExporter })],
        metricReaders: [new PeriodicExportingMetricReader({ exporter: secondMetricExporter })],
        logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: secondLogExporter })],
      });

      // The defect this proves absent: a second `configureOtel` call must not
      // silently become the new global delegate, and the caller must be able to see
      // that it did not.
      expect(second.globalRegistration).toEqual({ trace: false, metrics: false, logs: false });

      // Read back through the global API — not through either returned handle — to
      // prove where library code calling `trace.getTracer()` / `metrics.getMeter()` /
      // `logs.getLogger()` actually ends up: the FIRST provider, even after the
      // second `configureOtel` call.
      traceApi.getTracer("global-readback").startSpan("global-span").end();
      expect(firstSpanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "global-span",
      ]);
      expect(secondSpanExporter.getFinishedSpans()).toHaveLength(0);

      metricsApi.getMeter("global-readback").createCounter("otel.test.global_probe").add(1);
      await first.forceFlush();
      await second.forceFlush();
      const [firstResourceMetrics] = firstMetricExporter.getMetrics();
      const firstExportedNames = (
        firstResourceMetrics?.scopeMetrics.flatMap((s) => s.metrics) ?? []
      ).map((metric) => metric.descriptor.name);
      expect(firstExportedNames).toContain("otel.test.global_probe");
      expect(secondMetricExporter.getMetrics()).toHaveLength(0);

      logsApi
        .getLogger("global-readback")
        .emit({ body: "global-log", severityNumber: SeverityNumber.INFO });
      expect(firstLogExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
        "global-log",
      ]);
      expect(secondLogExporter.getFinishedLogRecords()).toHaveLength(0);
    } finally {
      // Leave the global registry clean for whatever runs after this test — it is
      // process-wide state and this test is the only one in the suite that touches it.
      traceApi.disable();
      metricsApi.disable();
      logsApi.disable();
    }
  });
});

describe("configureOtel — metrics", () => {
  it("is a no-op with no metric reader configured, and a metric reaches a reader when one is given", async () => {
    // Same shape as the traces no-op/reach test above, with a real negative control —
    // this used to be a bare `not.toThrow()`, which passes even if metric recording
    // silently exported somewhere it should not have.
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter });

    const unset = configureOtel({ resource: { serviceName: "otel-test", component: "app" } });
    const wired = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      metricReaders: [reader],
    });

    expect(() => {
      unset.metrics.rpcRequests.add(1, { "rpc.procedure": "searches.get" });
    }).not.toThrow();

    wired.metrics.rpcRequests.add(1, { "rpc.procedure": "searches.get" });
    await wired.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const allMetrics = resourceMetrics?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
    const rpcRequestsMetric = allMetrics.find(
      (metric) => metric.descriptor.name === OTEL_METRIC_DEFINITIONS.rpcRequests.name,
    );

    // Positive control: the wired call's recording reaches `exporter`. The unset
    // call's recording never could — its MeterProvider has no reader at all — so
    // exactly one data point (not a leaked second one from `unset`) is the negative
    // control.
    expect(rpcRequestsMetric?.dataPoints).toHaveLength(1);
  });

  it("reaches a configured metric reader/exporter, keyed by the documented instrument name, with hit and miss kept as distinct per-tier data points", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter });
    const configured = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      metricReaders: [reader],
    });

    configured.metrics.cacheAccess.add(1, { tier: "geometry", result: "hit" });
    configured.metrics.cacheAccess.add(1, { tier: "geometry", result: "miss" });

    // PeriodicExportingMetricReader batches on its own interval; forceFlush collects
    // and exports immediately without this module (or this test) picking an interval.
    await configured.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const allMetrics = resourceMetrics?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
    const cacheAccessMetric = allMetrics.find(
      (metric) => metric.descriptor.name === OTEL_METRIC_DEFINITIONS.cacheAccess.name,
    );

    expect(cacheAccessMetric).toBeDefined();
    expect(cacheAccessMetric?.descriptor.unit).toBe(OTEL_METRIC_DEFINITIONS.cacheAccess.unit);

    // Exact count, not `.toBeGreaterThan(0)`: "cache hit ratio per tier" (O1.6) is
    // only proven keyable if hit and miss stay two distinct data points. Dropping
    // the `tier`/`result` attributes at record time would collapse them into one
    // aggregated point and a `> 0` assertion would not notice.
    const dataPoints = cacheAccessMetric?.dataPoints ?? [];
    expect(dataPoints).toHaveLength(2);
    for (const dataPoint of dataPoints) {
      expect(Object.keys(dataPoint.attributes).sort()).toEqual(["result", "tier"]);
    }
    expect(dataPoints.map((dataPoint) => dataPoint.attributes.result).sort()).toEqual([
      "hit",
      "miss",
    ]);

    await configured.shutdown();
  });

  it("keeps every OTEL_METRIC_DEFINITIONS entry constructed as the exact name and unit createMetrics actually exports", async () => {
    // B3: the table test below (`describe("OTEL_METRIC_DEFINITIONS", ...)`) asserts
    // literals against `OTEL_METRIC_DEFINITIONS` itself, and the export test above
    // only exercises `cacheAccess`. Reviewer proof: changing `createMetrics` to emit
    // `rpcDuration` as `meter.createHistogram("probe.wrong.name", { unit: "s" })`
    // while leaving the table untouched left every existing test green. This test
    // records through every instrument `createMetrics` returns — not just
    // `cacheAccess` — and checks each one lands under its documented name and unit.
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter });
    const configured = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      metricReaders: [reader],
    });

    // `SeatfirstMetrics` is a nominal interface (not an index-signature type), so
    // spreading it into a fresh object literal is what lets `Object.values` below
    // keep its element type instead of widening to `any[]`.
    const instrumentsByKey: Readonly<
      Record<string, (typeof configured.metrics)[keyof typeof configured.metrics]>
    > = { ...configured.metrics };
    for (const instrument of Object.values(instrumentsByKey)) {
      if ("record" in instrument) {
        instrument.record(1);
      } else {
        instrument.add(1);
      }
    }

    await configured.forceFlush();

    const [resourceMetrics] = exporter.getMetrics();
    const exported = resourceMetrics?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
    const exportedByName = new Map(exported.map((metric) => [metric.descriptor.name, metric]));
    const definitionsByKey = OTEL_METRIC_DEFINITIONS as Record<
      string,
      { name: string; unit: string }
    >;
    for (const key of Object.keys(configured.metrics)) {
      expect(definitionsByKey[key], `${key} has no metric definition`).toBeDefined();
    }
    const asynchronousQueueMetricKeys = new Set(["queueJobCounts", "queueMemoryUsed"]);
    for (const [key, definition] of Object.entries(OTEL_METRIC_DEFINITIONS)) {
      if (asynchronousQueueMetricKeys.has(key)) {
        continue;
      }
      const metric = exportedByName.get(definition.name);
      expect(
        metric,
        `${key} (${definition.name}) was not exported under its documented name`,
      ).toBeDefined();
      expect(metric?.descriptor.unit, `${key} (${definition.name}) unit mismatch`).toBe(
        definition.unit,
      );
    }

    await configured.shutdown();
  });
});

describe("configureOtel — logs", () => {
  it("is a no-op with no log record processor configured, and a log record reaches a processor when one is given", () => {
    // Same shape as the traces no-op/reach test, with a real negative control — this
    // used to be a bare `not.toThrow()`.
    const exporter = new InMemoryLogRecordExporter();

    const unset = configureOtel({ resource: { serviceName: "otel-test", component: "app" } });
    const wired = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      logRecordProcessors: [new SimpleLogRecordProcessor({ exporter })],
    });

    expect(() => {
      unset.logger.emit({ body: "no-op log", severityNumber: SeverityNumber.INFO });
    }).not.toThrow();

    // Nothing was ever wired to `exporter` for the unset provider, so it stays empty.
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);

    wired.logger.emit({ body: "wired log", severityNumber: SeverityNumber.INFO });

    // Positive control: the same kind of call, through a logger actually wired to the
    // exporter, does reach it — and only it, never the unset call's record.
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("wired log");
  });

  it("reaches a configured log record processor/exporter", () => {
    const exporter = new InMemoryLogRecordExporter();
    const configured = configureOtel({
      resource: { serviceName: "otel-test", component: "app" },
      logRecordProcessors: [new SimpleLogRecordProcessor({ exporter })],
    });

    configured.logger.emit({ body: "wired log", severityNumber: SeverityNumber.INFO });

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("wired log");
  });
});

describe("configureOtel — resource attributes", () => {
  it("carries the caller-supplied service.name and component resource attributes onto exported spans", () => {
    const exporter = new InMemorySpanExporter();
    const configured = configureOtel({
      resource: { serviceName: "search-worker", component: "worker" },
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });

    configured.tracer.startSpan("resource-probe").end();

    const [span] = exporter.getFinishedSpans();
    expect(span?.resource.attributes["service.name"]).toBe("search-worker");
    expect(span?.resource.attributes[ATTR_SEATFIRST_COMPONENT]).toBe("worker");
  });
});

describe("OTEL_METRIC_DEFINITIONS", () => {
  // Falsifiable against O1.6: renaming or re-unitting an instrument here without
  // updating this table breaks the test, and vice versa — the table is the only
  // source these assertions are derived from independently of `createMetrics`.
  it("anticipates the architecture §10.1 metric set with names and units only", () => {
    expect(OTEL_METRIC_DEFINITIONS.rpcRequests.name).toBe("seatfirst.rpc.server.requests");
    expect(OTEL_METRIC_DEFINITIONS.rpcErrors.name).toBe("seatfirst.rpc.server.errors");
    expect(OTEL_METRIC_DEFINITIONS.rpcDuration).toMatchObject({
      name: "seatfirst.rpc.server.duration",
      unit: "ms",
    });
    expect(OTEL_METRIC_DEFINITIONS.cacheAccess).toMatchObject({
      name: "seatfirst.cache.access",
      unit: "{access}",
    });
    expect(OTEL_METRIC_DEFINITIONS.searchFunnelAcceptedDuration.name).toBe(
      "seatfirst.search.funnel.accepted.duration",
    );
    expect(OTEL_METRIC_DEFINITIONS.searchFunnelFirstGroupDuration.name).toBe(
      "seatfirst.search.funnel.first_group.duration",
    );
    expect(OTEL_METRIC_DEFINITIONS.searchFunnelCompleteDuration.name).toBe(
      "seatfirst.search.funnel.complete.duration",
    );
    expect(OTEL_METRIC_DEFINITIONS.searchOutcomes.unit).toBe("{search}");

    // No key in the table encodes a threshold, SLO, or numeric acceptance value.
    // Checking `typeof value === "string"` alone is not enough — a threshold smuggled
    // in under a new key (e.g. `p95: "500"`) is still a string and would pass. Instead
    // assert the exact key set every entry is allowed to have, so no such key can hide
    // regardless of what type its value happens to be.
    for (const [key, definition] of Object.entries(OTEL_METRIC_DEFINITIONS)) {
      expect(Object.keys(definition).sort(), `${key} has unexpected keys`).toEqual([
        "description",
        "name",
        "unit",
      ]);
      for (const value of Object.values(definition)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});
