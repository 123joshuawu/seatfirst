/**
 * Offline synthetic integration suite — the 14-item verification list from
 * `docs/tasks/P6-browser-runtime-transport/spec.md`.
 *
 * Every navigation runs against a local synthetic fulfillment harness: the harness is
 * the entire network (no socket, no DNS), AMC hostnames are network-denied by
 * construction (P6.19), and real Chrome is driven through the production transport path
 * — the guard layer runs first, the harness is reached only through `route.fallback()`
 * for guard-accepted documents.
 *
 * Skips (loudly) when no Chrome binary exists: the CI pinned browser test image is I1's
 * job (`docs/seatfirst-architecture.md:620`); locally, a system Chrome is used.
 * Verification items 4 and 5 (`redactHeaders` IP-scrubbing + fail-closed throw) live in
 * the primitive's own dedicated suite, `packages/providers/test/redactHeaders.test.ts`
 * (ADR 0005 §D requires coverage independent of the fixture-capture suite).
 */

import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext } from "playwright-core";
import type { NavigationAttempt, NavigationOutcome, NavigationScope } from "../src/outcome.js";
import { startReadinessServer, type ReadinessServer } from "../src/readiness-server.js";
import { BrowserSupervisor } from "../src/supervisor.js";
import { runCorridorNavigation, type ObservationPlan } from "../src/transport.js";
import {
  createHarness,
  deferred,
  MOVIES_XHR_PAGE_HTML,
  QUEUE_WAITING_HTML,
  SEAT_PAGE_HTML,
  THEATRE_SEARCH_ABORTED_PAGE_HTML,
  THEATRE_SEARCH_PAGE_HTML,
  type SyntheticHarness,
  type SyntheticHop,
} from "./support/harness.js";
import { findChromeExecutable } from "./support/chrome.js";
import { startSubresourceServer, type SubresourceServer } from "./support/subresource-server.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — browser-runtime corridor suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers: the runtime tunables under gate 14
// (cleanup grace, readiness timeout, navigation timeout) are injected per call below.
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;
const NAV_MS = 20_000;

const MOVIES = "https://www.amctheatres.com/movies";
const QUEUE = `https://queue.amctheatres.com/?c=amc&e=seats&ver=v1&cver=2&man=seatfinder&enqueuetoken=0000-1111&kupver=3&t=${encodeURIComponent(MOVIES)}`;
const TOKEN_RETURN = `${MOVIES}?queueittoken=q-123`;
const THEATRE_SEARCH = "https://www.amctheatres.com/movie-theatres?q=90045";
const SCOPE: NavigationScope = {
  providerId: "amc",
  observationId: "obs-test",
  fetchRunId: "run-test",
  routeClass: "SHOWTIME_FETCH",
  egressIdentityLabel: "test-relay-eip-label",
};
const USER_AGENT = "SeatFinder-Test/1.0 (+https://example.invalid/contact)";

/** Synthetic seat-element spec for the S35.11 observation-seam tests. */
interface SeatSpec {
  readonly row: number;
  readonly column: number;
  readonly name: string;
  readonly available: boolean | string;
  readonly status?: string;
  readonly selected?: boolean;
}

