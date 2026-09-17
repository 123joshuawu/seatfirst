/**
 * S35 verification — this slice's items from the spec's verification list: budget accounting
 * (S35.3), the 7-case abort matrix over every non-SUCCESS `NavigationOutcome.kind` (S35.5),
 * the refusal gates (S35.9), and the observation-log redaction filter (S35.7). Everything
 * browser-driven runs against P6's offline synthetic corridor harness (S35.10) with AMC
 * hostnames network-denied — no live request, ever. The observation-seam mechanics item
 * (S35.11) lives in `packages/browser-runtime/test/corridor.test.ts`; the workspace-wide
 * greenness item belongs to the coordinator.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BrowserSupervisor,
  runCorridorNavigation,
  startReadinessServer,
} from "@seatfirst/browser-runtime";
import type {
  NavigationOutcome,
  NavigationScope,
  ObservationPlan,
  ReadinessServer,
} from "@seatfirst/browser-runtime";

import {
  cliMain,
  loadTargets,
  redactObservationRecord,
  runVerificationSession,
} from "../scripts/verify-handoff.js";
import type {
  HandoffVerificationTarget,
  RunNavigation,
  VerificationResult,
} from "../scripts/verify-handoff.js";

import {
  MOVIES,
  QUEUE,
  QUEUE_WAITING_HTML,
  TOKEN_RETURN,
  corridorHops,
  createSyntheticHarness,
  deferred,
  findChromeExecutable,
  gateCleanup,
} from "./support/synthetic-corridor.js";
import type { SyntheticHarness, SyntheticHop } from "./support/synthetic-corridor.js";

const chromeExecutable = findChromeExecutable();
if (chromeExecutable === null) {
  console.warn(
    "SEATFIRST: no Chrome binary found — verify-handoff browser suite skipped. " +
      "CI supplies Chrome via the pinned browser test image (I1); locally set " +
      "SEATFIRST_CHROME_EXECUTABLE or install Google Chrome.",
  );
}

// Test-harness values, not policy numbers: every bound the session consumes is injected
// per call below (gate 14 / ADR 0006).
const GRACE_MS = 3_000;
const READINESS_MS = 20_000;
const NAV_MS = 20_000;
const USER_AGENT = "SeatFinder-Test/1.0 (+https://example.invalid/contact)";
const EGRESS_LABEL = "test-verify-eip-label";

const SCOPE: NavigationScope = {
  providerId: "provider-verify-test",
  observationId: "obs-verify-test",
  fetchRunId: "run-verify-test",
  routeClass: "seat",
  egressIdentityLabel: EGRESS_LABEL,
};

const CONFIRM_FLAG = "--confirm-live-session=yes-i-understand";

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AMC_USER_AGENT: USER_AGENT,
    AMC_EGRESS_IDENTITY_LABEL: EGRESS_LABEL,
    AMC_CHROME_EXECUTABLE_PATH: chromeExecutable ?? "/nonexistent/chrome",
    AMC_NAVIGATION_TIMEOUT_MS: String(NAV_MS),
    AMC_CLEANUP_GRACE_MS: String(GRACE_MS),
    AMC_READINESS_TIMEOUT_MS: String(READINESS_MS),
    VERIFY_NAVIGATION_BUDGET: "5",
    VERIFY_TARGETS_FILE: "/nonexistent/verify-targets.json",
    ...overrides,
  };
}

function cliArgs(): string[] {
  return ["node", "verify-handoff.ts", CONFIRM_FLAG, "--operator=test-operator"];
}

/** The declarative plan every offline target carries (S35.11). */
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
  maxResults: 5,
};

/**
 * The flight-parse plan (S35.11): `source: "flight"` parses the embedded Flight-JSON
 * seat map via `parseSeats`; DOM selectors are ignored (carried only to satisfy the
 * required-shape contract) and question 1 is always INCONCLUSIVE.
 */
