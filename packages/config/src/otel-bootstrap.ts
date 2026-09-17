/**
 * The one OTel bootstrap every process entrypoint calls (O4.5–O4.7): `buildOtelFromEnv`
 * turns `OTEL_EXPORTER_OTLP_ENDPOINT` into a working `ConfiguredOtel` handle — exporting
 * when the operator set it, a structural no-op when they did not ("wire otel but do not
 * require it").
 *
 * - The endpoint variable is the toggle itself, and its name comes from the
 *   OpenTelemetry env-var specification, not invented here. Unset/empty means disabled.
 * - Wire protocol is OTLP/HTTP (not gRPC), an engineering decision cited in O4.6: this
 *   workspace's `pnpm-workspace.yaml` `allowBuilds` disables native postinstall builds
 *   for gRPC-adjacent packages (`cpu-features`/`protobufjs`/`ssh2`), while the OTLP/HTTP
 *   exporters have no native dependency; `infra/config/observability/tempo.yaml` already
 *   opens the HTTP receiver on 4318.
 * - The four SDK numeric options come from ADR 0006 §C.3, accepted 2026-08-14 as written
 *   (`docs/adr/0006-capacity-cost-model-numeric-acceptance-criteria.md`, table under C.3):
 *   trace sampling ratio 1.0, batch max export batch size 512, batch scheduled delay 5 s,
 *   metric export interval 10 s. Sampling stays at the SDK default because 1.0 **is** the
 *   default sampler's ratio and `configureOtel` deliberately exposes no `sampler` option;
 *   ADR 0006 §C.3 names these "policy-authored config values", so the three that are set
 *   are set verbatim here rather than left implicit.
 * - Redaction seam (O4.7): caller-supplied `extra.spanProcessors` are prepended ahead of
 *   the batch span processor so a config-time attribute filter (S18.12's
 *   `InboundSpanAttributeFilter`, wired by O5) sees each span before export, per ADR
 *   0005 §A's config-time-not-post-hoc ordering requirement.
 * - Postgres query tracing (O8.2/O8.5): `PgInstrumentation` is registered here — exactly
 *   once per process, guarded — so every query through any `createPool()` pool emits a
 *   span, and a span processor stamps `seatfirst.component: "db"` on every pg-derived
 *   span (span-level cost attribution; the hosting process keeps its own resource
 *   component). Registration must happen before `pg`'s first module evaluation to take
 *   effect — process entrypoints order their bootstrap call accordingly (O8.2).
 *   `enhancedDatabaseReporting` is never enabled (O8.3): the only query payload on a
 *   span is the static statement text, which the durability discipline guarantees cannot
 *   carry user data. No instrumentation option value is authored here (O8.4).
 */
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace";

import {
  ATTR_SEATFIRST_COMPONENT,
  configureOtel,
  type ConfiguredOtel,
  type OtelResourceOptions,
} from "./otel.js";

/** ADR 0006 §C.3: "Batch export max size — 512 spans/records." */
const BATCH_MAX_EXPORT_BATCH_SIZE = 512;

/** ADR 0006 §C.3: "Batch export timeout — 5 s" (the batch processor flush cadence). */
const BATCH_SCHEDULED_DELAY_MS = 5_000;

/** ADR 0006 §C.3: "Export interval — 10 s" (the periodic metric reader cadence). */
const METRIC_EXPORT_INTERVAL_MS = 10_000;

/** Extra processors O4 hands to `buildOtelFromEnv`; see the module header (O4.7). */
export interface BuildOtelFromEnvExtra {
  /**
   * Prepended ahead of the built-in batch span processor so config-time filters run
   * first. Currently empty in production — O5 passes S18.12's span filter here.
   */
  readonly spanProcessors?: readonly SpanProcessor[];
}

