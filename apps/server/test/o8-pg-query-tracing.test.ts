import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { context } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";

// registerTraceContextGlobals (@seatfirst/config/otel) touches no pg module, so it stays
// a static import. EVERY other helper here — the test-support files included, whose
// module graphs evaluate `pg` at static-import time (support/db.ts imports `pg` and
// `@seatfirst/durability`) — must be loaded AFTER the bootstrap call, so they are
// imported dynamically inside beforeAll below. That is exactly the production ordering
// constraint this task's tests exist to prove.
import {
  AsyncLocalStorageContextManager,
  registerTraceContextGlobals,
} from "@seatfirst/config/otel";

import type * as containersTypes from "./support/containers.js";
import type * as supportDbTypes from "./support/db.js";
import type * as durabilityTypes from "@seatfirst/durability";
import type * as bootstrapTypes from "@seatfirst/config/otel-bootstrap";

// Type-only imports are fully erased — they never evaluate `pg` — so the O8.2 ordering
// inside beforeAll stays real.
type TestService = containersTypes.TestService;
import type * as pgTypes from "pg";
type PgModule = typeof pgTypes;

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * O8 — Postgres query tracing through the one pg patch point (spec Verification 1–5).
 *
 * Every assertion below reads REAL exported span data: an in-memory capturing processor
 * rides `buildOtelFromEnv`'s `extra.spanProcessors` seam (the same spans the batch
 * processor exports), and a stub OTLP/HTTP collector proves the OTLP path actually
 * ships them. The installed instrumentation's actual emitted attribute names are
 * asserted against — the current semconv generation emits `db.system.name`,
 * `db.namespace`, and `db.query.text` (the spec's `db.system`/`db.statement` names
 * predate this generation; per O8.5(b) the actual output is the source of truth).
 *
 * One process-wide OTel handle is built once in beforeAll: the OTel globals bind on the
 * first `setGlobalTracerProvider` only, so every test shares that handle (and resets the
 * shared exporter between tests) rather than building per-test handles whose providers
 * would silently never become global.
 */

/** The PostgreSQL value under the current semantic-conventions generation. */
const DB_SYSTEM_POSTGRESQL = "postgresql";
const RESOURCE = { serviceName: "seatfirst-relay", component: "worker" as const };

function pgSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter((span) => span.attributes["db.system.name"] === DB_SYSTEM_POSTGRESQL);
}

function normalizeSql(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function querySpanByText(spans: readonly ReadableSpan[], sql: string): ReadableSpan | undefined {
  return pgSpans(spans).find(
    (span) =>
      span.name.startsWith("pg.query") &&
      normalizeSql(span.attributes["db.query.text"]) === normalizeSql(sql),
  );
}

/** Serializes every attribute key and value on every span — what the hygiene tests scan. */
function spanPayload(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      resource: span.resource.attributes,
    })),
  );
}

/**
 * Stub OTLP collector: records every request's path and body size. Verification 1
 * asserts the trace export actually arrives here (bytes, not parse — the exporter's
 * protobuf payload is opaque to this harness; attribute-level assertions read the
 * capturing processor's spans, which are the same span objects the batch exports).
 */
class StubCollector {
  private server: Server | undefined;
  private traceHits = 0;
  private traceBytes = 0;

