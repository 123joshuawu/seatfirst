/**
 * One shared OpenTelemetry SDK setup, per `seatfirst-architecture.md:597` ("One
 * OpenTelemetry SDK setup in `packages/config`; traces, metrics, and logs all flow to
 * the self-hosted Grafana stack (or CloudWatch+AMP ... the OTel instrumentation is
 * identical either way, so this is swappable)").
 *
 * Scope of what this module decides, and what it deliberately does not:
 *
 * - It owns the *shape* of instrumentation: resource attributes (O1.5), and the
 *   instrument names/units the rest of the codebase will record against (O1.6,
 *   architecture §10.1).
 * - It does NOT own where telemetry goes. `configureOtel` never constructs an
 *   exporter and never reads an endpoint URL, env var, or hostname itself (O1.3).
 *   Grafana/Tempo/Loki vs. CloudWatch+AMP is an open deployment decision (ADR 0004,
 *   not written) and picking a wire protocol for a default OTLP exporter (HTTP vs.
 *   gRPC vs. proto, plus any auth headers) would decide part of that ADR by default.
 *   Instead, the caller supplies already-constructed `SpanProcessor` /
 *   `MetricReader` / `LogRecordProcessor` instances — the SDK's own extension
 *   points — via `ConfigureOtelOptions`. Supplying none for a signal is "unset",
 *   and that signal's provider is constructed with an empty processor/reader list,
 *   which cannot export anywhere: there is no code path here that can invent a
 *   destination. This package has no dependency on any `@opentelemetry/exporter-*`
 *   package at all, so it is structurally incapable of defaulting to localhost or
 *   anywhere else.
 * - It does NOT set a sampling ratio, batch size, export interval, or timeout
 *   anywhere (O1.4). Every SDK option below that could carry such a number
 *   (`sampler`, `spanLimits`, `forceFlushTimeoutMillis`, metric export interval,
 *   log record limits, batch sizes) is left unset, so the OpenTelemetry SDK's own
 *   built-in default applies. Those defaults are the SDK's, not a value this plan
 *   authored — capacity/cost numbers are gate 14 / ADR 0006, unresolved. If a
 *   caller needs a `PeriodicExportingMetricReader` or a `BatchSpanProcessor`, it
 *   constructs one itself and passes it in; this module never picks the interval.
 * - It carries no secrets, no credentials, and no log-redaction scheme (O1.7) —
 *   there is nothing here to redact, because there is no logging of any payload,
 *   only instrument definitions and provider wiring.
 */
import {
  context as contextApi,
  metrics as metricsApi,
  trace as traceApi,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";
import { logs as logsApi, type Logger } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation as propagationApi } from "@opentelemetry/api";

