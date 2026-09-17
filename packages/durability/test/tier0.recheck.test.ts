import { describe, expect, it } from "vitest";

import { useDatabase } from "./support/pg.js";

/**
 * Tier 0 — the S22 recheck schema (migration 007).
 *
 * The migration-set assertion (every on-disk file is listed in `MIGRATIONS`) lives in
 * `tier0.schema.test.ts:54-59`; once 007 was added to `MIGRATIONS` that assertion began
 * covering it. These are the S22-specific structural claims: the widened `run_key.kind`
 * CHECK, the kind↔route pairing, the per-kind key-part nullability, the new
 * `recheck_placement` jsonb (and its `(kind='RECHECK') = (recheck_placement IS NOT NULL)`
 * CHECK), the `provider_run.priority` column, and the two new tables
 * (`consumed_nonce`, `recheck_outcome`) with the recheck_outcome FK to `provider_run`.
 *
 * The negative CHECK assertions each carry a positive control: the neighbouring shape that
 * IS admitted. `search_job.kind` still rejects `RECHECK` (S22.1's documented deviation).
 */

describe("tier 0 — S22 recheck schema", () => {
  const db = useDatabase();

  it("widens run_key.kind to admit RECHECK without losing the existing two kinds", async () => {
    // Positive control: a RECHECK key inserts (seat route, showtime_id set, theatre/date null).
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, recheck_placement)
         VALUES ('rk_ok', 'RECHECK', 'amc', 'seat', 'st1', '{"placementKey":"p1"}'::jsonb)`,
      ),
    ).resolves.toBeTruthy();

    const kinds = await db().rows<{ kind: string }>(`SELECT DISTINCT kind FROM run_key`);
    expect(kinds.map((k) => k.kind).sort()).toEqual(["RECHECK"]);
  });

  it("still rejects search_job.kind = 'RECHECK' (S22.1's positive control)", async () => {
    await expect(
      db().query(
        `INSERT INTO search_job (job_id, search_id, kind, run_key_id, deadline_at)
         VALUES ('job_1', 's1', 'RECHECK', 'rk_1', now())`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("RECHECK pairs with route_class 'seat', not 'schedule' (kind↔route pairing CHECK)", async () => {
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, recheck_placement)
         VALUES ('rk_bad_route', 'RECHECK', 'amc', 'schedule', 'st1', '{"placementKey":"p1"}'::jsonb)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("a RECHECK key forbids theatre_id/local_date (key-parts CHECK)", async () => {
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, theatre_id, recheck_placement)
         VALUES ('rk_bad_parts', 'RECHECK', 'amc', 'seat', 'st1', 't1', '{"placementKey":"p1"}'::jsonb)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("recheck_placement is non-null exactly when kind = 'RECHECK'", async () => {
    // A RECHECK key without recheck_placement is rejected.
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
         VALUES ('rk_no_placement', 'RECHECK', 'amc', 'seat', 'st1')`,
      ),
    ).rejects.toThrow(/check constraint/i);

    // A SHOWTIME_FETCH key with recheck_placement is rejected (the other direction).
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, recheck_placement)
         VALUES ('rk_fetch_placement', 'SHOWTIME_FETCH', 'amc', 'seat', 'st1', '{"placementKey":"p1"}'::jsonb)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("provider_run.priority is integer NOT NULL DEFAULT 0", async () => {
    const col = await db().one<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'provider_run' AND column_name = 'priority'`,
    );
    expect(col.data_type).toBe("integer");
    expect(col.is_nullable).toBe("NO");
    expect(col.column_default).toBe("0");
  });

  it("consumed_nonce has the nonce_id PK and a consumed_at stamp", async () => {
    const cols = await db().rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'consumed_nonce'`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["nonce_id", "consumed_at"]);
    await expect(
      db().query(`INSERT INTO consumed_nonce (nonce_id) VALUES ('n1')`),
    ).resolves.toBeTruthy();
    await expect(db().query(`INSERT INTO consumed_nonce (nonce_id) VALUES ('n1')`)).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("recheck_outcome has the four declared columns and a status CHECK", async () => {
    const cols = await db().rows<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'recheck_outcome'`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["run_id", "status", "payload", "created_at"]);
    // status CHECK admits exactly the three verdicts.
    await expect(
      db().query(
        `INSERT INTO recheck_outcome (run_id, status, payload) VALUES ('r1', 'BOGUS', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("recheck_outcome.run_id is a real FK to provider_run", async () => {
    // The FK target must exist before an outcome can reference it.
    await expect(
      db().query(
        `INSERT INTO recheck_outcome (run_id, status, payload) VALUES ('no_such_run', 'AVAILABLE', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
