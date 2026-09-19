/**
 * Typed discriminated navigation-outcome union (P6.20) and the navigation-scope fields
 * grounded in architecture §4.2 (`docs/seatfirst-architecture.md:207`) and the halt-cause
 * enumeration in ADR 0001's B9 trigger table
 * (`docs/adr/0001-durability-search-lifecycle.md:1150-1158`).
 *
 * P6 REPORTS outcomes. It does not itself call B9 or any durability transition — S8 maps
 * this union onto the durability state machine.
 */

import { z } from "zod";
import type { CorridorStage, GuardRejectionReason } from "./guard.js";

/**
 * Fixed before dispatch (architecture §4.2). `egressIdentityLabel` is deployment-assigned
 * audit metadata copied into safe traces and metrics — never rotated by the fetch
 * runtime, never a proxy/route selector (P6.15, ADR 0004
 * `docs/adr/0004-deployment-shape-egress-identity.md:103-110`).
 */
export interface NavigationScope {
  readonly providerId: string;
  readonly observationId: string;
  readonly fetchRunId: string;
  readonly routeClass: string;
  readonly egressIdentityLabel: string;
}

/**
 * Per-navigation bounds. Every value is an injected, caller-supplied parameter with no
 * default — gate 14 / ADR 0006 (P6.18, `docs/gates.md` "Fetch-layer tunables" pattern).
 */
export interface NavigationLimits {
  /** Bound for the whole `page.goto` corridor transit. */
  readonly navigationTimeoutMs: number;
}

/** One guard-accepted physical document request of the corridor (safe fields only). */
export interface DocumentHop {
  readonly classification: CorridorStage;
  readonly status: number | null;
  readonly durationMs: number | null;
}

/**
 * Sanitized final-document URL parts: origin, pathname, and query-key NAMES only —
 * never query values, per the safe-outcome field list
 * (`docs/seatfirst-architecture.md:207`).
 */
export interface SanitizedFinalUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly queryKeys: readonly string[];
}

/**
 * The transport payload handed to the seat-page parser. `documentHtml` is in-memory
 * transport data only: it must NEVER be attached to a log line, span attribute, or crash
 * bundle, redacted or not (P6.13, `docs/adr/0005-security-privacy-operations.md:331-334`).
 */
export interface SanitizedPayload {
  readonly finalUrl: SanitizedFinalUrl;
  readonly finalStatus: number;
  /** Already passed through `redactHeaders()` (ADR 0005 §D). */
  readonly headers: Record<string, string>;
  readonly documentHtml: string;
  /**
   * Present only when an `observationPlan` was supplied (S35.11). The transport's
   * fixed evaluator produces this strictly schema-validated result; it carries no
   * page copy — only the carry-through answer and the bounded seat geometry.
   */
  readonly observation?: Observation;
}

/** One seat's factual geometry, as observed from the rendered seat map (S35.11). */
export const observationGeometrySeatSchema = z.object({
  row: z.number().int(),
  column: z.number().int(),
  name: z.string(),
  available: z.boolean(),
  status: z.string().nullable().optional(),
});
export type ObservationGeometrySeat = z.infer<typeof observationGeometrySeatSchema>;

/**
 * The declarative observation result (S35.11): the carry-through answer (question 1)
 * plus the bounded geometry of seats observed near the targets (question 2).
 * `carryThrough` is `INCONCLUSIVE` when the rendered state cannot answer the
 * question, `NONE_SELECTED` when the map rendered with no selection, or the
 * documented seat-name field when a seat rendered pre-selected/highlighted.
 */
export const observationSchema = z.object({
  carryThrough: z.union([
    z.literal("INCONCLUSIVE"),
    z.literal("NONE_SELECTED"),
    z.object({ selectedSeatId: z.string() }),
  ]),
  geometryNearTarget: z.array(observationGeometrySeatSchema),
});
export type Observation = z.infer<typeof observationSchema>;
/**
 * Raw/unredacted forensics for `UPSTREAM_BLOCKED` / `CHALLENGE_REQUIRED`.
 * Populated ONLY by `runNativeCorridor`'s production response handler, which
 * observes a real upstream response through a live Playwright `Page` — the
 * synthetic/offline test path never sets it. Purely additive: `headers` keeps
 * its existing redacted general-case telemetry; this field carries the raw
 * payload for the durability capture row. Absent (`undefined`) = no capture.
 */
