import { Client } from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import {
  MIGRATIONS,
  SCHEMA_MIGRATION_TABLE,
  SchemaVersionError,
  appliedMigrations,
  applyMigrations,
  baselineMigrations,
  verifySchemaVersion,
} from "../src/migrate.js";

/**
 * Tier 0 — ledger + advisory lock (ADR 0005 §G option C, amendment 2026-08-29).
 *
 * The hand-rolled runner previously replayed every file (`src/migrate.ts:52-60` before
 * the ledger). 18 of 20 files fail on a second `CREATE TABLE`/`ADD COLUMN`, so a live
 * database cannot be migrated by replay — it must be baselined once and thereafter
 * apply only pending files. This tier proves the ledger and lock actually hold:
 *
 *  - `applyMigrations` on an empty DB applies all 20 and records 20 ledger rows
 *  - a second `applyMigrations` on the same DB applies zero and throws nothing
 *  - pending-only: deleting the last ledger row makes the next run apply exactly that
 *    one file (advisory lock + per-file `BEGIN`/`COMMIT`, `src/migrate.ts`)
 *  - `verifySchemaVersion` is one-directional: every `MIGRATIONS` entry must be in the
 *    ledger; extra rows are allowed (rollback, `.github/workflows/rollback.yml:73`)
 *  - `baselineMigrations` refuses on an empty DB and records all names on a migrated
 *    one (`to_regclass('public.search')` guard)
 *  - two concurrent `applyMigrations` on separate connections serialize via
 *    `SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)`
 *    and neither throws a duplicate-object error
 *
 * Follows the fresh-empty-database pattern from `test/tier0.schema.test.ts:26-56` and
 * `test/tier2.repository.test.ts:197-221`, and the template-clone helpers in
 * `test/support/pg.ts` / `test/support/global-setup.ts` (real Postgres via
 * testcontainers, `inject("adminUrl")`).
 */

const empties: string[] = [];

afterAll(async () => {
  if (empties.length === 0) return;
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  for (const name of empties) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await admin.end();
});

async function createEmptyDatabase(): Promise<{ name: string; url: string; client: Client }> {
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  const name = `ledger_${process.pid}_${empties.length}_${Date.now()}`;
  empties.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(inject("adminUrl"));
  url.pathname = `/${name}`;
  const href = url.toString();
  const client = new Client({ connectionString: href });
  await client.connect();
  return { name, url: href, client };
}