function seatMapHtml(seats: readonly SeatSpec[]): string {
  const nodes = seats
    .map((s) => {
      const attrs = [
        `data-row="${s.row}"`,
        `data-column="${s.column}"`,
        `data-name="${s.name}"`,
        `data-available="${s.available}"`,
      ];
      if (s.status !== undefined) {
        attrs.push(`data-status="${s.status}"`);
      }
      if (s.selected === true) {
        attrs.push(`data-selected="true"`);
      }
      return `      <div data-seat ${attrs.join(" ")}></div>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
  <head><title>seat page</title></head>
  <body>
    <h1>Seats</h1>
    <div id="seat-map">
${nodes}
    </div>
  </body>
</html>`;
}

/**
 * The declarative plan the S35.11 tests drive through the fixed evaluator:
 * target `A26` (selected), `maxRadius: 2`, `maxResults: 2`.
 */
const OBSERVATION_PLAN: ObservationPlan = {
  source: "dom",
  targetSeatNames: ["A26"],
  selectedSeatSelector: "[data-seat][data-selected='true']",
  geometrySeatSelector: "[data-seat]",
  fieldMapping: {
    row: "data-row",
    column: "data-column",
    name: "data-name",
    available: "data-available",
    status: "data-status",
  },
  maxRadius: 2,
  maxResults: 2,
};

/**
 * The flight-parse plan (S35.11): `source: "flight"` reads the embedded Flight-JSON
 * seat map via `parseSeats`, so the DOM selectors are ignored (carried only to
 * satisfy the required-shape contract) and question 1 is always INCONCLUSIVE.
 */
const FLIGHT_PLAN: ObservationPlan = {
  source: "flight",
  targetSeatNames: ["A26"],
  selectedSeatSelector: "",
  geometrySeatSelector: "",
  fieldMapping: {},
  maxRadius: 2,
  maxResults: 2,
};

/** Synthetic Flight-JSON seat for the offline flight-parse tests. */
interface FlightSeatSpec {
  readonly row: number;
  readonly column: number;
  readonly name: string;
  readonly available: boolean;
}

/** A synthetic AMC Flight payload: one seat-map row and one showtime row. */
function flightSeatPageHtml(showtimeId: number, seats: readonly FlightSeatSpec[]): string {
  const seatMapRow = JSON.stringify({
    seatingLayout: {
      columns: 20,
      rows: 5,
      seats: seats.map((s) => ({
        available: s.available,
        column: s.column,
        row: s.row,
        name: s.name,
        type: "CanReserve",
        shouldDisplay: true,
      })),
    },
  });
  const showtimeRow = JSON.stringify({
    showtimeId,
    showDateTimeUtc: "2026-08-17T19:00:00Z",
    performanceNumber: 1,
    prices: [{ price: 12.5 }],
  });
  const flightStream = `0:${seatMapRow}\n1:${showtimeRow}\n`;
  const chunk = JSON.stringify([1, flightStream]);
  return `<!doctype html>
<html>
  <head><title>seat page</title></head>
  <body>
    <script>self.__next_f.push(${chunk});</script>
  </body>
</html>`;
}

interface CorridorOverrides {
  readonly initialStatus?: number;
  readonly initialHeaders?: Record<string, string>;
  readonly queueStatus?: number;
  readonly queueHeaders?: Record<string, string>;
  readonly queueUrl?: string;
  readonly queueBody?: string;
  readonly tokenStatus?: number;
  readonly tokenUrl?: string;
  readonly cleanStatus?: number;
  readonly cleanUrl?: string;
  readonly cleanBody?: string;
  /** Caller-provided: the test owns registration (heldDeferreds) and release. */
  readonly holdQueue?: ReturnType<typeof deferred>;
}

function corridorHops(overrides: CorridorOverrides = {}): SyntheticHop[] {
  const initialStatus = overrides.initialStatus ?? 302;
  const queueStatus = overrides.queueStatus ?? 302;
  const tokenStatus = overrides.tokenStatus ?? 302;
  const cleanStatus = overrides.cleanStatus ?? 200;
  return [
    {
      url: MOVIES,
      status: initialStatus,
      ...(initialStatus === 302 ? { location: QUEUE } : {}),
      ...(initialStatus !== 302 && overrides.initialHeaders !== undefined
        ? { headers: overrides.initialHeaders }
        : {}),
    },
    {
      url: overrides.queueUrl ?? QUEUE,
      status: queueStatus,
      ...(queueStatus === 302 ? { location: TOKEN_RETURN } : {}),
      ...(queueStatus !== 302 && overrides.queueHeaders !== undefined
        ? { headers: overrides.queueHeaders }
        : {}),
      ...(queueStatus !== 302 ? { body: overrides.queueBody ?? QUEUE_WAITING_HTML } : {}),
      ...(overrides.holdQueue !== undefined ? { hold: overrides.holdQueue } : {}),
    },
    {
      url: overrides.tokenUrl ?? TOKEN_RETURN,
      status: tokenStatus,
      ...(tokenStatus === 302 ? { location: MOVIES } : {}),
    },
    {
      url: overrides.cleanUrl ?? MOVIES,
      status: cleanStatus,
      body: overrides.cleanBody ?? SEAT_PAGE_HTML,
    },
  ];
}

interface Runner {
  readonly harness: SyntheticHarness;
  readonly attempt: Promise<NavigationAttempt>;
  readonly abort: () => void;
}

interface RunOptions {
  readonly targetUrl?: string;
  readonly seed?: (context: BrowserContext) => Promise<void>;
  readonly observationPlan?: ObservationPlan;
}

function runAgainst(
  supervisor: BrowserSupervisor,
  hops: SyntheticHop[],
  options: RunOptions = {},
): Runner {
  const harness = createHarness(hops);
  const controller = new AbortController();
  const attempt = runCorridorNavigation(supervisor, {
    scope: SCOPE,
    targetUrl: options.targetUrl ?? MOVIES,
    userAgent: USER_AGENT,
    limits: { navigationTimeoutMs: NAV_MS },
    signal: controller.signal,
    fetchHop: harness.fetchHop,
    contextSetup: async (context) => {
      if (options.seed !== undefined) {
        await options.seed(context);
      }
    },
    ...(options.observationPlan !== undefined ? { observationPlan: options.observationPlan } : {}),
  });
  return { harness, attempt, abort: () => controller.abort() };
}

async function outcomeOf(runner: Runner): Promise<NavigationOutcome> {
  const attempt = await runner.attempt;
  await attempt.cleanupCompleted;
  return attempt.outcome;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("waitFor deadline exceeded");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isGroupDead(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: gone. EPERM: the group id was recycled by a foreign process — the
    // supervisor's tree is gone either way.
    return code === "ESRCH" || code === "EPERM";
  }
}

const heldDeferreds: Array<ReturnType<typeof deferred>> = [];

describe.skipIf(chromeExecutable === null)(
  "browser-runtime corridor (offline synthetic, AMC network-denied)",
  () => {
    let readiness: ReadinessServer;
    let supervisor: BrowserSupervisor;

    beforeAll(async () => {
      readiness = await startReadinessServer();
      supervisor = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: SCOPE.egressIdentityLabel,
        providerId: SCOPE.providerId,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
    });

    afterAll(async () => {
      // The suite's shared warm Chrome (and its readiness server) is never otherwise
      // torn down — without this, every test run leaks one Chrome process group.
      await supervisor.shutdown().catch(() => {});
      await readiness.close().catch(() => {});
    });

    afterEach(() => {
      // Release any held hop so its route handler cannot outlive the test.
      for (const held of heldDeferreds.splice(0)) {
        held.resolve();
      }
    });

    it("1. redirect state machine — positive path: four classified hops and a SUCCESS outcome", async () => {
      const runner = runAgainst(supervisor, corridorHops());
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      // Observed classification at each hop.
      expect(outcome.hops.map((hop) => hop.classification)).toEqual([
        "AMC_INITIAL",
        "QUEUE_ENTRY",
        "AMC_TOKEN_RETURN",
        "AMC_CLEAN_RETURN",
      ]);
      expect(outcome.hops.map((hop) => hop.status)).toEqual([302, 302, 302, 200]);
      expect(outcome.classification).toBe("AMC_CLEAN_RETURN");
      expect(outcome.payload.finalUrl).toEqual({
        origin: "https://www.amctheatres.com",
        pathname: "/movies",
        queryKeys: [],
      });
      expect(outcome.payload.documentHtml).toContain("seat-map");
      // The synthetic network saw exactly the four scripted documents, in order, and
      // refused nothing.
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([
        MOVIES,
        QUEUE,
        TOKEN_RETURN,
        MOVIES,
      ]);
      expect(runner.harness.refusals).toEqual([]);
    });

    it("1b. redirect state machine — ADR 0021: bare /movie-theatres directory-index target completes all four hops", async () => {
      const target = "https://www.amctheatres.com/movie-theatres";
      const queue = `https://queue.amctheatres.com/?c=amc&e=seats&ver=v1&cver=2&man=seatfinder&enqueuetoken=0000-1111&kupver=3&t=${encodeURIComponent(target)}`;
      const tokenReturn = `${target}?queueittoken=q-123`;
      const hops: SyntheticHop[] = [
        { url: target, status: 302, location: queue },
        { url: queue, status: 302, location: tokenReturn },
        { url: tokenReturn, status: 302, location: target },
        { url: target, status: 200, body: SEAT_PAGE_HTML },
      ];
      const runner = runAgainst(supervisor, hops, { targetUrl: target });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      expect(outcome.hops.map((hop) => hop.classification)).toEqual([
        "AMC_INITIAL",
        "QUEUE_ENTRY",
        "AMC_TOKEN_RETURN",
        "AMC_CLEAN_RETURN",
      ]);
      expect(outcome.classification).toBe("AMC_CLEAN_RETURN");
      expect(outcome.payload.finalUrl).toEqual({
        origin: "https://www.amctheatres.com",
        pathname: "/movie-theatres",
        queryKeys: [],
      });
      expect(runner.harness.refusals).toEqual([]);
    });

    it("2. redirect state machine — every guard rejection fails closed before the next dispatch", async () => {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly hops: SyntheticHop[];
        readonly targetUrl?: string;
        readonly reason: string;
        /** Documents the harness is allowed to see before the violation is aborted. */
        readonly visible: readonly string[];
      }> = [
        // AMC_INITIAL: the dispatch target itself is rejected before any browser work —
        // the synthetic network sees nothing at all.
        {
          name: "initial wrong origin",
          hops: [{ url: MOVIES, status: 302, location: QUEUE }],
          targetUrl: "https://evil.example.com/movies",
          reason: "INITIAL_NOT_ALLOWED",
          visible: [],
        },
        {
          name: "initial disallowed shape",
          hops: [{ url: MOVIES, status: 302, location: QUEUE }],
          targetUrl: `${MOVIES}?extra=1`,
          reason: "INITIAL_NOT_ALLOWED",
          visible: [],
        },
        // QUEUE_ENTRY
        {
          name: "queue wrong origin",
          hops: [
            { url: MOVIES, status: 302, location: "https://waiting.evil.example.com/" },
            { url: "https://waiting.evil.example.com/", status: 200, body: "x" },
          ],
          reason: "WRONG_ORIGIN",
          visible: [MOVIES],
        },
        {
          name: "queue unexpected pathname",
          hops: [
            {
              url: MOVIES,
              status: 302,
              location:
                "https://queue.amctheatres.com/some/other?c=1&t=" + encodeURIComponent(MOVIES),
            },
            {
              url: "https://queue.amctheatres.com/some/other?c=1&t=" + encodeURIComponent(MOVIES),
              status: 200,
              body: "x",
            },
          ],
          reason: "UNEXPECTED_PATHNAME",
          visible: [MOVIES],
        },
        {
          name: "queue disallowed query key",
          hops: [
            {
              url: MOVIES,
              status: 302,
              location:
                "https://queue.amctheatres.com/?c=1&t=" + encodeURIComponent(MOVIES) + "&sneaky=1",
            },
            {
              url:
                "https://queue.amctheatres.com/?c=1&t=" + encodeURIComponent(MOVIES) + "&sneaky=1",
              status: 200,
              body: "x",
            },
          ],
          reason: "DISALLOWED_QUERY_KEY",
          visible: [MOVIES],
        },
        {
          name: "queue missing t constraint",
          hops: [
            { url: MOVIES, status: 302, location: "https://queue.amctheatres.com/?c=1" },
            { url: "https://queue.amctheatres.com/?c=1", status: 200, body: "x" },
          ],
          reason: "MISSING_T",
          visible: [MOVIES],
        },
        {
          name: "queue t that fails AMC_INITIAL after decode",
          hops: [
            {
              url: MOVIES,
              status: 302,
              location:
                "https://queue.amctheatres.com/?c=1&t=" +
                encodeURIComponent("https://evil.example.com/movies"),
            },
            {
              url:
                "https://queue.amctheatres.com/?c=1&t=" +
                encodeURIComponent("https://evil.example.com/movies"),
              status: 200,
              body: "x",
            },
          ],
          reason: "INVALID_T_TARGET",
          visible: [MOVIES],
        },
        // AMC_TOKEN_RETURN
        {
          name: "token-return unexpected pathname",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            {
              url: QUEUE,
              status: 302,
              location: "https://www.amctheatres.com/other?queueittoken=q",
            },
            { url: "https://www.amctheatres.com/other?queueittoken=q", status: 200, body: "x" },
          ],
          reason: "UNEXPECTED_PATHNAME",
          visible: [MOVIES, QUEUE],
        },
        {
          name: "token-return missing queueittoken",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: MOVIES },
            { url: MOVIES, status: 200, body: "x" },
          ],
          reason: "UNEXPECTED_QUERY_SHAPE",
          visible: [MOVIES, QUEUE],
        },
        {
          name: "token-return extra query key",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: `${MOVIES}?queueittoken=q&extra=1` },
            { url: `${MOVIES}?queueittoken=q&extra=1`, status: 200, body: "x" },
          ],
          reason: "UNEXPECTED_QUERY_SHAPE",
          visible: [MOVIES, QUEUE],
        },
        // AMC_CLEAN_RETURN
        {
          name: "clean-return extra params",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: TOKEN_RETURN },
            { url: TOKEN_RETURN, status: 302, location: `${MOVIES}?leftover=1` },
            { url: `${MOVIES}?leftover=1`, status: 200, body: "x" },
          ],
          reason: "EXTRA_PARAMS",
          visible: [MOVIES, QUEUE, TOKEN_RETURN],
        },
        {
          name: "clean-return unexpected pathname",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: TOKEN_RETURN },
            { url: TOKEN_RETURN, status: 302, location: `${MOVIES}/other` },
            { url: `${MOVIES}/other`, status: 200, body: "x" },
          ],
          reason: "UNEXPECTED_PATHNAME",
          visible: [MOVIES, QUEUE, TOKEN_RETURN],
        },
        {
          name: "fifth document after corridor completion",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: TOKEN_RETURN },
            { url: TOKEN_RETURN, status: 302, location: MOVIES },
            { url: MOVIES, status: 302, location: MOVIES },
            { url: MOVIES, status: 200, body: "x" },
          ],
          reason: "UNEXPECTED_HOP",
          visible: [MOVIES, QUEUE, TOKEN_RETURN, MOVIES],
        },
      ];

      for (const testCase of cases) {
        const runner = runAgainst(
          supervisor,
          testCase.hops,
          testCase.targetUrl === undefined ? {} : { targetUrl: testCase.targetUrl },
        );

        const outcome = await outcomeOf(runner);
        expect(outcome.kind, testCase.name).toBe("GUARD_REJECTED");
        if (outcome.kind === "GUARD_REJECTED") {
          expect(outcome.reason, testCase.name).toBe(testCase.reason);
        }
        // The navigation halted: the violating document was aborted before dispatch, so
        // the synthetic network only ever saw the hops that preceded it.
        expect(
          runner.harness.documents.map((doc) => doc.url),
          testCase.name,
        ).toEqual(testCase.visible);
        expect(runner.harness.refusals, testCase.name).toEqual([]);
      }
    });

    it("3. subresource abortion — scripts/styles/images are blocked while documents load", async () => {
      const runner = runAgainst(supervisor, corridorHops());
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error("expected SUCCESS");
      }
      // The final seat page references a script and an image; Chrome also probes
      // favicon.ico. The guard aborts them all pre-dispatch.
      expect(outcome.subresourceAborts).toBeGreaterThanOrEqual(3);
      // Positive control: exactly the four scripted documents reached the synthetic
      // network — nothing non-document can appear in its records.
      expect(runner.harness.documents).toHaveLength(4);
      expect(runner.harness.refusals).toEqual([]);
      // And the document itself did load.
      expect(outcome.payload.documentHtml).toContain("seat-map");
    });

    describe("ADR 0010 — theatre-search subresource exception (P6.11 amendment)", () => {
      let mappedSupervisor: BrowserSupervisor;
      let subresourceServer: SubresourceServer;

      beforeAll(async () => {
        subresourceServer = await startSubresourceServer();
        // The exception lets subresources through to the real network stack, so this
        // dedicated supervisor pins the AMC origin to a loopback TLS endpoint: a
        // passthrough lands on the synthetic server below, and P6.19 (no AMC egress)
        // holds by construction even if the corridor regressed. The certificate
        // override accepts the server's committed self-signed test certificate.
        mappedSupervisor = await BrowserSupervisor.start({
          executablePath: chromeExecutable as string,
          egressIdentityLabel: SCOPE.egressIdentityLabel,
          providerId: SCOPE.providerId,
          cleanupGracePeriodMs: GRACE_MS,
          readinessTimeoutMs: READINESS_MS,
          readinessTargetUrl: readiness.baseUrl,
          extraLaunchArgs: [
            `--host-resolver-rules=MAP www.amctheatres.com 127.0.0.1:${subresourceServer.port}`,
            "--ignore-certificate-errors",
          ],
        });
      });

      afterAll(async () => {
        await mappedSupervisor.shutdown().catch(() => {});
        await subresourceServer.close().catch(() => {});
      });

      it("a. same-origin fetch on the theatre-search route is let through to the local synthetic server, not counted as an abort", async () => {
        subresourceServer.requests.length = 0;
        const runner = runAgainst(
          mappedSupervisor,
          [{ url: THEATRE_SEARCH, status: 200, body: THEATRE_SEARCH_PAGE_HTML }],
          { targetUrl: THEATRE_SEARCH },
        );
        const outcome = await outcomeOf(runner);

        expect(outcome.kind).toBe("SUCCESS");
        if (outcome.kind !== "SUCCESS") {
          throw new Error("expected SUCCESS");
        }
        // The page's own JS dispatched the XHR and consumed the passthrough's
        // response (the synchronous send() gates the load event the walker captures
        expect(outcome.payload.documentHtml).toContain('data-fetch-dispatched="yes"');
        expect(outcome.payload.documentHtml).toContain(
          'data-search-result="synthetic subresource response"',
        );
        // …the corridor let it through without counting an abort…
        expect(outcome.subresourceAborts).toBe(0);
        // …and it reached the local synthetic server the origin is mapped to.
        expect(subresourceServer.requests).toEqual(["/api/theatre-search-results"]);
      });

      it("b. cross-origin and non-fetch subresources on the same route are still aborted", async () => {
        subresourceServer.requests.length = 0;
        const runner = runAgainst(
          mappedSupervisor,
          [{ url: THEATRE_SEARCH, status: 200, body: THEATRE_SEARCH_ABORTED_PAGE_HTML }],
          { targetUrl: THEATRE_SEARCH },
        );
        const outcome = await outcomeOf(runner);

        expect(outcome.kind).toBe("SUCCESS");
        if (outcome.kind !== "SUCCESS") {
          throw new Error("expected SUCCESS");
        }
        // Script, image, stylesheet, and cross-origin XHR: all still aborted — the
        // page observed the cross-origin XHR fail…
        expect(outcome.payload.documentHtml).toContain('data-cross-origin-dispatched="yes"');
        expect(outcome.payload.documentHtml).toContain('data-cross-origin-fetch="aborted"');
        expect(outcome.subresourceAborts).toBe(4);
        // …and nothing reached the synthetic server.
        expect(subresourceServer.requests).toEqual([]);
      });

      it("c. the exception does not leak to other routes: same-origin fetch on movies is still aborted", async () => {
        subresourceServer.requests.length = 0;
        const runner = runAgainst(
          mappedSupervisor,
          [{ url: MOVIES, status: 200, body: MOVIES_XHR_PAGE_HTML }],
          { targetUrl: MOVIES },
        );
        const outcome = await outcomeOf(runner);

        expect(outcome.kind).toBe("SUCCESS");
        if (outcome.kind !== "SUCCESS") {
          throw new Error("expected SUCCESS");
        }
        expect(outcome.payload.documentHtml).toContain('data-fetch-outcome="aborted"');
        expect(outcome.subresourceAborts).toBe(1);
        expect(subresourceServer.requests).toEqual([]);
      });

      it("d. ADR 0101 — native Chromium document navigation without fetchHop connects directly, verifies corridor guard and records hops", async () => {
        subresourceServer.requests.length = 0;
        const attempt = await runCorridorNavigation(mappedSupervisor, {
          scope: SCOPE,
          targetUrl: MOVIES,
          userAgent: USER_AGENT,
          limits: { navigationTimeoutMs: NAV_MS },
        });
        const outcome = attempt.outcome;
        await attempt.cleanupCompleted;

        expect(outcome.kind).toBe("SUCCESS");
        if (outcome.kind !== "SUCCESS") {
          throw new Error("expected SUCCESS");
        }
        expect(outcome.classification).toBe("AMC_INITIAL");
        expect(outcome.hops.length).toBe(1);
        expect(outcome.hops[0].classification).toBe("AMC_INITIAL");
        expect(outcome.hops[0].status).toBe(200);
        expect(typeof outcome.hops[0].durationMs).toBe("number");
        expect(outcome.payload.finalStatus).toBe(200);
        expect(outcome.payload.documentHtml).toContain("synthetic subresource response");
        expect(subresourceServer.requests).toContain("/movies");
      });
    });

    it("6. terminal state — Queue-it waiting page produces QUEUE_ENTERED; no countdown, no polling, no further documents", async () => {
      const runner = runAgainst(
        supervisor,
        corridorHops({ queueStatus: 200, queueBody: QUEUE_WAITING_HTML }),
      );
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("QUEUE_ENTERED");
      if (outcome.kind === "QUEUE_ENTERED") {
        expect(outcome.classification).toBe("QUEUE_ENTRY");
        expect(outcome.status).toBe(200);
      }
      // The browser never waited out the countdown or polled: the waiting page's script is
      // blocked and no document load occurs after the queue page.
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([MOVIES, QUEUE]);
      expect(runner.harness.refusals).toEqual([]);
    });

    it("7. terminal states — challenge (cf-mitigated) and HTTP 403 block", async () => {
      const challengeRunner = runAgainst(
        supervisor,
        corridorHops({ initialStatus: 200, initialHeaders: { "cf-mitigated": "challenge" } }),
      );
      const challenge = await outcomeOf(challengeRunner);
      expect(challenge.kind).toBe("CHALLENGE_REQUIRED");
      if (challenge.kind === "CHALLENGE_REQUIRED") {
        expect(challenge.classification).toBe("AMC_INITIAL");
        expect(challenge.headers["cf-mitigated"]).toBe("challenge");
      }

      const blockRunner = runAgainst(
        supervisor,
        corridorHops({ queueStatus: 403, queueBody: "blocked" }),
      );
      const blocked = await outcomeOf(blockRunner);
      expect(blocked.kind).toBe("UPSTREAM_BLOCKED");
      if (blocked.kind === "UPSTREAM_BLOCKED") {
        expect(blocked.classification).toBe("QUEUE_ENTRY");
        expect(blocked.status).toBe(403);
      }

      // Neither waited out, retried, nor solved: the harness saw exactly the corridor
      // prefix, nothing more.
      expect(challengeRunner.harness.documents).toHaveLength(1);
      expect(blockRunner.harness.documents.map((doc) => doc.url)).toEqual([MOVIES, QUEUE]);
    });

    it("8. terminal state — rate limiting (429) terminates with RATE_LIMITED and no Retry-After wait", async () => {
      const runner = runAgainst(
        supervisor,
        corridorHops({
          queueStatus: 429,
          queueHeaders: { "retry-after": "60" },
          queueBody: "rate limited",
        }),
      );
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("RATE_LIMITED");
      if (outcome.kind === "RATE_LIMITED") {
        expect(outcome.status).toBe(429);
        // retry-after passes through the redaction allowlist as data; the runtime does not
        // act on it.
        expect(outcome.headers["retry-after"]).toBe("60");
      }
      // No retry, no wait: the token-return hop was never requested.
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([MOVIES, QUEUE]);
    });

    it("9. cancellation — AbortSignal closes page, destroys context, cleanup signal emits without deadlock", async () => {
      const holdQueue = deferred();
      heldDeferreds.push(holdQueue);
      const runner = runAgainst(supervisor, corridorHops({ holdQueue }));
      await waitFor(() => runner.harness.documents.length >= 2, NAV_MS);
      runner.abort();
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("CANCELLED");
      // The corridor must not proceed past the queue hop.
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([MOVIES, QUEUE]);
      // The warm Chrome process survives transport-level cancellation.
      expect(supervisor.chromeProcessGroupId).toBeGreaterThan(0);
    });

    it("10. forced cleanup — a wedged page is killed after the grace period with a confirmed dead tree and a completion signal", async () => {
      const wedged = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: SCOPE.egressIdentityLabel,
        providerId: SCOPE.providerId,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
      try {
        const context = await wedged.newContext({ userAgent: USER_AGENT });
        const page = await context.newPage();
        // An active page (loopback readiness document — never AMC).
        await page.goto(readiness.baseUrl, { waitUntil: "load", timeout: NAV_MS });

        const exitPromise = wedged.waitForTreeExit();
        const groupId = wedged.chromeProcessGroupId;
        // Freeze the whole Chrome process group: every CDP-driven close now hangs, which
        // is the wedged-cleanup precondition.
        process.kill(-groupId, "SIGSTOP");
        const started = Date.now();
        await wedged.cleanupContext(context);
        const elapsed = Date.now() - started;

        // The kill was observed, not just a timeout: the grace period elapsed before the
        // signal could resolve, and the tree died by SIGKILL (a stopped process can only
        // be reaped that way).
        expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);
        const exit = await exitPromise;
        expect(exit.signal).toBe("SIGKILL");
        expect(isGroupDead(groupId)).toBe(true);
        // The signal resolved and capacity is retained: a replacement Chrome is warm.
        expect(wedged.chromeProcessGroupId).not.toBe(groupId);
        const post = await wedged.newContext();
        await post.close();
      } finally {
        await wedged.shutdown().catch(() => {});
      }
    });

    it("11. recycling — same-process fresh context isolation (cookies, storage, tokens)", async () => {
      // Seed #1: a cookie plus localStorage written by an init script on the AMC-origin
      const firstRunner = runAgainst(supervisor, corridorHops(), {
        seed: async (context) => {
          await context.addCookies([
            {
              name: "queueittoken-seed",
              value: "SECRET_FROM_NAV1",
              url: "https://www.amctheatres.com",
            },
          ]);
          await context.addInitScript(
            "localStorage.setItem('nav1-state', 'SECRET_STORAGE');" +
              "document.addEventListener('DOMContentLoaded', () => {" +
              "const marker = document.createElement('div');" +
              "marker.textContent = 'state=' + (localStorage.getItem('nav1-state') || 'none');" +
              "document.body.appendChild(marker);" +
              "});",
          );
        },
      });
      const first = await outcomeOf(firstRunner);
      expect(first.kind).toBe("SUCCESS");
      if (first.kind !== "SUCCESS") {
        throw new Error("expected SUCCESS");
      }
      expect(
        firstRunner.harness.documents.some((doc) => doc.cookies.includes("SECRET_FROM_NAV1")),
      ).toBe(true);
      expect(first.payload.documentHtml).toContain("state=SECRET_STORAGE");

      const groupId = supervisor.chromeProcessGroupId;
      const secondRunner = runAgainst(supervisor, corridorHops(), {
        seed: async (context) => {
          await context.addInitScript(
            "document.addEventListener('DOMContentLoaded', () => {" +
              "const marker = document.createElement('div');" +
              "marker.textContent = 'state=' + (localStorage.getItem('nav1-state') || 'NONE');" +
              "document.body.appendChild(marker);" +
              "});",
          );
        },
      });
      const second = await outcomeOf(secondRunner);
      expect(second.kind).toBe("SUCCESS");
      if (second.kind !== "SUCCESS") {
        throw new Error("expected SUCCESS");
      }

      // Same warm Chrome process…
      expect(supervisor.chromeProcessGroupId).toBe(groupId);
      // …fresh context: no cookie, no storage, no token carried over.
      expect(secondRunner.harness.documents.every((doc) => doc.cookies === "")).toBe(true);
      expect(second.payload.documentHtml).toContain("state=NONE");
    });

    it("12. recycling — actual Chrome-process recycle: old tree and profile die, replacement navigates clean", async () => {
      const recyclable = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: SCOPE.egressIdentityLabel,
        providerId: SCOPE.providerId,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
      try {
        const first = await outcomeOf(runAgainst(recyclable, corridorHops()));
        expect(first.kind).toBe("SUCCESS");

        const oldGroupId = recyclable.chromeProcessGroupId;
        const oldProfileDir = recyclable.profileDirectory;
        expect(oldProfileDir).not.toBeNull();
        const exitPromise = recyclable.waitForTreeExit();

        await recyclable.recycle();

        // The old tree exited and its scratch profile directory was discarded.
        await exitPromise;
        expect(isGroupDead(oldGroupId)).toBe(true);
        expect(existsSync(oldProfileDir as string)).toBe(false);
        // A replacement Chrome process is warm with a fresh profile.
        expect(recyclable.chromeProcessGroupId).not.toBe(oldGroupId);
        expect(recyclable.profileDirectory).not.toBeNull();
        expect(recyclable.profileDirectory).not.toBe(oldProfileDir);

        // Full corridor against the replacement, with no state carried over.
        const secondRunner = runAgainst(recyclable, corridorHops());
        const second = await outcomeOf(secondRunner);
        expect(second.kind).toBe("SUCCESS");
        expect(secondRunner.harness.documents.every((doc) => doc.cookies === "")).toBe(true);
      } finally {
        await recyclable.shutdown().catch(() => {});
      }
    });

    it("13. graceful termination — SIGTERM with an active page closes everything, no orphans", async () => {
      const terminable = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: SCOPE.egressIdentityLabel,
        providerId: SCOPE.providerId,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
      const context = await terminable.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      // An active page (loopback readiness document — never AMC).
      await page.goto(readiness.baseUrl, { waitUntil: "load", timeout: NAV_MS });

      const groupId = terminable.chromeProcessGroupId;
      const exitPromise = terminable.waitForTreeExit();
      await terminable.shutdown();

      // The active page's process tree terminated, without a forced kill.
      const exit = await exitPromise;
      expect(exit.signal).toBeNull();
      expect(isGroupDead(groupId)).toBe(true);
    });

    it("14. forced termination — SIGKILL after the grace timeout with an unresponsive page", async () => {
      const forced = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: SCOPE.egressIdentityLabel,
        providerId: SCOPE.providerId,
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
      const context = await forced.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      await page.goto(readiness.baseUrl, { waitUntil: "load", timeout: NAV_MS });

      const groupId = forced.chromeProcessGroupId;
      // Unresponsive page: freeze the tree so SIGTERM cannot be handled in time.
      process.kill(-groupId, "SIGSTOP");
      const exitPromise = forced.waitForTreeExit();

      await forced.shutdown();

      // Grace expired: the tree died by the forced signal, and nothing remains.
      const exit = await exitPromise;
      expect(exit.signal).toBe("SIGKILL");
      expect(isGroupDead(groupId)).toBe(true);
    });

    it("15. observation seam — plan result propagates onto SanitizedPayload, schema-validated, radius- and result-capped, with zero new requests (S35.11)", async () => {
      // Document order: A26 (target+selected), A25, B26, A28 within radius 2 of A26;
      // C20 is 16 columns away and must be excluded by the radius bound.
      const body = seatMapHtml([
        { row: 3, column: 4, name: "A26", available: false, status: "sold", selected: true },
        { row: 3, column: 3, name: "A25", available: true },
        { row: 4, column: 4, name: "B26", available: false },
        { row: 3, column: 6, name: "A28", available: true },
        { row: 5, column: 20, name: "C20", available: true },
      ]);
      const runner = runAgainst(supervisor, corridorHops({ cleanBody: body }), {
        observationPlan: OBSERVATION_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      const observation = outcome.payload.observation;
      expect(observation).toBeDefined();
      if (observation === undefined) {
        throw new Error("expected an observation on the SUCCESS payload");
      }
      // Question 1 (carry-through): the selected seat's documented name field.
      expect(observation.carryThrough).toEqual({ selectedSeatId: "A26" });
      // Question 2 (geometry): near-target seats in document order, capped at 2,
      // with the optional `status` null when absent and the radius bound enforced.
      expect(observation.geometryNearTarget).toEqual([
        { row: 3, column: 4, name: "A26", available: false, status: "sold" },
        { row: 3, column: 3, name: "A25", available: true, status: null },
      ]);
      // The observation step dispatched nothing and navigated nowhere: the harness
      // saw exactly the four scripted corridor documents and refused nothing, and the
      // final URL is the clean-return document (page.url() unchanged by observation).
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([
        MOVIES,
        QUEUE,
        TOKEN_RETURN,
        MOVIES,
      ]);
      expect(runner.harness.refusals).toEqual([]);
      expect(outcome.payload.finalUrl).toEqual({
        origin: "https://www.amctheatres.com",
        pathname: "/movies",
        queryKeys: [],
      });
    });

    it("16. observation seam — no selected seat renders carry-through NONE_SELECTED (S35.11)", async () => {
      const body = seatMapHtml([
        { row: 3, column: 4, name: "A26", available: false, status: "sold" },
        { row: 3, column: 3, name: "A25", available: true },
      ]);
      const runner = runAgainst(supervisor, corridorHops({ cleanBody: body }), {
        observationPlan: OBSERVATION_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      const observation = outcome.payload.observation;
      expect(observation).toBeDefined();
      if (observation === undefined) {
        throw new Error("expected an observation on the SUCCESS payload");
      }
      expect(observation.carryThrough).toBe("NONE_SELECTED");
      expect(observation.geometryNearTarget).toHaveLength(2);
    });

    it("17. observation seam — static HTML without a seat map falls through to the live evaluator and is INCONCLUSIVE (S35.11)", async () => {
      // SEAT_PAGE_HTML has an empty <div id="seat-map"> and no [data-seat] nodes:
      // the static pass sees zero geometry, the live pass agrees, so the result is
      // INCONCLUSIVE — not a failure and not an absent observation.
      const runner = runAgainst(supervisor, corridorHops(), {
        observationPlan: OBSERVATION_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      const observation = outcome.payload.observation;
      expect(observation).toBeDefined();
      if (observation === undefined) {
        throw new Error("expected an observation on the SUCCESS payload");
      }
      expect(observation.carryThrough).toBe("INCONCLUSIVE");
      expect(observation.geometryNearTarget).toEqual([]);
    });

    it("18. observation seam — a schema-invalid field maps to NAVIGATION_FAILED (observation_failed) with cleanup guaranteed (S35.11)", async () => {
      // The near-target seat's `available` attribute is not a parseable boolean:
      // it reaches the Zod gate as null and is rejected, failing the whole
      // navigation fail-closed — never a partial observation.
      const body = seatMapHtml([
        { row: 3, column: 4, name: "A26", available: "maybe", selected: true },
      ]);
      const runner = runAgainst(supervisor, corridorHops({ cleanBody: body }), {
        observationPlan: OBSERVATION_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("NAVIGATION_FAILED");
      if (outcome.kind === "NAVIGATION_FAILED") {
        expect(outcome.error).toBe("observation_failed");
      }
      // outcomeOf() already awaited cleanupCompleted; reaching this assertion is the
      // guarantee that cleanup ran on the failure branch.
    });

    it("19. observation seam — the plan is ignored on a non-SUCCESS outcome (S35.11)", async () => {
      // The corridor stalls in the queue: successOutcome is never reached, so the
      // observation step never invokes — the outcome is QUEUE_ENTERED, not an
      // observation failure, and only the initial + queue documents were served.
      const runner = runAgainst(
        supervisor,
        corridorHops({ queueStatus: 200, queueBody: QUEUE_WAITING_HTML }),
        { observationPlan: OBSERVATION_PLAN },
      );
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("QUEUE_ENTERED");
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([MOVIES, QUEUE]);
      expect(runner.harness.refusals).toEqual([]);
    });

    it("20. observation seam — flight-parse mode parses Flight JSON via parseSeats, maps cells with status=null, and is INCONCLUSIVE (S35.11)", async () => {
      // A single-hop corridor: the initial document is the seats deep link itself,
      // served 200 with an embedded Flight-JSON seat map. The flight evaluator never
      // touches the DOM; it calls parseSeats and maps RawGridCell rows into the same
      // candidate shape as the DOM path (status stays null — never inferred).
      const seatsUrl = "https://www.amctheatres.com/showtimes/123/seats";
      const body = flightSeatPageHtml(123, [
        { row: 3, column: 4, name: "A26", available: false },
        { row: 3, column: 3, name: "A25", available: true },
        { row: 4, column: 4, name: "B26", available: false },
        { row: 5, column: 20, name: "C20", available: true },
      ]);
      const runner = runAgainst(supervisor, [{ url: seatsUrl, status: 200, body }], {
        targetUrl: seatsUrl,
        observationPlan: FLIGHT_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("SUCCESS");
      if (outcome.kind !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome.kind}`);
      }
      const observation = outcome.payload.observation;
      expect(observation).toBeDefined();
      if (observation === undefined) {
        throw new Error("expected an observation on the SUCCESS payload");
      }
      // Question 1: nonempty geometry + empty selected (parseSeats has no selection
      // concept) must be INCONCLUSIVE — never a false NONE_SELECTED assertion.
      expect(observation.carryThrough).toBe("INCONCLUSIVE");
      // Question 2: geometry mapped from RawGridCell with status=null, radius-capped
      // (C20 is 16 columns away and excluded) and result-capped at maxResults=2.
      expect(observation.geometryNearTarget).toEqual([
        { row: 3, column: 4, name: "A26", available: false, status: null },
        { row: 3, column: 3, name: "A25", available: true, status: null },
      ]);
      // The flight path dispatched nothing and navigated nowhere beyond the initial.
      expect(runner.harness.documents.map((doc) => doc.url)).toEqual([seatsUrl]);
      expect(runner.harness.refusals).toEqual([]);
    });

    it("21. observation seam — flight-parse showtime-id mismatch fails closed (S35.11)", async () => {
      // The target URL carries showtime 123; the embedded Flight JSON says 999.
      // parseSeats validates the embedded showtimeId against the URL-derived expected
      // id and throws, which maps to NAVIGATION_FAILED (observation_failed) — never a
      // partial observation.
      const seatsUrl = "https://www.amctheatres.com/showtimes/123/seats";
      const body = flightSeatPageHtml(999, [{ row: 3, column: 4, name: "A26", available: false }]);
      const runner = runAgainst(supervisor, [{ url: seatsUrl, status: 200, body }], {
        targetUrl: seatsUrl,
        observationPlan: FLIGHT_PLAN,
      });
      const outcome = await outcomeOf(runner);

      expect(outcome.kind).toBe("NAVIGATION_FAILED");
      if (outcome.kind === "NAVIGATION_FAILED") {
        expect(outcome.error).toBe("observation_failed");
      }
    });
  },
);