/**
 * O8.2 — register the pg auto-instrumentation exactly once per process. `PgInstrumentation`
 * patches the `pg` module as Node loads it, so this must run before `pg`'s first module
 * evaluation to take effect — proven by test in both directions (O8's Verification 3):
 * bootstrapping first yields pg spans; loading `pg` first silently yields none.
 *
 * Process dispatchers (`apps/server/src/index.ts`, the fetch-worker container
 * entrypoints) call this ahead of their role-module imports because those modules'
 * import graphs evaluate `pg` at static-import time — earlier than any `buildOtelFromEnv`
 * call inside a role's own start body could run. Idempotent by guard: every
 * `buildOtelFromEnv` call reaches the same no-op-after-first registration, and tests
 * building multiple handles never stack instrumentations.
 *
 * Constructed with NO options (O8.3/O8.4): `enhancedDatabaseReporting` is never enabled —
 * statement text only, never parameter values or result rows — and no
 * `requireParentSpan`-style boolean is authored here; leaving it unset rides the library's
 * own documented default rather than repo-invented policy.
 */
let pgInstrumentationRegistered = false;

export function ensurePgInstrumented(): void {
  if (pgInstrumentationRegistered) {
    return;
  }
  pgInstrumentationRegistered = true;
  registerInstrumentations({ instrumentations: [new PgInstrumentation()] });
}

/** The instrumentation scope every pg-derived span carries (verified against actual output). */
export const PG_INSTRUMENTATION_SCOPE = "@opentelemetry/instrumentation-pg";

/**
 * O8.5(a) — stamps `seatfirst.component: "db"` on pg-derived spans only, identified by the
 * pg instrumentation's scope name (the dimension's first producer). HTTP/worker/caller
 * spans from other scopes keep their own attribution; the hosting process's resource
 * component is never consulted or mutated. Applied via `onStart` so even a force-flushed
 * span carries it before any export path sees the span.
 */
class DbComponentSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    if (span.instrumentationScope.name !== PG_INSTRUMENTATION_SCOPE) {
      return;
    }
    span.setAttribute(ATTR_SEATFIRST_COMPONENT, "db");
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Build the process-wide OTel setup from the environment (O4.5). Call once per process.
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` unset this is exactly `configureOtel`'s documented
 * no-op path: every returned handle still works (`tracer.startSpan()`,
 * `meter.createCounter()`, `logger.emit()`), nothing is exported anywhere, and existing
 * global-API call sites keep behaving as today. With it set, all three signals are
 * exported via OTLP/HTTP to `<endpoint>/v1/{traces,metrics,logs}`.
 */
export function buildOtelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  resource: OtelResourceOptions,
  extra?: BuildOtelFromEnvExtra,
): ConfiguredOtel {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // O8.2 — registered on both paths: an unset endpoint means "export nothing", not "trace
  // nothing" — the disabled path stays structurally identical (OTel-disabled parity).
  ensurePgInstrumented();
  // Caller-supplied processors are honored on both paths (a caller-passed processor may
  // capture or transform; without an exporter nothing leaves the process).
  if (endpoint === undefined || endpoint === "") {
    return configureOtel({
      resource,
      spanProcessors: [new DbComponentSpanProcessor(), ...(extra?.spanProcessors ?? [])],
      metricReaders: [],
      logRecordProcessors: [],
    });
  }
  const url = `${endpoint}/v1/traces`;
  const metricsUrl = `${endpoint}/v1/metrics`;
  const logsUrl = `${endpoint}/v1/logs`;

  // The db-component stamp rides the extra.spanProcessors seam ahead of the batch
  // processor (O8.5a); caller-supplied processors keep their O4.7 first position.
  const spanProcessors: SpanProcessor[] = [
    new DbComponentSpanProcessor(),
    ...(extra?.spanProcessors ?? []),
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({ url }),
      maxExportBatchSize: BATCH_MAX_EXPORT_BATCH_SIZE,
      scheduledDelayMillis: BATCH_SCHEDULED_DELAY_MS,
    }),
  ];

  return configureOtel({
    resource,
    spanProcessors,
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: metricsUrl }),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: logsUrl }),
        maxExportBatchSize: BATCH_MAX_EXPORT_BATCH_SIZE,
        scheduledDelayMillis: BATCH_SCHEDULED_DELAY_MS,
      }),
    ],
  });
}
