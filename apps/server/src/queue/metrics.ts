import type { Meter, ObservableGauge } from "@opentelemetry/api";
import type { Queue } from "bullmq";
import { OTEL_METRIC_DEFINITIONS } from "@seatfirst/config/otel";

export interface QueueMetricsOptions {
  readonly meter: Meter;
  readonly queues: readonly [Queue, ...Queue[]];
}

export function registerQueueHealthMetrics(
  options: QueueMetricsOptions,
): readonly ObservableGauge[] {
  const countsDefinition = OTEL_METRIC_DEFINITIONS.queueJobCounts;
  const memoryDefinition = OTEL_METRIC_DEFINITIONS.queueMemoryUsed;
  const counts = options.meter.createObservableGauge(countsDefinition.name, {
    unit: countsDefinition.unit,
    description: countsDefinition.description,
  });
  counts.addCallback(async (result) => {
    await Promise.all(
      options.queues.map(async (queue) => {
        try {
          const values = await queue.getJobCounts();
          for (const [state, value] of Object.entries(values)) {
            result.observe(value, {
              "seatfirst.queue": queue.name,
              "seatfirst.queue.state": state,
            });
          }
        } catch {
          // Redis unavailable: emit no points for this queue and collection.
        }
      }),
    );
  });

  const memory = options.meter.createObservableGauge(memoryDefinition.name, {
    unit: memoryDefinition.unit,
    description: memoryDefinition.description,
  });
  memory.addCallback(async (result) => {
    await Promise.all(
      options.queues.map(async (queue) => {
        try {
          const client = await queue.client;
          const response = await client.info();
          const match = /(?:^|\n)used_memory:(\d+)/.exec(response);
          if (match) {
            result.observe(Number(match[1]), { "seatfirst.queue": queue.name });
          }
        } catch {
          // Redis unavailable: emit no points for this queue and collection.
        }
      }),
    );
  });

  return [counts, memory];
}