const FLIGHT_PLAN: ObservationPlan = {
  source: "flight",
  targetSeatNames: ["A26"],
  selectedSeatSelector: "",
  geometrySeatSelector: "",
  fieldMapping: {},
  maxRadius: 2,
  maxResults: 5,
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

interface SeatSpec {
  readonly row: number;
  readonly column: number;
  readonly name: string;
  readonly available: boolean;
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

/** A minimal valid seat map: one selected target seat, so observation never fails. */
const SEAT_BODY = seatMapHtml([
  { row: 3, column: 4, name: "A26", available: false, status: "sold", selected: true },
]);

function target(url: string = MOVIES): HandoffVerificationTarget {
  return { url: new URL(url), observationPlan: OBSERVATION_PLAN };
}

/** Session-option builder for the no-Chrome live-gate tests (the supervisor is never touched). */
function sessionOptions(overrides: {
  isLive: boolean;
  confirmedLive?: boolean;
  runNavigation: RunNavigation;
}): Parameters<typeof runVerificationSession>[0] {
  return {
    supervisor: undefined as unknown as BrowserSupervisor,
    targets: [target()],
    budget: 5,
    isLive: overrides.isLive,
    navigationLimits: { navigationTimeoutMs: NAV_MS },
    scope: SCOPE,
    userAgent: USER_AGENT,
    logWriter: () => {},
    ...(overrides.confirmedLive !== undefined ? { confirmedLive: overrides.confirmedLive } : {}),
    runNavigation: overrides.runNavigation,
  };
}

// --- refusal gates (S35.9) — no Chrome, no network, no session work ----------------------

describe("verify-handoff refusal gates (S35.9)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("SEATFIRST_ENV=ci: cliMain refuses before any supervisor start or navigation", async () => {
    let supervisorStarts = 0;
    let navigations = 0;
    await cliMain(cliArgs(), cliEnv({ SEATFIRST_ENV: "ci" }), {
      startSupervisor: () => {
        supervisorStarts += 1;
        throw new Error("startSupervisor must not be called");
      },
      runNavigation: () => {
        navigations += 1;
        throw new Error("runNavigation must not be called");
      },
    });
    expect(process.exitCode).toBe(1);
    expect(supervisorStarts).toBe(0);
    expect(navigations).toBe(0);
  });

  it("missing --confirm-live-session flag: cliMain refuses before any supervisor start or navigation", async () => {
    let supervisorStarts = 0;
    let navigations = 0;
    await cliMain(["node", "verify-handoff.ts", "--operator=test-operator"], cliEnv(), {
      startSupervisor: () => {
        supervisorStarts += 1;
        throw new Error("startSupervisor must not be called");
      },
      runNavigation: () => {
        navigations += 1;
        throw new Error("runNavigation must not be called");
      },
    });
    expect(process.exitCode).toBe(1);
    expect(supervisorStarts).toBe(0);
    expect(navigations).toBe(0);
  });

  it("runVerificationSession (P3-mirrored defense in depth): live session refuses in CI", async () => {
    const previous = process.env.SEATFIRST_ENV;
    process.env.SEATFIRST_ENV = "ci";
    try {
      let navigations = 0;
      const options = sessionOptions({
        isLive: true,
        confirmedLive: true,
        runNavigation: () => {
          navigations += 1;
          throw new Error("runNavigation must not be called");
        },
      });
      await expect(runVerificationSession(options)).rejects.toThrow(
        "Refusing to run live session in CI.",
      );
      expect(navigations).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.SEATFIRST_ENV;
      } else {
        process.env.SEATFIRST_ENV = previous;
      }
    }
  });

  it("runVerificationSession (P3-mirrored defense in depth): live session refuses without confirmation", async () => {
    // This test's expected message is the non-CI refusal path (`confirmedLive` false and
    // SEATFIRST_ENV not "ci"). It must not inherit an ambient SEATFIRST_ENV=ci from the
    // job environment (set workflow-wide in ci.yml for real-traffic safety) — otherwise
    // the CI refusal message fires first and this assertion fails nondeterministically
    // depending on which CI job runs the suite.
    const previous = process.env.SEATFIRST_ENV;
    delete process.env.SEATFIRST_ENV;
    try {
      let navigations = 0;
      const options = sessionOptions({
        isLive: true,
        runNavigation: () => {
          navigations += 1;
          throw new Error("runNavigation must not be called");
        },
      });
      await expect(runVerificationSession(options)).rejects.toThrow(
        "Refusing to run live session without explicit confirmation.",
      );
      expect(navigations).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.SEATFIRST_ENV;
      } else {
        process.env.SEATFIRST_ENV = previous;
      }
    }
  });
});

