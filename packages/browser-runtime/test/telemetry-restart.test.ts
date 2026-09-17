/**
 * O2.4 / O2.7 restart-reason telemetry suite (slice C).
 *
 * The three fixed reasons — `deliberate_recycle`, `forced_cleanup_replace`,
 * `unexpected_exit` — are genuinely distinguished: recycle intent, the forced
 * kill-and-replace cleanup branch, and an out-of-band tree death each produce their
 * own labeled point. Supervisor-initiated kills (shutdown, forceShutdown, the
 * launch-failure cleanup kill) never masquerade as a restart under any reason.
 *
 * Real Chrome is driven against the local synthetic readiness page exactly like the
 * corridor suite. Metrics are read through an in-file stub `MeterProvider` built
 * against `@opentelemetry/api` types only — `@opentelemetry/sdk-metrics` is not a
 * dependency of this package, and adding one just for a test reader is not warranted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  metrics,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterProvider,
  type MetricAttributes,
  type MetricOptions,
  type ObservableCounter,
  type ObservableGauge,
  type ObservableUpDownCounter,
  type UpDownCounter,
} from "@opentelemetry/api";
import { BrowserSupervisor } from "../src/supervisor.js";
import { startReadinessServer, type ReadinessServer } from "../src/readiness-server.js";
import {
  ATTR_PROVIDER_ID,
  ATTR_RESTART_REASON,
  CHROME_RECYCLE_DURATION_METRIC,
  CHROME_RESTART_METRIC,
} from "../src/observability.js";
import { findChromeExecutable } from "./support/chrome.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — browser-runtime restart-telemetry suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers: the runtime tunables under gate 14
// (cleanup grace, readiness timeout) are injected per call below (ADR 0006 / P6.18).
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;
const PROVIDER_ID = "provider-restart-telemetry";
const EGRESS_LABEL = "restart-telemetry-relay-label";

/** One synchronous instrument observation, captured verbatim by the stub meter. */
interface RecordingPoint {
  readonly name: string;
  readonly unit: string | undefined;
  readonly value: number;
  readonly attributes: MetricAttributes;
}

/**
 * Stub metric reader: every `record()`/`add()` observation is appended to a plain
 * array, carrying the instrument name and the unit captured at creation time — the
 * O2.1/O2.4 discipline of asserting fixed names/units, not just "something emitted".
 */
class RecordingMeterProvider implements MeterProvider {
  readonly points: RecordingPoint[] = [];

  getMeter(): Meter {
    return new RecordingMeter(this.points);
  }
}

class RecordingMeter implements Meter {
  readonly #points: RecordingPoint[];

  constructor(points: RecordingPoint[]) {
    this.#points = points;
  }

  createHistogram<A extends MetricAttributes = MetricAttributes>(
    name: string,
    options?: MetricOptions,
  ): Histogram<A> {
    return {
      record: (value: number, attributes?: A) => {
        this.#points.push({
          name,
          unit: options?.unit,
          value,
          attributes: { ...(attributes ?? {}) },
        });
      },
    };
  }

  createCounter<A extends MetricAttributes = MetricAttributes>(
    name: string,
    options?: MetricOptions,
  ): Counter<A> {
    return {
      add: (value: number, attributes?: A) => {
        this.#points.push({
          name,
          unit: options?.unit,
          value,
          attributes: { ...(attributes ?? {}) },
        });
      },
    };
  }

  createGauge<A extends MetricAttributes = MetricAttributes>(): Gauge<A> {
    return { record: () => {} };
  }

  createUpDownCounter<A extends MetricAttributes = MetricAttributes>(): UpDownCounter<A> {
    return { add: () => {} };
  }

  createObservableGauge<A extends MetricAttributes = MetricAttributes>(): ObservableGauge<A> {
    return { addCallback: () => {}, removeCallback: () => {} };
  }

  createObservableCounter<A extends MetricAttributes = MetricAttributes>(): ObservableCounter<A> {
    return { addCallback: () => {}, removeCallback: () => {} };
  }

  createObservableUpDownCounter<
    A extends MetricAttributes = MetricAttributes,
  >(): ObservableUpDownCounter<A> {
    return { addCallback: () => {}, removeCallback: () => {} };
  }

  addBatchObservableCallback(): void {}

  removeBatchObservableCallback(): void {}
}

function isGroupDead(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: gone. EPERM: the group id was recycled by a foreign process — the
    // supervisor's tree is gone either way.
    return code === "ESRCH" || code === "EPERM";
  }
}

