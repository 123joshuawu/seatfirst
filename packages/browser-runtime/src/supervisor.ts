/**
 * Warm-Chrome process supervisor — the application-level half of ADR 0004's
 * runtime-ownership table (`docs/adr/0004-deployment-shape-egress-identity.md:112-125`);
 * the container/deployment half (pinned build, `USER`, Compose wiring, egress route) is
 * I1's job.
 *
 * Owns, for one fetch worker:
 * - ONE warm Chrome process, launched in its own process group (`detached: true` on
 *   POSIX), with a fresh ephemeral scratch profile directory per process lifetime
 *   (never a named/persistent volume), discarded on recycle;
 * - loopback-only remote debugging (`--remote-debugging-address=127.0.0.1`, ephemeral
 *   port) — no network-interface bind;
 * - readiness via a local synthetic page only (P6.16): start fails unless a throwaway
 *   `BrowserContext` can be created, navigated to the injected synthetic URL, and
 *   destroyed;
 * - process-group termination with confirmed dead-tree and a cleanup-completion signal
 *   (P6.3): if context cleanup exceeds the injected grace period, Chrome is killed and
 *   replaced while capacity is retained.
 *
 * Every bound (cleanup grace period, readiness timeout) is an injected caller-supplied
 * parameter with no default — gate 14 / ADR 0006 (P6.18). P6 does not itself call any S5
 * capacity-release transaction; S8 observes the cleanup-completion signals.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { chromium, errors, type Browser, type BrowserContext } from "playwright-core";
import { z } from "zod";
import {
  recordChromeRecycle,
  recordChromeRestart,
  recordChromeStartup,
  recordContextCleanupDuration,
  recordContextCreateDuration,
  recordReadinessProbe,
  registerChromeProcessGauges,
  type ReadinessProbeOutcome,
  type RuntimeVersions,
} from "./observability.js";

export interface BrowserSupervisorOptions {
  /** Injected: which Chrome binary to run (I1 pins the build). */
  readonly executablePath: string;
  /** Fixed deployment-assigned audit label; never rotated by this runtime (P6.15). */
  readonly egressIdentityLabel: string;
  /**
   * Fixed provider-actor identity (architecture §4.2: capacity-1-per-`providerId` semaphore,
   * one warm Chrome process per fetch worker). Injected, never mutated. O2 telemetry attribution
   * only — nothing branches on it.
   */
  readonly providerId: string;
  /** Gate 14 / ADR 0006 — injected, no default. */
  readonly cleanupGracePeriodMs: number;
  /** Gate 14 / ADR 0006 — injected, no default. */
  readonly readinessTimeoutMs: number;
  /** Local synthetic-page URL the readiness probe exercises — never AMC (P6.16). */
  readonly readinessTargetUrl: string;
  /**
   * Additional Chrome launch arguments. Test-only in practice: the offline synthetic
   * suite injects its host-resolver mapping and certificate override here; production
   * never adds debug bypasses.
   */
  readonly extraLaunchArgs?: readonly string[];
  /** Optional callback invoked whenever supervisor readiness changes. */
  readonly onReadinessChange?: (ready: boolean) => void;
}

export interface TreeExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Polling cadence for dead-tree confirmation — a check interval, not a policy bound. */
const TREE_POLL_INTERVAL_MS = 25;

const PLAYWRIGHT_VERSION: string = (() => {
  const require = createRequire(import.meta.url);
  const parsed = z
    .object({ version: z.string() })
    .safeParse(require("playwright-core/package.json"));
  return parsed.success ? parsed.data.version : "unknown";
})();

export class BrowserSupervisor {
  readonly #options: BrowserSupervisorOptions;

  #browser: Browser | null = null;
  #child: ChildProcess | null = null;
  #processGroupId = 0;
  /** Epoch ms of the current process's successful launch; 0 until the first one. */
  #launchedAt = 0;
  /** Contexts created since the current process's launch/recycle (O2.2). */
  #navigationCount = 0;
  /** Guards one-time gauge registration per supervisor instance (O2.2/O2.3). */
  #gaugesRegistered = false;
  #profileDir: string | null = null;

