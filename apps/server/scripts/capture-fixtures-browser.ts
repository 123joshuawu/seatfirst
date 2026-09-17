/**
 * P7 — browser-driven fixture-capture session runner: the entrypoint any FUTURE capture
 * session must use. It drives P6's Chrome corridor (`runCorridorNavigation`) instead of
 * P3's plain-fetch transport, reusing P3's budget/redaction/log/authorization-gate shape
 * exactly (`packages/providers/scripts/capture-fixtures.ts` — historical, never run again,
 * never modified by this task; its 2026-08-11 `fixtures/CAPTURE-LOG.md` entries likewise
 * stay untouched).
 *
 * This task ships capability only: it authorizes no live session and revives no consumed
 * authorization (ADR 0002 §3.4). Running a live session requires a separate logged decision
 * from Josh Wu plus the preregistration operator step at authorization time — this script
 * independently refuses without an explicit non-default confirmation flag and refuses in
 * `SEATFIRST_ENV=ci` (P7.8, P3.8's exact mechanism). No cron, no CI job, no retry wrapper.
 *
 * Every navigation bound (navigation timeout, egress identity label, user agent, budget,
 * supervisor cleanup/readiness grace periods, Chrome executable) is an injected CLI/env
 * parameter with no default constant anywhere in this file (P7.9, gate 14 / ADR 0006). The
 * only numeric constant is `MAX_NAVIGATIONS`, the structural 150-navigation policy ceiling
 * the injected budget is validated against — never a default budget value (P7.5, ADR 0002).
 *
 * Budget accounting (P7.5): one `runCorridorNavigation` call — one `CAPTURE_TARGETS` entry
 * attempted — spends exactly one budget unit. The up-to-four `DocumentHop` entries a
 * `NavigationOutcome` reports are never separately deducted; each is individually recorded
 * in the capture log for audit only (P7.10).
 *
 * The SanitizedPayload → RedactTarget adapter (P7.4) never changes `redact()`'s signature or
 * behavior: query values are already stripped at the transport layer, `headers` already
 * passed through `redactHeaders()` once, and `documentHtml` still runs the IPv4/IPv6/token
 * scrub plus the fail-closed check against the real HTML.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BrowserSupervisor,
  runCorridorNavigation,
  startReadinessServer,
} from "@seatfirst/browser-runtime";
import type {
  BrowserSupervisorOptions,
  CorridorNavigationOptions,
  DocumentHop,
  NavigationAttempt,
  NavigationLimits,
  NavigationOutcome,
  NavigationScope,
  ReadinessServer,
  SanitizedPayload,
} from "@seatfirst/browser-runtime";
import {
  buildMarketTheatresUrl,
  buildMoviesUrl,
  buildSeatsUrl,
  buildShowtimesUrl,
  buildTheatresDirectoryUrl,
  buildTheatresUrl,
  redact,
  type RedactTarget,
} from "@seatfirst/providers";

/** Structural policy ceiling (P7.5, ADR 0002): the injected budget may never exceed this. */
const MAX_NAVIGATIONS = 150;

/**
 * CONSUMED, historical only — the preregistered target list for the 2026-08-13 second live
 * session (ADR 0002 §3.4 "Second-session operator delegation," 2026-08-13). Slugs, date, and
 * showtime IDs were confirmed by an ordinary (non-scripted) browser walk immediately before
 * that session: 12 theatres across three markets (san-francisco, chicago, atlanta), that
 * session's date (2026-08-13), and real showtime IDs pulled from each theatre's live
 * showtimes page. 27 entries total, under that session's AMC_NAVIGATION_BUDGET=30.
 *
 * This exact list was run once (2026-08-13T05:04:05Z–05:04:59Z); all 27 navigations returned
 * SUCCESS (see `apps/server/fixtures/CAPTURE-LOG.md` and ADR 0002 §3.4's "Outcome" note). It
 * is kept here, unused and unexported from the live path, purely as an audit-trail record —
 * `cliMain` no longer reads this constant. Do NOT reuse it for a future session.
 */
