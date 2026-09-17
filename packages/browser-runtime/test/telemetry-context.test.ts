/**
 * O2.B telemetry tests — context-create/context-cleanup duration histograms and the
 * process-age / navigation-count / tree-wide resident-memory gauges (O2.2, O2.3).
 *
 * The metric-side assertions run against a stub `MeterProvider` built from
 * `@opentelemetry/api` types only: `@opentelemetry/sdk-metrics` is not a dependency of
 * this package (strict pnpm), and the contract under test is exactly what the API
 * receives — instrument names, units, recorded values, and the O2.10 `providerId`
 * attribute. Observable-gauge callbacks are driven manually with a fake
 * `ObservableResult`, which is what a real metric reader does at collection time.
 *
 * Skips (loudly) when no Chrome binary exists, mirroring `corridor.test.ts`: the CI
 * pinned browser test image supplies Chrome (I1); locally, a system Chrome is used.
 */

import { readFile } from "node:fs/promises";
import {
  metrics,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterProvider,
  type MetricAttributes,
  type MetricOptions,
  type ObservableCallback,
  type ObservableGauge,
  type ObservableResult,
  type UpDownCounter,
} from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ATTR_PROVIDER_ID } from "../src/observability.js";
import { startReadinessServer, type ReadinessServer } from "../src/readiness-server.js";
import { BrowserSupervisor } from "../src/supervisor.js";
import { findChromeExecutable } from "./support/chrome.js";

const PROVIDER_ID = "telemetry-context-provider";

const CONTEXT_CREATE_DURATION = "seatfirst.browser_runtime.chrome.context_create.duration";
const CONTEXT_CLEANUP_DURATION = "seatfirst.browser_runtime.chrome.context_cleanup.duration";
const PROCESS_AGE = "seatfirst.browser_runtime.chrome.process_age";
const NAVIGATION_COUNT = "seatfirst.browser_runtime.chrome.navigation_count";
const RESIDENT_MEMORY = "seatfirst.browser_runtime.chrome.resident_memory";

// Test-harness values, not policy numbers — the runtime tunables under gate 14
// (cleanup grace, readiness timeout) are injected per call, same as corridor.test.ts.
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;

interface CapturedHistogram {
  readonly name: string;
  readonly options: MetricOptions;
  readonly records: Array<{ readonly value: number; readonly attributes: Attributes }>;
}

interface CapturedObservableGauge {
  readonly name: string;
  readonly options: MetricOptions;
  readonly callbacks: Array<ObservableCallback<MetricAttributes>>;
}

interface StubMeterState {
  readonly histograms: Map<string, CapturedHistogram>;
  readonly observableGauges: Map<string, CapturedObservableGauge>;
}

function histogramOf(
  state: StubMeterState,
  name: string,
  options: MetricOptions | undefined,
): Histogram<MetricAttributes> {
  let captured = state.histograms.get(name);
  if (captured === undefined) {
    captured = { name, options: options ?? {}, records: [] };
    state.histograms.set(name, captured);
  }
  return {
    record: (value: number, attributes?: MetricAttributes) => {
      captured.records.push({ value, attributes: attributes ?? {} });
    },
  };
}

function observableGaugeOf(
  state: StubMeterState,
  name: string,
  options: MetricOptions | undefined,
): ObservableGauge<MetricAttributes> {
  let captured = state.observableGauges.get(name);
  if (captured === undefined) {
    captured = { name, options: options ?? {}, callbacks: [] };
    state.observableGauges.set(name, captured);
  }
  return {
    addCallback: (callback: ObservableCallback<MetricAttributes>) => {
      captured.callbacks.push(callback);
    },
    removeCallback: (callback: ObservableCallback<MetricAttributes>) => {
      const index = captured.callbacks.indexOf(callback);
      if (index >= 0) {
        captured.callbacks.splice(index, 1);
      }
    },
  };
}

/** A minimal Meter over @opentelemetry/api types: captures names, units, records, callbacks. */
function createStubMeter(state: StubMeterState): Meter {
  return {
    createGauge: <A extends MetricAttributes>(): Gauge<A> => ({ record: () => {} }),
    createHistogram: <A extends MetricAttributes>(
      name: string,
      options?: MetricOptions,
    ): Histogram<A> => histogramOf(state, name, options),
    createCounter: <A extends MetricAttributes>(): Counter<A> => ({ add: () => {} }),
    createUpDownCounter: <A extends MetricAttributes>(): UpDownCounter<A> => ({ add: () => {} }),
    createObservableGauge: <A extends MetricAttributes>(
      name: string,
      options?: MetricOptions,
    ): ObservableGauge<A> => observableGaugeOf(state, name, options),
    createObservableCounter: <A extends MetricAttributes>(
      name: string,
      options?: MetricOptions,
    ): ObservableGauge<A> => observableGaugeOf(state, name, options),
    createObservableUpDownCounter: <A extends MetricAttributes>(
      name: string,
      options?: MetricOptions,
    ): ObservableGauge<A> => observableGaugeOf(state, name, options),
    addBatchObservableCallback: (): void => {},
    removeBatchObservableCallback: (): void => {},
  };
}

