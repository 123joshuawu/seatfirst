/**
 * Per-hop corridor navigation (the fetch-transport half of the provider actor).
 *
 * P6 transport semantics (ADR 0005 §B, §D): the AMC queue corridor is walked ONE
 * DOCUMENT AT A TIME. Every hop's URL is guard-validated BEFORE it is dispatched;
 * a rejected hop is never sent. Chrome never follows a redirect: the transport
 * fetches each hop's raw response itself (redirects disabled), inspects its status
 * and headers for terminal upstream states, and dispatches the next hop explicitly.
 * Subresources and subframe documents are aborted pre-dispatch; only main-frame
 * documents may load (P6.11) — with one ADR 0010 exception: same-origin XHR/fetch
 * subresources on the theatre-search route pass through the guard (see
 * `isTheatreSearchPassthrough`).
 */

import type { Span } from "@opentelemetry/api";
import * as cheerio from "cheerio";
import type { BrowserContext, Page, Request, Route } from "playwright-core";
import {
  isAllowedUrl,
  parseSeats,
  redactHeaders,
  type RawGridCell,
  validateIdentity,
} from "@seatfirst/providers";
import { checkDocument, INITIAL_CORRIDOR_STATE, type CorridorState } from "./guard.js";
import type { BrowserSupervisor } from "./supervisor.js";
import {
  attachHopEvents,
  attachRedactedResponseHeaders,
  buildSafeSpanAttributes,
  getNavigationTracer,
  recordNavigationMetrics,
} from "./observability.js";
import {
  observationSchema,
  type DocumentHop,
  type NavigationAttempt,
  type NavigationLimits,
  type NavigationOutcome,
  type NavigationScope,
  type Observation,
  type SanitizedPayload,
} from "./outcome.js";

/**
 * One raw (never redirect-followed) document response. Header names are
 * normalized to lowercase by the default fetch implementation; test seams must
 * do the same.
 */
export interface HopResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface CorridorNavigationOptions {
  readonly scope: NavigationScope;
  /** The prevalidated AMC seat-page target — must satisfy `AMC_INITIAL`'s rule. */
  readonly targetUrl: string;
  /** Deployment-assigned AMC identity; validated against the providers identity policy. */
  readonly userAgent: string;
  readonly limits: NavigationLimits;
  /**
   * Transport-level cancellation (P6.21). Closes the page and destroys the context.
   * Optional: an absent signal means the navigation is cancelled only by its own
   * terminal conditions.
   */
  readonly signal?: AbortSignal;
  /**
   * Seam used by the offline synthetic test harness (and only it) to seed context
   * state (cookies, localStorage probes) BEFORE the guard's route layer is
   * registered. Runs on a freshly created, non-persistent context.
   */
  readonly contextSetup?: (context: BrowserContext) => void | Promise<void>;
  /**
   * Seam used by the offline synthetic test harness (and only it) to serve each
   * document hop without touching the network. Production callers omit it; the
   * default performs the request through the browser's own network stack with
   * redirects disabled so the walker can inspect every hop's raw status/headers.
   */
  readonly fetchHop?: (route: Route) => Promise<HopResponse>;
  /**
   * Additive S35.11 observation plan. When present, the transport evaluates the
   * final document's rendered seat map with a single fixed, transport-owned
   * evaluator (never caller-supplied code) and exposes the schema-validated
   * result on the SUCCESS payload's `observation` field. Any evaluation failure
   * or timeout maps to `NAVIGATION_FAILED` ("observation_failed") and still
   * guarantees cleanup.
   */
  readonly observationPlan?: ObservationPlan;
}

/**
 * Declarative seat-map observation plan (S35.11). The operator encodes, at
 * authorization time, which rendered seat attributes answer question 1
 * (carry-through) and question 2 (geometry). `fieldMapping` maps output field
 * names to the seat element's attribute names (or the literal `"@text"` for the
 * element's text content); `row`, `column`, `name`, and `available` are the
 * required output fields, `status` is optional.
 */
