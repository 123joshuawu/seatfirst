/**
 * Fetch-worker container entrypoint (I1 + S29, container-level wiring — not application
 * code). Hosts P6's local synthetic-page readiness server inside the container: the
 * readiness probe's HTTP logic is P6's (readiness-server.ts, P6.16); this file only starts
 * it on the container's fixed loopback port, which is what the Compose healthcheck
 * exercises. It then starts the composed fetch-worker process (S29): the dispatch worker
 * set plus S26's catalogue-crawl tick loop sharing one warm Chrome (BrowserSupervisor).
 * The application composition lives in `apps/server/src/fetch-worker/entrypoint.ts`; this
 * file owns only ordering — the readiness server must be listening before the worker
 * starts, because every `BrowserSupervisor.start()` readiness probe navigates the loopback
 * target and the Compose healthcheck hits this port.
 *
 * The pinned Chrome build is baked into the image regardless (Dockerfile.fetch-worker);
 * Chrome itself is launched — in its own process group, loopback-only debugging — by
 * P6's BrowserSupervisor once `startFetchWorker` composes the catalogue crawler. This
 * entrypoint deliberately contains no Chrome-launch code.
 *
 * The port number is container-internal configuration, not a policy threshold.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startReadinessServer } from "@seatfirst/browser-runtime";

// O8.2 — register the pg auto-instrumentation before the server module graph evaluates
// `pg` (its static imports reach @seatfirst/durability's pool). Registration after that
// evaluation produces no pg spans (O8's ordering test pins this in both directions).
const { ensurePgInstrumented } = await import("@seatfirst/config/otel-bootstrap");
ensurePgInstrumented();
const { startFetchWorker } = await import("@seatfirst/server/dist/fetch-worker/entrypoint.js");

const execFileAsync = promisify(execFile);
const READINESS_PORT = 8787;
const CONTROLLED_DESTINATION = process.env.CONTROLLED_ROUTE_DESTINATION || "1.1.1.1";
const egressMode = process.env.EGRESS_MODE || "relay";

async function checkEgressRouteLinux() {
  if (process.platform !== "linux") {
    return true;
  }
  try {
    if (egressMode === "residential") {
      // Residential mode (ADR 0099): verify egress does NOT transit tailscale0
      // and that the default route uses standard container ethernet (dev eth0).
      const { stdout: effective } = await execFileAsync("ip", [
        "route",
        "get",
        CONTROLLED_DESTINATION,
      ]);
      if (effective.includes("dev tailscale0")) {
        return false;
      }
      return effective.includes("dev eth0");
    } else {
      // Relay mode (ADR 0084):
      // 1. Inspect policy routing in table 52 where Tailscale installs exit-node routes (ADR 0004)
      const { stdout: table52 } = await execFileAsync("ip", ["route", "show", "table", "52"]);
      if (!table52.includes("dev tailscale0")) {
        return false;
      }
      // 2. Inspect effective route to a controlled destination via kernel policy routing FIB
      const { stdout: effective } = await execFileAsync("ip", [
        "route",
        "get",
        CONTROLLED_DESTINATION,
      ]);
      return effective.includes("dev tailscale0");
    }
  } catch {
    return false;
  }
}

const isCiOrSkip = process.env.SEATFIRST_ENV === "ci" || process.env.SKIP_EGRESS_VERIFY === "true";
let isEgressReady = isCiOrSkip;
let isWorkerReady = false;
let shuttingDown = false;

const server = await startReadinessServer({ port: READINESS_PORT });

function updateReadiness() {
  const ready = !shuttingDown && isEgressReady && isWorkerReady;
  server.setReady?.(ready);
}

const expectedEgress = process.env.EGRESS_IDENTITY_LABEL;

async function verifyEgressReadiness(env) {
  if (isCiOrSkip) {
    isEgressReady = true;
    return;
  }
  if (!expectedEgress || expectedEgress === "replace-me-relay-eip") {
    throw new Error(
      "EGRESS_IDENTITY_LABEL is not set to a valid IP; refusing to start fetch-worker (fail-closed)",
    );
  }
  const timeoutMs = Number(env.EGRESS_VERIFY_TIMEOUT_MS || 15000);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const routeOk = await checkEgressRouteLinux();
      if (!routeOk) {
        lastError = new Error(
          egressMode === "residential"
            ? `Linux route to ${CONTROLLED_DESTINATION} does not route via eth0 or transits tailscale0`
            : `Linux policy routing table 52 or effective route to ${CONTROLLED_DESTINATION} does not route via dev tailscale0`,
        );
      } else {
        const res = await fetch("https://checkip.amazonaws.com", {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text === expectedEgress) {
            process.stdout.write(
              `fetch-worker egress verified: ${text} matches EGRESS_IDENTITY_LABEL\n`,
            );
            isEgressReady = true;
            return;
          } else {
            lastError = new Error(`Egress IP mismatch: got ${text}, expected ${expectedEgress}`);
          }
        } else {
          lastError = new Error(`checkip returned HTTP ${res.status}`);
        }
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `fetch-worker failed egress route readiness verification within ${timeoutMs}ms: ${lastError?.message || "unknown error"}`,
  );
}

await verifyEgressReadiness(process.env);
const worker = await startFetchWorker(process.env);
isWorkerReady = typeof worker.isReady === "function" ? worker.isReady() : true;
worker.onReadinessChange?.((ready) => {
  isWorkerReady = ready;
  updateReadiness();
});
updateReadiness();

let egressInterval = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_PROBE_FAILURES = 3;
let isPaused = false;

if (!isCiOrSkip) {
  const probeIntervalMs = Number(process.env.EGRESS_PROBE_INTERVAL_MS || 10000);
  egressInterval = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const routeOk = await checkEgressRouteLinux();
      if (!routeOk) {
        process.stderr.write(
          egressMode === "residential"
            ? "FATAL: egress boundary lost! Route does not route via eth0 or unexpectedly transits tailscale0. Failing closed.\n"
            : "FATAL: egress boundary lost! Route tailscale0 missing from policy routing table 52 or effective route. Failing closed.\n",
        );
        if (!isPaused) {
          isPaused = true;
          await worker.pause?.().catch(() => {});
        }
        isEgressReady = false;
        updateReadiness();
        await worker.close().catch(() => {});
        process.exit(1);
      }

      const res = await fetch("https://checkip.amazonaws.com", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text === expectedEgress) {
          consecutiveFailures = 0;
          if (isPaused) {
            isPaused = false;
            await worker.resume?.().catch(() => {});
          }
          if (!isEgressReady) {
            isEgressReady = true;
            updateReadiness();
          }
        } else {
          process.stderr.write(
            `FATAL: egress boundary breach! checkip returned ${text}, expected ${expectedEgress}\n`,
          );
          await worker.close().catch(() => {});
          process.exit(1);
        }
      } else {
        consecutiveFailures++;
        if (!isPaused) {
          isPaused = true;
          await worker.pause?.().catch(() => {});
        }
        if (isEgressReady) {
          isEgressReady = false;
          updateReadiness();
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
          process.stderr.write(
            `FATAL: egress verification probe failed repeatedly (${consecutiveFailures} attempts). Failing closed.\n`,
          );
          await worker.close().catch(() => {});
          process.exit(1);
        }
      }
    } catch {
      consecutiveFailures++;
      if (!isPaused) {
        isPaused = true;
        await worker.pause?.().catch(() => {});
      }
      if (isEgressReady) {
        isEgressReady = false;
        updateReadiness();
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
        process.stderr.write(
          `FATAL: egress verification probe failed repeatedly (${consecutiveFailures} attempts). Failing closed.\n`,
        );
        await worker.close().catch(() => {});
        process.exit(1);
      }
    }
  }, probeIntervalMs);
  egressInterval.unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (egressInterval) {
      clearInterval(egressInterval);
      egressInterval = null;
    }
    updateReadiness();
    void Promise.resolve()
      .then(() => worker.close())
      .then(() => server.close())
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`shutdown on ${signal} failed: ${String(error)}\n`);
        process.exit(1);
      });
  });
}
