/**
 * S35 — browser-driven handoff-verification session runner: the entrypoint the ONE live
 * session ADR 0002 §3.5 proposes must use, when separately authorized by Josh Wu at
 * authorization time. It drives P6's Chrome corridor (`runCorridorNavigation`) and P6's
 * transport-owned observation evaluator (S35.11), reusing P3/P7's
 * budget/redaction/log/authorization-gate shape exactly.
 *
 * This task ships capability only: it authorizes no live session and revives no consumed
 * authorization (ADR 0002 §3.5). Running the live session requires Josh Wu's own separate,
 * in-session go-ahead with its own preregistered target list and navigation budget — this
 * script independently refuses without an explicit non-default confirmation flag and
 * refuses in `SEATFIRST_ENV=ci` (S35.9, P3.8/P7.8's exact mechanism). No cron, no CI job,
 * no retry wrapper.
 *
 * Every navigation bound (navigation timeout, egress identity label, user agent, budget,
 * supervisor cleanup/readiness grace periods, Chrome executable, targets file) is an
 * injected CLI/env parameter with no default constant anywhere in this file. The only
 * numeric constant is `MAX_NAVIGATIONS`, the structural 150-navigation policy ceiling the
 * injected budget is validated against — never a default budget value (S35.3, ADR 0002).
 *
 * S35.2: this script carries NO request logic — it composes `runCorridorNavigation`, which
 * owns every fetch/redirect/abort. One warm `BrowserSupervisor`, one navigation in flight
 * at a time, each `cleanupCompleted` awaited before the next target.
 *
 * S35.8: this script persists NO HTML/RSC and NO payload corpus — no `raw/` write, no
 * golden. The observation evaluator extracts factual seat-state in memory; only the
 * redacted observation log (S35.6/S35.7) is written.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

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
  Observation,
  ObservationPlan,
  ReadinessServer,
} from "@seatfirst/browser-runtime";
import { redact } from "@seatfirst/providers";

/** Structural policy ceiling (S35.3, ADR 0002): the injected budget may never exceed this. */
const MAX_NAVIGATIONS = 150;

/** The named allowlist of safe observation-record fields (S35.7) — everything else is dropped. */
export const OBSERVATION_RECORD_ALLOWLIST: ReadonlySet<string> = new Set([
  "url",
  "outcomeKind",
  "carryThrough",
  "geometryNearTarget",
]);

/** The preregistered-target file shape: an array of seats deep links + their plans (S35.4). */
const observationPlanInputSchema = z.object({
  source: z.enum(["dom", "flight"]),
  targetSeatNames: z.array(z.string()),
  selectedSeatSelector: z.string(),
  geometrySeatSelector: z.string(),
  fieldMapping: z.record(z.string(), z.string()),
  maxRadius: z.number(),
  maxResults: z.number(),
});

const verifyTargetInputSchema = z.object({
  url: z.string().url(),
  observationPlan: observationPlanInputSchema,
});

const verifyTargetsFileSchema = z.array(verifyTargetInputSchema);

/** One preregistered navigation target: a seats deep link plus its declarative plan. */
export interface HandoffVerificationTarget {
  readonly url: URL;
  readonly observationPlan: ObservationPlan;
}