export interface RawBlockedDiagnostic {
  /** Raw response URL, full query string included — never redacted. */
  readonly url: string;
  /** Full raw response headers — NOT the redacted allowlist. */
  readonly headers: Record<string, string>;
  /** Raw response body, when safely readable exactly once at capture time. */
  readonly body?: string;
  /** PNG screenshot bytes, when the live-`Page` capture succeeded. */
  readonly screenshot?: Uint8Array;
}

export type NavigationOutcome =
  | Readonly<{
      kind: "SUCCESS";
      classification: CorridorStage;
      hops: readonly DocumentHop[];
      payload: SanitizedPayload;
      /** Physical non-document requests aborted at the transport (P6.11). */
      subresourceAborts: number;
    }>
  /**
   * The corridor entered the Queue-it waiting page at `QUEUE_ENTRY` and stalled there
   * (countdown page, no redirect). S8 maps this to B9's `UPSTREAM_QUEUED` halt
   * (ADR 0001 `:1154`); P6 never waits out the countdown (P6.20, verification item 6).
   */
  | Readonly<{
      kind: "QUEUE_ENTERED";
      classification: "QUEUE_ENTRY";
      hops: readonly DocumentHop[];
      status: number;
      headers: Record<string, string>;
    }>
  /** `cf-mitigated: challenge` observed at a guard-accepted corridor document. */
  | Readonly<{
      kind: "CHALLENGE_REQUIRED";
      classification: CorridorStage;
      hops: readonly DocumentHop[];
      status: number;
      headers: Record<string, string>;
      /**
       * Production-only raw forensics (see `RawBlockedDiagnostic`); never set on
       * the synthetic/offline path.
       */
      rawDiagnostic?: RawBlockedDiagnostic;
    }>
  /** HTTP 403 at a guard-accepted corridor document. */
  | Readonly<{
      kind: "UPSTREAM_BLOCKED";
      classification: CorridorStage;
      hops: readonly DocumentHop[];
      status: number;
      headers: Record<string, string>;
      /**
       * Production-only raw forensics (see `RawBlockedDiagnostic`); never set on
       * the synthetic/offline path.
       */
      rawDiagnostic?: RawBlockedDiagnostic;
    }>
  /** HTTP 429 (or other rate-limiting response) — S8 maps to B9 `RATE_LIMITED` (`:1156`). */
  | Readonly<{
      kind: "RATE_LIMITED";
      classification: CorridorStage;
      hops: readonly DocumentHop[];
      status: number;
      headers: Record<string, string>;
    }>
  /**
   * Corridor-guard failure — the navigation halted before dispatching the violating
   * document. Carries a typed rule category, NEVER a URL, and no URL classification
   * (P6.14: a failed-guard event is not logged with a URL classification at all).
   */
  | Readonly<{
      kind: "GUARD_REJECTED";
      reason: GuardRejectionReason;
      hops: readonly DocumentHop[];
    }>
  /**
   * The caller's `AbortSignal` terminated the in-flight navigation: page closed, context
   * destroyed. Transport-level cancellation only (P6.21) — it authorizes no
   * `searches.cancel` (gate 18), no rate limiter (gate 13), and no durability transition.
   */
  | Readonly<{ kind: "CANCELLED" }>
  /** Catch-all terminal error. The message is URL-scrubbed before it is emitted. */
  | Readonly<{ kind: "NAVIGATION_FAILED"; error: string }>;

/**
 * The transport's return: the typed outcome plus the cleanup-completion signal (P6.3) —
 * a promise that resolves only once the page and the fresh `BrowserContext` are confirmed
 * destroyed, and, when cleanup exceeded the injected grace period, once the full Chrome
 * process tree is confirmed dead and a replacement process has been launched. S8 observes
 * this signal before releasing provider capacity; P6 itself calls no capacity-release
 * transaction.
 */
export interface NavigationAttempt {
  readonly outcome: NavigationOutcome;
  readonly cleanupCompleted: Promise<void>;
}