export interface ObservationPlan {
  /**
   * Evidence source for the geometry answer (S35.11). `"dom"` reads the rendered
   * seat map with the CSS selectors below (static HTML first, live page fallback);
   * `"flight"` parses the embedded Flight-JSON seat map via the providers
   * `parseSeats` and never runs the DOM evaluator — in that mode
   * `selectedSeatSelector`, `geometrySeatSelector`, and `fieldMapping` are ignored.
   */
  readonly source: "dom" | "flight";
  readonly targetSeatNames: string[];
  readonly selectedSeatSelector: string;
  readonly geometrySeatSelector: string;
  readonly fieldMapping: Record<string, string>;
  readonly maxRadius: number;
  readonly maxResults: number;
}

/** Mutable runtime hop record; structurally satisfies the readonly `DocumentHop` type. */
interface MutableHop {
  classification: DocumentHop["classification"];
  status: number | null;
  durationMs: number | null;
}

interface PendingFetch {
  readonly promise: Promise<HopResponse>;
  resolve(value: HopResponse): void;
  reject(error: unknown): void;
}

function pendingFetch(): PendingFetch {
  let resolve!: (value: HopResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<HopResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The route handler can reject this promise before the walker awaits it (a refused
  // or failed fetch hop): keep the rejection observed so that window never surfaces as
  // an unhandled rejection. The walker's own await still sees the same rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function scrubErrorUrl(raw: string): string {
  // NAVIGATION_FAILED.error must never carry a literal URL (P6.14).
  return raw.replace(/https?:\/\/\S+/g, "[REDACTED_URL]");
}

async function defaultFetchHop(route: Route): Promise<HopResponse> {
  // Redirects disabled: the walker must see every hop's raw status and headers.
  const response = await route.fetch({ maxRedirects: 0 });
  return {
    status: response.status(),
    headers: response.headers(),
    body: await response.text(),
  };
}

type AwaitResult =
  | Readonly<{ kind: "raw"; raw: HopResponse }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "rejected"; error: unknown }>;

/** Waits for one hop's raw response, bounded by the corridor deadline and the external signal. */
function awaitHopResponse(
  promise: Promise<HopResponse>,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<AwaitResult> {
  return new Promise((resolve) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      resolve({ kind: "timed-out" });
      return;
    }
    const timer = setTimeout(() => finish({ kind: "timed-out" }), remaining);
    const onAbort = (): void => finish({ kind: "cancelled" });
    let settled = false;
    function finish(result: AwaitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    }
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (raw) => finish({ kind: "raw", raw }),
      (error) => finish({ kind: "rejected", error }),
    );
  });
}

/** The AMC_INITIAL corridor document origin (ADR 0005 §B; `isAllowedUrl`'s origin). */
const AMC_ORIGIN = "https://www.amctheatres.com";

/**
 * ADR 0010 (P6.11 amendment): the theatre-search corridor route lets same-origin
 * XHR/fetch subresources through the guard so AMC's own search-widget JS can populate
 * results. This is the ONLY subresource exception: it applies only while the walker's
 * current navigation target is the `movie-theatres?q=…` variant of `isAllowedUrl`
 * (never movies, showtimes-by-date, or seats), only to `xhr`/`fetch`, and only to
 * requests on the corridor document's own origin (`https://www.amctheatres.com` — no
 * other AMC subdomain). Every other combination keeps P6.11's blanket abort.
 */
function isTheatreSearchPassthrough(currentUrl: string, request: Request): boolean {
  const resourceType = request.resourceType();
  if (resourceType !== "xhr" && resourceType !== "fetch") {
    return false;
  }
  let subresourceUrl: URL;
  try {
    subresourceUrl = new URL(request.url());
  } catch {
    return false;
  }
  if (subresourceUrl.origin !== AMC_ORIGIN) {
    return false;
  }
  let documentUrl: URL;
  try {
    documentUrl = new URL(currentUrl);
  } catch {
    return false;
  }
  // Pin the theatre-search variant: `isAllowedUrl` (P6.6's classifier) admits exactly
  // four patterns, and only the theatre-search one has pathname `/movie-theatres`.
  if (documentUrl.pathname !== "/movie-theatres") {
    return false;
  }
  return isAllowedUrl(documentUrl);
}

