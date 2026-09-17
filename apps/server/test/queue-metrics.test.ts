import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { readFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { join } from "node:path";
import { configureOtel, OTEL_METRIC_DEFINITIONS } from "@seatfirst/config/otel";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import { describe, expect, it, vi } from "vitest";
import { registerQueueHealthMetrics } from "../src/queue/metrics.js";

type Observation = { value: number; attributes: Record<string, string> };
type CallbackResult = { observe: (value: number, attributes?: Record<string, string>) => void };
type Gauge = { addCallback: (callback: (result: CallbackResult) => Promise<void>) => void };

function setupQueues() {
  const queues = [
    {
      name: "fetch",
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1, failed: 3 }),
      client: Promise.resolve({ info: vi.fn().mockResolvedValue("# Memory\nused_memory:42\n") }),
    },
    {
      name: "tmdb",
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 4, active: 0, failed: 1 }),
      client: Promise.resolve({ info: vi.fn().mockResolvedValue("# Memory\nused_memory:84\n") }),
    },
  ];
  const callbacks: Array<(result: CallbackResult) => Promise<void>> = [];
  const meter = {
    createObservableGauge: vi.fn((name: string, options: object): Gauge => {
      void name;
      void options;
      return { addCallback: (callback) => callbacks.push(callback) };
    }),
  };
  registerQueueHealthMetrics({ meter: meter as never, queues: queues as never });
  return { queues, callbacks, meter };
}

describe("queue health metrics", () => {
  it("reports exact states and memory for every supplied queue", async () => {
    const { queues, callbacks, meter } = setupQueues();
    const countPoints: Observation[] = [];
    const memoryPoints: Observation[] = [];
    await callbacks[0]!({
      observe: (value, attributes) => countPoints.push({ value, attributes: attributes ?? {} }),
    });
    await callbacks[1]!({
      observe: (value, attributes) => memoryPoints.push({ value, attributes: attributes ?? {} }),
    });
    expect(meter.createObservableGauge).toHaveBeenNthCalledWith(
      1,
      OTEL_METRIC_DEFINITIONS.queueJobCounts.name,
      expect.objectContaining({ unit: OTEL_METRIC_DEFINITIONS.queueJobCounts.unit }),
    );
    expect(meter.createObservableGauge).toHaveBeenNthCalledWith(
      2,
      OTEL_METRIC_DEFINITIONS.queueMemoryUsed.name,
      expect.objectContaining({ unit: OTEL_METRIC_DEFINITIONS.queueMemoryUsed.unit }),
    );
    expect(
      countPoints.map((point) => [
        point.attributes["seatfirst.queue"],
        point.attributes["seatfirst.queue.state"],
        point.value,
      ]),
    ).toEqual([
      ["fetch", "waiting", 2],
      ["fetch", "active", 1],
      ["fetch", "failed", 3],
      ["tmdb", "waiting", 4],
      ["tmdb", "active", 0],
      ["tmdb", "failed", 1],
    ]);
    expect(countPoints.every((point) => point.attributes["seatfirst.queue"])).toBe(true);
    expect(memoryPoints).toEqual([
      { value: 42, attributes: { "seatfirst.queue": "fetch" } },
      { value: 84, attributes: { "seatfirst.queue": "tmdb" } },
    ]);
    expect(memoryPoints.every((point) => point.value > 0)).toBe(true);
    expect(queues).toHaveLength(2);
  });

  it("tolerates rejected queue and Redis reads without points", async () => {
    const queues = [
      {
        name: "rejected-client",
        getJobCounts: vi.fn().mockRejectedValue(new Error("down")),
        client: Promise.reject(new Error("down")),
      },
      {
        name: "rejected-info",
        getJobCounts: vi.fn().mockRejectedValue(new Error("down")),
        client: Promise.resolve({ info: vi.fn().mockRejectedValue(new Error("down")) }),
      },
    ];
    const callbacks: Array<(result: CallbackResult) => Promise<void>> = [];
    const meter = {
      createObservableGauge: vi.fn(() => ({
        addCallback: (callback: (result: CallbackResult) => Promise<void>) =>
          callbacks.push(callback),
      })),
    };
    registerQueueHealthMetrics({ meter: meter as never, queues: queues as never });
    const observe = vi.fn();
    await expect(callbacks[0]!({ observe })).resolves.toBeUndefined();
    await expect(callbacks[1]!({ observe })).resolves.toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps OTel disabled construction side-effect free", async () => {
    const configured = buildOtelFromEnv({}, { serviceName: "test", component: "worker" });
    const inertQueue = {
      name: "disabled",
      getJobCounts: vi.fn(),
      client: Promise.resolve({ info: vi.fn() }),
    };
    expect(() =>
      registerQueueHealthMetrics({ meter: configured.meter, queues: [inertQueue as never] }),
    ).not.toThrow();
    await expect(configured.forceFlush()).resolves.toBeUndefined();
    await expect(configured.shutdown()).resolves.toBeUndefined();
  });

  it("does not add ioredis instrumentation or emit spans", async () => {
    const root = join(process.cwd(), "../..");
    const workspacePackagePaths = globSync("**/package.json", {
      cwd: root,
      exclude: ["**/node_modules/**", "**/dist/**"],
    });
    const packageTexts = await Promise.all(
      workspacePackagePaths.map((path) => readFile(join(root, path), "utf8")),
    );
    expect(packageTexts.join("\n")).not.toContain("instrumentation-ioredis");
    const exporter = new InMemorySpanExporter();
    const configured = configureOtel({
      resource: { serviceName: "test", component: "worker" },
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    const { callbacks } = setupQueues();
    const observe = vi.fn();
    await callbacks[0]!({ observe });
    await callbacks[1]!({ observe });
    await configured.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await configured.shutdown();
  });
});
