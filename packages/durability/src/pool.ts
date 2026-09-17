import { Pool, type PoolClient } from "pg";

import { applyMigrations, baselineMigrations } from "./migrate.js";
import type { SqlClient, TransactionClient } from "./transactions.js";

/** Caller-owned pg configuration. Numeric policy is never invented by this package. */
export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
}

/**
 * Creates a native pg pool from explicit options only. Attaches an `error` listener: `pg.Pool`
 * forwards a backend termination on an *idle* client (network blip, `DROP DATABASE ...
 * WITH (FORCE)`, an administrator killing the backend, the server restarting) as an `error`
 * event on the pool itself, not as a rejection anywhere a caller is awaiting. Node's
 * EventEmitter treats an `error` event with no listener as fatal — it throws — so without
 * this handler, one killed idle connection crashes the whole process. `pg.Pool` already
 * discards the broken client and opens a fresh one on the next checkout; there is nothing
 * for a caller to react to here, only a crash to prevent (mirrors the same swallow used for
 * BullMQ/ioredis clients elsewhere in this codebase, e.g. apps/server/src/streaming/redisStreams.ts).
 */
export function createPool(options: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  });
  pool.on("error", () => {});
  return pool;
}

/**
 * Adapts one checked-out pg client to the deliberately narrow transaction surface. Returns
 * `TransactionClient`, not plain `SqlClient`: a single checked-out `PoolClient` is exactly the
 * single-connection guarantee the brand asserts, so this is the DB boundary where that
 * guarantee is actually established. The object literal below has no `[tx]` property of its
 * own — nothing outside this module can name that symbol — so the cast is the one place the
 * brand is asserted rather than checked; everywhere else it is enforced structurally.
 */
function sqlClient(client: PoolClient): TransactionClient {
  return {
    async query(text, values) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as unknown[] };
    },
  } as TransactionClient;
}

/**
 * Adapts a bare `Pool` to the `SqlClient` surface for a single, autocommitted, non-
 * transactional call. Without this adapter no consumer can make one repository call outside
 * `withTransaction` — every read would have to open and commit a transaction it does not
 * need.
 *
 * Returns plain `SqlClient`, deliberately NOT `TransactionClient` (`transactions.ts`) — that
 * is the entire point of this function. Each call issued through this adapter may run on a
 * **different** physical connection: `Pool.query()` checks a connection out, runs one
 * statement, and returns it. That is exactly right for a single statement and exactly wrong
 * for anything that spans more than one, so never send `BEGIN`/`COMMIT` through it (see
 * `withTransaction`'s doc comment above). Because the return type here carries no brand,
 * passing `poolClient(pool)` to any of the five `BEGIN`-emitting functions in
 * `transactions.ts` (`acceptFetch`/`failRun`/`terminalize`/`sweepFailExhaustedJobs`/
 * `sweepFailExhaustedRuns`) is a compile error, not a hazard a comment merely warns about —
 * use a `withTransaction` callback argument, or `sqlClient` over one checked-out
 * `PoolClient`, instead.
 */
export function poolClient(pool: Pool): SqlClient {
  return {
    async query(text, values) {
      const result = await pool.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as unknown[] };
    },
  };
}

/**
 * Runs a callback on one checked-out connection. A transaction must never be composed by
 * sending BEGIN/COMMIT through Pool.query(), because successive calls may use different
 * connections. The callback receives a `TransactionClient` (via `sqlClient`, above), so it
 * can be passed straight into `acceptFetch`/`failRun`/`terminalize`/`sweepFailExhaustedJobs`/
 * `sweepFailExhaustedRuns` without a second adapter.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (transaction: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(sqlClient(client));
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the transaction-body error: it is the actionable failure for the caller.
      }
      throw cause;
    }
  } finally {
    client.release();
  }
}

/**
 * Applies pending migrations on one checked-out pool connection. The advisory lock in
 * `applyMigrations` (`src/migrate.ts`) is session-scoped
 * (`SELECT pg_advisory_lock(hashtext('seatfirst.schema_migration')::bigint)`), so a
 * single connection is mandatory — every `BEGIN`/`COMMIT` and ledger `INSERT` must run
 * on the same backend that holds the lock. This function establishes that guarantee by
 * checking out one `PoolClient` and adapting it via `sqlClient` (the brand assertion
 * site, above). Never call `applyMigrations` directly on a `Pool`.
 *
 * @returns names applied in this run, in `MIGRATIONS` order (empty if already current)
 */
export async function migrate(pool: Pool): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    return await applyMigrations(sqlClient(client));
  } finally {
    client.release();
  }
}

/**
 * Baselines the ledger on one checked-out pool connection. Same single-connection
 * requirement as `migrate` — the advisory lock is session-scoped — so this also
 * checks out one `PoolClient`.
 *
 * @returns names newly recorded (empty if already baselined)
 */
export async function baseline(pool: Pool): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    return await baselineMigrations(sqlClient(client));
  } finally {
    client.release();
  }
}
