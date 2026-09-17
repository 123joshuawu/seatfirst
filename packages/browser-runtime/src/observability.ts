/**
 * Observability attachment rules for the browser-runtime (P6.14, P6.15, P6.12).
 *
 * - A URL classification attribute is ALWAYS one of the four fixed stage labels, never a
 *   literal (even redacted) URL string. A failed-guard event carries no URL
 *   classification at all — `UNRECOGNIZED` is not a permitted classification
 *   (ADR 0005 §D, `docs/adr/0005-security-privacy-operations.md:335-345`).
 * - `egressIdentityLabel` is deployment-assigned audit metadata, attached to OTel spans
 *   and metric attributes only; the runtime never rotates it (P6.15).
 * - Every code path that attaches AMC-derived headers to a span attribute must call
 *   `redactHeaders()` first (ADR 0005 §D, `:313-319`); that call is fail-closed.
 * - No response body is ever attached to a log line, span attribute, or crash bundle
 *   (P6.13).
 */

import { metrics, trace, type Span, type Tracer } from "@opentelemetry/api";
import { redactHeaders } from "@seatfirst/providers";
import type { CorridorStage } from "./guard.js";
import type { DocumentHop, NavigationOutcome } from "./outcome.js";

export const ATTR_URL_CLASSIFICATION = "seatfirst.url_classification";
export const ATTR_EGRESS_IDENTITY_LABEL = "seatfirst.egress_identity_label";
export const ATTR_REDACTED_OUTCOME = "seatfirst.redacted_outcome";
export const ATTR_LOGICAL_DOCUMENTS = "seatfirst.logical_documents";
export const ATTR_PHYSICAL_DOCUMENTS = "seatfirst.physical_documents";
export const ATTR_ABORTED_SUBRESOURCES = "seatfirst.aborted_subresources";
export const ATTR_CHROME_VERSION = "seatfirst.chrome_version";
export const ATTR_PLAYWRIGHT_VERSION = "seatfirst.playwright_version";
export const ATTR_CHROME_RECYCLED = "seatfirst.chrome_recycled";
/** O2.10 — provider-actor attribution, common to every O2 instrument below. */
export const ATTR_PROVIDER_ID = "seatfirst.provider_id";

/**
 * O3 — structural entity identifiers, permitted as span attributes by the ADR 0005 §D
 * amendment (`docs/adr/0005-security-privacy-operations.md:345-353`). These are the
 * discrete `RunKeyRow` parts an AI agent/operator can use to reproduce an error
 * offline — never a reconstructed URL (O3.3). Names are fixed by the O3 contract.
 */
export const ATTR_ENTITY_THEATRE_ID = "seatfirst.entity.theatre_id";
export const ATTR_ENTITY_SHOWTIME_ID = "seatfirst.entity.showtime_id";
export const ATTR_ENTITY_LOCAL_DATE = "seatfirst.entity.local_date";
export const ATTR_RUN_KEY_ID = "seatfirst.run_key_id";

/** Prefix for per-header span attributes; values come from `redactHeaders()`. */
export const RESPONSE_HEADER_ATTR_PREFIX = "seatfirst.response_header.";

/** The four permitted URL classification labels (P6.14) — the guard's stage vocabulary. */
export { CORRIDOR_STAGES as CORRIDOR_LABELS } from "./guard.js";

export const TRACER_NAME = "seatfirst.browser-runtime";
export const METER_NAME = "seatfirst.browser-runtime";

export interface RuntimeVersions {
  readonly chrome: string;
  readonly playwright: string;
}

export type SafeSpanAttributeMap = Readonly<Record<string, string | number | boolean>>;

/** The stage label for an outcome, when a permitted classification exists (P6.14). */
export function outcomeClassification(outcome: NavigationOutcome): CorridorStage | null {
  switch (outcome.kind) {
    case "SUCCESS":
    case "CHALLENGE_REQUIRED":
    case "UPSTREAM_BLOCKED":
    case "RATE_LIMITED":
      return outcome.classification;
    case "QUEUE_ENTERED":
      return outcome.classification;
    case "GUARD_REJECTED":
      // By construction, never classified as permitted — no classification attribute.
      return null;
    case "CANCELLED":
    case "NAVIGATION_FAILED":
      return null;
  }
}

