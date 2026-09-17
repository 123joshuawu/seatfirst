/**
 * Local-dev-backend migration CLI (`dev/README.md:111-125`). A thin wrapper around this
 * package's own `migrate()`/`baseline()` (`pool.ts` — each applies on one checked-out
 * connection, because `src/migrate.ts`'s advisory lock
 * `SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)` is
 * session-scoped), so `docker-compose.dev.yml:111-121`'s one-shot `migrate` service and the
 * private-prod `migrate` init service (docker-compose.prod.yml, ADR 0005 §G — neither shipped here) have
 * something to run without reaching into `test/`. Not part of the package's public
 * `exports` — invoked directly as `node dist/src/migrate-cli.js [flag]`, same convention
 * as any other repo-internal CLI script.
 *
 * `DATABASE_URL` is the only input; pool sizing is irrelevant for a one-shot single-command
 * run, so it is fixed at one connection rather than exposed as another operator-supplied
 * tunable (unlike every long-lived pool elsewhere in this codebase, gate 14 does not apply
 * here — there is no policy decision being defaulted, just a CLI that opens one connection).
 *
 * Flags (from the batch Contract):
 *  - no flag       → `applyMigrations` (pending only), print applied names or
 *                    `no pending migrations`
 *  - `--baseline`  → `baselineMigrations` (record all as applied without running)
 *  - `--verify`    → `verifySchemaVersion` only, exit `0`/`1`
 *  - unknown flag  → usage to stderr, exit `64`
 */
import type { Pool } from "pg";

import { SchemaVersionError, verifySchemaVersion } from "./migrate.js";
import { baseline, createPool, migrate } from "./pool.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (args.length > 1 || (flag !== undefined && flag !== "--baseline" && flag !== "--verify")) {
    process.stderr.write(`Usage: node dist/src/migrate-cli.js [--baseline|--verify]\n`);
    process.exitCode = 64;
    return;
  }

  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    process.stderr.write("DATABASE_URL is required\n");
    process.exitCode = 64;
    return;
  }

  const pool: Pool = createPool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
  });

  try {
    if (flag === "--baseline") {
      const recorded = await baseline(pool);
      if (recorded.length === 0) {
        process.stdout.write("no pending migrations\n");
      } else {
        process.stdout.write(`migrations baselined: ${recorded.join(", ")}\n`);
      }
      return;
    }

    if (flag === "--verify") {
      // `verifySchemaVersion` needs a single connection for its probe, so checkout
      // one client rather than using the pool's autocommit path.
      const client = await pool.connect();
      try {
        const sqlClient = {
          async query(text: string, values?: readonly unknown[]) {
            const result = await client.query(text, values as unknown[]);
            return { rows: result.rows as unknown[] };
          },
        };
        await verifySchemaVersion(sqlClient);
      } finally {
        client.release();
      }
      process.stdout.write("schema version verified\n");
      return;
    }

    const applied = await migrate(pool);
    if (applied.length === 0) {
      process.stdout.write("no pending migrations\n");
    } else {
      process.stdout.write(`migrations applied: ${applied.join(", ")}\n`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  // `verify` failures already set exitCode/printed above when handled; this is the
  // catch-all for unexpected errors (connection failure, migration failure, etc.).
  if (error instanceof SchemaVersionError) {
    process.stderr.write(`schema version mismatch: ${error.message}\n`);
    if (error.missing.length > 0) {
      process.stderr.write(`missing: ${error.missing.join(", ")}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`migrate-cli failed: ${String(error)}\n`);
  process.exit(1);
});