// --- observation-log redaction (S35.7) — focused unit test, no session, no Chrome --------

describe("observation-record redaction (S35.7)", () => {
  it("drops cookie/auth/trace identifiers and invented fields, scrubs IP literals, and keeps the parser-needed geometry fields", () => {
    const record = {
      "set-cookie": "sessionid=secret123",
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      "cf-ray": "8a2eabc123",
      queueittoken: "c=0000-1111-2222-3333",
      "invented-field-name": "not-in-allowlist",
      url: "https://www.amctheatres.com/showtimes/123/seats",
      outcomeKind: "SUCCESS",
      carryThrough: "selected=A26",
      geometryNearTarget: [
        { row: 3, column: 4, name: "A26", available: false, status: "client ip 192.168.1.1" },
        { row: 3, column: 3, name: "A25", available: true, status: "peer 2001:db8::1" },
      ],
    };

    const redacted = redactObservationRecord(record);

    // Header/trace/invented fields dropped by the allowlist — not by a denylist that
    // happens to pass today.
    expect(redacted).not.toHaveProperty("set-cookie");
    expect(redacted).not.toHaveProperty("authorization");
    expect(redacted).not.toHaveProperty("cf-ray");
    expect(redacted).not.toHaveProperty("queueittoken");
    expect(redacted).not.toHaveProperty("invented-field-name");
    // Parser-needed fields still present.
    expect(redacted.url).toBe("https://www.amctheatres.com/showtimes/123/seats");
    expect(redacted.outcomeKind).toBe("SUCCESS");
    expect(redacted.carryThrough).toBe("selected=A26");
    const geometry = redacted.geometryNearTarget as Array<Record<string, unknown>>;
    expect(geometry).toHaveLength(2);
    expect(geometry[0]).toMatchObject({ row: 3, column: 4, name: "A26", available: false });
    // IPv4/IPv6 literals in retained values are scrubbed by P7.3's redact().
    expect(geometry[0]?.status).toContain("[REDACTED_IPV4]");
    expect(geometry[0]?.status).not.toContain("192.168.1.1");
    expect(geometry[1]?.status).toContain("[REDACTED_IPV6]");
    expect(geometry[1]?.status).not.toContain("2001:db8");
  });

  it("positive control — an identity allowlist keeps the invented field, proving the default allowlist is what drops it (S35.7)", () => {
    const record = {
      "invented-field-name": "not-in-allowlist",
      url: "https://www.amctheatres.com/showtimes/123/seats",
    };
    // Replace the allowlist with an identity function (keep every key) and the invented
    // field survives — the discriminator that separates an allowlist from a denylist.
    const identityAllowlist = new Set(Object.keys(record));
    const kept = redactObservationRecord(record, identityAllowlist);
    expect(kept).toHaveProperty("invented-field-name", "not-in-allowlist");
  });
});

// --- target-file schema validation (S35.4/S35.11) — pure unit test, no Chrome -------