/** Registers the stub as the global meter provider, before any instrument is created. */
function installStubMeterProvider(): StubMeterState {
  const state: StubMeterState = { histograms: new Map(), observableGauges: new Map() };
  const provider: MeterProvider = { getMeter: () => createStubMeter(state) };
  const registered = metrics.setGlobalMeterProvider(provider);
  if (!registered) {
    throw new Error(
      "stub meter provider registration failed: a metrics global is already registered in this worker",
    );
  }
  return state;
}

interface Observation {
  readonly value: number;
  readonly attributes: Attributes;
}

/** Runs every registered callback on a gauge, exactly like a reader's collection pass. */
async function collectGauge(state: StubMeterState, name: string): Promise<Observation[]> {
  const gauge = state.observableGauges.get(name);
  expect(gauge).toBeDefined();
  const observations: Observation[] = [];
  const result: ObservableResult<MetricAttributes> = {
    observe(value: number, attributes?: MetricAttributes): void {
      observations.push({ value, attributes: attributes ?? {} });
    },
  };
  for (const callback of gauge!.callbacks) {
    await callback(result);
  }
  return observations;
}

/** Leader-only resident memory (bytes) from `/proc/<pid>/status` — the test's own independent read. */
async function vmRssBytes(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  for (const line of status.split("\n")) {
    if (line.startsWith("VmRSS:")) {
      const kb = Number(line.slice("VmRSS:".length).trim().split(/\s+/)[0]);
      if (Number.isFinite(kb) && kb > 0) {
        return kb * 1024;
      }
    }
  }
  throw new Error(`no VmRSS line for pid ${pid}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — browser-runtime context-telemetry suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

describe.skipIf(chromeExecutable === null)("O2.B context/process telemetry", () => {
  let readiness: ReadinessServer;
  let supervisor: BrowserSupervisor;
  let meterState: StubMeterState;

  beforeAll(async () => {
    // The stub must be the global provider BEFORE #launch() registers the gauges.
    meterState = installStubMeterProvider();
    readiness = await startReadinessServer();
    supervisor = await BrowserSupervisor.start({
      executablePath: chromeExecutable as string,
      egressIdentityLabel: "telemetry-context-eip",
      providerId: PROVIDER_ID,
      cleanupGracePeriodMs: GRACE_MS,
      readinessTimeoutMs: READINESS_MS,
      readinessTargetUrl: readiness.baseUrl,
    });
  });

  afterAll(async () => {
    await supervisor.shutdown().catch(() => {});
    await readiness.close().catch(() => {});
    metrics.disable();
  });

  it("process-age getter and gauge report a small positive age shortly after start (O2.2)", async () => {
    // Let the clock tick past the launch-completion millisecond.
    await sleep(25);

    const ageBefore = supervisor.processAgeMs;
    expect(ageBefore).toBeGreaterThan(0);
    expect(ageBefore).toBeLessThan(30_000);

    const gauge = meterState.observableGauges.get(PROCESS_AGE);
    expect(gauge).toBeDefined();
    expect(gauge!.name).toBe(PROCESS_AGE);
    expect(gauge!.options.unit).toBe("ms");

    const observations = await collectGauge(meterState, PROCESS_AGE);
    const ageAfter = supervisor.processAgeMs;
    // The gauge must observe exactly what the getter reports: sandwiched between the
    // two direct reads, and attributed to the provider.
    expect(observations).toHaveLength(1);
    expect(observations[0]!.value).toBeGreaterThanOrEqual(ageBefore);
    expect(observations[0]!.value).toBeLessThanOrEqual(ageAfter);
    expect(observations[0]!.attributes).toEqual({ [ATTR_PROVIDER_ID]: PROVIDER_ID });
  });

  it("navigation count increments per newContext and resets on recycle (O2.2)", async () => {
    expect(supervisor.navigationCount).toBe(0);

    await supervisor.newContext();
    expect(supervisor.navigationCount).toBe(1);
    await supervisor.newContext({ userAgent: "SeatFinder-Test/1.0" });
    expect(supervisor.navigationCount).toBe(2);

    const gauge = meterState.observableGauges.get(NAVIGATION_COUNT);
    expect(gauge).toBeDefined();
    expect(gauge!.options.unit).toBe("{navigation}");

    const observations = await collectGauge(meterState, NAVIGATION_COUNT);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.value).toBe(2);
    expect(observations[0]!.attributes).toEqual({ [ATTR_PROVIDER_ID]: PROVIDER_ID });

    // The two leaked contexts die with the tree on recycle — no per-context cleanup
    // needed. A successful recycle relaunches, which resets the counters.
    await supervisor.recycle();
    expect(supervisor.navigationCount).toBe(0);
    expect(supervisor.processAgeMs).toBeGreaterThanOrEqual(0);
    expect(supervisor.processAgeMs).toBeLessThan(30_000);
  });

  it("resident-memory is a tree-wide /proc sum, or reports no point where /proc is unavailable (O2.3)", async () => {
    const pgid = supervisor.chromeProcessGroupId;
    expect(pgid).toBeGreaterThan(0);

    const gauge = meterState.observableGauges.get(RESIDENT_MEMORY);
    expect(gauge).toBeDefined();
    expect(gauge!.options.unit).toBe("By");

    if (process.platform === "linux") {
      const direct = await supervisor.residentMemoryBytes();
      expect(direct).not.toBeNull();
      if (direct === null) {
        throw new Error("residentMemoryBytes returned null on a /proc-capable platform");
      }
      expect(direct).toBeGreaterThan(0);

      // Positive control: the leader PID's own VmRSS, computed independently here.
      // The tree-wide sum must never be smaller than the leader alone — proving the
      // gauge sums the whole process group, not just the group leader.
      const leaderOnly = await vmRssBytes(pgid);
      expect(leaderOnly).toBeGreaterThan(0);
      expect(direct).toBeGreaterThanOrEqual(leaderOnly);

      const observations = await collectGauge(meterState, RESIDENT_MEMORY);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.value).toBeGreaterThan(0);
      expect(observations[0]!.value).toBeGreaterThanOrEqual(leaderOnly);
      expect(observations[0]!.attributes).toEqual({ [ATTR_PROVIDER_ID]: PROVIDER_ID });
    } else {
      // Documented non-Linux fallback (O2.3): no /proc on this platform, so the getter
      // resolves null and the gauge callback observes NO data point for the cycle —
      // never a fabricated zero or a null-valued point.
      expect(await supervisor.residentMemoryBytes()).toBeNull();
      expect(await collectGauge(meterState, RESIDENT_MEMORY)).toEqual([]);
    }
  });

  it("context-create and context-cleanup durations record positive values with the provider attribute (O2.1)", async () => {
    const create = meterState.histograms.get(CONTEXT_CREATE_DURATION);
    expect(create).toBeDefined();
    expect(create!.name).toBe(CONTEXT_CREATE_DURATION);
    expect(create!.options.unit).toBe("ms");
    const createsBefore = create!.records.length;

    const context = await supervisor.newContext();

    expect(create!.records.length).toBe(createsBefore + 1);
    const createRecord = create!.records[create!.records.length - 1]!;
    expect(createRecord.value).toBeGreaterThan(0);
    expect(createRecord.attributes).toEqual({ [ATTR_PROVIDER_ID]: PROVIDER_ID });

    // A loaded page makes the close non-trivial, exercising the real cleanup path.
    const page = await context.newPage();
    await page.goto(readiness.baseUrl, { waitUntil: "load", timeout: READINESS_MS });

    await supervisor.cleanupContext(context);

    // The cleanup histogram is created lazily on first record, so assert it after.
    const cleanup = meterState.histograms.get(CONTEXT_CLEANUP_DURATION);
    expect(cleanup).toBeDefined();
    expect(cleanup!.name).toBe(CONTEXT_CLEANUP_DURATION);
    expect(cleanup!.options.unit).toBe("ms");
    expect(cleanup!.records.length).toBe(1);
    const cleanupRecord = cleanup!.records[0]!;
    expect(cleanupRecord.value).toBeGreaterThan(0);
    expect(cleanupRecord.attributes).toEqual({ [ATTR_PROVIDER_ID]: PROVIDER_ID });
  });

  it("resident-memory resolves null once the supervisor is shut down (group id cleared)", async () => {
    // A dedicated instance: shutdown clears the process-group id, so the getter must
    // report "no measurement" rather than a stale tree sum.
    const local = await BrowserSupervisor.start({
      executablePath: chromeExecutable as string,
      egressIdentityLabel: "telemetry-context-eip-local",
      providerId: PROVIDER_ID,
      cleanupGracePeriodMs: GRACE_MS,
      readinessTimeoutMs: READINESS_MS,
      readinessTargetUrl: readiness.baseUrl,
    });
    await local.shutdown();
    expect(await local.residentMemoryBytes()).toBeNull();
  });
});