export interface VerificationResult {
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
 * untouched. Production callers omit them; the default performs each hop through the
 * browser's own network stack.
 */
export interface NavigationSeams {
  readonly contextSetup?: CorridorNavigationOptions["contextSetup"];
  readonly fetchHop?: CorridorNavigationOptions["fetchHop"];
}

export interface VerifySessionOptions {
  supervisor: BrowserSupervisor;
  targets: readonly HandoffVerificationTarget[];
  budget: number;
  isLive: boolean;
  confirmedLive?: boolean;
  navigationLimits: NavigationLimits;
  scope: NavigationScope;
  userAgent: string;
  logWriter: (line: string) => void;
  signal?: AbortSignal;
  navigationSeams?: NavigationSeams;
  runNavigation?: RunNavigation;
  navigationsSpentTracker?: { spent: number };
}

/** Reuse P7.3's promoted `redact()` body-scrub for one free-text value (S35.7). */
function scrubText(value: string): string {
  return redact({ url: "https://seatfinder.invalid/", status: 0, headers: {}, body: value }).body;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}

/**
 * S35.7 — allowlist-shaped redaction for the observation record, as a separate pure module.
 * Every key outside the named allowlist is dropped (a denylist silently ships the next
 * header/field AMC adds), and every retained string value is run through P7.3's `redact()`
 * so no cookie, auth/session token, IP address, or Cloudflare/Queue-it trace identifier
 * survives — with `redact()`'s fail-closed check still applied.
 */
export function redactObservationRecord(
  record: Record<string, unknown>,
  allowlist: ReadonlySet<string> = OBSERVATION_RECORD_ALLOWLIST,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!allowlist.has(key)) {
      continue;
    }
    redacted[key] = redactValue(value);
  }
  return redacted;
}

/** The carry-through answer as a log-safe label (question 1, S35.6). */
function carryThroughLabel(carryThrough: Observation["carryThrough"]): string {
  if (carryThrough === "INCONCLUSIVE") {
    return "INCONCLUSIVE";
  }
  if (carryThrough === "NONE_SELECTED") {
    return "NONE_SELECTED";
  }
  return `selected=${carryThrough.selectedSeatId}`;
}

function buildObservationRecord(
  target: HandoffVerificationTarget,
  outcome: NavigationOutcome,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    url: target.url.href,
    outcomeKind: outcome.kind,
  };
  if (outcome.kind === "SUCCESS") {
    const observation = outcome.payload.observation;
    if (observation !== undefined) {
      record.carryThrough = carryThroughLabel(observation.carryThrough);
      record.geometryNearTarget = observation.geometryNearTarget;
    }
  }
  return record;
}

/** Log the redacted carry-through and geometry answers (S35.6) — never raw payloads. */
function logObservationRecord(
  logWriter: (line: string) => void,
  record: Record<string, unknown>,
): void {
  if (typeof record.carryThrough === "string") {
    logWriter(`  carry-through: ${record.carryThrough}`);
  }
  const geometry = record.geometryNearTarget;
  if (Array.isArray(geometry)) {
    for (const entry of geometry) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const seat = entry as Record<string, unknown>;
      const row = typeof seat.row === "number" ? seat.row : "null";
      const column = typeof seat.column === "number" ? seat.column : "null";
      const name = typeof seat.name === "string" ? seat.name : "null";
      const available = typeof seat.available === "boolean" ? seat.available : "null";
      const status = typeof seat.status === "string" ? seat.status : "null";
      logWriter(
        `  geometry: row=${row} column=${column} name=${name} available=${available} status=${status}`,
      );
    }
  }
}

/**
 * S35.6/S35.10 — one log entry per navigation: the corridor-stage classification and status
 * of EVERY `DocumentHop`, the `subresourceAborts` count, the outcome `kind`, and — on
 * SUCCESS — the redacted carry-through and geometry answers. Never cookies, tokens, IP
 * addresses, or page copy.
 */
function logNavigation(
  logWriter: (line: string) => void,
  target: HandoffVerificationTarget,
  outcome: NavigationOutcome,
): void {
  const hops: readonly DocumentHop[] = "hops" in outcome ? outcome.hops : [];
  const statusPart = "status" in outcome ? ` | HTTP ${outcome.status}` : "";
  logWriter(
    `[ATTEMPT] ${new Date().toISOString()} | ${target.url.href} | outcome=${outcome.kind}${statusPart}`,
  );
  hops.forEach((hop, index) => {
    logWriter(
      `  hop ${index + 1}/${hops.length}: ${hop.classification} | status=${hop.status ?? "null"}`,
    );
  });
  if (outcome.kind === "SUCCESS") {
    logWriter(`  subresourceAborts: ${outcome.subresourceAborts}`);
    logObservationRecord(
      logWriter,
      redactObservationRecord(buildObservationRecord(target, outcome)),
    );
  }
}