const CONSUMED_SECOND_SESSION_TARGETS: readonly URL[] = [
  buildMoviesUrl(),
  buildTheatresUrl("San Francisco, CA"),
  buildTheatresUrl("Chicago, IL"),
  buildTheatresUrl("Atlanta, GA"),
  buildShowtimesUrl("san-francisco", "amc-metreon-16", "2026-08-13"),
  buildShowtimesUrl("san-francisco", "amc-sunnyvale-12", "2026-08-13"),
  buildShowtimesUrl("san-francisco", "amc-newpark-12", "2026-08-13"),
  buildShowtimesUrl("san-francisco", "amc-kabuki-8", "2026-08-13"),
  buildShowtimesUrl("san-francisco", "amc-manteca-16", "2026-08-13"),
  buildShowtimesUrl("chicago", "amc-river-east-21", "2026-08-13"),
  buildShowtimesUrl("chicago", "amc-evanston-12", "2026-08-13"),
  buildShowtimesUrl("chicago", "amc-randhurst-12", "2026-08-13"),
  buildShowtimesUrl("chicago", "amc-norridge-6", "2026-08-13"),
  buildShowtimesUrl("atlanta", "amc-north-dekalb-16", "2026-08-13"),
  buildShowtimesUrl("atlanta", "amc-phipps-plaza-14", "2026-08-13"),
  buildShowtimesUrl("atlanta", "amc-southlake-24", "2026-08-13"),
  buildSeatsUrl(145738252),
  buildSeatsUrl(144251358),
  buildSeatsUrl(145738053),
  buildSeatsUrl(145381450),
  buildSeatsUrl(145817558),
  buildSeatsUrl(144239197),
  buildSeatsUrl(146131401),
  buildSeatsUrl(145835334),
  buildSeatsUrl(145835344),
  buildSeatsUrl(145835357),
  buildSeatsUrl(0), // deliberately invalid ID — branded-error-path coverage (P3.2 precedent)
];
void CONSUMED_SECOND_SESSION_TARGETS; // referenced only for the audit trail, never dispatched

/**
 * CONSUMED, historical only — the preregistered target list for the 2026-08-13 THIRD live
 * session (ADR 0002 §3.4 "Third-session operator delegation," 2026-08-13), scoped narrowly to
 * test the P5.12/finding-(b) hypothesis (empty schedule/theatre-search bodies: genuinely empty
 * results, or a capture defect?). Confirmed by an ordinary (non-scripted) browser walk
 * immediately before that session: both AMC Empire 25 and AMC Lincoln Square 13 (New York
 * City) visibly showed real showtimes for that session's date (2026-08-13) — large,
 * high-throughput flagship theatres chosen as strong positive controls, since a genuinely
 * empty result there would be surprising. 3 entries total, under that session's
 * AMC_NAVIGATION_BUDGET=5.
 *
 * This exact list was run once (2026-08-13T18:56:02Z–18:56:10Z); all 3 navigations returned
 * SUCCESS (see `apps/server/fixtures/CAPTURE-LOG.md` and ADR 0002 §3.4's "Third-session
 * operator delegation" entry). It is kept here, unused and unexported from the live path,
 * purely as an audit-trail record — `cliMain` no longer reads this constant. Do NOT reuse it
 * for a future session.
 */
const CONSUMED_THIRD_SESSION_TARGETS: readonly URL[] = [
  buildTheatresUrl("New York, NY"),
  buildShowtimesUrl("new-york-city", "amc-empire-25", "2026-08-13"),
  buildShowtimesUrl("new-york-city", "amc-lincoln-square-13", "2026-08-13"),
];
void CONSUMED_THIRD_SESSION_TARGETS; // referenced only for the audit trail, never dispatched

