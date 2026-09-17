import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";

import { checkInvariants, formatViolations } from "../../src/invariants.js";
import type { TransactionClient } from "../../src/transactions.js";

/**
 * Template-database isolation (docs/durability-harness-plan.md, "Infrastructure
 * decisions"): migrations are applied once into `durability_base` by the global setup and
 * every test clones it. A clone is milliseconds, so per-test isolation stays affordable
 * and tests never share state.
 */

/**
 * Extends `TransactionClient` (`src/transactions.ts`), not a bare re-declaration of its
 * brand — this is truthful, not a workaround: `useDatabase()`'s `db()` and `session(client)`
 * below are each backed by exactly one dedicated `pg.Client`, the same single-connection
 * guarantee the brand asserts in `src/`. Extending the real type (rather than declaring a
 * second, distinct `unique symbol`) is what lets a value produced here be passed directly to
 * `acceptFetch`/`failRun`/`terminalize`/`sweepFailExhaustedJobs`/`sweepFailExhaustedRuns`.
 */
export interface SqlClient extends TransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  /** Exactly one row, or throw with the statement that produced the wrong count. */
  one<T = any>(text: string, values?: readonly unknown[]): Promise<T>;
  rows<T = any>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface Db extends SqlClient {
  readonly name: string;
  readonly url: string;
  /** A second connection to the same database, for the two-connection interleaving tiers. */
  connect(): Promise<Client>;
  close(): Promise<void>;
}

/**
 * Give a dedicated pg connection the same small query surface used by scenario fixtures.
 * `client` is one `pg.Client`, never a pool, so the returned value truthfully carries the
 * single-connection brand — the cast supplies the `[tx]` marker no object literal can name.
 */
export function session(client: Client): SqlClient {
  return {
    query: (text, values) =>
      client
        .query(text, values as unknown[])
        .then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })),
    async one(text, values) {
      const r = await client.query(text, values as unknown[]);
      if (r.rows.length !== 1) {
        throw new Error(`expected exactly 1 row, got ${r.rows.length}, from:\n${text}`);
      }
      return r.rows[0];
    },
    async rows(text, values) {
      return (await client.query(text, values as unknown[])).rows;
    },
  } as SqlClient;
}

/**
 * Crash injection is a real backend termination, not a ROLLBACK masquerading as one.
 * The surviving connection issues the kill; the target's open transaction is then gone.
 */
export async function terminateConnection(db: SqlClient, client: Client): Promise<void> {
  const target = session(client);
  const { pid } = await target.one<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);

  // pg emits an error event when another backend kills this socket. Consume that expected
  // event so it does not become an unhandled EventEmitter error in the test process.
  client.on("error", () => undefined);
  const killed = await db.one<{ killed: boolean }>(`SELECT pg_terminate_backend($1) AS killed`, [
    pid,
  ]);
  if (!killed.killed) throw new Error(`Postgres refused to terminate test backend ${pid}`);

  await client.query(`SELECT 1`).then(
    () => {
      throw new Error(`terminated backend ${pid} still accepted a query`);
    },
    () => undefined,
  );
}

let created = 0;

/**
 * Short-lived admin connections rather than one kept open: a long-lived client would have
 * to outlive every `afterAll` that still needs to DROP, and hook ordering makes that a
 * race nobody should have to reason about.
 */
async function withAdmin<T>(fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export async function freshDatabase(): Promise<Db> {
  const name = `t_${process.pid}_${++created}`;
  await withAdmin((a) => a.query(`CREATE DATABASE ${name} TEMPLATE ${inject("templateDb")}`));

  const url = new URL(inject("adminUrl"));
  url.pathname = `/${name}`;
  const href = url.toString();

  const client = new Client({ connectionString: href });
  await client.connect();
  const extra: Client[] = [];

  // `client` is one dedicated `pg.Client`, so this is truthfully single-connection; the cast
  // supplies the `[tx]` brand marker (`SqlClient extends TransactionClient`, above) that no
  // object literal can name directly.
  return {
    name,
    url: href,
    query: (text, values) =>
      client
        .query(text, values as unknown[])
        .then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })),
    async one(text, values) {
      const r = await client.query(text, values as unknown[]);
      if (r.rows.length !== 1) {
        throw new Error(`expected exactly 1 row, got ${r.rows.length}, from:\n${text}`);
      }
      return r.rows[0];
    },
    async rows(text, values) {
      const r = await client.query(text, values as unknown[]);
      return r.rows;
    },
    async connect() {
      const c = new Client({ connectionString: href });
      await c.connect();
      extra.push(c);
      return c;
    },
    async close() {
      await Promise.all(extra.map((c) => c.end().catch(() => undefined)));
      await client.end();
      // FORCE: a test that leaked a connection should fail on its assertion, not on drop.
      await withAdmin((a) => a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  } as Db;
}

/**
 * Per-test database, dropped afterwards. Every test that touches the schema ends with the
 * full invariant sweep: an effect assertion that passes while conservation is broken is
 * not a pass.
 */
export function useDatabase(): () => Db {
  let db: Db | undefined;

  beforeEach(async () => {
    db = await freshDatabase();
  });

  afterEach(async () => {
    if (!db) return;
    try {
      const violations = await checkInvariants(db);
      if (violations.length > 0) {
        throw new Error(`ADR 0001 invariants violated:\n\n${formatViolations(violations)}`);
      }
    } finally {
      await db.close();
      db = undefined;
    }
  });

  return () => {
    if (!db) throw new Error("useDatabase() accessed outside a test");
    return db;
  };
}

/**
 * One database for a whole file. For tiers that only inspect the schema (tier 1 prepares
 * every statement); a per-test clone there buys isolation nothing writes to.
 */
export function useSharedDatabase(): () => Db {
  let db: Db | undefined;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db?.close();
    db = undefined;
  });

  return () => {
    if (!db) throw new Error("useSharedDatabase() accessed outside a test");
    return db;
  };
}
