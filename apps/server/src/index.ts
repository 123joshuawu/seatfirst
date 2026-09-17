/**
 * Server entrypoint (S28): the role dispatcher that starts one of the four Chrome-free
 * processes from the single Node image. `Dockerfile.app`'s `CMD` is `node dist/index.js`
 * with no role argument; the home-machine Compose stack selects the role per service via
 * `command: ["node", "dist/index.js", "<role>"]` — "one image, four commands".
 *
 * Roles (all Chrome-free — none imports `playwright-core` or `@seatfirst/browser-runtime`):
 *   api      — Fastify + tRPC API (app-config.ts: appConfigFromEnv + startApp)
 *   relay    — outbox → BullMQ relay daemon (relay/entrypoint.ts)
 *   sweeper  — periodic reconciliation + projection loop (sweeper/entry.ts)
 *   tmdb     — TMDB metadata fetch worker (tmdb/entrypoint.ts)
 *
 * The Chrome-bearing processes — `dispatch`'s RUN-kind workers and S26's catalogue-crawl
 * tick loop — are deliberately NOT roles here; they belong to the fetch-worker image
 * (`infra/docker/fetch-worker/entrypoint.mjs`), a separate named follow-up (S28's
 * "Related, out of scope").
 *
 * A missing or unknown role is a usage error: the valid list goes to stderr and the
 * process exits 64 (`EX_USAGE`), failing loudly rather than silently doing nothing (the
 * pre-S28 placeholder behaviour).
 */

type Role = "api" | "relay" | "sweeper" | "tmdb";

const ROLES: readonly Role[] = ["api", "relay", "sweeper", "tmdb"];

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === undefined || !ROLES.includes(arg as Role)) {
    process.stderr.write(
      `usage: node dist/index.js <role>\n` +
        `role must be one of: ${ROLES.join(", ")}\n` +
        `(got ${arg === undefined ? "no argument" : JSON.stringify(arg)})\n`,
    );
    process.exitCode = 64;
    return;
  }

  // O8.2 — register the pg auto-instrumentation BEFORE any role module is imported.
  // Every role's import graph evaluates `pg` (via @seatfirst/durability or a direct pg
  // import) at static-import time, and instrumentation registered after that evaluation
  // produces no spans (proven both directions by the O8 ordering test). The full OTel
  // bootstrap still happens inside each role's start body; this only front-runs the
  // once-per-process patch registration.
  const { ensurePgInstrumented } = await import("@seatfirst/config/otel-bootstrap");
  ensurePgInstrumented();
  // Schema-version gate (ADR 0005 §G, option C): verify every migration this binary
  // expects is already recorded in the `schema_migration` ledger before any role
  // starts. Uses a one-shot single-connection pool fixed at one connection — pool
  // sizing is not an operator-supplied tunable here (gate 14 does not apply, same
  // justification as `packages/durability/src/migrate-cli.ts:12-15`: there is no
  // policy decision being defaulted, just a check that opens one connection).
  // Dynamic `await import("@seatfirst/durability")` is required: `pg` must not be
  // evaluated before `ensurePgInstrumented()` runs, or O8's tracing produces no
  // spans (proven both directions by the existing O8 ordering test). A static
  // top-of-file import of `@seatfirst/durability` would evaluate `pg` too early —
  // that package imports `pg` at static-import time.
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    process.stderr.write("DATABASE_URL is required\n");
    process.exitCode = 64;
    return;
  }
  {
    const { createPool, verifySchemaVersion, SchemaVersionError } =
      await import("@seatfirst/durability");
    const pool = createPool({
      connectionString: databaseUrl,
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 30_000,
    });
    try {
      await verifySchemaVersion(pool);
    } catch (error: unknown) {
      if (error instanceof SchemaVersionError) {
        process.stderr.write(
          `schema version check failed: missing migrations: ${error.missing.join(", ")}\n` +
            `run the migrate service first\n`,
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    } finally {
      await pool.end();
    }
  }

  switch (arg as Role) {
    case "api": {
      const { appConfigFromEnv, startApp } = await import("./app-config.js");
      const handle = await startApp(appConfigFromEnv(process.env));
      installSignalHandlers(() => handle.close());
      return;
    }
    case "relay": {
      const { relayConfigFromEnv, startRelayDaemon } = await import("./relay/entrypoint.js");
      const handle = await startRelayDaemon({ config: relayConfigFromEnv(process.env) });
      installSignalHandlers(() => handle.close());
      return;
    }
    case "sweeper": {
      const { createSweeper, sweeperConfigFromEnv } = await import("./sweeper/entry.js");
      const handle = createSweeper(sweeperConfigFromEnv(process.env));
      installSignalHandlers(() => handle.stop());
      return;
    }
    case "tmdb": {
      const { tmdbWorkerConfigFromEnv, startTmdbWorker } = await import("./tmdb/entrypoint.js");
      const handle = startTmdbWorker(tmdbWorkerConfigFromEnv(process.env));
      installSignalHandlers(() => handle.close());
      return;
    }
  }
}

/**
 * S28.4 — one shared SIGINT/SIGTERM handler for every role. The dispatcher normalizes each
 * role's shutdown surface to a single `close: () => Promise<void>` and installs the handler
 * once. A second signal during shutdown is ignored (no double-close).
 */
function installSignalHandlers(close: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void Promise.resolve()
      .then(close)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`shutdown on ${signal} failed: ${String(error)}\n`);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`fatal startup error: ${String(error)}\n`);
  process.exit(1);
});
