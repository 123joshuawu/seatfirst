import type { SqlClient } from "./pg.js";

/** Time is always moved by writing timestamp data; durability tests never sleep. */
export async function expireSearch(db: SqlClient, searchId: string): Promise<void> {
  await db.query(
    `UPDATE search SET deadline_at = now() - interval '1 second' WHERE search_id = $1`,
    [searchId],
  );
}

export async function expireRunLease(db: SqlClient, runId: string): Promise<void> {
  await db.query(
    `UPDATE provider_run SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1`,
    [runId],
  );
}

export async function expireAggregationLease(db: SqlClient, searchId: string): Promise<void> {
  await db.query(
    `UPDATE search SET agg_lease_expires = now() - interval '1 second' WHERE search_id = $1`,
    [searchId],
  );
}
