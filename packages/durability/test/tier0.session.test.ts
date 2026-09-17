import { describe, expect, it } from "vitest";

import { useSharedDatabase } from "./support/pg.js";

/**
 * Tier 0 — S16.1's `004_session.sql` structural claims (S16 verification item 1):
 * exactly the three ADR 0005 §F columns (nothing resembling an IP/address column — the
 * gates.md trap, checked literally against information_schema), the `session_retention`
 * index, and the `search_open_per_session` partial index serving S16.3's gauge.
 *
 * The tier-0 "applies every registered migration from nothing" and "on-disk equals
 * MIGRATIONS" assertions in `tier0.schema.test.ts` already cover 004 applying cleanly
 * and being registered; this file pins the NEW table's shape.
 */

describe("tier 0 — the session table (S16.1)", () => {
  const db = useSharedDatabase();

  it("has exactly the three §F columns, with no IP/address-shaped column anywhere", async () => {
    const columns = await db().rows<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'session'
       ORDER BY ordinal_position`,
    );

    // Exactly the ADR 0005 §F column set — no IP, flag, or OAuth/account-linkage column
    // (the gates.md trap row, §F:469).
    expect(columns).toEqual([
      { column_name: "session_id", is_nullable: "NO", data_type: "text" },
      { column_name: "created_at", is_nullable: "NO", data_type: "timestamp with time zone" },
      { column_name: "last_seen_at", is_nullable: "NO", data_type: "timestamp with time zone" },
    ]);
  });

  it("carries the §F retention index on last_seen_at", async () => {
    const index = await db().one<{ definition: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'session_retention'`,
    );
    expect(index.definition).toContain("USING btree");
    expect(index.definition).toContain("last_seen_at");
  });

  it("carries the search_open_per_session partial index for S16.3's gauge", async () => {
    const index = await db().one<{ definition: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'search_open_per_session'`,
    );
    expect(index.definition).toContain("ON public.search USING btree (session_id)");
    expect(index.definition).toContain(
      "WHERE (status = ANY (ARRAY['PENDING_SCHEDULE'::text, 'RUNNING'::text]))",
    );
  });
});
