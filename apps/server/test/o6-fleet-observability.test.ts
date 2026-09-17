import { PassThrough } from "node:stream";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { poolClient } from "@seatfirst/durability";
import type { SqlClient } from "@seatfirst/durability";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import { createLogger } from "@seatfirst/config/logger";

import {
  createDispatchWorkers,
  createPlaceholderRegistry,
  dispatchJobMessage,
  dispatchRunMessage,
  implementedHandler,
} from "../src/dispatch/index.js";
import type { DispatchDeps, JobHandlerContext, RunHandlerContext } from "../src/dispatch/index.js";
import { createRelayPublisher, pollOnce } from "../src/relay/index.js";
import type { RelayMessage } from "../src/relay/publisher.js";
import { runSweeper } from "../src/sweeper/index.js";
import type { SweepTickSummary } from "../src/sweeper/index.js";
import { redisConnectionFromEnv } from "../src/queue/index.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";
import { until } from "./support/queue-redis.js";
import { seedJobOutbox, seedRunOutbox } from "./support/relay-db.js";
import { capturingLogger } from "./support/logger.js";
import type { LogCall } from "./support/logger.js";

/**
 * O6 verification items 2, 3 and 5 — the three proofs the original task landed only at
 * unit level:
 *
 * 2. Cross-process correlation end to end: one seeded outbox row flows relay → BullMQ →
 *    dispatch consumer → handler, and the combined structured log stream (real processes'
 *    real code paths against live Postgres + Redis) yields a non-empty, chronologically
 *    ordered sequence spanning all four stages. The relay's claim line carries `outbox_id`
 *    (the relay never joins to `search`), so the correlation key is the outbox→targetId
 *    linkage: claim line by `outbox_id`, consumer/handler lines by `search_id`.
 * 3. Level discipline under a production-like `LOG_LEVEL=info` filter: the same sweeper
 *    scenario run through a real pino logger at `info` vs `debug` — zero debug-tier lines
 *    leak at `info`, strictly more lines appear at `debug`, none fewer.
 * 5. Metrics land per `targetKind` dimension: a JOB completion and a RUN completion
 *    recorded on the real dispatch instruments exported over OTLP/HTTP to a stub collector
 *    arrive as two distinct series (`target_kind=JOB` vs `target_kind=RUN`). FULL/PARTIAL
 *    fetch-worker outcomes are pinned separately at unit level
 *    (`provider-fetch-actor.test.ts`).
 *
 * Item 6 (OTel-disabled parity) holds structurally for items 2–3 — neither scenario
 * touches OTel at all (`DispatchDeps.metrics` is optional and omitted) — and for item 5's
 * enabled-path counterpart `buildOtelFromEnv({}, …)` is exercised by
 * `app-logging.test.ts` (O5.4). Item 1 is a repo-wide grep recorded in review.md; item 4's
 * two seam tests exist (`fetch-worker-logger.test.ts`, `theatres.movies.test.ts`).
 */

// --- shared fixture (one Postgres 16 + Redis 7 pair; testcontainers or env URLs) -----

let pg: TestService;
let redis: TestService;
let pool: Pool;
let redisAdmin: IORedis.Redis;
let jobQueue: Queue<RelayMessage>;
let runQueue: Queue<RelayMessage>;
let aggregateQueue: Queue<RelayMessage & { searchId: string }>;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  await migrateDatabase(pg.url);

  pool = new Pool({ connectionString: pg.url, max: 2 });
  redisAdmin = new IORedis.Redis(redis.url, { lazyConnect: true });
  await redisAdmin.connect();

  const connection = redisConnectionFromEnv({ REDIS_URL: redis.url });
  jobQueue = new Queue<RelayMessage>("job-queue", { connection });
  runQueue = new Queue<RelayMessage>("run-queue", { connection });
  aggregateQueue = new Queue("aggregate-queue", { connection });
  jobQueue.on("error", () => {});
  runQueue.on("error", () => {});
  aggregateQueue.on("error", () => {});
});

afterAll(async () => {
  await Promise.allSettled([
    jobQueue.close(),
    runQueue.close(),
    aggregateQueue.close(),
    pool.end(),
  ]);
  redisAdmin.disconnect();
  await Promise.allSettled([pg.stop(), redis.stop()]);
});

