import { Queue } from "bullmq";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { context, propagation, trace, type Span } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { OUTBOX_CREATE_RUN, poolClient, runStatement } from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";
import { registerTraceContextGlobals } from "@seatfirst/config/otel";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import {
  createDispatchWorkers,
  createPlaceholderRegistry,
  implementedHandler,
} from "../src/dispatch/index.js";
import type {
  DispatchDeps,
  DispatchHandle,
  DispatchRegistry,
  RunHandlerFn,
} from "../src/dispatch/index.js";
import type { RelayMessage } from "../src/relay/publisher.js";
import type { AggregateHintMessage } from "../src/sweeper/index.js";
import { publish } from "../src/queue/index.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { until } from "./support/queue-redis.js";

/**
 * O7.9 — the falsifiable end-to-end proof of cross-process trace-context propagation:
 * a simulated HTTP request span's `traceparent` is captured via `propagation.inject`
 * (O7.6), carried as an `outbox.traceparent` value through a real BullMQ publish (the
 * relay-publish hop) into the real dispatch workers (O7.7's extract + `context.with`),
 * and the RUN handler's span must then carry the SAME trace id — not merely "no error
 * was thrown". The negative control proves a null-traceparent row (the sweeper-rearm /
 * TMDB shape) still produces exactly today's behavior: a fresh root trace and no error.
 *
 * Raw INSERTs below are seed data only (the legitimate non-boundary bucket,
 * CONTRIBUTING.md §2); the outbox row itself is created through the real
 * `OUTBOX_CREATE_RUN` boundary with its O7.3 traceparent parameter.
 */

// O7.5 — install the global W3C propagator + async-local context manager for this test
// process (idempotent), so the extracted context survives every await inside the worker.
registerTraceContextGlobals();

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

async function seedSearch(pool: Pool): Promise<string> {
  const searchId = uniq("search");
  await pool.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status,
                         deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'PENDING_SCHEDULE', $5)`,
    [searchId, uniq("session"), uniq("idem"), uniq("hash"), FUTURE],
  );
  return searchId;
}

async function seedRunKey(pool: Pool): Promise<string> {
  const runKeyId = uniq("key");
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
    [runKeyId, uniq("showtime")],
  );
  return runKeyId;
}

async function seedRun(pool: Pool, runKeyId: string): Promise<string> {
  const runId = uniq("run");
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'PENDING', 0, 0)`,
    [runId, runKeyId, uniq("obs")],
  );
  return runId;
}

function capturingLogger(): SeatfirstLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => capturingLogger(),
  };
}

/** Simulates O7.6's HTTP-boundary capture: inject from an active request span. */
function captureTraceparent(tracer: ReturnType<TracerProvider["getTracer"]>): {
  traceparent: string;
  requestSpan: Span;
  requestTraceId: string;
} {
  const requestSpan = tracer.startSpan("simulated http request");
  const requestContext = trace.setSpan(context.active(), requestSpan);
  const carrier: Record<string, string> = {};
  propagation.inject(requestContext, carrier);
  const traceparent = carrier["traceparent"];
  if (traceparent === undefined) {
    throw new Error("propagation.inject produced no traceparent — W3C propagator missing");
  }
  return { traceparent, requestSpan, requestTraceId: requestSpan.spanContext().traceId };
}

