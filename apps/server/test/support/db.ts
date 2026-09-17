import { Client } from "pg";

import type { Redis } from "ioredis";

import type { TransactionClient } from "@seatfirst/durability";
import { applyMigrations, B1_CREATE_SEARCH, B1_STAGE1_ADMISSION } from "@seatfirst/durability";

import type { Queryable } from "../../src/streaming/queries.js";

/**
 * Database plumbing for the subscription suite. The schema is applied through the
 * durability package's own `applyMigrations` — the authoritative migration path — never a
 * hand-rolled copy.
 */

export async function migrateDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    // Migration 022 grants to this role. A server test database starts empty, so
    // create the credential-free test role before the authoritative migration path.
    await client.query(`
      DO $retention_worker$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker') THEN
          CREATE ROLE retention_worker WITH NOLOGIN;
        END IF;
      END
      $retention_worker$;
    `);
    // Migration 023 revokes access from this role. A server test database starts empty,
    // so create the credential-free runtime role before the authoritative migration path.
    await client.query(`
      DO $seatfirst_app$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seatfirst_app') THEN
          CREATE ROLE seatfirst_app WITH NOLOGIN;
        END IF;
      END
      $seatfirst_app$;
    `);
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Seed-data inserts — scaffolding that creates rows, not a state transition. */
export async function seedSearchRow(
  db: Queryable,
  opts: { searchId: string; sessionId: string; status?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, now() + interval '10 minutes')`,
    [
      opts.searchId,
      opts.sessionId,
      `idem_${opts.searchId}`,
      `hash_${opts.searchId}`,
      opts.status ?? "PENDING_SCHEDULE",
    ],
  );
}

export interface SeedEvent {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Seed `search_event` rows with gapless seqs (`firstSeq`, `firstSeq+1`, …) and advance
 * `search.next_seq` to match — the invariant the acceptance transactions maintain
 * (`001_schema.sql:153`). Direct seeding is exactly what the spec asks for: this task
 * does not generate events (S12.8).
 */

export async function seedEvents(
  db: Queryable,
  searchId: string,
  events: readonly SeedEvent[],
  opts: { firstSeq?: number } = {},
): Promise<void> {
  const firstSeq = opts.firstSeq ?? 1;
  for (const [index, event] of events.entries()) {
    const seq = firstSeq + index;
    await db.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES ($1, $2, $3, $4::jsonb)`,
      [searchId, seq, event.type, JSON.stringify(event.payload)],
    );
  }
  await db.query(`UPDATE search SET next_seq = $2 WHERE search_id = $1`, [
    searchId,
    firstSeq + events.length - 1,
  ]);
}

export async function projectEvents(
  redis: Redis,
  searchId: string,
  events: readonly { seq: number; type: string; payload: unknown }[],
): Promise<void> {
  for (const event of events) {
    await redis.xadd(
      `search:${searchId}`,
      `${event.seq}-0`,
      "type",
      event.type,
      "payload",
      JSON.stringify(event.payload),
    );
  }
}

/**
 * Builds a search eligible for terminalization through the REAL B1 statements, then
 * expires its deadline (time is data — an UPDATE, never a sleep, per the house rule).
 * After this, `terminalize()` from `packages/durability/src/transactions.ts` claims and
 * completes it: warm path, no jobs, no subscriptions, so B8 derives COMPLETE with a null
 * cause (`B8_TERMINALIZE`, `packages/durability/src/boundaries.ts:875-1010`).
 */
export async function seedSearchEligibleForTerminalization(
  db: TransactionClient,
  opts: { searchId: string; sessionId: string },
): Promise<void> {
  // Provider admission/fence rows are seed data (durability's `seedProvider` fixture).
  await db.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    ["amc", 1000, 100],
  );
  await db.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, ["amc"]);

  const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const created = await db.query(B1_CREATE_SEARCH.text, [
    opts.searchId,
    opts.sessionId,
    `idem_${opts.searchId}`,
    JSON.stringify({ v: 1 }),
    `hash_${opts.searchId}`,
    deadlineAt,
  ]);
  if (created.rows.length < 1) throw new Error("B1_CREATE_SEARCH seeded no row");

  const reserved = await db.query(B1_STAGE1_ADMISSION.text, ["amc", 1, 0, opts.searchId, 0]);
  if (reserved.rows.length < 1) throw new Error("B1_STAGE1_ADMISSION seeded no row");

  // Precondition simulation (time manipulation): make the deadline pass so B7_CLAIM and
  // B8_TERMINALIZE's guard see a terminal-ready search.
  await db.query(
    `UPDATE search SET deadline_at = now() - interval '1 minute' WHERE search_id = $1`,
    [opts.searchId],
  );
}

/**
 * Brand a single-connection `pg.Client` as the durability tier's `TransactionClient`.
 * Same cast and rationale as the durability harness's `session()` helper
 * (`packages/durability/test/support/pg.ts:59`): the client IS one physical connection,
 * the cast supplies the nominal marker no object literal can name.
 */
export function asTransactionClient(client: Client): TransactionClient {
  return client as unknown as TransactionClient;
}