  #treeExit: Deferred<TreeExitInfo> | null = null;
  #chromeVersion = "";
  #lastLaunchError: Error | null = null;
  #isReady = false;
  readonly #readinessListeners = new Set<(ready: boolean) => void>();
  /**
   * True while a supervisor-initiated kill of the current process group is in flight
   * (recycle/forced-cleanup/shutdown/forceShutdown/launch-failure cleanup). The exit
   * listener consults it so a tree exit caused by one of those paths is never double-
   * reported as `unexpected_exit` (O2.4): only an exit observed outside every one of
   * those paths is a surprise. Set by each caller AROUND its `#killTreeAndConfirm()`
   * call, never inside it — that method serves several semantics and cannot know
   * which caller invoked it.
   */
  #killInProgress = false;
  /**
   * The process-group id currently being killed deliberately (set alongside
   * #killInProgress, cleared only once that group leader's `exit` event has been
   * observed). Node reaps the child in its SIGCHLD handler but delivers the JS
   * `exit` event one loop phase later — so the event can fire AFTER
   * `#killTreeAndConfirm()` confirmed the group dead and the caller cleared
   * #killInProgress. This slot lets the listener still attribute that inevitable
   * late delivery to the deliberate kill instead of `unexpected_exit`.
   */
  #killedGroupId: number | null = null;

  readonly #onProcessExit = (): void => {
    if (this.#processGroupId > 0 && this.#child !== null) {
      try {
        process.kill(-this.#processGroupId, "SIGKILL");
      } catch {
        // Group already gone — nothing to kill.
      }
    }
  };

  private constructor(options: BrowserSupervisorOptions) {
    this.#options = options;
  }

  static async start(options: BrowserSupervisorOptions): Promise<BrowserSupervisor> {
    const supervisor = new BrowserSupervisor(options);
    await supervisor.#launch();
    return supervisor;
  }

  /** Current Chrome process-group id (the group leader's pid). */
  get chromeProcessGroupId(): number {
    return this.#processGroupId;
  }

  /** Current ephemeral scratch profile directory (created per launch, deleted on recycle). */
  get profileDirectory(): string | null {
    return this.#profileDir;
  }

  get versions(): RuntimeVersions {
    return { chrome: this.#chromeVersion, playwright: PLAYWRIGHT_VERSION };
  }

  get egressIdentityLabel(): string {
    return this.#options.egressIdentityLabel;
  }

  get providerId(): string {
    return this.#options.providerId;
  }

  /** Age of the current warm Chrome process in ms; 0 before the first successful launch. */
  get processAgeMs(): number {
    return this.#launchedAt === 0 ? 0 : Date.now() - this.#launchedAt;
  }

  /** Contexts created since the current process's launch or last recycle (O2.2). */
  get navigationCount(): number {
    return this.#navigationCount;
  }

  /**
   * Returns true if Chrome is warm, CDP is connected, and the readiness probe passed.
   */
  isReady(): boolean {
    return this.#isReady;
  }

  /**
   * Subscribes to readiness state transitions. Returns an unsubscribe callback.
   */
  addReadinessListener(listener: (ready: boolean) => void): () => void {
    this.#readinessListeners.add(listener);
    return () => {
      this.#readinessListeners.delete(listener);
    };
  }

  #setReady(ready: boolean): void {
    if (this.#isReady === ready) {
      return;
    }
    this.#isReady = ready;
    try {
      this.#options.onReadinessChange?.(ready);
    } catch {
      // Listener errors must not crash supervisor
    }
    for (const listener of this.#readinessListeners) {
      try {
        listener(ready);
      } catch {
        // Listener errors must not crash supervisor
      }
    }
  }

