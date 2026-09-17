/**
 * O8 Verification 3 fixture — the pg-instrumentation ordering harness, run in a child
 * process per direction because the module patch is once-per-process by design.
 *
 * Mirrors apps/server/src/index.ts's dynamic-import pattern:
 *   bootstrap-first: register instrumentation, THEN import pg → spans appear.
 *   pg-first:        import pg first → registration is too late → no spans.
 *
 * "SELECT 1" is a connectivity probe, not state movement (CONTRIBUTING §2's raw-SQL rule
 * governs state transitions; this fixture performs none).
 */
const mode = process.argv[2];

if (mode === "pg-first") {
  await import("pg");
}

const { buildOtelFromEnv } = await import("@seatfirst/config/otel-bootstrap");
const { InMemorySpanExporter, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace");

const exporter = new InMemorySpanExporter();
const otel = buildOtelFromEnv(
  {},
  { serviceName: "o8-ordering-harness", component: "worker" },
  { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
);

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: process.env.O8_DATABASE_URL });
await pool.query("SELECT 1");
await otel.forceFlush();

const pgSpans = exporter
  .getFinishedSpans()
  .filter((span) => span.attributes["db.system.name"] !== undefined);

process.stdout.write(JSON.stringify({ mode, pgSpans: pgSpans.length }));

await pool.end();
await otel.shutdown().catch(() => {});
process.exit(0);