  async start(): Promise<string> {
    this.server = createServer((request: IncomingMessage, response) => {
      request.on("data", (chunk: Buffer) => {
        if (request.url === "/v1/traces") this.traceBytes += chunk.byteLength;
      });
      request.on("end", () => {
        if (request.url === "/v1/traces") this.traceHits += 1;
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub collector failed to bind");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** Real received payload totals — hits and actual octets on /v1/traces. */
  stats(): { hits: number; bytes: number } {
    return { hits: this.traceHits, bytes: this.traceBytes };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

let seedCounter = 0;
function uniq(prefix: string): string {
  seedCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${seedCounter}`;
}

const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();

describe("O8 — pg query spans through createPool's pool", () => {
  let containers: typeof containersTypes;
  let supportDb: typeof supportDbTypes;
  let durability: typeof durabilityTypes;
  let pgModule: PgModule;
  let bootstrap: typeof bootstrapTypes;

  let pgService: TestService;
  let pool: InstanceType<PgModule["Pool"]>;
  let collector: StubCollector;
  let exporter: InMemorySpanExporter;
  let otel: ReturnType<typeof bootstrapTypes.buildOtelFromEnv>;

  beforeAll(async () => {
    // O8.2 ordering, inside this process: register FIRST, import pg-touching modules
    // (including the support files' own `pg` imports) after.
    const { ensurePgInstrumented } = await import("@seatfirst/config/otel-bootstrap");
    ensurePgInstrumented();
    [bootstrap, durability, pgModule, containers, supportDb] = await Promise.all([
      import("@seatfirst/config/otel-bootstrap"),
      import("@seatfirst/durability"),
      import("pg"),
      import("./support/containers.js"),
      import("./support/db.js"),
    ]);

    pgService = await containers.startTestPostgres();
    await supportDb.migrateDatabase(pgService.url);
    // O8 Verification 1's exact surface: the pool comes from durability's createPool,
    // the one construction point the instrumentation must cover.
    pool = durability.createPool({
      connectionString: pgService.url,
      // Test-harness plumbing numbers, not policy values (the container is throwaway).
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    registerTraceContextGlobals();

    // One shared handle: the stub OTLP endpoint proves the real export path, and the
    // capturing processor exposes span attributes without parsing protobuf payloads.
    collector = new StubCollector();
    const endpoint = await collector.start();
    exporter = new InMemorySpanExporter();
    otel = bootstrap.buildOtelFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, RESOURCE, {
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await Promise.allSettled([
      pool.end(),
      pgService.stop(),
      collector?.stop(),
      otel?.shutdown().catch(() => undefined),
    ]);
  });

  it("positive: a boundary-statement query exports a pg span carrying the static text (Verification 1)", async () => {
    // Real boundary statement through the real poolClient surface (O8's patch point).
    const searchId = uniq("search");
    await pool.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status,
                           deadline_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, 'PENDING_SCHEDULE', $5)`,
      [searchId, uniq("session"), uniq("idem"), uniq("hash"), FUTURE],
    );
    const keyId = uniq("key");
    await pool.query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
      [keyId, uniq("showtime")],
    );
    const runId = uniq("run");
    await pool.query(
      `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
       VALUES ($1, $2, $3, 'PENDING', 0, 0)`,
      [runId, keyId, uniq("obs")],
    );
    const outboxRows = await durability.runStatement<{ outbox_id: string }>(
      durability.poolClient(pool),
      durability.OUTBOX_CREATE_RUN,
      [runId, null],
    );
    expect(outboxRows).toHaveLength(1);

    await otel.forceFlush();

    // The boundary statement's static text rides the span (placeholders, never values).
    const querySpan = querySpanByText(
      exporter.getFinishedSpans(),
      durability.OUTBOX_CREATE_RUN.text,
    );
    expect(querySpan).toBeDefined();
    // The OTLP path actually shipped real payload bytes to the stub endpoint.
    expect(collector.stats().hits).toBeGreaterThan(0);
    expect(collector.stats().bytes).toBeGreaterThan(0);
  });

  it("negative control: bound values never appear anywhere in the exported payload (Verification 2)", async () => {
    const boundSecret = "o8-bound-value-must-never-leak-9f2c";
    const sql = "SELECT $1::text";
    await durability.poolClient(pool).query(sql, [boundSecret]);
    await otel.forceFlush();

    const querySpan = querySpanByText(exporter.getFinishedSpans(), sql);
    expect(querySpan).toBeDefined();
    // Placeholder text survives; the bound value does not exist anywhere in the payload.
    expect(normalizeSql(querySpan?.attributes["db.query.text"])).toBe(sql);
    expect(spanPayload(exporter.getFinishedSpans())).not.toContain(boundSecret);
  });

  it("hygiene: no credential leakage; every pg span carries component=db; resource stays worker (Verification 4)", async () => {
    // A credential-bearing connection string (deliberately fake credentials) used for
    // one query issued through its own pool — the hygiene scan runs over everything.
    const credUrl = "postgres://o8_census_owner:o8-super-secret-password@127.0.0.1:1/o8_census";
    const credPool = new pgModule.Pool({ connectionString: credUrl, connectionTimeoutMillis: 50 });
    await expect(
      durability.poolClient(credPool).query("SELECT $1::text", ["hygiene"]),
    ).rejects.toThrow();
    credPool.removeAllListeners?.("error");

    // The main pool supplies the actual exported pg spans for the hygiene scan.
    await durability.poolClient(pool).query("SELECT $1::text", ["hygiene"]);
    await otel.forceFlush();

    const all = exporter.getFinishedSpans();
    expect(pgSpans(all).length).toBeGreaterThan(0);
    const payload = spanPayload(all);
    // No attribute anywhere carries the credential-bearing URL or any credential from it
    // (O8.5b — verified against actual output, not documentation).
    expect(payload).not.toContain(credUrl);
    expect(payload).not.toContain("o8-super-secret-password");
    expect(payload).not.toContain("o8_census_owner");
    // Every pg-derived span carries the db component at span level...
    for (const span of pgSpans(all)) {
      expect(span.attributes["seatfirst.component"]).toBe("db");
    }
    // ...and NO non-pg span is mislabeled as db (O8.5(a) is scoped to pg-derived spans).
    for (const span of all) {
      if (span.attributes["db.system.name"] === DB_SYSTEM_POSTGRESQL) continue;
      expect(span.attributes["seatfirst.component"]).not.toBe("db");
    }
    // ...while the hosting process's resource dimension is unchanged (relay = worker).
    for (const span of all) {
      expect(span.resource.attributes["seatfirst.component"]).toBe("worker");
    }
  });

  it("ordering: bootstrap before pg's first evaluation yields spans; after yields none (Verification 3)", async () => {
    // Child-process harness: the two directions cannot share a process, because the
    // module patch is once-per-process by design. The fixture mirrors index.ts's
    // dynamic-import ordering: (a) bootstrap → import pg → query; (b) import pg →
    // bootstrap → query. "SELECT 1" is a connectivity probe, not state movement.
    const run = async (mode: "bootstrap-first" | "pg-first"): Promise<number> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [join(here, "fixtures", "o8-ordering-probe.mjs"), mode],
        {
          cwd: join(here, "..", ".."),
          env: { ...process.env, O8_DATABASE_URL: pgService.url },
        },
      );
      const parsed = JSON.parse(stdout.trim()) as { pgSpans: number };
      return parsed.pgSpans;
    };

    const bootstrappedFirst = await run("bootstrap-first");
    expect(bootstrappedFirst).toBeGreaterThan(0);

    const pgLoadedFirst = await run("pg-first");
    expect(pgLoadedFirst).toBe(0);
  });

  it("nesting with O7's context manager: the pg span parents onto the awaited caller span (Verification 5, post-O7)", async () => {
    const sql = "SELECT $1::text";
    await otel.tracer.startActiveSpan("o8 nested caller span", async (caller) => {
      await durability.poolClient(pool).query(sql, ["nest"]);
      caller.end();
    });
    await otel.forceFlush();

    const callerSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "o8 nested caller span");
    const querySpan = querySpanByText(exporter.getFinishedSpans(), sql);
    expect(callerSpan).toBeDefined();
    expect(querySpan).toBeDefined();
    // sdk-trace v2 exposes the parent as `parentSpanContext` (the old `parentSpanId`
    // getter no longer exists on ReadableSpan).
    // The instrumentation nests the query inside its own connection-acquisition chain
    // (pg.query -> pg.connect -> pg-pool.connect), so the assertion is ancestor reachability:
    // the awaited caller span must appear in the query span's parent chain on one shared trace.
    const byId = new Map(exporter.getFinishedSpans().map((sp) => [sp.spanContext().spanId, sp]));
    const ancestors: string[] = [];
    let cursor = querySpan?.parentSpanContext?.spanId;
    while (cursor !== undefined && !ancestors.includes(cursor)) {
      ancestors.push(cursor);
      cursor = byId.get(cursor)?.parentSpanContext?.spanId;
    }
    expect(ancestors).toContain(callerSpan?.spanContext().spanId);
    expect(querySpan?.spanContext().traceId).toBe(callerSpan?.spanContext().traceId);
  });