beforeEach(async () => {
  await pool.query("TRUNCATE search, run_key CASCADE");
  await jobQueue.drain();
  await runQueue.drain();
  await aggregateQueue.drain();
});

const db = (): SqlClient => poolClient(pool);

// --- item 2: cross-process correlation ----------------------------------------------

describe("O6 item 2 — cross-process correlation, end to end", () => {
  it("relay → BullMQ → dispatch → handler leaves a chronological search_id-correlated trail", async () => {
    const tag = `corr_${Date.now().toString(36)}`;
    const { outboxId, jobId, searchId } = await seedJobOutbox(db(), tag);

    // Stage 1 — the relay process: sweep claims the row and publishes to BullMQ. Both the
    // pollOnce logger and the publisher log into the same capturing logger, exactly as
    // the entrypoint wires them.
    const relayLogger = capturingLogger();
    const publisher = createRelayPublisher({ url: redis.url }, relayLogger);
    const swept = await pollOnce(db(), publisher, {
      batchSize: 10,
      retryBackoff: "1 second",
      logger: relayLogger,
    });
    expect(swept.published).toBe(1);

    // Stages 2–4 — the dispatch-worker process: consume from the real queue via S11's
    // workers; the handler logs through ctx.logger (O6.3 child with job/search ids).
    const handlerSeen: string[] = [];
    const registry = {
      ...createPlaceholderRegistry(),
      job: {
        ...createPlaceholderRegistry().job,
        SHOWTIME_FETCH: implementedHandler<(ctx: JobHandlerContext) => void>((ctx) => {
          handlerSeen.push(ctx.job.jobId);
          ctx.logger.info({ stage: "handler" }, "showtime fetch handler ran");
        }),
      },
    };
    const dispatchLogger = capturingLogger();
    const deps: DispatchDeps = { db: db(), registry, logger: dispatchLogger };
    const handle = createDispatchWorkers(
      deps,
      { job: jobQueue, run: runQueue, aggregate: aggregateQueue },
      { leaseTtl: "5 minutes" },
    );
    try {
      await until(() => Promise.resolve(handlerSeen.length > 0), {
        label: "SHOWTIME_FETCH handler invoked via BullMQ",
      });
      expect(handlerSeen).toEqual([jobId]);
    } finally {
      await handle.close();
    }
    await publisher.close();

    // The combined structured stream, correlated: relay lines carry outbox_id; everything
    // downstream of the lease carries search_id (O6.3 child bindings).
    const combined: { stage: string; call: LogCall }[] = [
      ...relayLogger.calls.map((call) => ({ stage: "relay", call })),
      ...dispatchLogger.calls.map((call) => ({ stage: "dispatch", call })),
    ];

    // Stage-spanning sequence for this search, in emission order:
    //   relay claim (outbox_id) → consumer receipt → handler line → completion line.
    const relayClaimIndex = combined.findIndex(
      ({ call }) =>
        call.fields["outbox_id"] === outboxId &&
        call.fields["target_id"] === jobId &&
        call.message === "outbox row claimed",
    );
    expect(relayClaimIndex).toBeGreaterThanOrEqual(0);

    const trail = combined
      .map((entry, index) => ({ ...entry, index }))
      .filter(({ call }) => call.fields["search_id"] === searchId);
    expect(trail.length).toBeGreaterThanOrEqual(3);
    expect(trail.map((t) => t.call.message)).toContain("JOB message received");
    expect(trail.map((t) => t.call.message)).toContain("handler completed");
    expect(trail.some((t) => t.call.fields["stage"] === "handler")).toBe(true);

    // Chronological across processes: every search_id-correlated line comes after the
    // relay claim that caused it, receipt precedes handler line precedes completion.
    for (const entry of trail) {
      expect(entry.index).toBeGreaterThan(relayClaimIndex);
    }
    const messages = trail.map((t) => t.call.message);
    const receiptPos = messages.indexOf("JOB message received");
    const handlerPos = messages.indexOf("showtime fetch handler ran");
    const completedPos = messages.indexOf("handler completed");
    expect(receiptPos).toBeGreaterThanOrEqual(0);
    expect(handlerPos).toBeGreaterThan(receiptPos);
    expect(completedPos).toBeGreaterThan(handlerPos);
  });
});