/**
 * Preregistered target list for the 2026-08-15 FIFTH live session (ADR 0002 §3.4
 * "Fifth-session operator delegation," 2026-08-15). The 2026-08-14T03:14Z entry was a
 * passive-observation session, not a fixture capture, so this is the fourth scripted capture
 * run overall but the fifth logged §3.4 session. Scope: close the redacted-corpus gap for the
 * two ADR 0021 page shapes that have zero raw/golden coverage today — the bare `/movie-theatres`
 * theatre-directory index and the per-market `/movie-theatres/{marketSlug}` theatre-list page.
 * Slugs confirmed live by an ordinary (non-scripted) browser walk earlier in this same session
 * (`docs/amc-catalogue-plan.md` §6.5): a fresh Atlanta market-page re-fetch returned 10
 * theatres (ids 402,403,404,405,410,411,415,416,417,801); San Francisco was a previously
 * visited market (second session, 2026-08-13) chosen for shape variety, not re-confirmed live
 * in this session. 3 entries total, under the AMC_NAVIGATION_BUDGET=5 authorized for this
 * session and the 150-navigation structural ceiling.
 */
export const CAPTURE_TARGETS: readonly URL[] = [
  buildTheatresDirectoryUrl(),
  buildMarketTheatresUrl("atlanta"),
  buildMarketTheatresUrl("san-francisco"),
];

export interface CaptureResult {
  aborted: boolean;
  navigationsSpent: number;
  abortedKind: NavigationOutcome["kind"] | null;
}

/**
 * The injectable navigation call (P3's injectable-transport analogue). Tests inject a
 * counting wrapper around the real `runCorridorNavigation`; production callers omit it.
 */
export type RunNavigation = (
  supervisor: BrowserSupervisor,
  options: CorridorNavigationOptions,
) => Promise<NavigationAttempt>;

/**
 * P6's offline synthetic test-harness seams, passed through to `runCorridorNavigation`
 * untouched (the same pass-through S8's `ProviderFetchNavigationSeams` performs). Production
 * callers omit them; the default performs each hop through the browser's own network stack.
 */
export interface NavigationSeams {
  readonly contextSetup?: CorridorNavigationOptions["contextSetup"];
  readonly fetchHop?: CorridorNavigationOptions["fetchHop"];
}

export interface CaptureSessionOptions {
  supervisor: BrowserSupervisor;
  targets: readonly URL[];
  budget: number;
  isLive: boolean;
  confirmedLive?: boolean;
  navigationLimits: NavigationLimits;
  scope: NavigationScope;
  userAgent: string;
  outDir: string;
  logWriter: (line: string) => void;
  signal?: AbortSignal;
  navigationSeams?: NavigationSeams;
  runNavigation?: RunNavigation;
  navigationsSpentTracker?: { spent: number };
}

/**
 * P7.4 — payload-shape adapter, not a `redact()` rewrite. `finalUrl` carries query-key NAMES
 * only (values are stripped at the transport layer, so `redact()`'s own URL-value retention
 * step is a documented no-op here), `headers` have already passed through `redactHeaders()`
 * once (a second pass is idempotent), and `documentHtml` becomes the body so the
 * IPv4/IPv6/token regex scrub and the fail-closed check still run against the real HTML.
 */
export function toRedactTarget(payload: SanitizedPayload): RedactTarget {
  const { finalUrl } = payload;
  const query = finalUrl.queryKeys.length === 0 ? "" : `?${finalUrl.queryKeys.join("&")}`;
  return {
    url: `${finalUrl.origin}${finalUrl.pathname}${query}`,
    status: payload.finalStatus,
    headers: payload.headers,
    body: payload.documentHtml,
  };
}

/**
 * P7.10 — one log entry per navigation recording the browser-specific audit fields: the
 * corridor-stage classification and status of EVERY `DocumentHop` (not just the final
 * document), the `subresourceAborts` count (P6.11's blocking), and the outcome `kind`.
 * Never cookies, tokens, IP addresses, or page copy.
 */