  it("nesting without a context manager: the same query exports as a disconnected root, then propagation restores (Verification 5, pre-O7)", async () => {
    // Simulate the pre-O7 state WITHOUT poisoning suite order: the disabled state lasts
    // only for this test — a fresh dependency-free context manager is installed again in
    // the finally block, and the nested probe at the end proves propagation is restored.
    context.disable();
    const rootlessSql = "SELECT 'no-nest'::text";
    const restoredSql = "SELECT 'restored'::text";
    try {
      await otel.tracer.startActiveSpan("o8 rootless caller span", async (caller) => {
        await durability.poolClient(pool).query(rootlessSql);
        caller.end();
      });
      await otel.forceFlush();

      const querySpan = querySpanByText(exporter.getFinishedSpans(), rootlessSql);
      expect(querySpan).toBeDefined();
      // Disconnected root: no parent context at all (or only an invalid id), on its own
      // fresh trace rather than the awaited caller's.
      const parentCtx = querySpan?.parentSpanContext;
      const hasNoParent =
        (parentCtx === undefined || /^[0]+$/.test(parentCtx.spanId ?? "0")) &&
        !(querySpan as { parentSpanId?: string }).parentSpanId;
      expect(hasNoParent).toBe(true);
      const callerSpan = exporter
        .getFinishedSpans()
        .find((span) => span.name === "o8 rootless caller span");
      expect(querySpan?.spanContext().traceId === callerSpan?.spanContext().traceId).toBe(false);
    } finally {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    }

    exporter.reset();
    await otel.tracer.startActiveSpan("o8 restored probe", async (caller) => {
      await durability.poolClient(pool).query(restoredSql);
      caller.end();
    });
    await otel.forceFlush();

    const restoredCaller = exporter
      .getFinishedSpans()
      .find((span) => span.name === "o8 restored probe");
    const restoredQuery = querySpanByText(exporter.getFinishedSpans(), restoredSql);
    expect(restoredCaller).toBeDefined();
    expect(restoredQuery).toBeDefined();
    const ancestors: string[] = [];
    let cursor = restoredQuery?.parentSpanContext?.spanId;
    while (cursor !== undefined && !ancestors.includes(cursor)) {
      ancestors.push(cursor);
      cursor = exporter.getFinishedSpans().find((sp) => sp.spanContext().spanId === cursor)
        ?.parentSpanContext?.spanId;
    }
    expect(ancestors).toContain(restoredCaller?.spanContext().spanId);
  }, 30_000);
});