/**
 * Safe span attributes for a navigation outcome: the redacted outcome kind, permitted
 * URL classification (never for guard rejections), the fixed egress audit label, safe
 * versions, and logical/physical request counts. No URL strings, no headers, no bodies.
 */
export function buildSafeSpanAttributes(
  outcome: NavigationOutcome,
  egressIdentityLabel: string,
  versions: RuntimeVersions,
  opts: {
    readonly physicalDocuments: number;
    readonly subresourceAborts: number;
    readonly chromeRecycled: boolean;
  },
): SafeSpanAttributeMap {
  const attributes: Record<string, string | number | boolean> = {
    [ATTR_REDACTED_OUTCOME]: outcome.kind,
    [ATTR_EGRESS_IDENTITY_LABEL]: egressIdentityLabel,
    [ATTR_CHROME_VERSION]: versions.chrome,
    [ATTR_PLAYWRIGHT_VERSION]: versions.playwright,
    [ATTR_LOGICAL_DOCUMENTS]: 1,
    [ATTR_PHYSICAL_DOCUMENTS]: opts.physicalDocuments,
    [ATTR_ABORTED_SUBRESOURCES]: opts.subresourceAborts,
    [ATTR_CHROME_RECYCLED]: opts.chromeRecycled,
  };
  const classification = outcomeClassification(outcome);
  if (classification !== null) {
    attributes[ATTR_URL_CLASSIFICATION] = classification;
  }
  return attributes;
}

/**
 * O3.1/O3.2 — attach the discrete structural entity identifiers from a run's key to a
 * span. Only the exact `RunKeyRow` parts permitted by the ADR 0005 §D amendment are
 * attached; null/undefined values are omitted (never stringified as `"null"`), and the
 * reconstructed URL is never a candidate (O3.3). The caller supplies the active span —
 * this helper never mints or activates a span of its own.
 */
export function attachRunKeyEntityAttributes(
  span: Span,
  runKey: {
    readonly runKeyId: string;
    readonly theatreId: string | null;
    readonly showtimeId: string | null;
    readonly localDate: string | null;
  },
): void {
  span.setAttribute(ATTR_RUN_KEY_ID, runKey.runKeyId);
  if (runKey.theatreId !== null) {
    span.setAttribute(ATTR_ENTITY_THEATRE_ID, runKey.theatreId);
  }
  if (runKey.showtimeId !== null) {
    span.setAttribute(ATTR_ENTITY_SHOWTIME_ID, runKey.showtimeId);
  }
  if (runKey.localDate !== null) {
    span.setAttribute(ATTR_ENTITY_LOCAL_DATE, runKey.localDate);
  }
}

/**
 * Attach redacted response headers to a span, one attribute per allowlisted header.
 * Calls `redactHeaders()` first — fail-closed: throws rather than emitting an
 * unredacted value (ADR 0005 §D).
 */
export function attachRedactedResponseHeaders(span: Span, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(redactHeaders(headers))) {
    span.setAttribute(
      `${RESPONSE_HEADER_ATTR_PREFIX}${name.toLowerCase().replace(/-/g, "_")}`,
      value,
    );
  }
}

/** Add one span event per physical document hop: classification + status + timing only. */
export function attachHopEvents(span: Span, hops: readonly DocumentHop[]): void {
  for (const [index, hop] of hops.entries()) {
    const attributes: Record<string, string | number> = {
      "seatfirst.hop_index": index,
      [ATTR_URL_CLASSIFICATION]: hop.classification,
    };
    if (hop.status !== null) {
      attributes["seatfirst.http_status"] = hop.status;
    }
    if (hop.durationMs !== null) {
      attributes["seatfirst.hop_duration_ms"] = hop.durationMs;
    }
    span.addEvent("document_hop", attributes);
  }
}