function logNavigation(
  logWriter: (line: string) => void,
  target: URL,
  outcome: NavigationOutcome,
): void {
  const hops: readonly DocumentHop[] = "hops" in outcome ? outcome.hops : [];
  const statusPart = "status" in outcome ? ` | HTTP ${outcome.status}` : "";
  logWriter(
    `[ATTEMPT] ${new Date().toISOString()} | ${target.href} | outcome=${outcome.kind}${statusPart}`,
  );
  hops.forEach((hop, index) => {
    logWriter(
      `  hop ${index + 1}/${hops.length}: ${hop.classification} | status=${hop.status ?? "null"}`,
    );
  });
  if (outcome.kind === "SUCCESS") {
    logWriter(`  subresourceAborts: ${outcome.subresourceAborts}`);
  }
}

export async function runCaptureSession({
  supervisor,
  targets,
  budget,
  isLive,
  confirmedLive,
  navigationLimits,
  scope,
  userAgent,
  outDir,
  logWriter,
  signal,
  navigationSeams,
  runNavigation,
  navigationsSpentTracker,
}: CaptureSessionOptions): Promise<CaptureResult> {
  if (isLive) {
    if (process.env.SEATFIRST_ENV === "ci") {
      throw new Error("Refusing to run live session in CI.");
    }
    if (!confirmedLive) {
      throw new Error("Refusing to run live session without explicit confirmation.");
    }
  }
  if (!Number.isInteger(budget) || budget <= 0 || budget > MAX_NAVIGATIONS) {
    throw new Error("Budget must be an integer between 1 and 150.");
  }

  const navigate = runNavigation ?? runCorridorNavigation;
  let navigationsSpent = 0;
  let aborted = false;
  let abortedKind: NavigationOutcome["kind"] | null = null;

  for (const target of targets) {
    if (navigationsSpent >= budget) {
      logWriter(
        `[WARN] Budget of ${budget} navigations spent. Target left uncaptured: ${target.href}`,
      );
      continue;
    }

    // One `runCorridorNavigation` call per target: exactly one budget unit per logical
    // navigation, regardless of how many DocumentHops it reports (P7.5). The one warm
    // supervisor (P7.7) and a fresh context per navigation come from P6's transport itself.
    const attempt = await navigate(supervisor, {
      scope,
      targetUrl: target.href,
      userAgent,
      limits: navigationLimits,
      ...(signal !== undefined ? { signal } : {}),
      ...(navigationSeams?.contextSetup !== undefined
        ? { contextSetup: navigationSeams.contextSetup }
        : {}),
      ...(navigationSeams?.fetchHop !== undefined ? { fetchHop: navigationSeams.fetchHop } : {}),
    });
    navigationsSpent++;
    if (navigationsSpentTracker) navigationsSpentTracker.spent = navigationsSpent;
    // P7.7: cleanup must complete before the next target's navigation starts.
    await attempt.cleanupCompleted;

    const outcome = attempt.outcome;
    logNavigation(logWriter, target, outcome);

    switch (outcome.kind) {
      case "SUCCESS": {
        const redacted = redact(toRedactTarget(outcome.payload));
        const safeName =
          target.pathname.replace(/[^a-z0-9]/gi, "_") + target.search.replace(/[^a-z0-9]/gi, "_");
        const outPath = join(outDir, `${safeName}_${Date.now()}.json`);
        writeFileSync(outPath, JSON.stringify(redacted));
        break;
      }
      // P7.6: every non-SUCCESS outcome ends the WHOLE session — never a per-target
      // skip-and-continue. The exhaustive switch plus the `never` check makes a missing
      // variant a type error, mirroring S8's `mapNavigationOutcome` pattern.
      case "QUEUE_ENTERED":
      case "CHALLENGE_REQUIRED":
      case "UPSTREAM_BLOCKED":
      case "RATE_LIMITED":
      case "GUARD_REJECTED":
      case "CANCELLED":
      case "NAVIGATION_FAILED": {
        logWriter(`[ABORT] Non-success navigation outcome ${outcome.kind}. Aborting session.`);
        aborted = true;
        abortedKind = outcome.kind;
        break;
      }
      default: {
        const never: never = outcome;
        throw new Error(`Unhandled navigation outcome: ${JSON.stringify(never)}`);
      }
    }

    if (aborted) {
      break;
    }
  }

  return { aborted, navigationsSpent, abortedKind };
}

