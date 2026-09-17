import { describe, expect, it } from "vitest";

import { useSharedDatabase } from "./support/pg.js";

/**
 * Tier 0 — the retention functions' structural claims (S18.1).
 *
 * `tier0.schema.test.ts` already covers 006 applying cleanly and the on-disk migration
 * set matching `MIGRATIONS` (a file nobody applies proves nothing); this file pins the
 * shapes of the functions 006 adds. Behavior — the drop boundaries, the TTL figures, the
 * lookahead alarm — is tier 2's job (tier2.retention.test.ts).
 *
 * The DEFAULT-partition exclusion asserted here is the structural half of the protected
 * partition guarantee: `_dated_partitions` can only see children that HAVE a range bound,
 * and the DEFAULT children have none — so no drop function can ever name
 * `availability_snapshot_default` or `events_default`. (Tier 2 asserts the behavioral
 * half: dropping still leaves them intact.)
 */

describe("tier 0 — retention function structures", () => {
  const db = useSharedDatabase();

  const DECLARED_SIGNATURES = [
    "drop_snapshot_partitions(integer)",
    "drop_event_partitions(integer)",
    "delete_expired_snapshot_default_rows(integer)",
    "delete_expired_event_default_rows(integer)",
    "maintain_partition_lookahead()",
    "delete_expired_sessions(integer)",
    "delete_expired_searches(integer)",
  ] as const;

  it("every S18.2–S18.8 function exists with its declared signature", async () => {
    const rows = await db().rows<{ signature: string; resolves_to: string | null }>(
      `SELECT sig AS signature, to_regprocedure(sig)::text AS resolves_to
       FROM unnest($1::text[]) AS sig`,
      [[...DECLARED_SIGNATURES]],
    );
    // to_regprocedure resolves only when a function with EXACTLY that name and argument
    // list exists in the search path — a near-miss (different arg type, missing arg) is
    // null, and an ambiguously overloaded name is also null.
    for (const row of rows) {
      expect(row.resolves_to, row.signature).toBe(row.signature);
    }
    expect(rows.map((row) => row.signature).sort()).toEqual([...DECLARED_SIGNATURES].sort());
  });

  it("the drop/delete functions return integer and the lookahead returns boolean", async () => {
    const results = await db().rows<{ name: string; result: string }>(
      `SELECT p.proname AS name, pg_get_function_result(p.oid) AS result
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = ANY($1::text[])
       ORDER BY p.proname`,
      [
        [
          "drop_snapshot_partitions",
          "drop_event_partitions",
          "delete_expired_snapshot_default_rows",
          "delete_expired_event_default_rows",
          "delete_expired_sessions",
          "delete_expired_searches",
        ],
      ],
    );
    expect(results).toHaveLength(6);
    for (const row of results) {
      expect(row.result, row.name).toBe("integer");
    }

    const lookahead = await db().one<{ result: string }>(
      `SELECT pg_get_function_result(oid) AS result
       FROM pg_proc
       WHERE proname = 'maintain_partition_lookahead' AND pronamespace = 'public'::regnamespace`,
    );
    expect(lookahead.result).toBe("boolean");
  });

  it("the DEFAULT partitions render the DEFAULT marker — invisible to the drop scope by construction", async () => {
    const bounds = await db().rows<{ relname: string; bound: string | null }>(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_class c
       WHERE c.relname IN ('availability_snapshot_default', 'events_default')`,
    );
    expect(bounds).toHaveLength(2);
    for (const row of bounds) {
      expect(row.bound, row.relname).toBe("DEFAULT");
    }

    // Structural consequence: the helper that feeds both drop functions and the lookahead
    // sees only the dated children — the DEFAULT names can never appear in it.
    const visible = await db().rows<{ relname: string }>(
      `SELECT relname FROM _dated_partitions('availability_snapshot')
       UNION ALL
       SELECT relname FROM _dated_partitions('events')`,
    );
    expect(visible.map((row) => row.relname)).not.toContain("availability_snapshot_default");
    expect(visible.map((row) => row.relname)).not.toContain("events_default");
  });

  it("006 refreshes the gate-blocked comment on ensure_event_partitions to name the landed policy", async () => {
    const comment = await db().one<{ description: string | null }>(
      `SELECT obj_description('ensure_event_partitions(integer)'::regprocedure, 'pg_proc') AS description`,
    );
    // 003_catalog.sql:99-101 said the retention side "remains gate-blocked"; 006 refreshes
    // it to name the functions that now own it.
    expect(comment.description).toContain("drop_event_partitions");
  });
});