export async function runCorridorNavigation(
  supervisor: BrowserSupervisor,
  options: CorridorNavigationOptions,
): Promise<NavigationAttempt> {
  const span = getNavigationTracer().startSpan("amc.browser_navigation");
  const versions = supervisor.versions;

  // Deployment-identity policy check (P1) — a config error, fail before any browser work.
  validateIdentity({ userAgent: options.userAgent });

  // Fail fast, with zero browser work, when the dispatch target is not a permitted
  // AMC_INITIAL document (P6.4: the navigation halts rather than guessing).
  const targetCheck = checkDocument(INITIAL_CORRIDOR_STATE, options.targetUrl);
  if (!targetCheck.ok) {
    const outcome: NavigationOutcome = {
      kind: "GUARD_REJECTED",
      reason: targetCheck.reason,
      hops: [],
    };
    finishAttempt(span, outcome, options, versions, {
      physicalDocuments: 0,
      subresourceAborts: 0,
      chromeRecycled: false,
    });
    return { outcome, cleanupCompleted: Promise.resolve() };
  }

  const externalAborted = (): boolean => options.signal?.aborted === true;

  let context: BrowserContext | null = null;
  let resolveCleanup!: () => void;
  // P6.3 — the cleanup-completion signal resolves only once the context (and, when
  // applicable, the full Chrome tree) is confirmed dead. Cleanup starts the moment the
  // navigation outcome settles, on every branch; S8 awaits this promise before it
  // releases capacity (S8.16).
  const cleanupCompleted = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });
  const runCleanup = (): void => {
    const created = context;
    context = null;
    if (created === null) {
      resolveCleanup();
      return;
    }
    // Cleanup failure must never leave the signal unresolved: S8 releases strictly
    // after it, so it resolves once cleanupContext settles either way.
    void supervisor
      .cleanupContext(created)
      .catch(() => {})
      .then(() => resolveCleanup());
  };

  const closeOnAbort = (): void => {
    void context?.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });

  let state: CorridorState = INITIAL_CORRIDOR_STATE;
  const hops: MutableHop[] = [];
  let subresourceAborts = 0;
  // The walker's current navigation target. Declared before the route handler below,
  // which reads it for the ADR 0010 theatre-search passthrough check.
  let currentUrl = options.targetUrl;

  try {
    context = await supervisor.newContext({ userAgent: options.userAgent });
    await options.contextSetup?.(context);
    const page: Page = await context.newPage();
    const fetchHop = options.fetchHop ?? defaultFetchHop;
    // Per-hop raw-response channel between the route handler and the walker.
    let channel: PendingFetch | null = null;

    await context.route("**/*", async (route) => {
      const request = route.request();
      const isMainDocument =
        request.resourceType() === "document" && request.frame() === page.mainFrame();
      if (!isMainDocument) {
        if (isTheatreSearchPassthrough(currentUrl, request)) {
          // ADR 0010 (P6.11 amendment): the theatre-search route lets its own
          // same-origin XHR/fetch through so AMC's search-widget JS can populate
          // results. A passthrough is not an abort — subresourceAborts keeps counting
          // only genuinely aborted requests.
          await route.continue();
          return;
        }
        // P6.11: abort every other non-main-document request — scripts, stylesheets,
        // images, fonts, media, WebSockets, subframe documents — and every subresource
        // type on the other three corridor routes (movies, showtimes-by-date, seats).
        subresourceAborts += 1;
        await route.abort();
        return;
      }
      const active = channel;
      if (active === null) {
        // No walker is waiting for a document (late/unsolicited navigation).
        await route.abort();
        return;
      }
      let raw: HopResponse;
      try {
        raw = await fetchHop(route);
      } catch (error) {
        active.reject(error);
        await route.abort();
        return;
      }
      active.resolve(raw);
      if (raw.status >= 300 && raw.status < 400) {
        // Never hand the browser a redirect: Chrome would follow it internally,
        // bypassing the guard on the next hop — and aborting it would commit an
        // error-page navigation that races the next dispatch. A 204 keeps the
        // current document; the walker re-dispatches explicitly.
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      await route.fulfill({ status: raw.status, headers: raw.headers, body: raw.body });
    });

    const deadline = Date.now() + options.limits.navigationTimeoutMs;
    let outcome: NavigationOutcome | null = null;

    while (outcome === null) {
      if (externalAborted()) {
        outcome = { kind: "CANCELLED" };
        break;
      }
      if (Date.now() >= deadline) {
        outcome = { kind: "NAVIGATION_FAILED", error: "navigation timed out" };
        break;
      }
      const check = checkDocument(state, currentUrl);
      if (!check.ok) {
        // Fail closed BEFORE another dispatch: the violating document is never sent.
        outcome = { kind: "GUARD_REJECTED", reason: check.reason, hops };
        break;
      }
      const hop: MutableHop = {
        classification: check.classification,
        status: null,
        durationMs: null,
      };
      hops.push(hop);
      state = check.next;

      const startedAt = Date.now();
      const attempt = pendingFetch();
      channel = attempt;
      try {
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, deadline - Date.now()),
        });
      } catch {
        // A 3xx hop is served as a 204 after publishing its raw response —
        // an expected rejection. The channel (below) is the source of truth.
      }
      hop.durationMs = Date.now() - startedAt;

      const result = await awaitHopResponse(attempt.promise, options.signal, deadline);
      if (result.kind === "cancelled") {
        outcome = { kind: "CANCELLED" };
        break;
      }
      if (result.kind === "timed-out") {
        outcome = { kind: "NAVIGATION_FAILED", error: "navigation timed out" };
        break;
      }
      if (result.kind === "rejected") {
        const failure = result.error;
        if (failure instanceof Error && failure.name === "TimeoutError") {
          outcome = { kind: "NAVIGATION_FAILED", error: "navigation timed out" };
        } else {
          outcome = {
            kind: "NAVIGATION_FAILED",
            error: scrubErrorUrl(failure instanceof Error ? failure.message : String(failure)),
          };
        }
        break;
      }
      const raw = result.raw;
      hop.status = raw.status;

      // Terminal upstream states: terminate immediately — never wait out, solve,
      // retry, or follow a Retry-After header (P6.20, ADR 0001 B9).
      if (raw.status === 403) {
        outcome = {
          kind: "UPSTREAM_BLOCKED",
          classification: hop.classification,
          hops,
          status: raw.status,
          headers: redactHeaders(raw.headers),
        };
        break;
      }
      if (raw.status === 429) {
        outcome = {
          kind: "RATE_LIMITED",
          classification: hop.classification,
          hops,
          status: raw.status,
          headers: redactHeaders(raw.headers),
        };
        break;
      }
      if ((raw.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
        outcome = {
          kind: "CHALLENGE_REQUIRED",
          classification: hop.classification,
          hops,
          status: raw.status,
          headers: redactHeaders(raw.headers),
        };
        break;
      }

      if (raw.status >= 300 && raw.status < 400) {
        const location = raw.headers["location"];
        if (location === undefined) {
          outcome = {
            kind: "NAVIGATION_FAILED",
            error: `redirect response without a location header at ${hop.classification}`,
          };
          break;
        }
        // The next hop is validated by the loop's guard check before dispatch.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // A final (non-redirect, non-terminal) document committed.
      switch (hop.classification) {
        case "AMC_INITIAL":
        case "AMC_CLEAN_RETURN":
          // Let subresources settle (each is aborted → error → load fires) so the
          // payload reflects the final document and the abort count is complete.
          try {
            await page.waitForLoadState("load", {
              timeout: Math.max(1, deadline - Date.now()),
            });
          } catch {
            outcome = { kind: "NAVIGATION_FAILED", error: "navigation timed out" };
            break;
          }
          outcome = await successOutcome(
            hop,
            hops,
            raw,
            page,
            subresourceAborts,
            options.observationPlan,
            deadline,
          );
          break;
        case "QUEUE_ENTRY":
          // The Queue-it waiting page committed and the navigation ended there —
          // entered the queue; never wait out the countdown (verification item 6).
          outcome = {
            kind: "QUEUE_ENTERED",
            classification: "QUEUE_ENTRY",
            hops,
            status: raw.status,
            headers: redactHeaders(raw.headers),
          };
          break;
        case "AMC_TOKEN_RETURN":
          // The corridor stalled after the token return — not a terminal shape.
          outcome = {
            kind: "NAVIGATION_FAILED",
            error: "corridor stalled at AMC_TOKEN_RETURN",
          };
          break;
      }
    }

    finishAttempt(span, outcome, options, versions, {
      physicalDocuments: hops.length,
      subresourceAborts,
      chromeRecycled: false,
    });
    runCleanup();
    return { outcome, cleanupCompleted };
  } catch (error) {
    const outcome: NavigationOutcome = {
      kind: "NAVIGATION_FAILED",
      error: scrubErrorUrl(error instanceof Error ? error.message : String(error)),
    };
    finishAttempt(span, outcome, options, versions, {
      physicalDocuments: hops.length,
      subresourceAborts,
      chromeRecycled: false,
    });
    runCleanup();
    return { outcome, cleanupCompleted };
  } finally {
    options.signal?.removeEventListener("abort", closeOnAbort);
  }
}

