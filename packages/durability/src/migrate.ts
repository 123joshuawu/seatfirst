import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Queryable } from "./invariants.js";

/**
 * Hand-rolled migration runner — ADR 0005 §G (option C) and its 2026-08-29 amendment.
 *
 * ADR 0005 §G bans `Prisma`, `Drizzle-migrate` and `node-pg-migrate` by name; this
 * `~60`-line ledger + advisory-lock addition to the existing hand-rolled runner is the
 * entire migration system. `packages/durability/migrations/001..018_*.sql` are the
 * source of SQL truth; `MIGRATIONS` is the source of truth for order
 * (`test/tier0.schema.test.ts:54` asserts every file on disk is listed).
 *
 * Design (option C — authorized by the repo owner in this session as an amendment to
 * ADR 0005 §G):
 *  - A ledger table `schema_migration` (`SCHEMA_MIGRATION_TABLE`) records names only
 *    (no `checksum`/`hash` column — whether files may be edited after landing is an
 *    UNWRITTEN policy, so the runner does not decide it). Created by the runner, never
 *    by a numbered migration file. Ledger DDL is the exact string from the batch
 *    Contract:
 *      `CREATE TABLE IF NOT EXISTS schema_migration (`
 *      `  name       text PRIMARY KEY,`
 *      `  applied_at timestamptz NOT NULL DEFAULT now()`
 *      `);`
 *  - An advisory lock `SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)`
 *    (and matching `pg_advisory_unlock`) serializes concurrent `applyMigrations` runs
 *    on separate connections. The lock is session-scoped, so `applyMigrations` MUST be
 *    called on a single dedicated connection — the same `Queryable` that took the lock
 *    must run every `BEGIN`/`COMMIT` and `INSERT` (`src/pool.ts:110-133` `migrate(pool)`
 *    checks one `PoolClient` out; `test/support/global-setup.ts:54-61`,
 *    `test/tier0.schema.test.ts:37` and `apps/server/test/support/db.ts:16-24` use a
 *    single `pg.Client`). The `Queryable` param is intentionally not the branded
 *    `TransactionClient` (`src/transactions.ts:47`) — that brand is module-private to
 *    `pool.ts` and test `Client`s cannot satisfy it — so the single-connection
 *    precondition is documented here, not enforced by the type.
 *  - `applyMigrations` applies only pending files, each as one multi-statement
 *    transaction (`BEGIN`, the file's SQL as one `db.query`, parameterized
 *    `INSERT INTO schema_migration (name) VALUES ($1)`, `COMMIT` — ADR 0005 §G
 *    "each applied as one multi-statement transaction"; never collapsed into one
 *    transaction spanning all files).
 *  - A one-shot `migrate` init service (`docker-compose.dev.yml:111-121`,
 *    private-prod `migrate` (docker-compose.prod.yml, not shipped here), `src/migrate-cli.ts`) runs `applyMigrations` to
 *    completion before long-lived services start, in dev and prod.
 *  - Every long-lived process verifies at boot via `verifySchemaVersion`
 *    (`apps/server/src/index.ts` role dispatcher, `apps/server/src/fetch-worker/entrypoint.ts`).
 */

/** Ledger table name. Created by the runner, never by a numbered migration file. */
export const SCHEMA_MIGRATION_TABLE = "schema_migration";

/** Thrown by verifySchemaVersion when the database is behind this binary. */
export class SchemaVersionError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[], message?: string) {
    super(message ?? `schema version mismatch: missing migrations: ${missing.join(", ")}`);
    this.name = "SchemaVersionError";
    this.missing = missing;
  }
}

/** Ordered migration filenames. Adding one here is what makes tier 0 apply it. */
export const MIGRATIONS: readonly string[] = [
  "001_schema.sql",
  "002_partitions.sql",
  "003_catalog.sql",
  "004_session.sql",
  "005_cost_ledger.sql",
  "006_retention.sql",
  "007_recheck_run_kind.sql",
  "008_cancelled_status.sql",
  "009_movie_catalog.sql",
  "010_catalogue_crawl_state.sql",
  "011_tmdb_movie.sql",
  "012_tmdb_fetch_outbox.sql",
  "013_recurring_window_search_admission.sql",
  "014_theatre_city.sql",
  "015_outbox_traceparent.sql",
  "016_provider_run_dispatch_rank.sql",
  "017_search_batch_deferred_count.sql",
  "018_search_continues_id.sql",
  "019_tmdb_movie_runtime_genre.sql",
  "020_performance_price_currency_basis.sql",
  "021_search_aggregate_evidence.sql",
  "022_retention_least_privilege.sql",
  "023_restore_sentinel.sql",
  "024_retire_restore_sentinel.sql",
  "025_tmdb_movie_slate_release.sql",
  "026_diagnostic_capture.sql",
  "027_amc_movie_catalogue.sql",
];