describe("verify-handoff target-file schema (S35.11)", () => {
  it("a flight-parse plan parses and a plan missing `source` is rejected", () => {
    const flightPlan = {
      source: "flight",
      targetSeatNames: ["A26"],
      selectedSeatSelector: "",
      geometrySeatSelector: "",
      fieldMapping: {},
      maxRadius: 2,
      maxResults: 5,
    };
    const withFlight = loadTargets(
      JSON.stringify([
        { url: "https://www.amctheatres.com/showtimes/123/seats", observationPlan: flightPlan },
      ]),
    );
    expect(withFlight).toHaveLength(1);
    expect(withFlight[0]?.observationPlan.source).toBe("flight");
    // Missing the new discriminator: the preregistered target file must be rejected at
    // load time rather than silently defaulting the evidence source.
    const missingSource = {
      targetSeatNames: ["A26"],
      selectedSeatSelector: "",
      geometrySeatSelector: "",
      fieldMapping: {},
      maxRadius: 2,
      maxResults: 5,
    };
    expect(() =>
      loadTargets(
        JSON.stringify([
          {
            url: "https://www.amctheatres.com/showtimes/123/seats",
            observationPlan: missingSource,
          },
        ]),
      ),
    ).toThrow(/failed schema validation/);
  });
});

// --- session drives the real transport against the synthetic corridor -------------------