import { AsyncLocalStorageContextManager } from "./context.js";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  LoggerProvider as SdkLoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { MeterProvider as SdkMeterProvider, type IMetricReader } from "@opentelemetry/sdk-metrics";
import { TracerProvider as SdkTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { AsyncLocalStorageContextManager } from "./context.js";

/**
 * O7.5 / ADR 0031 §2 — register this codebase's first real `TextMapPropagator` (W3C
 * Trace Context) and `ContextManager` (the dependency-free `AsyncLocalStorage`
 * implementation promoted from the test-proven class), exactly once per process.
 *
 * Propagator/context-manager registration is a *global* concern — unlike the
 * tracer/meter/logger providers, it is not a per-`ConfiguredOtel`-handle decision — so
 * it lives in its own idempotent function rather than in `configureOtel`'s handle
 * construction. `configureOtel` calls it, so every process that already bootstraps OTel
 * (all seven startup roles) picks propagation up with no per-role wiring; a second call
 * in the same process is a no-op, never a re-registration.
 */
let traceContextGlobalsRegistered = false;

export function registerTraceContextGlobals(): void {
  if (traceContextGlobalsRegistered) {
    return;
  }
  traceContextGlobalsRegistered = true;
  propagationApi.setGlobalPropagator(new W3CTraceContextPropagator());
  contextApi.setGlobalContextManager(new AsyncLocalStorageContextManager());
}

/**
 * The cost-attribution dimension architecture §11 tags onto every AWS resource
 * (`component=app|worker|db|cache`, `seatfirst-architecture.md:631`). Every process
 * that calls `configureOtel` must say which of these it is so telemetry can be
 * joined to that same dimension.
 */
export type SeatfirstComponent = "app" | "worker" | "db" | "cache";

/**
 * Resource attribute key for the `component` dimension above. Namespaced under
 * `seatfirst.` because `component` is not a standard OpenTelemetry semantic
 * convention attribute — this is an application-specific dimension, not a
 * misuse of one that already means something else.
 */
export const ATTR_SEATFIRST_COMPONENT = "seatfirst.component";

/** The instrumentation-scope name every tracer/meter/logger from this module shares. */
const INSTRUMENTATION_SCOPE = "seatfirst";

export interface OtelResourceOptions {
  /** OpenTelemetry `service.name` (architecture §10, §11). Caller-supplied — no default. */
  readonly serviceName: string;
  /** The `component` cost-attribution dimension (architecture §11). Caller-supplied. */
  readonly component: SeatfirstComponent;
}

/**
 * Explicit typed options for `configureOtel` (O1.2). Every exporter-facing field is
 * an already-constructed SDK primitive, never a URL/endpoint string — see the module
 * header comment for why. Omitting a field (or passing an empty array) means that
 * signal is unconfigured and stays a no-op.
 */
export interface ConfigureOtelOptions {
  readonly resource: OtelResourceOptions;
  readonly spanProcessors?: readonly SpanProcessor[];
  readonly metricReaders?: readonly IMetricReader[];
  readonly logRecordProcessors?: readonly LogRecordProcessor[];
}

interface MetricDefinition {
  readonly name: string;
  readonly unit: string;
  readonly description: string;
}

/**
 * Names and units only (O1.6) — anticipating the architecture §10.1 metric set
 * ("Request rate/errors/duration per tRPC procedure; active subscription count and
 * duration; queue depth and job latency; cache hit ratio per tier ...; search funnel
 * timings ...; `PARTIAL`/`HALTED` rates", `seatfirst-architecture.md:601`).
 *
 * No thresholds, SLOs, or alert conditions are defined here — architecture §10.1's
 * own targets (500 ms / 4 s / 8 s) and §10.2's alert policy are product/ops
 * decisions this module does not encode. "Rate" and "ratio" are not instruments in
 * their own right: OpenTelemetry counters record raw counts, and rate/ratio are
 * derived downstream by whatever queries the exported time series (that derivation,
 * and any threshold on it, is exactly the kind of decision O1.4/gate 14 reserves).
 * Cache hit ratio per tier, specifically, comes from `cacheAccess` split by the
 * caller-supplied `tier` and `result` attributes at record time — there is one
 * instrument, not a hits/misses pair, so the two counts can never diverge in what
 * they're keyed by.
 */
const METRIC_DEFINITIONS = {
  rpcRequests: {
    name: "seatfirst.rpc.server.requests",
    unit: "{request}",
    description: "Count of tRPC procedure invocations, by procedure.",
  },
  rpcErrors: {
    name: "seatfirst.rpc.server.errors",
    unit: "{error}",
    description: "Count of tRPC procedure invocations that ended in an error, by procedure.",
  },
  rpcDuration: {
    name: "seatfirst.rpc.server.duration",
    unit: "ms",
    description: "tRPC procedure duration, by procedure.",
  },
  activeSubscriptions: {
    name: "seatfirst.search.subscriptions.active",
    unit: "{subscription}",
    description: "Current count of live search progress subscriptions.",
  },
  subscriptionDuration: {
    name: "seatfirst.search.subscription.duration",
    unit: "ms",
    description: "Lifetime of a search progress subscription, from open to close.",
  },
  queueDepth: {
    name: "seatfirst.queue.depth",
    unit: "{job}",
    description: "Current count of outstanding fetch-run jobs, by queue.",
  },
  queueJobDuration: {
    name: "seatfirst.queue.job.duration",
    unit: "ms",
    description: "Fetch-run job latency from dispatch to terminal state, by queue.",
  },
  cacheAccess: {
    name: "seatfirst.cache.access",
    unit: "{access}",
    description:
      "Count of cache lookups, by tier and result (hit|miss). Hit ratio per tier is " +
      "this instrument's hit count over its total, grouped by the tier attribute.",
  },
  searchFunnelAcceptedDuration: {
    name: "seatfirst.search.funnel.accepted.duration",
    unit: "ms",
    description: "Time from search submission to the 202 acceptance response.",
  },
  searchFunnelFirstGroupDuration: {
    name: "seatfirst.search.funnel.first_group.duration",
    unit: "ms",
    description: "Time from search submission to the first result group.",
  },
  searchFunnelCompleteDuration: {
    name: "seatfirst.search.funnel.complete.duration",
    unit: "ms",
    description: "Time from search submission to scan completion.",
  },
  searchOutcomes: {
    name: "seatfirst.search.outcomes",
    unit: "{search}",
    description: "Count of completed searches, by terminal outcome (e.g. PARTIAL, HALTED).",
  },
  // ---- Worker-side instruments (O6.6, architecture §10.1/§10.2). Emitted by the
  // apps/server worker fleet; dimensions are recorded at record time as attributes.
  dispatchHandlerDuration: {
    name: "seatfirst.dispatch.handler.duration",
    unit: "ms",
    description:
      "Dispatch handler duration, by target kind (JOB|RUN|AGGREGATE) and, for RUN " +
      "kinds, by provider and route class.",
  },
  dispatchHandlerCompleted: {
    name: "seatfirst.dispatch.handler.completed",
    unit: "{handler}",
    description:
      "Count of dispatch handler completions, by target kind, outcome (ok|error), " +
      "and — for RUN kinds — provider and route class. Error rate is this " +
      "instrument's error count over its total per dimension.",
  },
  sweeperTickDuration: {
    name: "seatfirst.sweeper.tick.duration",
    unit: "ms",
    description: "One full sweeper tick's duration across all ten duties.",
  },
  sweeperRowsReclaimed: {
    name: "seatfirst.sweeper.rows.reclaimed",
    unit: "{row}",
    description: "Count of stranded jobs/runs reclaimed by the sweeper, by row kind.",
  },
  tmdbFetchCount: {
    name: "seatfirst.tmdb.fetch.count",
    unit: "{fetch}",
    description: "Count of TMDB fetch-worker jobs processed.",
  },
  tmdbFetchDuration: {
    name: "seatfirst.tmdb.fetch.duration",
    unit: "ms",
    description: "TMDB fetch-worker job duration.",
  },
  fetchJobDuration: {
    name: "seatfirst.fetch.job.duration",
    unit: "ms",
    description:
      "Provider fetch-job duration, by coarse outcome family (FULL|PARTIAL|HALTED) " +
      "matching the run state machine's terminal families.",
  },
  catalogueCrawlTickDuration: {
    name: "seatfirst.catalogue_crawl.tick.duration",
    unit: "ms",
    description: "One catalogue-crawl pass's duration (ADR 0022 ten-minute cadence).",
  },
  // ---- API request RED metrics (O5.6, architecture §10.1). Emitted by the api
  // role's onResponse hook; dimensions are recorded at record time as attributes.
  httpRequestDuration: {
    name: "seatfirst.http.request.duration",
    unit: "ms",
    description:
      "API request duration, by matched route pattern and status code. " +
      "Error rate is this instrument's ≥500 count over its total per dimension.",
  },
  httpRequestCount: {
    name: "seatfirst.http.request.count",
    unit: "{request}",
    description: "Count of API requests, by matched route pattern and status code.",
  },
  // ---- Broker-side queue health metrics (O9, architecture §10.1). Emitted by
  // any process with a BullMQ Queue handle; dimensions are recorded at
  // collection time via the observable gauge callback.
  queueJobCounts: {
    name: "seatfirst.queue.job.counts",
    unit: "{job}",
    description:
      "BullMQ job counts per state (waiting|active|delayed|failed|completed|paused|prioritized|waitingChildren), by queue.",
  },
  queueMemoryUsed: {
    name: "seatfirst.queue.memory.used",
    unit: "By",
    description:
      "Redis used_memory bytes reported via INFO memory on the queue's connection, by queue.",
  },
} as const satisfies Record<string, MetricDefinition>;

/** Read-only view of the instrument name/unit table, for callers and tests. */
export const OTEL_METRIC_DEFINITIONS: typeof METRIC_DEFINITIONS = METRIC_DEFINITIONS;

export interface SeatfirstMetrics {
  readonly rpcRequests: Counter;
  readonly rpcErrors: Counter;
  readonly rpcDuration: Histogram;
  readonly activeSubscriptions: UpDownCounter;
  readonly subscriptionDuration: Histogram;
  readonly queueDepth: UpDownCounter;
  readonly queueJobDuration: Histogram;
  readonly cacheAccess: Counter;
  readonly searchFunnelAcceptedDuration: Histogram;
  readonly searchFunnelFirstGroupDuration: Histogram;
  readonly searchFunnelCompleteDuration: Histogram;
  readonly searchOutcomes: Counter;
  readonly dispatchHandlerDuration: Histogram;
  readonly dispatchHandlerCompleted: Counter;
  readonly sweeperTickDuration: Histogram;
  readonly sweeperRowsReclaimed: Counter;
  readonly tmdbFetchCount: Counter;
  readonly tmdbFetchDuration: Histogram;
  readonly fetchJobDuration: Histogram;
  readonly catalogueCrawlTickDuration: Histogram;
  readonly httpRequestDuration: Histogram;
  readonly httpRequestCount: Counter;
}
function createMetrics(meter: Meter): SeatfirstMetrics {
  return {
    rpcRequests: meter.createCounter(METRIC_DEFINITIONS.rpcRequests.name, {
      unit: METRIC_DEFINITIONS.rpcRequests.unit,
      description: METRIC_DEFINITIONS.rpcRequests.description,
    }),
    rpcErrors: meter.createCounter(METRIC_DEFINITIONS.rpcErrors.name, {
      unit: METRIC_DEFINITIONS.rpcErrors.unit,
      description: METRIC_DEFINITIONS.rpcErrors.description,
    }),
    rpcDuration: meter.createHistogram(METRIC_DEFINITIONS.rpcDuration.name, {
      unit: METRIC_DEFINITIONS.rpcDuration.unit,
      description: METRIC_DEFINITIONS.rpcDuration.description,
    }),
    activeSubscriptions: meter.createUpDownCounter(METRIC_DEFINITIONS.activeSubscriptions.name, {
      unit: METRIC_DEFINITIONS.activeSubscriptions.unit,
      description: METRIC_DEFINITIONS.activeSubscriptions.description,
    }),
    subscriptionDuration: meter.createHistogram(METRIC_DEFINITIONS.subscriptionDuration.name, {
      unit: METRIC_DEFINITIONS.subscriptionDuration.unit,
      description: METRIC_DEFINITIONS.subscriptionDuration.description,
    }),
    queueDepth: meter.createUpDownCounter(METRIC_DEFINITIONS.queueDepth.name, {
      unit: METRIC_DEFINITIONS.queueDepth.unit,
      description: METRIC_DEFINITIONS.queueDepth.description,
    }),
    queueJobDuration: meter.createHistogram(METRIC_DEFINITIONS.queueJobDuration.name, {
      unit: METRIC_DEFINITIONS.queueJobDuration.unit,
      description: METRIC_DEFINITIONS.queueJobDuration.description,
    }),
    cacheAccess: meter.createCounter(METRIC_DEFINITIONS.cacheAccess.name, {
      unit: METRIC_DEFINITIONS.cacheAccess.unit,
      description: METRIC_DEFINITIONS.cacheAccess.description,
    }),
    searchFunnelAcceptedDuration: meter.createHistogram(
      METRIC_DEFINITIONS.searchFunnelAcceptedDuration.name,
      {
        unit: METRIC_DEFINITIONS.searchFunnelAcceptedDuration.unit,
        description: METRIC_DEFINITIONS.searchFunnelAcceptedDuration.description,
      },
    ),
    searchFunnelFirstGroupDuration: meter.createHistogram(
      METRIC_DEFINITIONS.searchFunnelFirstGroupDuration.name,
      {
        unit: METRIC_DEFINITIONS.searchFunnelFirstGroupDuration.unit,
        description: METRIC_DEFINITIONS.searchFunnelFirstGroupDuration.description,
      },
    ),
    searchFunnelCompleteDuration: meter.createHistogram(
      METRIC_DEFINITIONS.searchFunnelCompleteDuration.name,
      {
        unit: METRIC_DEFINITIONS.searchFunnelCompleteDuration.unit,
        description: METRIC_DEFINITIONS.searchFunnelCompleteDuration.description,
      },
    ),
    searchOutcomes: meter.createCounter(METRIC_DEFINITIONS.searchOutcomes.name, {
      unit: METRIC_DEFINITIONS.searchOutcomes.unit,
      description: METRIC_DEFINITIONS.searchOutcomes.description,
    }),
    dispatchHandlerDuration: meter.createHistogram(
      METRIC_DEFINITIONS.dispatchHandlerDuration.name,
      {
        unit: METRIC_DEFINITIONS.dispatchHandlerDuration.unit,
        description: METRIC_DEFINITIONS.dispatchHandlerDuration.description,
      },
    ),
    dispatchHandlerCompleted: meter.createCounter(
      METRIC_DEFINITIONS.dispatchHandlerCompleted.name,
      {
        unit: METRIC_DEFINITIONS.dispatchHandlerCompleted.unit,
        description: METRIC_DEFINITIONS.dispatchHandlerCompleted.description,
      },
    ),
    sweeperTickDuration: meter.createHistogram(METRIC_DEFINITIONS.sweeperTickDuration.name, {
      unit: METRIC_DEFINITIONS.sweeperTickDuration.unit,
      description: METRIC_DEFINITIONS.sweeperTickDuration.description,
    }),
    sweeperRowsReclaimed: meter.createCounter(METRIC_DEFINITIONS.sweeperRowsReclaimed.name, {
      unit: METRIC_DEFINITIONS.sweeperRowsReclaimed.unit,
      description: METRIC_DEFINITIONS.sweeperRowsReclaimed.description,
    }),
    tmdbFetchCount: meter.createCounter(METRIC_DEFINITIONS.tmdbFetchCount.name, {
      unit: METRIC_DEFINITIONS.tmdbFetchCount.unit,
      description: METRIC_DEFINITIONS.tmdbFetchCount.description,
    }),
    tmdbFetchDuration: meter.createHistogram(METRIC_DEFINITIONS.tmdbFetchDuration.name, {
      unit: METRIC_DEFINITIONS.tmdbFetchDuration.unit,
      description: METRIC_DEFINITIONS.tmdbFetchDuration.description,
    }),
    fetchJobDuration: meter.createHistogram(METRIC_DEFINITIONS.fetchJobDuration.name, {
      unit: METRIC_DEFINITIONS.fetchJobDuration.unit,
      description: METRIC_DEFINITIONS.fetchJobDuration.description,
    }),
    catalogueCrawlTickDuration: meter.createHistogram(
      METRIC_DEFINITIONS.catalogueCrawlTickDuration.name,
      {
        unit: METRIC_DEFINITIONS.catalogueCrawlTickDuration.unit,
        description: METRIC_DEFINITIONS.catalogueCrawlTickDuration.description,
      },
    ),
    httpRequestDuration: meter.createHistogram(METRIC_DEFINITIONS.httpRequestDuration.name, {
      unit: METRIC_DEFINITIONS.httpRequestDuration.unit,
      description: METRIC_DEFINITIONS.httpRequestDuration.description,
    }),
    httpRequestCount: meter.createCounter(METRIC_DEFINITIONS.httpRequestCount.name, {
      unit: METRIC_DEFINITIONS.httpRequestCount.unit,
      description: METRIC_DEFINITIONS.httpRequestCount.description,
    }),
  };
}

function buildResource(options: OtelResourceOptions): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SEATFIRST_COMPONENT]: options.component,
  });
}