// --- item 3: level discipline --------------------------------------------------------

/** Minimal seed set for one tick of reclaimable work (raw INSERTs: seed data). */
async function seedOneExpiredLease(tag: string): Promise<void> {
  const client = db();
  const searchId = `srch_${tag}`;
  const keyId = `key_${tag}`;
  const jobId = `job_${tag}`;
  await client.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'RUNNING', now() + interval '10 minutes')`,
    [searchId, `sess_${tag}`, `idem_${tag}`, `hash_${tag}`],
  );
  await client.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
    [keyId, `st_${tag}`],
  );
  await client.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, generation, state, attempt,
                             lease_expires_at, deadline_at)
     VALUES ($1, $2, 'SHOWTIME_FETCH', $3, 0, 'LEASED', 1, now() - interval '1 minute',
             now() + interval '10 minutes')`,
    [jobId, searchId, keyId],
  );
}

/** A REAL pino logger at the given level, JSON lines captured off the destination. */
function pinoCapture(level: "info" | "debug"): {
  logger: ReturnType<typeof createLogger>;
  lines: () => { level: number; msg: string }[];
} {
  const raw: string[] = [];
  const destination = new PassThrough();
  destination.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim().length > 0) raw.push(line);
    }
  });
  const logger = createLogger({
    service: "seatfirst-sweeper-test",
    component: "worker",
    level,
    destination,
  });
  return {
    logger,
    lines: () => raw.map((line) => JSON.parse(line) as { level: number; msg: string }),
  };
}

async function runOneTick(logger: ReturnType<typeof createLogger>): Promise<SweepTickSummary[]> {
  const summaries: SweepTickSummary[] = [];
  const silent = capturingLogger();
  const handle = runSweeper(
    {
      pool,
      publisher: createRelayPublisher({ url: redis.url }, silent),
      aggregateQueue,
      redis: redisAdmin,
      logger,
    },
    {
      outboxBatch: 10,
      rearmAge: "1 minute",
      maxAttempts: 5,
      snapshotAge: "1 minute",
      computeSnapshotProjection: () => Promise.resolve(),
      // Long interval: exactly one tick runs, then stop() aborts the sleep.
      tickIntervalMs: 60_000,
      onTickComplete: (summary) => summaries.push(summary),
    },
  );
  try {
    await until(() => Promise.resolve(summaries.length >= 1), {
      label: "one sweeper tick",
      timeoutMs: 15_000,
      intervalMs: 20,
    });
  } finally {
    await handle.stop();
  }
  return summaries;
}

describe("O6 item 3 — level discipline under LOG_LEVEL=info", () => {
  it("info drops all debug-tier lines; debug shows strictly more; info is a subset", async () => {
    // Identical scenario twice: re-seed between runs so both ticks do the same work.
    await seedOneExpiredLease(`lvl_info_${Date.now().toString(36)}`);
    const infoRun = pinoCapture("info");

    const infoSummaries = await runOneTick(infoRun.logger);
    expect(infoSummaries.length).toBe(1);

    await pool.query("TRUNCATE search, run_key CASCADE");
    await seedOneExpiredLease(`lvl_debug_${Date.now().toString(36)}`);
    const debugRun = pinoCapture("debug");
    const debugSummaries = await runOneTick(debugRun.logger);
    expect(debugSummaries.length).toBe(1);

    const infoLines = infoRun.lines();
    const debugLines = debugRun.lines();

    // Production-like filter: nothing below info (pino level 30) leaks through...
    for (const line of infoLines) {
      expect(line.level).toBeGreaterThanOrEqual(30);
    }
    // ...while the same scenario at debug shows strictly more lines, including the
    // known debug-tier housekeeping lines ("none fewer": every info line's message also
    // appears at debug).
    expect(debugLines.length).toBeGreaterThan(infoLines.length);
    const debugMsgs = debugLines.map((l) => l.msg);
    for (const line of infoLines) {
      expect(debugMsgs).toContain(line.msg);
    }
    expect(debugMsgs).toContain("sweeper tick started");
    expect(debugMsgs).toContain("sweeper tick completed");
  });
});

// --- item 5: JOB vs RUN distinct metric series over real OTLP export ------------------