describe.skipIf(chromeExecutable === null)(
  "verify-handoff session (offline synthetic corridor, AMC network-denied)",
  () => {
    let readiness: ReadinessServer;
    let supervisor: BrowserSupervisor;

    const heldDeferreds: Array<ReturnType<typeof deferred>> = [];

    beforeAll(async () => {
      readiness = await startReadinessServer();
      supervisor = await BrowserSupervisor.start({
        executablePath: chromeExecutable as string,
        egressIdentityLabel: EGRESS_LABEL,
        providerId: "amc",
        cleanupGracePeriodMs: GRACE_MS,
        readinessTimeoutMs: READINESS_MS,
        readinessTargetUrl: readiness.baseUrl,
      });
    });

    afterAll(async () => {
      await supervisor.shutdown().catch(() => {});
      await readiness.close().catch(() => {});
    });

    afterEach(() => {
      process.exitCode = 0;
      for (const held of heldDeferreds.splice(0)) {
        held.resolve();
      }
    });

    interface SessionRun {
      readonly session: Promise<VerificationResult>;
      callCount(): number;
      readonly lines: string[];
      readonly harness: SyntheticHarness;
    }

    function startSession(options: {
      hops: readonly SyntheticHop[];
      targets?: readonly HandoffVerificationTarget[];
      budget?: number;
      controller?: AbortController;
    }): SessionRun {
      const harness = createSyntheticHarness(options.hops);
      const lines: string[] = [];
      let calls = 0;
      const runNavigation: RunNavigation = (sup, opts) => {
        calls += 1;
        return runCorridorNavigation(sup, opts);
      };
      const session = runVerificationSession({
        supervisor,
        targets: options.targets ?? [target(), target()],
        budget: options.budget ?? 5,
        isLive: false,
        confirmedLive: true,
        navigationLimits: { navigationTimeoutMs: NAV_MS },
        scope: SCOPE,
        userAgent: USER_AGENT,
        logWriter: (line) => {
          lines.push(line);
        },
        ...(options.controller !== undefined ? { signal: options.controller.signal } : {}),
        navigationSeams: { fetchHop: harness.fetchHop },
        runNavigation,
      });
      return { session, callCount: () => calls, lines, harness };
    }

    it("1. budget — exactly `budget` navigations are attempted regardless of hop count; the next target is left unobserved and reported (S35.3)", async () => {
      const targets = [target(), target(), target()];
      const hops = [
        ...corridorHops({ cleanBody: SEAT_BODY }),
        ...corridorHops({ cleanBody: SEAT_BODY }),
        ...corridorHops({ cleanBody: SEAT_BODY }),
      ];
      const run = startSession({ hops, targets, budget: 2 });

      const result = await run.session;

      expect(result.aborted).toBe(false);
      expect(result.navigationsSpent).toBe(2);
      // Two logical navigations, each reporting four document hops: hops are logged, not
      // separately deducted from the budget (S35.3).
      expect(run.callCount()).toBe(2);
      expect(run.harness.documents).toHaveLength(8);
      expect(run.lines.filter((line) => line.startsWith("  hop "))).toHaveLength(8);
      // The third target is left unobserved and reported.
      expect(
        run.lines.some((line) =>
          line.includes("[WARN] Budget of 2 navigations spent. Target left unobserved:"),
        ),
      ).toBe(true);
      // Each SUCCESS navigation logged the redacted observation answers.
      expect(run.lines.filter((line) => line.startsWith("  carry-through: "))).toHaveLength(2);
      expect(run.lines.filter((line) => line.startsWith("  geometry: "))).toHaveLength(2);
    });

    it("2. budget positive control — a larger budget observes more (S35.3)", async () => {
      const targets = [target(), target(), target()];
      const hops = [
        ...corridorHops({ cleanBody: SEAT_BODY }),
        ...corridorHops({ cleanBody: SEAT_BODY }),
        ...corridorHops({ cleanBody: SEAT_BODY }),
      ];
      const run = startSession({ hops, targets, budget: 3 });

      const result = await run.session;

      expect(result.aborted).toBe(false);
      expect(run.callCount()).toBe(3);
      expect(run.lines.some((line) => line.includes("[WARN]"))).toBe(false);
    });

    it("3. abort matrix — every non-SUCCESS kind ends the whole session, logs the kind, and attempts no further target (S35.5)", async () => {
      const cases: ReadonlyArray<{
        readonly kind: Exclude<NavigationOutcome["kind"], "SUCCESS" | "CANCELLED">;
        readonly hops: SyntheticHop[];
      }> = [
        {
          kind: "QUEUE_ENTERED",
          hops: corridorHops({ queueStatus: 200, queueBody: QUEUE_WAITING_HTML }),
        },
        {
          kind: "CHALLENGE_REQUIRED",
          hops: corridorHops({
            initialStatus: 200,
            initialHeaders: { "cf-mitigated": "challenge" },
          }),
        },
        {
          kind: "UPSTREAM_BLOCKED",
          hops: corridorHops({ queueStatus: 403, queueBody: "blocked" }),
        },
        {
          kind: "RATE_LIMITED",
          hops: corridorHops({
            queueStatus: 429,
            queueHeaders: { "retry-after": "60" },
            queueBody: "rate limited",
          }),
        },
        {
          kind: "GUARD_REJECTED",
          hops: [
            { url: MOVIES, status: 302, location: "https://waiting.evil.example.com/" },
            { url: "https://waiting.evil.example.com/", status: 200, body: "x" },
          ],
        },
        {
          kind: "NAVIGATION_FAILED",
          hops: [
            { url: MOVIES, status: 302, location: QUEUE },
            { url: QUEUE, status: 302, location: TOKEN_RETURN },
            { url: TOKEN_RETURN, status: 200, body: "x" },
          ],
        },
      ];

      for (const testCase of cases) {
        const run = startSession({ hops: testCase.hops });
        const result = await run.session;

        expect(result.aborted, testCase.kind).toBe(true);
        expect(result.abortedKind, testCase.kind).toBe(testCase.kind);
        // One navigation attempted out of two targets — the session never skip-and-continues.
        expect(run.callCount(), testCase.kind).toBe(1);
        expect(
          run.lines.some(
            (line) =>
              line === `[ABORT] Non-success navigation outcome ${testCase.kind}. Aborting session.`,
          ),
          testCase.kind,
        ).toBe(true);
        expect(
          run.lines.some(
            (line) => line.startsWith("[ATTEMPT]") && line.includes(`outcome=${testCase.kind}`),
          ),
          testCase.kind,
        ).toBe(true);
      }
    });

    it("4. abort matrix — CANCELLED ends the session with the kind logged (S35.5)", async () => {
      const hold = deferred();
      heldDeferreds.push(hold);
      const controller = new AbortController();
      const run = startSession({
        hops: corridorHops({ holdQueue: hold }),
        controller,
      });

      // Deterministic: wait until the queue hop is actually held (the synthetic corridor
      // has fetched the queue document and is blocked on the held deferred), then abort. A
      // fixed sleep races Chrome/context startup under parallel-suite load and yields a
      // spurious NAVIGATION_FAILED (deadline timeout) instead of CANCELLED.
      const holdDeadline = Date.now() + NAV_MS;
      while (run.harness.documents.length < 2 && Date.now() < holdDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(run.harness.documents.length).toBe(2);
      controller.abort();

      const result = await run.session;

      expect(result.aborted).toBe(true);
      expect(result.abortedKind).toBe("CANCELLED");
      expect(run.callCount()).toBe(1);
      expect(
        run.lines.some(
          (line) => line === "[ABORT] Non-success navigation outcome CANCELLED. Aborting session.",
        ),
      ).toBe(true);
    });

    it("5. cleanup — the next target's navigation never starts before cleanupCompleted resolves (S35.2)", async () => {
      const gate = gateCleanup(supervisor);
      const hops = [
        ...corridorHops({ cleanBody: SEAT_BODY }),
        ...corridorHops({ cleanBody: SEAT_BODY }),
      ];
      const harness = createSyntheticHarness(hops);
      const lines: string[] = [];
      let calls = 0;
      const runNavigation: RunNavigation = (sup, opts) => {
        calls += 1;
        return runCorridorNavigation(sup, opts);
      };
      const session = runVerificationSession({
        supervisor,
        targets: [target(), target()],
        budget: 5,
        isLive: false,
        confirmedLive: true,
        navigationLimits: { navigationTimeoutMs: NAV_MS },
        scope: SCOPE,
        userAgent: USER_AGENT,
        logWriter: (line) => {
          lines.push(line);
        },
        navigationSeams: { fetchHop: harness.fetchHop },
        runNavigation,
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(calls).toBe(1);
        expect(lines.some((line) => line.includes("[ATTEMPT]"))).toBe(false);

        gate.open();
        const result = await session;
        await gate.opened;

        expect(calls).toBe(2);
        expect(result.aborted).toBe(false);
        expect(result.navigationsSpent).toBe(2);
      } finally {
        gate.restore();
      }
    });

    it("6. flight-parse target — observation propagates with INCONCLUSIVE carry-through and status-null geometry (S35.11)", async () => {
      // A flight-parse target whose seats deep link is the single corridor document:
      // parseSeats reads the embedded Flight JSON and the session log records the
      // INCONCLUSIVE carry-through answer plus the mapped geometry with status=null.
      const seatsUrl = "https://www.amctheatres.com/showtimes/123/seats";
      const flightTarget: HandoffVerificationTarget = {
        url: new URL(seatsUrl),
        observationPlan: FLIGHT_PLAN,
      };
      const body = flightSeatPageHtml(123, [
        { row: 3, column: 4, name: "A26", available: false },
        { row: 3, column: 3, name: "A25", available: true },
      ]);
      const run = startSession({
        hops: [{ url: seatsUrl, status: 200, body }],
        targets: [flightTarget],
        budget: 1,
      });

      const result = await run.session;

      expect(result.aborted).toBe(false);
      expect(result.navigationsSpent).toBe(1);
      expect(run.callCount()).toBe(1);
      expect(run.lines.some((line) => line.startsWith("  carry-through: INCONCLUSIVE"))).toBe(true);
      expect(
        run.lines.some(
          (line) =>
            line.startsWith("  geometry: ") &&
            line.includes("name=A26") &&
            line.includes("status=null"),
        ),
      ).toBe(true);
    });
  },
);
