/**
 * P7 verification — this slice's items from the spec's verification list: budget accounting
 * (P7.5), the 7-case abort matrix over every non-SUCCESS `NavigationOutcome.kind` (P7.6),
 * cleanup-before-next-navigation ordering (P7.7), the `SanitizedPayload` → `RedactTarget`
 * adapter (P7.4), and the refusal gates (P7.8). Everything browser-driven runs against P6's
 * offline synthetic corridor harness (P7.11) with AMC hostnames network-denied — no live
 * request, ever. The promotion-regression item (P7.3) and the workspace-wide greenness item
 * belong to the other slice / the coordinator.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BrowserSupervisor,
  runCorridorNavigation,
  startReadinessServer,
} from "@seatfirst/browser-runtime";
import type {
  NavigationOutcome,
  NavigationScope,
  ReadinessServer,
  SanitizedPayload,
} from "@seatfirst/browser-runtime";
import { redact } from "@seatfirst/providers";

import {
  CAPTURE_TARGETS,
  cliMain,
  runCaptureSession,
  toRedactTarget,
} from "../scripts/capture-fixtures-browser.js";
import type { CaptureResult, RunNavigation } from "../scripts/capture-fixtures-browser.js";

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
    "SEATFIRST: no Chrome binary found — capture-fixtures-browser browser suite skipped. " +
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
const EGRESS_LABEL = "test-capture-eip-label";

const SCOPE: NavigationScope = {
  providerId: "provider-capture-test",
  observationId: "obs-capture-test",
  fetchRunId: "run-capture-test",
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
    AMC_NAVIGATION_BUDGET: "5",
    AMC_CLEANUP_GRACE_MS: String(GRACE_MS),
    AMC_READINESS_TIMEOUT_MS: String(READINESS_MS),
    ...overrides,
  };
}

/** A seat page referencing subresources the guard must abort pre-dispatch (P6.11). */
const SUBRESOURCE_HTML = `<!doctype html>
<html>
  <head>
    <title>seat page</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="icon" href="/favicon.ico" />
  </head>
  <body>
    <h1>Seats</h1>
    <div id="seat-map"></div>
    <img src="/assets/poster.jpg" />
    <script src="/assets/app.js"></script>
  </body>
</html>`;

function cliArgs(): string[] {
  return ["node", "capture-fixtures-browser.ts", CONFIRM_FLAG, "--operator=test-operator"];
}