/** The slice of an OTLP/JSON metrics export this suite inspects. */
interface OtlpMetricsExport {
  resourceMetrics: {
    scopeMetrics: {
      metrics: {
        name: string;
        sum?: {
          dataPoints: {
            attributes?: { key: string; value: { stringValue?: string } }[];
          }[];
        };
      }[];
    }[];
  }[];
}

class StubCollector {
  private server: Server | undefined;
  readonly requests: {
    path: string;
    bytes: number;
    contentType: string | undefined;
    body: Buffer;
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
          body: Buffer.concat(chunks),
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

  hits(path: string): { bytes: number; contentType: string | undefined; body: Buffer }[] {
    return this.requests.filter((request) => request.path === path);
  }
}

describe("O6 item 5 — JOB vs RUN completions land as distinct exported series", () => {
  it("exports target_kind-differentiated dispatch series to a stub OTLP endpoint", async () => {
    const tag = `metric_${Date.now().toString(36)}`;
    const jobSeed = await seedJobOutbox(db(), `${tag}_j`);
    const runSeed = await seedRunOutbox(db(), `${tag}_r`);

    const collector = new StubCollector();
    const endpoint = await collector.start();
    try {
      const configured = buildOtelFromEnv(
        { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
        { serviceName: "seatfirst-dispatch-test", component: "worker" },
      );

      const handler = (kind: "JOB" | "RUN") => (ctx: JobHandlerContext | RunHandlerContext) => {
        ctx.logger.info({ stage: "handler" }, `${kind} handler ran`);
      };
      const base = createPlaceholderRegistry();
      const registry = {
        ...base,
        job: { ...base.job, SHOWTIME_FETCH: implementedHandler(handler("JOB")) },
        run: { ...base.run, SHOWTIME_FETCH: implementedHandler(handler("RUN")) },
      };
      const deps: DispatchDeps = {
        db: db(),
        registry,
        logger: capturingLogger(),
        metrics: configured.metrics,
      };

      // One JOB completion and one RUN completion through the real consumer paths.
      await dispatchJobMessage(
        deps,
        { leaseTtl: "5 minutes" },
        {
          outboxId: jobSeed.outboxId,
          targetKind: "JOB",
          targetId: jobSeed.jobId,
          traceparent: null,
        },
      );
      await dispatchRunMessage(
        deps,
        { leaseTtl: "5 minutes" },
        {
          outboxId: runSeed.outboxId,
          targetKind: "RUN",
          targetId: runSeed.runId,
          traceparent: null,
        },
      );

      // shutdown() forces the periodic reader to collect and export now — the assertion
      // is on what actually left the process, not on SDK internals.
      await configured.shutdown();

      const hits = collector.hits("/v1/metrics");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      let sawJobSeries = false;
      let sawRunSeries = false;
      let totalBytes = 0;
      for (const hit of hits) {
        expect(hit.bytes).toBeGreaterThan(0);
        expect(hit.contentType ?? "").toMatch(/json|protobuf/);
        totalBytes += hit.bytes;
        // OTel 2.x emits the JSON encoding of OTLP here (no protobufjs build allowed);
        // parse each exported payload for the dispatchHandlerCompleted data points.
        if ((hit.contentType ?? "").includes("json")) {
          // OTLP/JSON encodes attributes as a {key, value} pair list.
          const payload = JSON.parse(hit.body.toString("utf8")) as unknown as OtlpMetricsExport;
          for (const rm of payload.resourceMetrics ?? []) {
            for (const sm of rm.scopeMetrics ?? []) {
              for (const metric of sm.metrics ?? []) {
                if (metric.name !== "seatfirst.dispatch.handler.completed") continue;
                for (const point of metric.sum?.dataPoints ?? []) {
                  const kind = (point.attributes ?? []).find((attr) => attr.key === "target_kind")
                    ?.value.stringValue;
                  if (kind === "JOB") sawJobSeries = true;
                  if (kind === "RUN") sawRunSeries = true;
                }
              }
            }
          }
        }
      }
      expect(totalBytes).toBeGreaterThan(0);
      expect(sawJobSeries).toBe(true);
      expect(sawRunSeries).toBe(true);
    } finally {
      await collector.stop();
    }
  });
});