  /**
   * Tree-wide resident memory (bytes): the VmRSS sum of every process in the Chrome
   * process group, read from /proc. Resolves null — never throws, never fabricates a
   * value — when /proc is unavailable (non-Linux) or the group id is not positive.
   */
  async residentMemoryBytes(): Promise<number | null> {
    if (process.platform !== "linux" || this.#processGroupId <= 0) {
      return null;
    }
    try {
      const groupId = this.#processGroupId;
      const entries = await readdir("/proc");
      const results = await Promise.allSettled(
        entries.map(async (name): Promise<number | null> => {
          if (!/^\d+$/.test(name)) {
            return null;
          }
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          if (procStatPgrp(stat) !== groupId) {
            return null;
          }
          const status = await readFile(`/proc/${name}/status`, "utf8");
          return statusVmRssKb(status) * 1024;
        }),
      );
      let total = 0;
      let members = 0;
      for (const result of results) {
        if (result.status === "fulfilled" && result.value !== null) {
          total += result.value;
          members += 1;
        }
      }
      // An empty sum means no group member was found (e.g. every pid exited mid-scan):
      // report "no measurement" rather than a fabricated zero.
      return members === 0 ? null : total;
    } catch {
      return null;
    }
  }

  /**
   * A fresh non-persistent BrowserContext per logical navigation (P6.1). Playwright
   * contexts over CDP are isolated storage partitions: cookies, Queue-it tokens, local
   * storage, and service-worker state live only inside the context and are destroyed
   * when it closes. A Chrome restart changes no application-visible cookie state.
   */
  async newContext(options: Readonly<{ userAgent?: string }> = {}): Promise<BrowserContext> {
    if (this.#browser === null) {
      throw new Error(
        this.#lastLaunchError === null
          ? "browser supervisor has no live Chrome process"
          : `browser supervisor is broken: ${this.#lastLaunchError.message}`,
      );
    }
    const started = Date.now();
    const context =
      options.userAgent === undefined
        ? await this.#browser.newContext()
        : await this.#browser.newContext({ userAgent: options.userAgent });
    this.#navigationCount += 1;
    recordContextCreateDuration(this.providerId, Date.now() - started);
    return context;
  }

  /** Resolves with the exit code/signal when the CURRENT Chrome tree exits. */
  waitForTreeExit(): Promise<TreeExitInfo> {
    if (this.#treeExit === null) {
      return Promise.resolve({ code: null, signal: null });
    }
    return this.#treeExit.promise;
  }