export interface CliDependencies {
  startReadinessServer?: () => Promise<ReadinessServer>;
  startSupervisor?: (options: BrowserSupervisorOptions) => Promise<BrowserSupervisor>;
  runNavigation?: RunNavigation;
  navigationSeams?: NavigationSeams;
  outDir?: string;
  logWriter?: (line: string) => void;
}

export async function cliMain(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: CliDependencies = {},
): Promise<void> {
  const isCi = env.SEATFIRST_ENV === "ci";
  const flagIndex = args.indexOf("--confirm-live-session=yes-i-understand");

  if (isCi) {
    console.error(
      "Refusing to run: SEATFIRST_ENV=ci is set. Explicit operator authorization is required.",
    );
    process.exitCode = 1;
    return;
  }

  if (flagIndex === -1) {
    console.error("Refusing to run: missing --confirm-live-session=yes-i-understand flag.");
    process.exitCode = 1;
    return;
  }

  const operatorFlag = args.find((a) => a.startsWith("--operator="));
  const operator = operatorFlag ? operatorFlag.split("=")[1] : env.AMC_OPERATOR;
  if (!operator || operator.trim() === "") {
    console.error(
      "Refusing to run: missing or invalid operator. Provide --operator=NAME or AMC_OPERATOR env var.",
    );
    process.exitCode = 1;
    return;
  }

  const requiredEnvVars = [
    "AMC_USER_AGENT",
    "AMC_EGRESS_IDENTITY_LABEL",
    "AMC_CHROME_EXECUTABLE_PATH",
    "AMC_NAVIGATION_TIMEOUT_MS",
    "AMC_NAVIGATION_BUDGET",
    "AMC_CLEANUP_GRACE_MS",
    "AMC_READINESS_TIMEOUT_MS",
  ];

  for (const v of requiredEnvVars) {
    if (!env[v]) {
      console.error(
        `Refusing to run: missing required environment variable ${v}.\n` +
          `You MUST supply all navigation bounds explicitly.\n` +
          `Note: ADR 0002 §2.8 requires AMC_USER_AGENT to include a descriptive product name and contact info.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const navigationTimeoutMs = parseInt(env.AMC_NAVIGATION_TIMEOUT_MS!, 10);
  const budget = parseInt(env.AMC_NAVIGATION_BUDGET!, 10);
  const cleanupGracePeriodMs = parseInt(env.AMC_CLEANUP_GRACE_MS!, 10);
  const readinessTimeoutMs = parseInt(env.AMC_READINESS_TIMEOUT_MS!, 10);

  if (
    isNaN(navigationTimeoutMs) ||
    isNaN(budget) ||
    isNaN(cleanupGracePeriodMs) ||
    isNaN(readinessTimeoutMs)
  ) {
    console.error("Refusing to run: one or more navigation bounds are not valid integers.");
    process.exitCode = 1;
    return;
  }

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = deps.outDir || join(packageRoot, "fixtures", "raw");
  if (!deps.outDir) {
    mkdirSync(outDir, { recursive: true });
  }

  const logPath = join(packageRoot, "fixtures", "CAPTURE-LOG.md");
  if (!deps.logWriter) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  const logWriter =
    deps.logWriter ||
    ((line: string) => {
      process.stdout.write(line + "\n");
      appendFileSync(logPath, line + "\n");
    });

  logWriter("\n```text");
  logWriter(`## Session started at ${new Date().toISOString()}`);
  logWriter(`Operator: ${operator}`);

  let moviesCount = 0;
  let theatresCount = 0;
  let showtimesCount = 0;
  let seatsCount = 0;
  for (const t of CAPTURE_TARGETS) {
    const path = t.pathname;
    if (path.includes("/seats")) seatsCount++;
    else if (path.includes("/showtimes")) showtimesCount++;
    else if (path.includes("/theatres") || path.includes("/movie-theatres")) theatresCount++;
    else if (path.includes("/movies")) moviesCount++;
    logWriter(`Target: ${t.href}`);
  }
  logWriter(
    `Route mix: ${moviesCount} movies, ${theatresCount} theatres, ${showtimesCount} showtimes, ${seatsCount} seats`,
  );

  const navigationsSpentTracker = { spent: 0 };

  let readiness: ReadinessServer | undefined;
  let supervisor: BrowserSupervisor | undefined;

  try {
    readiness = await (deps.startReadinessServer ?? startReadinessServer)();
    supervisor = await (deps.startSupervisor ?? ((options) => BrowserSupervisor.start(options)))({
      executablePath: env.AMC_CHROME_EXECUTABLE_PATH!,
      egressIdentityLabel: env.AMC_EGRESS_IDENTITY_LABEL!,
      providerId: "amc",
      cleanupGracePeriodMs,
      readinessTimeoutMs,
      readinessTargetUrl: readiness.baseUrl,
    });

    const fetchRunId = `capture-${Date.now().toString(36)}`;
    const scope: NavigationScope = {
      providerId: "amc",
      observationId: `${fetchRunId}-observation`,
      fetchRunId,
      routeClass: "capture",
      egressIdentityLabel: env.AMC_EGRESS_IDENTITY_LABEL!,
    };

    const { aborted, navigationsSpent } = await runCaptureSession({
      supervisor,
      targets: CAPTURE_TARGETS,
      budget,
      isLive: true,
      confirmedLive: flagIndex !== -1,
      navigationLimits: { navigationTimeoutMs },
      scope,
      userAgent: env.AMC_USER_AGENT!,
      outDir,
      logWriter,
      ...(deps.navigationSeams !== undefined ? { navigationSeams: deps.navigationSeams } : {}),
      ...(deps.runNavigation !== undefined ? { runNavigation: deps.runNavigation } : {}),
      navigationsSpentTracker,
    });
    navigationsSpentTracker.spent = navigationsSpent;
    logWriter(
      `Session ended. Aborted: ${aborted}. Navigations spent: ${navigationsSpent}/${budget}.`,
    );
    if (aborted) {
      process.exitCode = 1;
    }
  } catch (err) {
    // Never print the raw error: a redaction fail-closed error legitimately embeds the
    // un-redacted fragment it caught, and other local errors may carry a filesystem path or
    // URL. Only the error's name is safe to surface; the sanitized [ABORT] entry below is the
    // durable, human-verifiable record. This branch also covers startup failures (readiness
    // server or browser supervisor never came up) — the fence and cleanup below still run
    // either way.
    console.error(
      `Fatal error during capture session: ${err instanceof Error ? err.name : "UnknownError"}.`,
    );
    logWriter(`[ABORT] Fatal error encountered.`);
    logWriter(
      `Session ended. Aborted: true. Navigations spent: ${navigationsSpentTracker.spent}/${budget}.`,
    );
    process.exitCode = 1;
  } finally {
    logWriter("```");
    if (supervisor) {
      await supervisor.shutdown().catch(() => {});
    }
    if (readiness) {
      await readiness.close().catch(() => {});
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cliMain(process.argv, process.env)
    .then(() => {
      if (process.exitCode) {
        process.exit(process.exitCode);
      }
    })
    .catch((err) => {
      console.error(
        `Fatal error running capture-fixtures-browser: ${err instanceof Error ? err.name : "UnknownError"}.`,
      );
      process.exit(1);
    });
}