export function getNavigationTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Outcome + physical-document counters, with the egress label as a metric attribute. */
export function recordNavigationMetrics(
  outcome: NavigationOutcome,
  scope: { readonly egressIdentityLabel: string },
  physicalDocuments: number,
): void {
  const meter = metrics.getMeter(METER_NAME);
  const navigations = meter.createCounter("browser.navigations", {
    description: "AMC corridor navigation outcomes (architecture §10.2)",
  });
  const documents = meter.createCounter("browser.documents", {
    description: "Physical document requests dispatched per logical navigation",
  });
  const classification = outcomeClassification(outcome);
  const common = { [ATTR_EGRESS_IDENTITY_LABEL]: scope.egressIdentityLabel };
  navigations.add(1, {
    ...common,
    [ATTR_REDACTED_OUTCOME]: outcome.kind,
    ...(classification !== null ? { [ATTR_URL_CLASSIFICATION]: classification } : {}),
  });
  documents.add(physicalDocuments, common);
}

// --- O2.A: startup duration + readiness-probe duration/outcome instruments ---
// (owned by the #launch()-rooted telemetry slice)

/** O2.5 — wire key for one readiness-probe attempt's outcome (fixed by the O2 contract). */
export const ATTR_READINESS_PROBE_OUTCOME = "outcome";

/** O2.5 — fixed vocabulary for one readiness-probe attempt's outcome. */
export type ReadinessProbeOutcome = "ready" | "timeout" | "error";

/** O2.1 — warm-Chrome startup duration, recorded only for successful `#launch()` runs. */
export function recordChromeStartup(providerId: string, durationMs: number): void {
  metrics
    .getMeter(METER_NAME)
    .createHistogram("seatfirst.browser_runtime.chrome.startup.duration", {
      description: "Warm-Chrome startup duration (architecture §10.2)",
      unit: "ms",
    })
    .record(durationMs, { [ATTR_PROVIDER_ID]: providerId });
}

/**
 * O2.5 — one readiness-probe attempt: duration histogram + per-outcome counter.
 * `timeout` is a breached `readinessTimeoutMs`; `error` is any other failed attempt.
 */
export function recordReadinessProbe(
  providerId: string,
  durationMs: number,
  outcome: ReadinessProbeOutcome,
): void {
  const meter = metrics.getMeter(METER_NAME);
  const attributes = { [ATTR_PROVIDER_ID]: providerId, [ATTR_READINESS_PROBE_OUTCOME]: outcome };
  meter
    .createHistogram("seatfirst.browser_runtime.chrome.readiness_probe.duration", {
      description: "Per-attempt readiness-probe duration (architecture §10.2)",
      unit: "ms",
    })
    .record(durationMs, attributes);
  meter
    .createCounter("seatfirst.browser_runtime.chrome.readiness_probe.count", {
      description: "Readiness-probe attempts by outcome",
      unit: "{probe}",
    })
    .add(1, attributes);
}

// --- O2.B: context-create/context-cleanup duration + process-age/nav-count/memory gauges ---

/**
 * The supervisor state a gauge registration reads. Structural on purpose: importing
 * `BrowserSupervisor` here would create a supervisor→observability import cycle.
 */
export interface ChromeProcessGaugeSource {
  readonly processAgeMs: number;
  readonly navigationCount: number;
  residentMemoryBytes(): Promise<number | null>;
  readonly providerId: string;
}

/** O2.1 — context-create duration histogram, recorded only for successful creates. */
export function recordContextCreateDuration(providerId: string, durationMs: number): void {
  metrics
    .getMeter(METER_NAME)
    .createHistogram("seatfirst.browser_runtime.chrome.context_create.duration", {
      description: "Chrome BrowserContext creation duration (architecture §10.2)",
      unit: "ms",
    })
    .record(durationMs, { [ATTR_PROVIDER_ID]: providerId });
}

/** O2.1 — context-cleanup duration histogram, recorded only for successful cleanups. */
export function recordContextCleanupDuration(providerId: string, durationMs: number): void {
  metrics
    .getMeter(METER_NAME)
    .createHistogram("seatfirst.browser_runtime.chrome.context_cleanup.duration", {
      description:
        "Chrome BrowserContext cleanup duration, including kill-and-replace (architecture §10.2)",
      unit: "ms",
    })
    .record(durationMs, { [ATTR_PROVIDER_ID]: providerId });
}