describe.skipIf(chromeExecutable === null)(
  "browser-runtime restart-reason telemetry (O2.4/O2.7)",
  () => {
    let readiness: ReadinessServer;
    let provider: RecordingMeterProvider;

    beforeAll(async () => {
      readiness = await startReadinessServer();
      provider = new RecordingMeterProvider();
      // First registration in this isolated module graph wins; a false return would
      // mean the stub never receives anything and every assertion below would fail.
      expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
    });

    afterAll(async () => {
      await readiness.close().catch(() => {});
    });

    beforeEach(() => {
      provider.points.length = 0;
    });

    function startSupervisor(): Promise<BrowserSupervisor> {
      return BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: EGRESS_LABEL,
        providerId: PROVIDER_ID,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
    }

    function restartPoints(): RecordingPoint[] {
      return provider.points.filter((p) => p.name === CHROME_RESTART_METRIC);
    }

    function restartReasons(): string[] {
      return restartPoints().map((p) => String(p.attributes[ATTR_RESTART_REASON]));
    }

    function recycleDurationPoints(): RecordingPoint[] {
      return provider.points.filter((p) => p.name === CHROME_RECYCLE_DURATION_METRIC);
    }

    it("recycle records deliberate_recycle and a positive recycle.duration", async () => {
      const supervisor = await startSupervisor();
      try {
        await supervisor.recycle();

        expect(restartReasons()).toEqual(["deliberate_recycle"]);
        const restart = restartPoints()[0]!;
        expect(restart.unit).toBe("{restart}");
        expect(restart.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);

        const durations = recycleDurationPoints();
        expect(durations).toHaveLength(1);
        expect(durations[0]!.unit).toBe("ms");
        expect(durations[0]!.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);
        expect(durations[0]!.value).toBeGreaterThan(0);
      } finally {
        await supervisor.shutdown().catch(() => {});
      }
    });

    it("an out-of-band SIGKILL records unexpected_exit and nothing else", async () => {
      const supervisor = await startSupervisor();
      const groupId = supervisor.chromeProcessGroupId;
      const exit = supervisor.waitForTreeExit();

      // Kill the tree directly, bypassing every supervisor method.
      process.kill(-groupId, "SIGKILL");
      const info = await exit;

      expect(info.signal).toBe("SIGKILL");
      expect(restartReasons()).toEqual(["unexpected_exit"]);
      const point = restartPoints()[0]!;
      expect(point.unit).toBe("{restart}");
      expect(point.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);

      // Teardown of an already-dead tree must not add a second point.
      await supervisor.shutdown().catch(() => {});
      expect(restartReasons()).toEqual(["unexpected_exit"]);
    });

    it("a wedged cleanup past the grace period records forced_cleanup_replace once", async () => {
      const supervisor = await startSupervisor();
      try {
        const context = await supervisor.newContext();
        const page = await context.newPage();
        // An active page (loopback readiness document — never AMC).
        await page.goto(readiness.baseUrl, { waitUntil: "load", timeout: READINESS_MS });

        const exit = supervisor.waitForTreeExit();
        const groupId = supervisor.chromeProcessGroupId;
        // Freeze the whole Chrome process group: every CDP-driven close now hangs,
        // which is the wedged-cleanup precondition.
        process.kill(-groupId, "SIGSTOP");
        const started = Date.now();
        await supervisor.cleanupContext(context);
        const elapsed = Date.now() - started;

        // The kill was observed, not just a timeout: the grace period elapsed before
        // the signal could resolve, and the tree died by SIGKILL (a stopped process
        // can only be reaped that way).
        expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);
        const info = await exit;
        expect(info.signal).toBe("SIGKILL");
        expect(isGroupDead(groupId)).toBe(true);
        // Capacity is retained: a replacement Chrome is warm.
        expect(supervisor.chromeProcessGroupId).not.toBe(groupId);

        expect(restartReasons()).toEqual(["forced_cleanup_replace"]);
        const point = restartPoints()[0]!;
        expect(point.unit).toBe("{restart}");
        expect(point.attributes[ATTR_PROVIDER_ID]).toBe(PROVIDER_ID);
      } finally {
        await supervisor.shutdown().catch(() => {});
      }
    });

    it("shutdown on a healthy supervisor records zero restart-reason points", async () => {
      const supervisor = await startSupervisor();
      await supervisor.shutdown();
      expect(restartPoints()).toHaveLength(0);
    });

    it("forceShutdown on a healthy supervisor records zero restart-reason points", async () => {
      const supervisor = await startSupervisor();
      await supervisor.forceShutdown();
      expect(restartPoints()).toHaveLength(0);
    });

    it("a launch failure rejects without recording any restart reason", async () => {
      // A loopback port that was bound and immediately released: connection-refused
      // is deterministic, so the readiness probe fails without a bespoke wait.
      const dead = await startReadinessServer();
      const deadUrl = dead.baseUrl;
      await dead.close();

      await expect(
        BrowserSupervisor.start({
          executablePath: chromeExecutable as string,
          egressIdentityLabel: EGRESS_LABEL,
          providerId: PROVIDER_ID,
          cleanupGracePeriodMs: GRACE_MS,
          readinessTimeoutMs: READINESS_MS,
          readinessTargetUrl: deadUrl,
        }),
      ).rejects.toThrow(/readiness probe failed/);

      expect(restartPoints()).toHaveLength(0);
    });
  },
);
