/**
 * O2 slice A — startup duration + readiness-probe duration/outcome telemetry.
 *
 * Drives a real warm-Chrome launch against the synthetic readiness page (the same
 * offline harness values corridor.test.ts uses) and asserts what the recording
 * functions put on the wire: the fixed contract instrument names/units and a
 * provider-attributed data point per instrument.
 *
 * `@opentelemetry/sdk-metrics` is not a dependency of this package, so the stub
 * below is a minimal in-process `MeterProvider` against `@opentelemetry/api`
 * types only: it registers instruments and collects data points synchronously.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metrics, type Meter, type MetricOptions } from "@opentelemetry/api";
import { ATTR_PROVIDER_ID, ATTR_READINESS_PROBE_OUTCOME } from "../src/observability.js";
import { startReadinessServer, type ReadinessServer } from "../src/readiness-server.js";
import { BrowserSupervisor } from "../src/supervisor.js";
import { findChromeExecutable } from "./support/chrome.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — browser-runtime launch-telemetry suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers (gate 14 tunables are injected per call).
const READINESS_MS = 20_000;
const PROVIDER_ID = "telemetry-launch-test";

// The O2 contract fixes these names and units; asserted literally, not via imports,
// so a drifted implementation cannot drag its own test along with it.
const STARTUP_DURATION = "seatfirst.browser_runtime.chrome.startup.duration";
const PROBE_DURATION = "seatfirst.browser_runtime.chrome.readiness_probe.duration";
const PROBE_COUNT = "seatfirst.browser_runtime.chrome.readiness_probe.count";

interface StubDataPoint {
  readonly value: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

type StubKind = "histogram" | "counter";

class StubInstrument {
  readonly points: StubDataPoint[] = [];

  constructor(
    readonly name: string,
    readonly kind: StubKind,
    readonly unit: string,
  ) {}

  record(value: number, attributes?: Record<string, string | number | boolean>): void {
    this.points.push({ value, attributes: attributes ?? {} });
  }

  add(value: number, attributes?: Record<string, string | number | boolean>): void {
    this.points.push({ value, attributes: attributes ?? {} });
  }
}

/**
 * Synchronous stand-in for an OTel metric reader/exporter: the API-facing
 * instruments it hands out accumulate every recorded data point in-process.
 */
class StubRegistry {
  private readonly byKey = new Map<string, StubInstrument>();
  /** Histogram/counter instruments in creation order, for descriptor assertions. */
  readonly instruments: StubInstrument[] = [];

  private create(name: string, kind: StubKind, options?: MetricOptions): StubInstrument {
    const key = `${kind}:${name}`;
    let instrument = this.byKey.get(key);
    if (instrument === undefined) {
      instrument = new StubInstrument(name, kind, options?.unit ?? "");
      this.byKey.set(key, instrument);
      this.instruments.push(instrument);
    }
    return instrument;
  }

  histogram(name: string, options?: MetricOptions): StubInstrument {
    return this.create(name, "histogram", options);
  }

  counter(name: string, options?: MetricOptions): StubInstrument {
    return this.create(name, "counter", options);
  }

  find(name: string, kind: StubKind): StubInstrument | undefined {
    return this.byKey.get(`${kind}:${name}`);
  }
}

/** Installs the stub as the global meter provider; only this test's instruments flow into it. */
function installStubMeterProvider(registry: StubRegistry): void {
  const meter = {
    createHistogram: (name: string, options?: MetricOptions) => registry.histogram(name, options),
    createCounter: (name: string, options?: MetricOptions) => registry.counter(name, options),
    // Everything below is exercised by other O2 slices during a successful launch
    // (the process gauges register callbacks); the stub accepts them without collecting.
    createGauge: () => ({ record: () => {} }),
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => ({ addCallback: () => {}, removeCallback: () => {} }),
    createObservableCounter: () => ({ addCallback: () => {}, removeCallback: () => {} }),
    createObservableUpDownCounter: () => ({ addCallback: () => {}, removeCallback: () => {} }),
    addBatchObservableCallback: () => {},
    removeBatchObservableCallback: () => {},
  };
  const provider = {
    getMeter: (): Meter => meter as unknown as Meter,
  };
  metrics.setGlobalMeterProvider(provider);
}

describe.skipIf(chromeExecutable === null)("browser-runtime launch telemetry (O2 slice A)", () => {
  let registry: StubRegistry;
  let readiness: ReadinessServer;
  let supervisor: BrowserSupervisor;

  beforeAll(async () => {
    registry = new StubRegistry();
    installStubMeterProvider(registry);
    readiness = await startReadinessServer();
    supervisor = await BrowserSupervisor.start({
      executablePath: chromeExecutable as string,
      egressIdentityLabel: "telemetry-launch-egress-label",
      providerId: PROVIDER_ID,
      cleanupGracePeriodMs: 3_000,
      readinessTimeoutMs: READINESS_MS,
      readinessTargetUrl: readiness.baseUrl,
    });
  });

  afterAll(async () => {
    await supervisor?.shutdown().catch(() => {});
    await readiness?.close().catch(() => {});
    metrics.disable();
  });

  it("records one positive startup duration on the fixed-name ms histogram, attributed to the provider", () => {
    const instrument = registry.find(STARTUP_DURATION, "histogram");
    expect(instrument).toBeDefined();
    // Exactly one successful launch happened in beforeAll; a failed launch never records.
    expect(instrument!.points).toHaveLength(1);
    const point = instrument!.points[0]!;
    expect(point.value).toBeGreaterThan(0);
    expect(point.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);
  });

  it("records at least one successful readiness probe on both probe instruments with the fixed outcome vocabulary", () => {
    const histogram = registry.find(PROBE_DURATION, "histogram");
    const counter = registry.find(PROBE_COUNT, "counter");
    expect(histogram).toBeDefined();
    expect(counter).toBeDefined();

    const readyDurations = histogram!.points.filter(
      (point) => point.attributes[ATTR_READINESS_PROBE_OUTCOME] === "ready",
    );
    expect(readyDurations.length).toBeGreaterThanOrEqual(1);
    for (const point of readyDurations) {
      expect(point.value).toBeGreaterThan(0);
      expect(point.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);
    }

    const readyCounts = counter!.points.filter(
      (point) => point.attributes[ATTR_READINESS_PROBE_OUTCOME] === "ready",
    );
    expect(readyCounts.length).toBeGreaterThanOrEqual(1);
    for (const point of readyCounts) {
      expect(point.value).toBe(1);
      expect(point.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);
    }
  });

  it("exposes the fixed contract names and units on the exported instrument descriptors", () => {
    const descriptors = registry.instruments
      .map((instrument) => ({
        name: instrument.name,
        kind: instrument.kind,
        unit: instrument.unit,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(descriptors).toEqual([
      { name: PROBE_COUNT, kind: "counter", unit: "{probe}" },
      { name: PROBE_DURATION, kind: "histogram", unit: "ms" },
      { name: STARTUP_DURATION, kind: "histogram", unit: "ms" },
    ]);
  });

  it("uses the contract's literal `outcome` attribute key on every probe data point", () => {
    // Asserted with the literal key, not the exported constant, so renaming the
    // constant cannot mask a wire-format drift.
    const histogram = registry.find(PROBE_DURATION, "histogram");
    const counter = registry.find(PROBE_COUNT, "counter");
    const points = [...histogram!.points, ...counter!.points];
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(Object.keys(point.attributes)).toContain("outcome");
      expect(["ready", "timeout", "error"]).toContain(point.attributes["outcome"]);
    }
  });
});