function tempOutDir(): string {
  return mkdtempSync(join(tmpdir(), "capture-fixtures-browser-"));
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

/** Session-option builder for the no-Chrome live-gate tests (the supervisor is never touched). */
function sessionOptions(overrides: {
  isLive: boolean;
  confirmedLive?: boolean;
  runNavigation: RunNavigation;
}): Parameters<typeof runCaptureSession>[0] {
  return {
    supervisor: undefined as unknown as BrowserSupervisor,
    targets: [new URL(MOVIES)],
    budget: 5,
    isLive: overrides.isLive,
    navigationLimits: { navigationTimeoutMs: NAV_MS },
    scope: SCOPE,
    userAgent: USER_AGENT,
    outDir: tempOutDir(),
    logWriter: () => {},
    ...(overrides.confirmedLive !== undefined ? { confirmedLive: overrides.confirmedLive } : {}),
    runNavigation: overrides.runNavigation,
  };
}

// --- refusal gates (P7.8) — no Chrome, no network, no session work ----------------------

describe("capture-fixtures-browser refusal gates (P7.8)", () => {
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
    await cliMain(["node", "capture-fixtures-browser.ts", "--operator=test-operator"], cliEnv(), {
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

  it("runCaptureSession (P3-mirrored defense in depth): live session refuses in CI", async () => {
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
      await expect(runCaptureSession(options)).rejects.toThrow(
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

  it("runCaptureSession (P3-mirrored defense in depth): live session refuses without confirmation", async () => {
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
      await expect(runCaptureSession(options)).rejects.toThrow(
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

// --- CAPTURE-LOG.md fencing and readiness/supervisor cleanup survive a startup failure ---
// --- not just a session failure (no Chrome; readiness is injected, not a real listener) ---

describe("capture-fixtures-browser log fence balance and cleanup on startup failure (no Chrome)", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  function fakeReadiness(): { server: ReadinessServer; close: ReturnType<typeof vi.fn> } {
    const close = vi.fn(() => Promise.resolve());
    return { server: { baseUrl: "http://127.0.0.1:0", close }, close };
  }

  it("a supervisor-start throw closes the fence and calls the injected readiness's close exactly once", async () => {
    const lines: string[] = [];
    const { server, close } = fakeReadiness();
    await cliMain(cliArgs(), cliEnv(), {
      outDir: tempOutDir(),
      logWriter: (line) => {
        lines.push(line);
      },
      startReadinessServer: () => Promise.resolve(server),
      startSupervisor: () => {
        throw new Error("supervisor boom — simulates Chrome launch failure at startup");
      },
      runNavigation: () => {
        throw new Error("runNavigation must not be called — session never starts");
      },
    });

    expect(process.exitCode).toBe(1);
    // Every logged line lands between one open fence and one close fence, matching the
    // committed CAPTURE-LOG.md convention markdownlint's MD022/MD034 rules require.
    expect(lines[0]).toBe("\n```text");
    expect(lines.at(-1)).toBe("```");
    expect(lines.filter((line) => line === "```").length).toBe(1);
    expect(lines.some((line) => line === "[ABORT] Fatal error encountered.")).toBe(true);
    expect(lines.some((line) => line.includes("Session ended. Aborted: true."))).toBe(true);
    expect(lines.some((line) => line.includes("Navigations spent: 0/"))).toBe(true);
    // The bug this guards against: the readiness/supervisor startup used to sit outside the
    // try/catch/finally entirely, so a supervisor-start throw here would have left the
    // injected readiness server's close() never called.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a readiness-start throw closes the fence without ever attempting supervisor startup", async () => {
    const lines: string[] = [];
    let supervisorStarts = 0;
    await cliMain(cliArgs(), cliEnv(), {
      outDir: tempOutDir(),
      logWriter: (line) => {
        lines.push(line);
      },
      startReadinessServer: () => {
        throw new Error("readiness boom — simulates the readiness listener failing to bind");
      },
      startSupervisor: () => {
        supervisorStarts += 1;
        throw new Error("startSupervisor must not be called — readiness never came up");
      },
      runNavigation: () => {
        throw new Error("runNavigation must not be called — session never starts");
      },
    });

    expect(process.exitCode).toBe(1);
    expect(supervisorStarts).toBe(0);
    expect(lines[0]).toBe("\n```text");
    expect(lines.at(-1)).toBe("```");
    expect(lines.filter((line) => line === "```").length).toBe(1);
    expect(lines.some((line) => line === "[ABORT] Fatal error encountered.")).toBe(true);
    expect(lines.some((line) => line.includes("Session ended. Aborted: true."))).toBe(true);
  });
});

// --- preregistered target list matches ADR 0002 §3.4's fifth-session authorization ---------

describe("CAPTURE_TARGETS (ADR 0002 §3.4 fifth-session preregistration, 2026-08-15)", () => {
  it("is exactly the 3 authorized, ordinary-browser-walk-confirmed targets — no stray entry from a consumed prior-session list, no accidental drift", () => {
    expect(CAPTURE_TARGETS.map((u) => u.href)).toEqual([
      "https://www.amctheatres.com/movie-theatres",
      "https://www.amctheatres.com/movie-theatres/atlanta",
      "https://www.amctheatres.com/movie-theatres/san-francisco",
    ]);
  });
});

// --- redaction adapter (P7.4) — focused unit test, no session, no Chrome ----------------

describe("SanitizedPayload → RedactTarget adapter (P7.4)", () => {
  it("reconstructs the URL from origin/pathname/query-key names, passes headers through, and scrubs IP/token literals from documentHtml", () => {
    const payload: SanitizedPayload = {
      finalUrl: {
        origin: "https://www.amctheatres.com",
        pathname: "/showtimes/123/seats",
        queryKeys: ["q", "date"],
      },
      finalStatus: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      documentHtml: [
        "<html><body>",
        "observed client ip 192.168.1.1 and ipv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        "cf_clearance=abcdef123456 and queue-it token c=12345",
        "</body></html>",
      ].join("\n"),
    };

    const redacted = redact(toRedactTarget(payload));

    // Parser-needed fields intact. Query values never reach this layer, so the retained
    // keys carry empty values — the documented no-op retention of P7.4.
    expect(redacted.url).toBe("https://www.amctheatres.com/showtimes/123/seats?q=&date=");
    expect(redacted.status).toBe(200);
    expect(redacted.headers["content-type"]).toBe("text/html; charset=utf-8");

    // The token/IP scrub ran against the real HTML. Had the token/IP regex set been an
    // identity function, every `not.toContain` below would fail — P3's redaction
    // verification posture, applied through the new adapter.
    expect(redacted.body).not.toContain("192.168.1.1");
    expect(redacted.body).toContain("[REDACTED_IPV4]");
    expect(redacted.body).not.toContain("2001:0db8");
    expect(redacted.body).toContain("[REDACTED_IPV6]");
    expect(redacted.body).not.toContain("cf_clearance=abcdef123456");
    expect(redacted.body).not.toContain("c=12345");
    expect(redacted.body).toContain("[REDACTED_TOKEN]");
  });
});

// --- session drives the real transport against the synthetic corridor -------------------

describe.skipIf(chromeExecutable === null)(
  "capture-fixtures-browser session (offline synthetic corridor, AMC network-denied)",
  () => {
    let readiness: ReadinessServer;
    let supervisor: BrowserSupervisor;

    const tempDirs: string[] = [];
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
      // The suite's shared warm Chrome (and its readiness server) is never otherwise torn
      // down — without this, every test run leaks one Chrome process group.
      await supervisor.shutdown().catch(() => {});
      await readiness.close().catch(() => {});
    });

    afterEach(() => {
      process.exitCode = 0;
      for (const held of heldDeferreds.splice(0)) {
        held.resolve();
      }
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    interface SessionRun {
      readonly session: Promise<CaptureResult>;
      callCount(): number;
      readonly lines: string[];
      readonly outDir: string;
      readonly harness: SyntheticHarness;
    }

    function startSession(options: {
      hops: readonly SyntheticHop[];
      targets?: readonly URL[];
      budget?: number;
      controller?: AbortController;
    }): SessionRun {
      const harness = createSyntheticHarness(options.hops);
      const outDir = tempOutDir();
      tempDirs.push(outDir);
      const lines: string[] = [];
      let calls = 0;
      const runNavigation: RunNavigation = (sup, opts) => {
        calls += 1;
        return runCorridorNavigation(sup, opts);
      };
      const session = runCaptureSession({
        supervisor,
        targets: options.targets ?? [new URL(MOVIES), new URL(MOVIES)],
        budget: options.budget ?? 5,
        isLive: false,
        confirmedLive: true,
        navigationLimits: { navigationTimeoutMs: NAV_MS },
        scope: SCOPE,
        userAgent: USER_AGENT,
        outDir,
        logWriter: (line) => {
          lines.push(line);
        },
        ...(options.controller !== undefined ? { signal: options.controller.signal } : {}),
        navigationSeams: { fetchHop: harness.fetchHop },
        runNavigation,
      });
      return { session, callCount: () => calls, lines, outDir, harness };
    }

    it("1. budget — exactly `budget` navigations are attempted regardless of hop count; the next target is left uncaptured and reported (P7.5)", async () => {
      const targets = [new URL(MOVIES), new URL(MOVIES), new URL(MOVIES)];
      // A seat page referencing subresources: the guard aborts each one pre-dispatch
      // (P6.11), so the harness never serves them and the transport counts the aborts.
      const hops = [
        ...corridorHops({ cleanBody: SUBRESOURCE_HTML }),
        ...corridorHops({ cleanBody: SUBRESOURCE_HTML }),
        ...corridorHops({ cleanBody: SUBRESOURCE_HTML }),
      ];
      const run = startSession({ hops, targets, budget: 2 });

      const result = await run.session;

      expect(result.aborted).toBe(false);
      expect(result.navigationsSpent).toBe(2);
      // Two logical navigations, each reporting four document hops: hops are logged, not
      // separately deducted from the budget (P7.5, P7.10).
      expect(run.callCount()).toBe(2);
      expect(run.harness.documents).toHaveLength(8);
      expect(run.lines.filter((line) => line.startsWith("  hop "))).toHaveLength(8);
      // The third target is left uncaptured and reported.
      expect(
        run.lines.some((line) =>
          line.includes("[WARN] Budget of 2 navigations spent. Target left uncaptured:"),
        ),
      ).toBe(true);
      // Both successful captures persisted, redacted, with the parser-needed fields intact.
      const files = readdirSync(run.outDir);
      expect(files).toHaveLength(2);
      const first = JSON.parse(readFileSync(join(run.outDir, files[0]!), "utf8")) as {
        url: string;
        status: number;
        body: string;
      };
      expect(first.url).toBe(MOVIES);
      expect(first.status).toBe(200);
      expect(first.body).toContain("seat-map");
      // The subresource block is recorded per navigation (P7.10): every referenced
      // subresource (stylesheet, icon, image, script) was aborted pre-dispatch.
      const abortLines = run.lines.filter((line) => line.includes("subresourceAborts:"));
      expect(abortLines).toHaveLength(2);
      for (const line of abortLines) {
        expect(Number(line.split("subresourceAborts: ")[1])).toBeGreaterThanOrEqual(3);
      }
    });

    it("2. budget positive control — a larger budget captures more (P7.5)", async () => {
      const targets = [new URL(MOVIES), new URL(MOVIES), new URL(MOVIES)];
      const hops = [...corridorHops(), ...corridorHops(), ...corridorHops()];
      const run = startSession({ hops, targets, budget: 3 });

      const result = await run.session;

      expect(result.aborted).toBe(false);
      expect(run.callCount()).toBe(3);
      expect(readdirSync(run.outDir)).toHaveLength(3);
      expect(run.lines.some((line) => line.includes("[WARN]"))).toBe(false);
    });

    it("3. cleanup — the next target's navigation never starts before cleanupCompleted resolves (P7.7)", async () => {
      const gate = gateCleanup(supervisor);
      const hops = [...corridorHops(), ...corridorHops()];
      const harness = createSyntheticHarness(hops);
      const outDir = tempOutDir();
      tempDirs.push(outDir);
      const lines: string[] = [];
      let calls = 0;
      const runNavigation: RunNavigation = (sup, opts) => {
        calls += 1;
        return runCorridorNavigation(sup, opts);
      };
      const session = runCaptureSession({
        supervisor,
        targets: [new URL(MOVIES), new URL(MOVIES)],
        budget: 5,
        isLive: false,
        confirmedLive: true,
        navigationLimits: { navigationTimeoutMs: NAV_MS },
        scope: SCOPE,
        userAgent: USER_AGENT,
        outDir,
        logWriter: (line) => {
          lines.push(line);
        },
        navigationSeams: { fetchHop: harness.fetchHop },
        runNavigation,
      });

      try {
        // The first navigation finishes its four hops and enters cleanup…
        await waitFor(() => calls === 1 && harness.documents.length === 4, NAV_MS);
        // …but with cleanup gated, neither the second navigation nor even the first
        // outcome's log entry may proceed.
        await new Promise((resolve) => setTimeout(resolve, 300));
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

    it("4. abort matrix — every non-SUCCESS kind ends the whole session, logs the kind, and attempts no further target (P7.6)", async () => {
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
        // The outcome kind and every reported hop are in the log (P7.10)…
        expect(
          run.lines.some(
            (line) => line.startsWith("[ATTEMPT]") && line.includes(`outcome=${testCase.kind}`),
          ),
          testCase.kind,
        ).toBe(true);
        // …and nothing was captured.
        expect(readdirSync(run.outDir), testCase.kind).toHaveLength(0);
      }
    });

    it("5. abort matrix — CANCELLED ends the session with the kind logged (P7.6)", async () => {
      const hold = deferred();
      heldDeferreds.push(hold);
      const controller = new AbortController();
      const run = startSession({
        hops: corridorHops({ holdQueue: hold }),
        controller,
      });

      await waitFor(() => run.harness.documents.length >= 2, NAV_MS);
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
      expect(readdirSync(run.outDir)).toHaveLength(0);
      // The warm Chrome process survives transport-level cancellation (P6.21).
      expect(supervisor.chromeProcessGroupId).toBeGreaterThan(0);
    });

    it("6. cliMain end to end — an aborted session exits non-zero with the kind in the log (P7.6)", async () => {
      const firstTarget = CAPTURE_TARGETS[0];
      expect(firstTarget).toBeDefined();
      if (firstTarget === undefined) {
        throw new Error("expected CAPTURE_TARGETS to have at least one entry");
      }
      const harness = createSyntheticHarness(
        corridorHops({
          initialUrl: firstTarget.href,
          initialStatus: 200,
          initialHeaders: { "cf-mitigated": "challenge" },
        }),
      );
      const outDir = tempOutDir();
      tempDirs.push(outDir);
      const lines: string[] = [];
      let calls = 0;
      const runNavigation: RunNavigation = (sup, opts) => {
        calls += 1;
        return runCorridorNavigation(sup, opts);
      };

      await cliMain(cliArgs(), cliEnv(), {
        startSupervisor: (options) => BrowserSupervisor.start(options),
        runNavigation,
        navigationSeams: { fetchHop: harness.fetchHop },
        outDir,
        logWriter: (line) => {
          lines.push(line);
        },
      });

      expect(process.exitCode).toBe(1);
      // CAPTURE_TARGETS[0] is the only navigation attempted before the abort.
      expect(calls).toBe(1);
      expect(
        lines.some(
          (line) =>
            line === "[ABORT] Non-success navigation outcome CHALLENGE_REQUIRED. Aborting session.",
        ),
      ).toBe(true);
      expect(lines.some((line) => line.includes("Session ended. Aborted: true."))).toBe(true);
      expect(lines.some((line) => line.includes("Navigations spent: 1/"))).toBe(true);
    });
  },
);