/**
 * O2.2/O2.3 — process age, navigation count, and tree-wide resident memory as
 * observable gauges, sampled at the metric reader's cadence (no bespoke interval).
 * Register once per supervisor instance. The resident-memory callback is async and
 * observes NOTHING when the platform can't sample (no fabricated zero or null point).
 */
export function registerChromeProcessGauges(supervisor: ChromeProcessGaugeSource): void {
  const meter = metrics.getMeter(METER_NAME);
  meter
    .createObservableGauge("seatfirst.browser_runtime.chrome.process_age", {
      description:
        "Age of the current warm Chrome process since its successful launch (architecture §10.2)",
      unit: "ms",
    })
    .addCallback((result) => {
      result.observe(supervisor.processAgeMs, { [ATTR_PROVIDER_ID]: supervisor.providerId });
    });
  meter
    .createObservableGauge("seatfirst.browser_runtime.chrome.navigation_count", {
      description:
        "Navigation contexts created since the current process's launch or recycle (architecture §10.2)",
      unit: "{navigation}",
    })
    .addCallback((result) => {
      result.observe(supervisor.navigationCount, { [ATTR_PROVIDER_ID]: supervisor.providerId });
    });
  meter
    .createObservableGauge("seatfirst.browser_runtime.chrome.resident_memory", {
      description:
        "Tree-wide resident memory (VmRSS sum) of the Chrome process group (architecture §10.2)",
      unit: "By",
    })
    .addCallback(async (result) => {
      const bytes = await supervisor.residentMemoryBytes();
      if (bytes !== null) {
        result.observe(bytes, { [ATTR_PROVIDER_ID]: supervisor.providerId });
      }
    });
}

// --- O2.C: recycle duration + restart-reason counter ---
/**
 * O2.4 — the fixed restart-reason vocabulary: exactly these three literals, typed as
 * a const union so call sites cannot pass free text.
 */
export const CHROME_RESTART_REASONS = [
  "deliberate_recycle",
  "forced_cleanup_replace",
  "unexpected_exit",
] as const;

export type ChromeRestartReason = (typeof CHROME_RESTART_REASONS)[number];

/** O2.4/O2.7 — reason label on every restart data point (namespaced per the O2.8 discipline). */
export const ATTR_RESTART_REASON = "seatfirst.restart_reason";

/** O2.1 — recycle duration histogram; name and unit are fixed, not left implicit. */
export const CHROME_RECYCLE_DURATION_METRIC = "seatfirst.browser_runtime.chrome.recycle.duration";

/** O2.4/O2.7 — restart-reason counter: the alert-signal surface, no log-record path. */
export const CHROME_RESTART_METRIC = "seatfirst.browser_runtime.chrome.restart";

/** O2.1 — record a completed recycle()'s wall-clock duration (success path only). */
export function recordChromeRecycle(durationMs: number, providerId: string): void {
  metrics
    .getMeter(METER_NAME)
    .createHistogram(CHROME_RECYCLE_DURATION_METRIC, {
      description:
        "Full warm-process recycle duration, terminate through relaunch (architecture §10.2)",
      unit: "ms",
    })
    .record(durationMs, { [ATTR_PROVIDER_ID]: providerId });
}

/**
 * O2.4/O2.7 — one point per supervisor restart, labeled with which of the three fixed
 * reasons it was. This counter alone is the downstream alerting surface (O2.7): the
 * package has no `@opentelemetry/api-logs` dependency and must not gain a log path.
 */
export function recordChromeRestart(reason: ChromeRestartReason, providerId: string): void {
  metrics
    .getMeter(METER_NAME)
    .createCounter(CHROME_RESTART_METRIC, {
      description:
        "Chrome restarts by fixed reason (O2.4); the O2.7 crash/forced-cleanup alert signal",
      unit: "{restart}",
    })
    .add(1, {
      [ATTR_PROVIDER_ID]: providerId,
      [ATTR_RESTART_REASON]: reason,
    });
}