/**
 * Directory holding the `.sql` files. Resolved from this module rather than from cwd so
 * the same path works from `src/` under vitest and from `dist/` after a build.
 */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot =
    basename(dirname(here)) === "dist" ? join(here, "..", "..") : join(here, "..");
  return join(packageRoot, "migrations");
}

export async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const dir = migrationsDir();
  return Promise.all(
    MIGRATIONS.map(async (name) => ({ name, sql: await readFile(join(dir, name), "utf8") })),
  );
}

/** Ledger table DDL — exact string from the batch Contract. */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

/** Advisory lock — exact expression from the batch Contract (session-scoped). */
const ADVISORY_LOCK_SQL = `SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)`;

/** Advisory unlock — exact expression from the batch Contract. */
const ADVISORY_UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('seatfirst.schema_migration')::bigint)`;

/**
 * Names recorded in the ledger. Throws if the ledger table does not exist.
 *
 * Implemented as a single `SELECT` so a missing table surfaces as the native
 * `relation "schema_migration" does not exist` error — the caller can
 * distinguish a never-migrated database from an empty ledger.
 */
export async function appliedMigrations(db: Queryable): Promise<readonly string[]> {
  const result = await db.query(`SELECT name FROM ${SCHEMA_MIGRATION_TABLE} ORDER BY name`);
  return result.rows.map((row) => (row as { name: string }).name);
}

/**
 * Applies ONLY pending files, recording each in the ledger. Returns names applied.
 *
 * Single-connection precondition: the advisory lock
 * `SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)` is
 * session-scoped. The same `Queryable` that acquires the lock must run every
 * subsequent `BEGIN`/`COMMIT`/`INSERT`. Callers MUST pass a single dedicated
 * connection (`pg.Client` via `src/pool.ts:110-133` or `test/support/pg.ts:42`
 * `session(client)`), never a bare `Pool` — `Pool.query` may use a different
 * backend per call and would break the lock's guarantee. The `Queryable` type
 * is intentionally not `TransactionClient` (`src/transactions.ts:47` brand is
 * module-private to `pool.ts`).
 *
 * Each pending file is applied as one multi-statement transaction per
 * ADR 0005 §G: `BEGIN`, the file's SQL as one `db.query` (unchanged), a
 * parameterized `INSERT INTO schema_migration (name) VALUES ($1)`, `COMMIT`.
 * On failure `ROLLBACK` and rethrow wrapped as `migration ${name} failed to
 * apply` with `cause` preserved (same wrapping as before the ledger).
 */
export async function applyMigrations(db: Queryable): Promise<readonly string[]> {
  // a. Ensure ledger — `CREATE TABLE IF NOT EXISTS` is the exact DDL from the
  // batch Contract. Two concurrent `applyMigrations` on an empty DB can race
  // here and Postgres may throw `duplicate key` on `pg_type_typname_nsp_index`
  // even with `IF NOT EXISTS` (known behavior). If the table now exists, the
  // race is benign — ignore and proceed to the advisory lock.
  try {
    await db.query(LEDGER_DDL);
  } catch (error) {
    const probe = await db.query(`SELECT to_regclass('public.schema_migration') AS reg`);
    if ((probe.rows[0] as { reg: string | null }).reg === null) throw error;
  }
  await db.query(ADVISORY_LOCK_SQL);
  try {
    // Re-ensure inside the lock — now serialized, so no race, and we are
    // guaranteed the ledger exists before reading `appliedMigrations`.
    await db.query(LEDGER_DDL);
    const appliedSet = new Set(await appliedMigrations(db));
    const all = await readMigrations();
    const pending = all.filter(({ name }) => !appliedSet.has(name));
    const appliedNames: string[] = [];
    for (const { name, sql } of pending) {
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query(`INSERT INTO ${SCHEMA_MIGRATION_TABLE} (name) VALUES ($1)`, [name]);
        await db.query("COMMIT");
      } catch (cause) {
        try {
          await db.query("ROLLBACK");
        } catch {
          // Preserve the migration-body error; ROLLBACK failure is not actionable here.
        }
        throw new Error(`migration ${name} failed to apply`, { cause });
      }
      appliedNames.push(name);
    }
    return appliedNames;
  } finally {
    try {
      await db.query(ADVISORY_UNLOCK_SQL);
    } catch {
      // Unlock is best-effort: the session ends on `pool.end()` / `client.end()` anyway.
    }
  }
}

/**
 * Records every `MIGRATIONS` entry as applied WITHOUT running it. Returns names
 * newly recorded.
 *
 * Guarded: refuses with a clear error if the database looks EMPTY (probe for the
 * `search` table via `to_regclass('public.search')`) — an empty database must
 * be migrated, never baselined, and baselining one would permanently skip all
 * 19 files.
 *
 * Each name is inserted as `INSERT INTO schema_migration (name) VALUES ($1)
 * ON CONFLICT (name) DO NOTHING` — idempotent, so a second baseline on the same
 * database inserts nothing and returns an empty array.
 */
export async function baselineMigrations(db: Queryable): Promise<readonly string[]> {
  try {
    await db.query(LEDGER_DDL);
  } catch (error) {
    const p = await db.query(`SELECT to_regclass('public.schema_migration') AS reg`);
    if ((p.rows[0] as { reg: string | null }).reg === null) throw error;
  }
  // Guard: an empty database has no `search` relation; baselining it would
  // permanently skip every migration, so refuse and tell the operator to migrate.
  const probe = await db.query(`SELECT to_regclass('public.search') AS reg`);
  const reg = (probe.rows[0] as { reg: string | null }).reg;
  if (reg === null) {
    throw new Error(
      "cannot baseline an empty database — run migrations instead; baselining an empty database would permanently skip all migrations",
    );
  }
  await db.query(ADVISORY_LOCK_SQL);
  try {
    await db.query(LEDGER_DDL);
    const newly: string[] = [];
    for (const name of MIGRATIONS) {
      const result = await db.query(
        `INSERT INTO ${SCHEMA_MIGRATION_TABLE} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name`,
        [name],
      );
      if (result.rows.length > 0) newly.push(name);
    }
    return newly;
  } finally {
    try {
      await db.query(ADVISORY_UNLOCK_SQL);
    } catch {
      // Best-effort unlock, same rationale as in `applyMigrations`.
    }
  }
}

/**
 * Resolves if every `MIGRATIONS` entry is in the ledger; else throws
 * `SchemaVersionError`.
 *
 * - If the ledger table itself is absent, throws `SchemaVersionError` with a
 *   message telling the operator to run the migrate step (`--baseline` for a
 *   pre-existing database — one that already has application tables but has
 *   never had the ledger).
 * - If any `MIGRATIONS` entry is absent, throws `SchemaVersionError` with
 *   `missing` listing exactly those names, in `MIGRATIONS` order.
 * - Extra ledger rows are ALLOWED and must not error — that is precisely the
 *   rollback case, where an older image runs against a newer schema. Rollback
 *   (`.github/workflows/rollback.yml:73` re-pulls the previous tag and runs
 *   `up -d app fetch-worker`) restores code but never reverses schema, so a
 *   ledger entry unknown to this binary is expected and must not be treated as
 *   drift.
 */
export async function verifySchemaVersion(db: Queryable): Promise<void> {
  const probe = await db.query(`SELECT to_regclass('public.schema_migration') AS reg`);
  const reg = (probe.rows[0] as { reg: string | null }).reg;
  if (reg === null) {
    throw new SchemaVersionError(
      [...MIGRATIONS],
      `schema_migration ledger is missing — run the migrate step (use --baseline for a pre-existing database that already has tables)`,
    );
  }
  const applied = await appliedMigrations(db);
  const appliedSet = new Set(applied);
  const missing = MIGRATIONS.filter((name) => !appliedSet.has(name));
  if (missing.length > 0) {
    throw new SchemaVersionError(
      missing,
      `database schema is behind this binary — missing migrations: ${missing.join(", ")} — run the migrate step`,
    );
  }
  // Extra ledger rows are fine: rollback case (`.github/workflows/rollback.yml:73`).
}