// --- S35.11 observation evaluator (fixed, transport-owned; no caller code) ---------------

/** Raw attribute values read from one seat element, keyed by OUTPUT field name. */
interface RawSeatRow {
  readonly row: string | null;
  readonly column: string | null;
  readonly name: string | null;
  readonly available: string | null;
  readonly status: string | null;
}

interface RawObservation {
  readonly geometry: readonly RawSeatRow[];
  readonly selected: readonly RawSeatRow[];
}

/** A seat after coercion; unparseable required fields are `null` and fail the schema. */
interface CandidateSeat {
  readonly row: number | null;
  readonly column: number | null;
  readonly name: string;
  readonly available: boolean | null;
  readonly status: string | null;
}

/** The pre-validation candidate — `available` may be `null` and is rejected by Zod. */
interface CandidateObservation {
  readonly carryThrough: Observation["carryThrough"];
  readonly geometryNearTarget: ReadonlyArray<{
    readonly row: number;
    readonly column: number;
    readonly name: string;
    readonly available: boolean | null;
    readonly status: string | null;
  }>;
}

function coerceInt(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

function coerceBool(raw: string | null): boolean | null {
  if (raw === null) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return null;
}

function interpretSeat(raw: RawSeatRow): CandidateSeat {
  return {
    row: coerceInt(raw.row),
    column: coerceInt(raw.column),
    name: raw.name ?? "",
    available: coerceBool(raw.available),
    status: raw.status,
  };
}

function computeCarryThrough(
  raw: RawObservation,
  source: ObservationPlan["source"],
): Observation["carryThrough"] {
  // Flight-parse mode observes geometry only — `parseSeats` has no selection
  // concept — so an empty `selected` here cannot assert NONE_SELECTED (that would
  // be a false claim about a data source that cannot answer question 1).
  if (source === "flight") {
    return "INCONCLUSIVE";
  }
  // No seat rendered at all (empty seat map): we cannot distinguish "no seat
  // selected" from "the seat map never rendered", so the answer is inconclusive.
  if (raw.geometry.length === 0) {
    return "INCONCLUSIVE";
  }
  if (raw.selected.length === 0) {
    return "NONE_SELECTED";
  }
  const name = raw.selected[0]?.name ?? "";
  if (name.trim() === "") {
    return "INCONCLUSIVE";
  }
  return { selectedSeatId: name };
}

function buildObservation(plan: ObservationPlan, raw: RawObservation): CandidateObservation {
  const seats = raw.geometry.map(interpretSeat);

  const targetCoords: Array<{ readonly row: number; readonly column: number }> = [];
  for (const seat of seats) {
    const { row, column } = seat;
    if (row === null || column === null) {
      continue;
    }
    if (plan.targetSeatNames.includes(seat.name)) {
      targetCoords.push({ row, column });
    }
  }

  const geometryNearTarget: Array<{
    readonly row: number;
    readonly column: number;
    readonly name: string;
    readonly available: boolean | null;
    readonly status: string | null;
  }> = [];
  for (const seat of seats) {
    const { row, column } = seat;
    if (row === null || column === null) {
      continue;
    }
    const withinRadius = targetCoords.some(
      (target) =>
        Math.max(Math.abs(row - target.row), Math.abs(column - target.column)) <= plan.maxRadius,
    );
    if (!withinRadius) {
      continue;
    }
    geometryNearTarget.push({
      row,
      column,
      name: seat.name,
      available: seat.available,
      status: seat.status,
    });
  }

  return {
    carryThrough: computeCarryThrough(raw, plan.source),
    geometryNearTarget: geometryNearTarget.slice(0, Math.max(0, plan.maxResults)),
  };
}

/** Read one output field from a seat element via the plan's attribute (or text) mapping. */
function readField(
  read: (source: string) => string | null,
  fieldMapping: Record<string, string>,
  field: string,
): string | null {
  const source = fieldMapping[field];
  if (source === undefined) {
    return null;
  }
  return read(source);
}

/** Static evaluation: parse the extracted document HTML with cheerio — no live page. */
function readRowsFromHtml(plan: ObservationPlan, documentHtml: string): RawObservation {
  const $ = cheerio.load(documentHtml);

  const readRow = (el: {
    attr: (name: string) => string | undefined;
    text: () => string;
  }): RawSeatRow => {
    const read = (source: string): string | null => {
      if (source === "@text") {
        return el.text().trim();
      }
      return el.attr(source) ?? null;
    };
    return {
      row: readField(read, plan.fieldMapping, "row"),
      column: readField(read, plan.fieldMapping, "column"),
      name: readField(read, plan.fieldMapping, "name"),
      available: readField(read, plan.fieldMapping, "available"),
      status: readField(read, plan.fieldMapping, "status"),
    };
  };

  return {
    geometry: $(plan.geometrySeatSelector)
      .toArray()
      .map((node) => readRow($(node))),
    selected: $(plan.selectedSeatSelector)
      .toArray()
      .map((node) => readRow($(node))),
  };
}

/** Minimal DOM element surface the serialized page function reads (no DOM lib). */
interface PageElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

/**
 * The browser's real `document` global — declared locally (not the DOM lib)
 * because browser-runtime is server-only (`types: ["node"]`, `lib: ["ES2024"]`).
 * The page function that references it is serialized into Chrome, where the
 * global genuinely exists; it is never read on the server.
 */
declare const document: {
  querySelectorAll(selector: string): readonly PageElement[];
};

/**
 * The live fallback evaluator, serialized into the page by `page.evaluate`. It
 * performs read-only DOM queries (`querySelectorAll` + `getAttribute`/`textContent`)
 * and returns raw field rows for server-side interpretation — it mutates nothing and
 * dispatches nothing.
 */
function readObservationInPage(args: {
  readonly geometrySelector: string;
  readonly selectedSelector: string;
  readonly fieldMapping: Record<string, string>;
}): RawObservation {
  const readSource = (el: PageElement, source: string): string | null => {
    if (source === "@text") {
      return (el.textContent ?? "").trim();
    }
    return el.getAttribute(source);
  };
  const readRow = (el: PageElement): RawSeatRow => {
    const readFieldLocal = (field: string): string | null => {
      const source = args.fieldMapping[field];
      if (source === undefined) {
        return null;
      }
      return readSource(el, source);
    };
    return {
      row: readFieldLocal("row"),
      column: readFieldLocal("column"),
      name: readFieldLocal("name"),
      available: readFieldLocal("available"),
      status: readFieldLocal("status"),
    };
  };
  return {
    geometry: Array.from(document.querySelectorAll(args.geometrySelector)).map(readRow),
    selected: Array.from(document.querySelectorAll(args.selectedSelector)).map(readRow),
  };
}

/** Run the live evaluator in the page, bounded by the corridor deadline. */
async function evaluateInPage(
  page: Page,
  plan: ObservationPlan,
  deadlineMs: number,
): Promise<RawObservation> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error("observation timed out");
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(readObservationInPage, {
        geometrySelector: plan.geometrySeatSelector,
        selectedSelector: plan.selectedSeatSelector,
        fieldMapping: plan.fieldMapping,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("observation timed out")), remaining);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Map one flight-parse `RawGridCell` into the transport's raw-seat-row shape.
 * `status` is `null` by contract: `RawGridCell` carries no seat-status field,
 * and inferring one from `kind`/`rawType` would fabricate data (S35.11).
 */
function mapFlightCell(cell: RawGridCell): RawSeatRow {
  return {
    row: String(cell.row),
    column: String(cell.column),
    name: cell.name ?? null,
    available: String(cell.available),
    status: null,
  };
}

/** Derive the numeric AMC showtime id from a guard-validated seats-route URL. */
function extractShowtimeId(seatsUrl: string): number {
  const url = new URL(seatsUrl);
  const match = url.pathname.match(/^\/showtimes\/(\d+)\/seats$/);
  const id = match?.[1];
  if (id === undefined) {
    throw new Error(`cannot derive showtime id from seats URL pathname: ${url.pathname}`);
  }
  return Number.parseInt(id, 10);
}

/**
 * The transport-owned observation evaluator (S35.11). `source: "dom"` reads the
 * static HTML first and falls back to the live `page.evaluate` only when the
 * static HTML is inconclusive; `source: "flight"` parses the embedded Flight-JSON
 * seat map with the providers `parseSeats` and never runs the DOM evaluator. The
 * result is always run through the strict runtime schema before it leaves here.
 */
async function evaluateObservation(
  plan: ObservationPlan,
  documentHtml: string,
  page: Page,
  deadlineMs: number,
  finalUrl: string,
): Promise<Observation> {
  if (plan.source === "flight") {
    const expectedShowtimeId = extractShowtimeId(finalUrl);
    const result = parseSeats(documentHtml, new Date(), finalUrl, expectedShowtimeId);
    const raw: RawObservation = {
      geometry: result.grid.cells.map(mapFlightCell),
      selected: [],
    };
    return observationSchema.parse(buildObservation(plan, raw));
  }
  const staticRows = readRowsFromHtml(plan, documentHtml);
  if (staticRows.geometry.length > 0) {
    return observationSchema.parse(buildObservation(plan, staticRows));
  }
  const liveRows = await evaluateInPage(page, plan, deadlineMs);
  return observationSchema.parse(buildObservation(plan, liveRows));
}

async function successOutcome(
  lastHop: DocumentHop,
  hops: readonly DocumentHop[],
  raw: HopResponse,
  page: Page,
  subresourceAborts: number,
  observationPlan: ObservationPlan | undefined,
  deadlineMs: number,
): Promise<NavigationOutcome> {
  let payload: SanitizedPayload;
  try {
    const finalUrl = new URL(page.url());
    payload = {
      finalUrl: {
        origin: finalUrl.origin,
        pathname: finalUrl.pathname,
        queryKeys: Array.from(finalUrl.searchParams.keys()),
      },
      finalStatus: raw.status,
      headers: redactHeaders(raw.headers),
      documentHtml: await page.content(),
    };
  } catch (error) {
    const detail = scrubErrorUrl(error instanceof Error ? error.message : String(error));
    return {
      kind: "NAVIGATION_FAILED",
      error: `failed to extract the sanitized payload: ${detail}`,
    };
  }

  if (observationPlan !== undefined) {
    try {
      const observation = await evaluateObservation(
        observationPlan,
        payload.documentHtml,
        page,
        deadlineMs,
        page.url(),
      );
      payload = { ...payload, observation };
    } catch {
      // Fail closed: any evaluation, schema, or timeout failure ends this navigation
      // with a scrubbed cause — never a partial observation.
      return { kind: "NAVIGATION_FAILED", error: "observation_failed" };
    }
  }

  return {
    kind: "SUCCESS",
    classification: lastHop.classification,
    hops,
    payload,
    subresourceAborts,
  };
}

function finishAttempt(
  span: Span,
  outcome: NavigationOutcome,
  options: CorridorNavigationOptions,
  versions: { readonly chrome: string; readonly playwright: string },
  counts: {
    readonly physicalDocuments: number;
    readonly subresourceAborts: number;
    readonly chromeRecycled: boolean;
  },
): void {
  span.setAttributes(
    buildSafeSpanAttributes(outcome, options.scope.egressIdentityLabel, versions, counts),
  );
  attachHopEvents(span, hopList(outcome));
  const headers =
    outcome.kind === "SUCCESS"
      ? outcome.payload.headers
      : "headers" in outcome
        ? outcome.headers
        : null;
  if (headers !== null) {
    try {
      // Headers were already redacted at construction (redactHeaders throws fail-closed
      // there); re-deriving them through the same primitive proves the span-attribute
      // path can never carry an unredacted value (P6.12). If it somehow still fails,
      // the attribute path emits nothing rather than an unredacted value.
      attachRedactedResponseHeaders(span, headers);
    } catch {
      // Fail-closed: no header attributes rather than unredacted ones.
    }
  }
  span.end();
  recordNavigationMetrics(outcome, options.scope, counts.physicalDocuments);
}

function hopList(outcome: NavigationOutcome): readonly DocumentHop[] {
  if ("hops" in outcome) {
    return outcome.hops;
  }
  return [];
}