describe("O7.9 — simulated create → relay-publish → dispatch-consume trace linkage", () => {
  let pg: TestService;
  let redis: TestService;
  let pool: Pool;
  let jobQueue: Queue<RelayMessage>;
  let runQueue: Queue<RelayMessage>;
  let aggregateQueue: Queue<AggregateHintMessage>;

  /** Spans from this tracer carry real, recordable trace ids (no-op tracers do not). */
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const tracer = provider.getTracer("o7-e2e");

  /**
   * The RUN handler opens a real active child span on this tracer (O7.9's "resulting
   * RUN handler span") and records its trace id — so the assertion below proves actual
   * span parentage through extract + context.with, not just an ambient read.
   */
  const observedTraceIds: string[] = [];
  const registry: DispatchRegistry = (() => {
    const base = createPlaceholderRegistry();
    return {
      ...base,
      run: {
        ...base.run,
        SHOWTIME_FETCH: implementedHandler<RunHandlerFn>(async (ctx) => {
          // With O7.5's context manager installed and O7.7 wrapping this handler in
          // context.with, startActiveSpan parents onto the extracted remote span (or a
          // fresh root when the message carries no traceparent).
          await tracer.startActiveSpan("resulting RUN handler span", (handlerSpan) => {
            handlerSpan.setAttribute("seatfirst.run_key_id", ctx.runKey.runKeyId);
            observedTraceIds.push(handlerSpan.spanContext().traceId);
            handlerSpan.end();
            return Promise.resolve();
          });
        }),
      },
    };
  })();

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = await startTestRedis();
    await migrateDatabase(pg.url);
    pool = new Pool({ connectionString: pg.url });
    const connection = { url: redis.url };
    jobQueue = new Queue<RelayMessage>("job-queue", { connection });
    runQueue = new Queue<RelayMessage>("run-queue", { connection });
    aggregateQueue = new Queue<AggregateHintMessage>("aggregate-queue", { connection });
  });

  afterAll(async () => {
    await Promise.allSettled([
      jobQueue.close(),
      runQueue.close(),
      aggregateQueue.close(),
      pool.end(),
    ]);
    await Promise.allSettled([pg.stop(), redis.stop()]);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE search, run_key CASCADE");
    await jobQueue.drain();
    await runQueue.drain();
    await aggregateQueue.drain();
    exporter.reset();
    observedTraceIds.length = 0;
  });

  const db = (): SqlClient => poolClient(pool);

  function startHarness(): DispatchHandle {
    const deps: DispatchDeps = { db: db(), registry, logger: capturingLogger() };
    return createDispatchWorkers(
      deps,
      { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
      { leaseTtl: "5 minutes" },
    );
  }

  /** Seeds one RUN's full row family plus its outbox row via the real O7.3 boundary. */
  async function seedRunInOutbox(
    traceparent: string | null,
  ): Promise<{ runId: string; outboxId: string }> {
    await seedSearch(pool);
    const keyId = await seedRunKey(pool);
    const runId = await seedRun(pool, keyId);
    const outboxRows = await runStatement<{ outbox_id: string }>(
      db(),
      OUTBOX_CREATE_RUN,
      traceparent === null ? [runId, null] : [runId, traceparent],
    );
    if (outboxRows.length !== 1) {
      throw new Error(`OUTBOX_CREATE_RUN returned ${outboxRows.length} rows`);
    }
    return { runId, outboxId: outboxRows[0]?.outbox_id ?? "" };
  }

  it("positive path: the handler span's traceId equals the originating request span's traceId", async () => {
    const { traceparent, requestSpan, requestTraceId } = captureTraceparent(tracer);
    const { runId, outboxId } = await seedRunInOutbox(traceparent);

    // Relay-publish hop: the exact message shape relay/daemon.ts builds for a widened
    // SWEEP_OVERDUE_OUTBOX row whose traceparent column is non-null (O7.4).
    const handle = startHarness();
    try {
      await publish(runQueue, "RUN", outboxId, {
        outboxId,
        targetKind: "RUN",
        targetId: runId,
        traceparent,
      });

      await until(() => Promise.resolve(observedTraceIds.length > 0), {
        label: "RUN handler invoked",
      });
    } finally {
      requestSpan.end();
      await handle.close();
    }

    expect(observedTraceIds).toEqual([requestTraceId]);
    // The linkage is real exported span data: the request span AND the handler's own
    // child span share the request's trace id across the queue boundary.
    const spansOnRequestTrace = exporter
      .getFinishedSpans()
      .filter((span) => span.spanContext().traceId === requestTraceId);
    expect(spansOnRequestTrace.length).toBeGreaterThanOrEqual(2);
  });

  it("negative control: a null-traceparent row produces a fresh root trace, never the prior one", async () => {
    // Establish a prior trace so "fresh" is falsifiable.
    const { requestSpan, requestTraceId } = captureTraceparent(tracer);
    requestSpan.end();

    // And an ACTIVE decoy context around the whole dispatch: a null traceparent must
    // mean ROOT_CONTEXT inside the consumer (fresh root), never the ambient caller span.
    const decoySpan = tracer.startSpan("decoy active span");
    const decoyTraceId = decoySpan.spanContext().traceId;
    const inDecoy = <T>(fn: () => Promise<T>): Promise<T> =>
      context.with(trace.setSpan(context.active(), decoySpan), fn);

    const { runId, outboxId } = await inDecoy(() => seedRunInOutbox(null));
    const handle = startHarness();
    try {
      // The sweeper-rearm/TMDB message shape: traceparent is null, never fabricated.
      await inDecoy(async () => {
        await publish(runQueue, "RUN", outboxId, {
          outboxId,
          targetKind: "RUN",
          targetId: runId,
          traceparent: null,
        });

        await until(() => Promise.resolve(observedTraceIds.length > 0), {
          label: "RUN handler invoked",
        });
      });
    } finally {
      decoySpan.end();
      await handle.close();
    }

    const handlerTraceId = observedTraceIds[0];
    expect(handlerTraceId).toBeDefined();
    expect(handlerTraceId).not.toBe(requestTraceId);
    expect(handlerTraceId).not.toBe(decoyTraceId);
    // A fresh root: not linked to ANY trace seen in this process during the run.
    expect(requestTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(handlerTraceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