describe("tier 0 — ledger: first apply records all", () => {
  it("first apply on empty DB applies all 29 and records 29 ledger rows", async () => {
    const { client } = await createEmptyDatabase();
    try {
      const applied = await applyMigrations(client);
      expect(applied).toEqual([...MIGRATIONS]);
      expect(applied).toHaveLength(29);

      const ledger = await appliedMigrations(client);
      expect(ledger).toHaveLength(29);
      expect(new Set(ledger)).toEqual(new Set(MIGRATIONS));

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA_MIGRATION_TABLE}`,
      );
      expect(rows[0].n).toBe(29);
    } finally {
      await client.end();
    }
  });

  it("second apply on same DB applies zero and throws nothing", async () => {
    const { client } = await createEmptyDatabase();
    try {
      const first = await applyMigrations(client);
      expect(first).toHaveLength(29);

      const second = await applyMigrations(client);
      expect(second).toEqual([]);
      expect(second).toHaveLength(0);

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA_MIGRATION_TABLE}`,
      );
      expect(rows[0].n).toBe(29);
    } finally {
      await client.end();
    }
  });

  it("pending-only: deleting a ledger row makes next run apply exactly that one file", async () => {
    const { client } = await createEmptyDatabase();
    try {
      const first = await applyMigrations(client);
      expect(first).toHaveLength(29);
      // Anchored to 028 by name, not "the last migration" — 028's ADD COLUMN IF NOT
      // EXISTS / DROP CONSTRAINT IF EXISTS+ADD CONSTRAINT / CREATE UNIQUE INDEX IF NOT
      // EXISTS are all idempotent, unlike most migrations (023 needs a pre-revert; 029
      // is a plain unguarded ADD COLUMN like most others), so it is safe to re-apply
      // over its own already-materialized effects. Deleting the ledger row is
      // sufficient to make the pending-only property observable regardless of which
      // migration is picked, since `pending` is computed by ledger membership, not
      // file position (`src/migrate.ts`).
      const target = MIGRATIONS.find((name) => name.startsWith("028_"))!;
      await client.query(`DELETE FROM ${SCHEMA_MIGRATION_TABLE} WHERE name = $1`, [target]);

      const ledgerBefore = await appliedMigrations(client);
      expect(ledgerBefore).toHaveLength(28);
      expect(ledgerBefore).not.toContain(target);

      const second = await applyMigrations(client);
      expect(second).toEqual([target]);

      const ledgerAfter = await appliedMigrations(client);
      expect(ledgerAfter).toHaveLength(29);
      expect(new Set(ledgerAfter)).toEqual(new Set(MIGRATIONS));

      // 028 re-ran as a guarded no-op: the movie-schedule run_key columns/constraints
      // it (re)adds are still exactly there, and the guarded DROP CONSTRAINT/ADD COLUMN
      // IF NOT EXISTS it re-issues stay no-ops.
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'run_key' AND column_name = 'movie_slug'`,
      );
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual(["movie_slug"]);
    } finally {
      await client.end();
    }
  });
});

describe("tier 0 — ledger: verifySchemaVersion", () => {
  it("resolves on a migrated DB", async () => {
    const { client } = await createEmptyDatabase();
    try {
      await applyMigrations(client);
      await expect(verifySchemaVersion(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  it("throws SchemaVersionError naming missing file when a ledger row is removed", async () => {
    const { client } = await createEmptyDatabase();
    try {
      await applyMigrations(client);
      const victim = MIGRATIONS[5]!; // arbitrary, 006_retention.sql
      await client.query(`DELETE FROM ${SCHEMA_MIGRATION_TABLE} WHERE name = $1`, [victim]);

      await expect(verifySchemaVersion(client)).rejects.toThrow(SchemaVersionError);
      try {
        await verifySchemaVersion(client);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaVersionError);
        const e = error as SchemaVersionError;
        expect(e.missing).toContain(victim);
        expect(e.missing).toEqual(expect.arrayContaining([victim]));
        expect(e.message).toMatch(/missing/i);
      }
    } finally {
      await client.end();
    }
  });

  it("resolves when an extra unknown ledger row is present (rollback case)", async () => {
    const { client } = await createEmptyDatabase();
    try {
      await applyMigrations(client);
      // Rollback (`.github/workflows/rollback.yml:73`) restores previous-tag code
      // but never reverses schema — an older binary sees a newer ledger entry.
      // Extra rows must not be treated as drift.
      await client.query(`INSERT INTO ${SCHEMA_MIGRATION_TABLE} (name) VALUES ($1)`, [
        "999_future.sql",
      ]);

      await expect(verifySchemaVersion(client)).resolves.toBeUndefined();

      const ledger = await appliedMigrations(client);
      expect(ledger).toContain("999_future.sql");
      expect(ledger).toHaveLength(30);
    } finally {
      await client.end();
    }
  });

  it("throws SchemaVersionError telling operator to run migrate --baseline when ledger is missing", async () => {
    const { client } = await createEmptyDatabase();
    try {
      // Empty DB has no ledger table at all (we have not run applyMigrations).
      await expect(verifySchemaVersion(client)).rejects.toThrow(SchemaVersionError);
      try {
        await verifySchemaVersion(client);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaVersionError);
        const e = error as SchemaVersionError;
        expect(e.missing).toEqual([...MIGRATIONS]);
        expect(e.message).toMatch(/--baseline/);
        expect(e.message).toMatch(/migrate/i);
      }
    } finally {
      await client.end();
    }
  });
});

describe("tier 0 — ledger: baseline", () => {
  it("refuses on an empty database (to_regclass probe)", async () => {
    const { client } = await createEmptyDatabase();
    try {
      await expect(baselineMigrations(client)).rejects.toThrow(/empty database/i);
      // Ledger was created by baseline's ensure step, but no names should be recorded
      // because the guard threw before inserts. An empty DB must be migrated, never
      // baselined, otherwise all 29 files would be permanently skipped.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA_MIGRATION_TABLE}`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("records all names on a migrated DB (ledger cleared, then baselined)", async () => {
    const { client } = await createEmptyDatabase();
    try {
      await applyMigrations(client);
      // Simulate a pre-ledger production database: tables exist but ledger is empty.
      await client.query(`DELETE FROM ${SCHEMA_MIGRATION_TABLE}`);
      const before = await appliedMigrations(client);
      expect(before).toHaveLength(0);
      const recorded = await baselineMigrations(client);
      expect(recorded).toHaveLength(29);
      expect(new Set(recorded)).toEqual(new Set(MIGRATIONS));
      const after = await appliedMigrations(client);
      expect(after).toHaveLength(29);
      expect(new Set(after)).toEqual(new Set(MIGRATIONS));

      // Idempotent second baseline inserts nothing.
      const second = await baselineMigrations(client);
      expect(second).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("tier 0 — ledger: concurrent apply serializes via advisory lock", () => {
  it("two concurrent applyMigrations on separate connections both settle without duplicate-object error", async () => {
    const { url, client: seed } = await createEmptyDatabase();
    // Keep the seed connection open just to hold the DB, but use two fresh
    // connections for the concurrent applies — the lock is session-scoped, so
    // each `applyMigrations` must be on its own backend.
    const c1 = new Client({ connectionString: url });
    const c2 = new Client({ connectionString: url });
    await c1.connect();
    await c2.connect();
    // Seed connection is no longer needed after we have two workers; close it
    // so it does not hold an idle lock.
    await seed.end();
    try {
      const p1 = applyMigrations(c1);
      const p2 = applyMigrations(c2);
      const results = await Promise.all([p1, p2]);

      // Both must have settled without throwing "already exists" / "duplicate"
      // errors — the advisory lock serializes the two runs.
      expect(results).toHaveLength(2);
      const combined = [...results[0], ...results[1]];
      expect(combined).toHaveLength(29);
      expect(new Set(combined)).toEqual(new Set(MIGRATIONS));
      // Exactly one of the two did the work; the other saw zero pending.
      expect([results[0].length, results[1].length].sort()).toEqual([0, 29]);

      const { rows } = await c1.query(`SELECT count(*)::int AS n FROM ${SCHEMA_MIGRATION_TABLE}`);
      expect(rows[0].n).toBe(29);
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });
});