  /**
   * Cleanup-completion signal for one navigation (P6.3): resolves only once the context
   * is confirmed destroyed — or, when that cleanup exceeds the injected grace period,
   * once the full Chrome process tree is confirmed dead and a replacement process has
   * been launched (kill and replace while retaining capacity).
   */
  async cleanupContext(context: BrowserContext): Promise<void> {
    const started = Date.now();
    const closed = context.close();
    const result = await Promise.race([
      closed.then(
        () => "closed" as const,
        () => "unconfirmed" as const,
      ),
      delay(this.#options.cleanupGracePeriodMs).then(() => "grace-expired" as const),
    ]);
    // Never allow a late rejection from a wedged close to surface as unhandled.
    closed.catch(() => {});
    if (result === "closed") {
      recordContextCleanupDuration(this.providerId, Date.now() - started);
      return;
    }
    // Close was unconfirmed or the grace period expired: confirm (or force) tree death.
    this.#setReady(false);
    const alreadyDead = await this.#confirmGroupDead();
    if (!alreadyDead) {
      this.#killInProgress = true;
      this.#killedGroupId = this.#processGroupId;
      try {
        await this.#killTreeAndConfirm("SIGTERM");
      } finally {
        this.#killInProgress = false;
      }
    }
    // Kill and replace while retaining capacity (P6.3). Replacement failure does not
    // revoke the dead-tree confirmation; it marks the supervisor broken instead.
    // O2.4: this branch IS the `forced_cleanup_replace` reason — recorded once, before
    // the replacement launch, so the launch's own outcome cannot double or mask it.
    recordChromeRestart("forced_cleanup_replace", this.#options.providerId);
    await this.#relaunch();
    recordContextCleanupDuration(this.providerId, Date.now() - started);
  }

  /** Full warm-process recycle: terminate the tree, discard the profile, relaunch fresh. */
  async recycle(): Promise<void> {
    this.#setReady(false);
    const started = Date.now();
    // O2.4: `deliberate_recycle` is the caller's intent, recorded up front so a later
    // relaunch failure can never conflate the reason with the launch's own outcome.
    recordChromeRestart("deliberate_recycle", this.#options.providerId);
    this.#killInProgress = true;
    this.#killedGroupId = this.#processGroupId;
    try {
      await this.#killTreeAndConfirm("SIGTERM");
    } finally {
      this.#killInProgress = false;
    }
    await this.#discardProfile();
    await this.#launch();
    recordChromeRecycle(Date.now() - started, this.#options.providerId);
  }

  /** Graceful termination: SIGTERM the group, confirm the tree dead (no replacement). */
  async shutdown(): Promise<void> {
    this.#setReady(false);
    this.#killInProgress = true;
    this.#killedGroupId = this.#processGroupId;
    try {
      await this.#killTreeAndConfirm("SIGTERM");
    } finally {
      this.#killInProgress = false;
    }
    this.#dispose();
  }

  /** Forced termination: SIGKILL the group immediately, confirm the tree dead. */
  async forceShutdown(): Promise<void> {
    this.#setReady(false);
    this.#killInProgress = true;
    this.#killedGroupId = this.#processGroupId;
    try {
      await this.#killTreeAndConfirm("SIGKILL");
    } finally {
      this.#killInProgress = false;
    }
    this.#dispose();
  }

  async #launch(): Promise<void> {
    const startedAt = Date.now();
    if (process.platform === "win32") {
      throw new Error(
        "process-group supervision is POSIX-only; browser-runtime targets Linux (Docker Compose) and macOS",
      );
    }
    this.#lastLaunchError = null;

    const profileDir = await mkdtemp(join(tmpdir(), "seatfirst-chrome-"));
    const child = spawn(
      this.#options.executablePath,
      [
        "--headless=new",
        // Required for Chrome to launch at all under ADR 0004's non-root execution
        // requirement: without host-granted CAP_SYS_ADMIN or a kernel/AppArmor
        // configuration that permits unprivileged user-namespace sandboxing (neither
        // of which this deployment's container grants — I1 runs fetch-worker as a
        // fixed non-root UID with no added capabilities), Chromium's own process
        // sandbox cannot initialize and Chrome never exposes its debugging endpoint
        // (verified directly: identical launch flags minus this one hang past the
        // readiness timeout in every containerized environment tested — GitHub
        // Actions' ci-smoke job and local Docker — while adding it launches
        // cleanly). This is the standard, universally-documented mitigation for
        // running headless Chrome non-root in a container (Puppeteer/Playwright's
        // own Docker guidance); the container boundary — not Chrome's internal
        // sandbox — is this deployment's isolation layer, matching ADR 0004's
        // "non-root execution... enforced at the Dockerfile/Compose service level".
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        // Standard Playwright default: disables Chromium experimental field trials whose
        // non-standard TLS/HTTP2 fingerprints trigger Cloudflare bot detection blocks.
        "--disable-field-trial-config",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        // Loopback-only remote debugging (ADR 0004 table) — ephemeral port.
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir}`,
        ...(this.#options.extraLaunchArgs ?? []),
        "about:blank",
      ],
      {
        // Own process group: the group id is the child's pid.
        detached: true,
        // Chrome output is discarded: a crash bundle must never capture Chrome logs
        // (they may embed URLs) — P6.13.
        stdio: "ignore",
      },
    );

    this.#child = child;
    this.#processGroupId = child.pid ?? 0;
    this.#profileDir = profileDir;
    this.#treeExit = deferred<TreeExitInfo>();
    // Capture this generation's deferred by value: `#dispose()` nulls `this.#treeExit`
    // as soon as a kill is confirmed, but the actual `exit` event can be delivered one
    // event-loop phase later (Node reaps via SIGCHLD before the JS event fires). Reading
    // `this.#treeExit` at listener-invocation time would silently no-op the resolve and
    // hang every caller awaiting `waitForTreeExit()`; closing over the value fixes that.
    const treeExit = this.#treeExit;
    child.once("exit", (code, signal) => {
      this.#setReady(false);
      // A tree exit observed while no supervisor-initiated kill is in flight is a
      // surprise (crash, OOM kill, out-of-band kill) — the O2.4/O2.7 `unexpected_exit`
      // alert signal. A deliberate kill is recognized two ways: the in-flight flag
      // (the common case) and the killed-group slot (covers the late `exit` delivery
      // described on #killedGroupId — the child is reaped before the JS event fires,
      // so the confirm poll can win the race against the listener).
      const deliberate = this.#killInProgress || child.pid === this.#killedGroupId;
      if (child.pid === this.#killedGroupId) {
        this.#killedGroupId = null;
      }
      if (!deliberate) {
        recordChromeRestart("unexpected_exit", this.#options.providerId);
      }
      treeExit.resolve({ code, signal });
    });
    // Best-effort orphan guard: if the worker process itself exits unexpectedly, take
    // the Chrome group with it. Container-level `init: true` (I1) covers the rest.
    process.once("exit", this.#onProcessExit);

    try {
      const deadline = Date.now() + this.#options.readinessTimeoutMs;
      const endpoint = await this.#waitForDebugEndpoint(profileDir, deadline);
      const versionInfo = await fetchDevToolsVersion(endpoint);
      this.#browser = await chromium.connectOverCDP(versionInfo.webSocketDebuggerUrl, {
        timeout: Math.max(1, deadline - Date.now()),
      });
      this.#browser.once("disconnected", () => {
        this.#setReady(false);
      });
      this.#chromeVersion = versionInfo.Browser;
      const ready = await this.#probeReadiness();
      if (!ready) {
        throw new Error(
          "readiness probe failed: could not create and destroy a BrowserContext against the synthetic page",
        );
      }
      this.#launchedAt = Date.now();
      this.#navigationCount = 0;
      if (!this.#gaugesRegistered) {
        this.#gaugesRegistered = true;
        registerChromeProcessGauges(this);
      }
      this.#setReady(true);
    } catch (error) {
      this.#setReady(false);
      this.#lastLaunchError = error instanceof Error ? error : new Error(String(error));
      this.#browser = null;
      // The launch-failure cleanup kill is supervisor-initiated too: its tree exit must
      // not surface as `unexpected_exit`. A bare launch failure is the caller's rejected
      // promise and out of scope for the restart taxonomy (O2.4) — no reason is recorded.
      this.#killInProgress = true;
      this.#killedGroupId = this.#processGroupId;
      try {
        await this.#killTreeAndConfirm("SIGTERM").catch(() => {});
      } finally {
        this.#killInProgress = false;
      }
      await this.#discardProfile().catch(() => {});
      throw this.#lastLaunchError;
    }
    recordChromeStartup(this.#options.providerId, Date.now() - startedAt);
  }

  async #waitForDebugEndpoint(profileDir: string, deadline: number): Promise<string> {
    for (;;) {
      let portFile: string;
      try {
        portFile = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
      } catch {
        if (Date.now() >= deadline) {
          throw new Error(
            "Chrome did not expose its debugging endpoint within the readiness timeout",
          );
        }
        await delay(TREE_POLL_INTERVAL_MS);
        continue;
      }
      const port = portFile.split("\n")[0];
      if (port === undefined || port === "") {
        throw new Error("Chrome wrote an empty DevToolsActivePort");
      }
      return `http://127.0.0.1:${port}`;
    }
  }

  async #probeReadiness(): Promise<boolean> {
    if (this.#browser === null) {
      return false;
    }
    const startedAt = Date.now();
    let outcome: ReadinessProbeOutcome | null = null;
    try {
      const context = await this.#browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(this.#options.readinessTargetUrl, {
          waitUntil: "load",
          timeout: this.#options.readinessTimeoutMs,
        });
        if (page.url() !== this.#options.readinessTargetUrl) {
          // Landing anywhere else is a failed probe attempt: error, not timeout.
          outcome = "error";
        }
      } finally {
        // A failed destroy also reports not-ready.
        await context.close();
      }
    } catch (error) {
      // Only a breached readinessTimeoutMs (Playwright's TimeoutError) is the timeout
      // outcome; any other failed attempt is the error outcome.
      recordReadinessProbe(
        this.#options.providerId,
        Date.now() - startedAt,
        outcome ?? (error instanceof errors.TimeoutError ? "timeout" : "error"),
      );
      return false;
    }
    recordReadinessProbe(this.#options.providerId, Date.now() - startedAt, outcome ?? "ready");
    return outcome === null;
  }

  async #killTreeAndConfirm(signal: NodeJS.Signals): Promise<void> {
    if (this.#processGroupId > 0) {
      try {
        process.kill(-this.#processGroupId, signal);
      } catch (error) {
        // ESRCH: already gone. EPERM: the group id was recycled by a foreign
        // process — nothing of ours to signal (best effort).
        if (!["ESRCH", "EPERM"].includes(errnoCode(error))) {
          throw error;
        }
      }
      if (!(await this.#confirmGroupDead())) {
        try {
          process.kill(-this.#processGroupId, "SIGKILL");
        } catch (error) {
          if (!["ESRCH", "EPERM"].includes(errnoCode(error))) {
            throw error;
          }
        }
        if (!(await this.#confirmGroupDead())) {
          throw new Error(
            `Chrome process group ${this.#processGroupId} did not terminate after SIG${signal} + SIGKILL`,
          );
        }
      }
    }
    this.#browser = null;
  }

  /**
   * True once `kill(-pgid, 0)` reports ESRCH — the whole group is gone. EPERM is
   * also treated as gone: the supervisor only ever signals its own uid's group, so
   * an EPERM result means the group id was recycled by a foreign process and this
   * supervisor's tree is no longer signallable (its leader exit is observed
   * separately through `waitForTreeExit()`).
   */
  async #confirmGroupDead(): Promise<boolean> {
    if (this.#processGroupId <= 0) {
      return true;
    }
    const deadline = Date.now() + this.#options.cleanupGracePeriodMs;
    for (;;) {
      try {
        process.kill(-this.#processGroupId, 0);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ESRCH" || code === "EPERM") {
          return true;
        }
        throw error;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(TREE_POLL_INTERVAL_MS);
    }
  }

  async #discardProfile(): Promise<void> {
    if (this.#profileDir !== null) {
      const dir = this.#profileDir;
      this.#profileDir = null;
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #relaunch(): Promise<void> {
    // Launch failures must not turn a confirmed dead-tree cleanup into a hang: record
    // the supervisor as broken and let the caller observe it via newContext().
    await this.#discardProfile();
    try {
      await this.#launch();
    } catch {
      this.#browser = null;
      this.#setReady(false);
    }
  }

  #dispose(): void {
    this.#setReady(false);
    this.#browser = null;
    this.#child = null;
    this.#processGroupId = 0;
    this.#treeExit = null;
    process.removeListener("exit", this.#onProcessExit);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errno code of an unknown thrown value — "" when absent, so the ESRCH/EPERM
 * checks below keep their exact semantics without asserting the error's shape.
 */
function errnoCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "";
}

/**
 * Process-group id from one `/proc/<pid>/stat` line: the field after `ppid`, parsed
 * past the last `)` because `(comm)` may itself contain spaces or parentheses.
 * Returns null when the line does not parse.
 */
function procStatPgrp(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const pgrp = Number(stat.slice(close + 2).split(" ")[2]);
  return Number.isFinite(pgrp) ? pgrp : null;
}

/** Resident memory in kB from one `/proc/<pid>/status` body; 0 when the line is absent. */
function statusVmRssKb(status: string): number {
  for (const line of status.split("\n")) {
    if (line.startsWith("VmRSS:")) {
      const kb = Number(line.slice("VmRSS:".length).trim().split(/\s+/)[0]);
      return Number.isFinite(kb) && kb > 0 ? kb : 0;
    }
  }
  return 0;
}

/**
 * Non-strict: real Chrome `/json/version` bodies carry extra keys
 * (`Protocol-Version`, `User-Agent`, …) that must not reject the payload.
 */
const devToolsVersionSchema = z.object({
  Browser: z.string(),
  webSocketDebuggerUrl: z.string(),
});

async function fetchDevToolsVersion(
  endpoint: string,
): Promise<z.infer<typeof devToolsVersionSchema>> {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome debugging endpoint returned HTTP ${response.status}`);
  }
  return devToolsVersionSchema.parse(await response.json());
}