/**
 * Whether this call's providers actually became the process-wide global delegate for
 * each signal. `@opentelemetry/api`'s global registry accepts only one registration
 * per signal per process by default (`registerGlobal`, called internally by
 * `setGlobalTracerProvider`/`setGlobalMeterProvider`/`setGlobalLoggerProvider`) — a
 * second `configureOtel` call in the same process does not replace the first
 * registration, it is silently ignored by the global registry. See `configureOtel`'s
 * doc comment for what to do with this.
 */
export interface OtelGlobalRegistration {
  readonly trace: boolean;
  readonly metrics: boolean;
  readonly logs: boolean;
}

export interface ConfiguredOtel {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logger: Logger;
  readonly metrics: SeatfirstMetrics;
  readonly tracerProvider: SdkTracerProvider;
  readonly meterProvider: SdkMeterProvider;
  readonly loggerProvider: SdkLoggerProvider;
  /**
   * Per-signal outcome of registering this call's providers as the process-wide
   * globals — see `OtelGlobalRegistration`. `tracer`/`meter`/`logger` above always
   * work regardless of these values (they come from this call's own providers, not
   * the global registry), but code elsewhere that reaches the SDK via
   * `@opentelemetry/api`'s `trace.getTracer()` / `metrics.getMeter()` /
   * `@opentelemetry/api-logs`'s `logs.getLogger()` sees this call's provider only for
   * the signals where the corresponding field is `true`.
   */
  readonly globalRegistration: OtelGlobalRegistration;
  /** Flushes all three providers. Does not throw when nothing is configured to export. */
  readonly forceFlush: () => Promise<void>;
  /** Shuts down all three providers. Safe to call even when nothing was ever exported. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Build one OpenTelemetry SDK setup — traces, metrics, and logs together — from an
 * explicit typed options object (O1.2). See the module header comment for what this
 * function deliberately does not decide.
 *
 * Attempts to register the constructed providers as the process-wide global providers
 * (so code elsewhere can reach the same setup via `@opentelemetry/api`'s
 * `trace`/`metrics` and `@opentelemetry/api-logs`'s `logs`, not only through the
 * handle returned here). This succeeds only for the **first** `configureOtel` call in
 * a process for each signal: `@opentelemetry/api`'s global registry refuses a second
 * registration by default, and the underlying `setGlobalTracerProvider`/
 * `setGlobalMeterProvider` calls report that with a boolean return value that this
 * function surfaces on the returned handle as `globalRegistration` — check it before
 * relying on the global (`trace.getTracer()` etc.) path if `configureOtel` might run
 * more than once in the same process (a shared test harness, a second entry point, a
 * worker that re-initializes). The handle's own `tracer`/`meter`/`logger` fields are
 * unaffected either way and always reflect this call's own providers.
 */
export function configureOtel(options: ConfigureOtelOptions): ConfiguredOtel {
  const resource = buildResource(options.resource);

  // Every option below that is NOT set (sampler, span limits, force-flush timeout,
  // log record limits) takes the OpenTelemetry SDK's own built-in default — see the
  // module header comment (O1.4). `spanProcessors`/`readers`/`processors` default to
  // an empty list when the caller supplies none, which is what makes an unconfigured
  // signal a true no-op: there is nothing registered that could export anywhere.
  const tracerProvider = new SdkTracerProvider({
    resource,
    spanProcessors: options.spanProcessors ? [...options.spanProcessors] : [],
  });
  const meterProvider = new SdkMeterProvider({
    resource,
    readers: options.metricReaders ? [...options.metricReaders] : [],
  });
  const loggerProvider = new SdkLoggerProvider({
    resource,
    processors: options.logRecordProcessors ? [...options.logRecordProcessors] : [],
  });

  // Each `setGlobal*Provider` call reports whether *this* call's provider became the
  // process-wide delegate. `@opentelemetry/api-logs`'s `setGlobalLoggerProvider`
  // returns the provider that ended up registered (this one on success, the
  // already-registered one on failure) rather than a boolean, so success is
  const traceRegistered = traceApi.setGlobalTracerProvider(tracerProvider);
  const metricsRegistered = metricsApi.setGlobalMeterProvider(meterProvider);
  const logsRegistered = logsApi.setGlobalLoggerProvider(loggerProvider) === loggerProvider;

  // O7.5 — one code path installs the global W3C propagator and async-local context
  // manager (idempotent, once per process). Without them, `context.with(...)` would not
  // survive `await` and `propagation.inject/extract` would be no-ops, defeating O7.6/O7.7.
  registerTraceContextGlobals();

  const tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE);
  const meter = meterProvider.getMeter(INSTRUMENTATION_SCOPE);
  const logger = loggerProvider.getLogger(INSTRUMENTATION_SCOPE);

  return {
    tracer,
    meter,
    logger,
    metrics: createMetrics(meter),
    tracerProvider,
    meterProvider,
    loggerProvider,
    globalRegistration: {
      trace: traceRegistered,
      metrics: metricsRegistered,
      logs: logsRegistered,
    },
    forceFlush: async () => {
      await Promise.all([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider.forceFlush(),
      ]);
    },
    shutdown: async () => {
      await Promise.all([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}