export async function runVerificationSession({
  supervisor,
  targets,
  budget,
  isLive,
  confirmedLive,
  navigationLimits,
  scope,
  userAgent,
  logWriter,
  signal,
  navigationSeams,
  runNavigation,
  navigationsSpentTracker,
}: VerifySessionOptions): Promise<VerificationResult> {
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
        `[WARN] Budget of ${budget} navigations spent. Target left unobserved: ${target.url.href}`,
      );
      continue;
    }

    // One `runCorridorNavigation` call per target: exactly one budget unit per logical
    // navigation, regardless of how many DocumentHops it reports (S35.3). One warm
    // supervisor and a fresh context per navigation come from P6's transport itself.
    const attempt = await navigate(supervisor, {
      scope,
      targetUrl: target.url.href,
      userAgent,
      limits: navigationLimits,
      observationPlan: target.observationPlan,
      ...(signal !== undefined ? { signal } : {}),
      ...(navigationSeams?.contextSetup !== undefined
        ? { contextSetup: navigationSeams.contextSetup }
        : {}),
      ...(navigationSeams?.fetchHop !== undefined ? { fetchHop: navigationSeams.fetchHop } : {}),
    });
    navigationsSpent++;
    if (navigationsSpentTracker) navigationsSpentTracker.spent = navigationsSpent;
    // S35.2 / P7.7: cleanup must complete before the next target's navigation starts.
    await attempt.cleanupCompleted;

    const outcome = attempt.outcome;
    logNavigation(logWriter, target, outcome);

    switch (outcome.kind) {
      case "SUCCESS": {
        // No corpus write: the redacted observation answers were already logged.
        break;
      }
      // S35.5: every non-SUCCESS outcome ends the WHOLE session — never a per-target
      // skip-and-continue. The exhaustive switch plus the `never` check makes a missing
      // variant a type error.
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
  logWriter?: (line: string) => void;
}

/** Parse and schema-validate the preregistered targets file (S35.4) into session targets. */
export function loadTargets(raw: string): HandoffVerificationTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `VERIFY_TARGETS_FILE is not valid JSON: ${error instanceof Error ? error.name : "UnknownError"}`,
      { cause: error },
    );
  }
  const result = verifyTargetsFileSchema.safeParse(parsed);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`VERIFY_TARGETS_FILE failed schema validation: ${paths}`);
  }
  return result.data.map((entry) => ({
    url: new URL(entry.url),
    observationPlan: entry.observationPlan,
  }));
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
    "AMC_CLEANUP_GRACE_MS",
    "AMC_READINESS_TIMEOUT_MS",
    "VERIFY_NAVIGATION_BUDGET",
    "VERIFY_TARGETS_FILE",
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
  const budget = parseInt(env.VERIFY_NAVIGATION_BUDGET!, 10);
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

  const targets = loadTargets(readFileSync(env.VERIFY_TARGETS_FILE!, "utf8"));

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const logPath = join(packageRoot, "fixtures", "HANDOFF-VERIFICATION-LOG.md");
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
  logWriter(`Navigation budget: ${budget}`);
  for (const t of targets) {
    logWriter(`Target: ${t.url.href}`);
  }

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

    const fetchRunId = `verify-${Date.now().toString(36)}`;
    const scope: NavigationScope = {
      providerId: "amc",
      observationId: `${fetchRunId}-observation`,
      fetchRunId,
      routeClass: "handoff-verification",
      egressIdentityLabel: env.AMC_EGRESS_IDENTITY_LABEL!,
    };

    const { aborted, navigationsSpent } = await runVerificationSession({
      supervisor,
      targets,
      budget,
      isLive: true,
      confirmedLive: flagIndex !== -1,
      navigationLimits: { navigationTimeoutMs },
      scope,
      userAgent: env.AMC_USER_AGENT!,
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
    // server or browser supervisor never came up) — the fence and cleanup below still run.
    console.error(
      `Fatal error during handoff-verification session: ${
        err instanceof Error ? err.name : "UnknownError"
      }.`,
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
        `Fatal error running verify-handoff: ${err instanceof Error ? err.name : "UnknownError"}.`,
      );
      process.exit(1);
    });
}
