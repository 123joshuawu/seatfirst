import { Client } from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { applyMigrations, MIGRATIONS, readMigrations } from "../src/migrate.js";
import { browseTheatres, upsertSession } from "../src/repository.js";

import { session, useDatabase } from "./support/pg.js";

/**
 * Tier 0 — the schema loads.
 *
 * Would have caught immediately: R2#1 (partitioned PK invalid), R4#6 (missing composite
 * UNIQUE targets), R5#13 (snapshot FK absent), R5#14 (no partition accepts the first
 * insert). None of these needed anyone to think hard; they needed a database.
 */

const empties: string[] = [];

afterAll(async () => {
  if (empties.length === 0) return;
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  for (const name of empties) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe("tier 0 — migrations apply to an empty database", () => {
  it("applies every registered migration in order, from nothing", async () => {
    const admin = new Client({ connectionString: inject("adminUrl") });
    await admin.connect();
    const name = `empty_${process.pid}_${empties.length}`;
    empties.push(name);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const url = new URL(inject("adminUrl"));
    url.pathname = `/${name}`;
    const db = new Client({ connectionString: url.toString() });
    await db.connect();
    // `applyMigrations` is session-scoped (advisory lock) — must run on a single
    // dedicated `Client`, never a `Pool` (`src/migrate.ts`, `src/pool.ts:110-133`).
    // The returned array is the pending names applied in `MIGRATIONS` order.
    try {
      await expect(applyMigrations(db)).resolves.toEqual([...MIGRATIONS]);
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind IN ('r','p')`,
      );
      expect(rows[0].n).toBeGreaterThan(15);
    } finally {
      await db.end();
    }
  });

  it("every migration is listed in MIGRATIONS (a file nobody applies proves nothing)", async () => {
    const { readdir } = await import("node:fs/promises");
    const { migrationsDir } = await import("../src/migrate.js");
    const onDisk = (await readdir(migrationsDir())).filter((f) => f.endsWith(".sql")).sort();
    expect(onDisk).toEqual([...MIGRATIONS].sort());
  });
});

describe("tier 0 — structural claims", () => {
  const db = useDatabase();

  it("creates the theatre catalogue with the G1 column superset", async () => {
    const columns = await db().rows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'theatre'`,
    );
    expect(columns.map((column) => column.column_name)).toEqual(
      expect.arrayContaining([
        "theatre_id",
        "provider_id",
        "name",
        "lat",
        "lng",
        "market_slug",
        "timezone",
        "address",
        "slugs",
        "first_seen_at",
        "last_seen_at",
      ]),
    );
    expect(columns.find((column) => column.column_name === "timezone")?.is_nullable).toBe("NO");
  });

  it("uses the declared btree geo index for the catalogue", async () => {
    const index = await db().one<{ method: string; definition: string }>(
      `SELECT am.amname AS method, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am am ON am.oid = c.relam
       WHERE c.relname = 'theatre_geo_bbox'`,
    );
    expect(index.method).toBe("btree");
    expect(index.definition).toContain("(lat, lng)");
  });

  it("creates the movie catalogue with exactly the five S24 columns", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'movie'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "first_seen_at",
      "last_seen_at",
      "movie_id",
      "provider_id",
      "title",
    ]);
    const title = await db().one<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'movie' AND column_name = 'title'`,
    );
    expect(title.is_nullable).toBe("NO");
  });

  it("the movie migration carries no image-shaped field or URL (S24 verification 6)", async () => {
    const migrations = await readMigrations();
    const movieSql = migrations.find((m) => m.name === "009_movie_catalog.sql")?.sql ?? "";
    // Check the DDL only, not the file's explanatory header comments: the guarantee is that
    // no image/poster COLUMN or URL ships in the schema, not that prose never mentions the
    // word while explaining why it is absent.
    const ddl = movieSql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const imageish = /image|poster|thumbnail|avatar|\.jpe?g|\.png|\.webp|srcset|cloudinary/i;
    expect(ddl).not.toMatch(imageish);
  });

  it("creates the tmdb_movie table with exactly the eight S25+S55+S63 columns (ADR 0019 §1, amendment 2026-09-02, migration 025; ADR 0102 via migration 027 drops the slate flags)", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tmdb_movie'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "genres",
      "normalized_title",
      "poster_path",
      "release_date",
      "runtime_minutes",
      "title",
      "tmdb_id",
      "updated_at",
    ]);
    // tmdb_id is the PRIMARY KEY, normalized_title is UNIQUE — the ADR's DDL verbatim.
    const pk = await db().one<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'tmdb_movie'::regclass AND i.indisprimary`,
    );
    expect(pk.column_name).toBe("tmdb_id");
    const unique = await db().rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'tmdb_movie' AND indexname <> 'tmdb_movie_pkey'`,
    );
    expect(unique.map((u) => u.indexname)).toEqual(["tmdb_movie_normalized_title_key"]);
    // S55 — runtime_minutes stays nullable ("unknown," never fabricated); genres is
    // NOT NULL DEFAULT '{}' ("no genre data yet," mirroring poster_path IS NULL).
    const s55 = await db().rows<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tmdb_movie'
         AND column_name IN ('runtime_minutes', 'genres')`,
    );
    expect(s55.find((c) => c.column_name === "runtime_minutes")?.is_nullable).toBe("YES");
    expect(s55.find((c) => c.column_name === "genres")?.is_nullable).toBe("NO");
    expect(s55.find((c) => c.column_name === "genres")?.column_default).toBe("'{}'::text[]");
  });

  it("creates the tmdb_fetch table with exactly the six S25 columns and the one-live-fetch partial UNIQUE (ADR 0019 amendment decision 5)", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tmdb_fetch'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "attempt",
      "created_at",
      "fail_cause",
      "movie_title",
      "state",
      "tmdb_fetch_id",
    ]);
    const pk = await db().one<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'tmdb_fetch'::regclass AND i.indisprimary`,
    );
    expect(pk.column_name).toBe("tmdb_fetch_id");
    // The searchless fetch drops LEASED/lease_expires_at (no durable lease); the only
    // dedup index is the partial UNIQUE on movie_title WHERE state = 'PENDING'.
    const indexes = await db().rows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'tmdb_fetch' AND indexname <> 'tmdb_fetch_pkey'`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(["one_live_tmdb_fetch_per_title"]);
    expect(indexes[0]!.indexdef).toMatch(/WHERE \(state = 'PENDING'::text\)/);
  });

  it("creates the amc_movie_catalogue table with exactly the twelve ADR 0102 columns (migration 027)", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'amc_movie_catalogue'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "details_path",
      "first_seen_at",
      "image_url",
      "movie_id",
      "mpaa_rating",
      "name",
      "release_date",
      "runtime_minutes",
      "showtimes_path",
      "slug",
      "status",
      "updated_at",
    ]);
    const pk = await db().one<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'amc_movie_catalogue'::regclass AND i.indisprimary`,
    );
    expect(pk.column_name).toBe("movie_id");
  });

  it("creates the amc_movie_catalogue_state singleton checkpoint with exactly the three ADR 0102 columns (migration 027, replacing tmdb_prewarm_state)", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'amc_movie_catalogue_state'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "last_completed_at",
      "singleton",
      "updated_at",
    ]);
    const pk = await db().one<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'amc_movie_catalogue_state'::regclass AND i.indisprimary`,
    );
    expect(pk.column_name).toBe("singleton");
  });

  it("widens outbox.target_kind to TMDB_FETCH with the matching nullable FK + pair CHECK (decision 5)", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'tmdb_fetch_id'`,
    );
    expect(columns).toHaveLength(1);
    const check = await db().one<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
       WHERE conname = 'outbox_target_kind_check'`,
    );
    expect(check.consrc).toContain("TMDB_FETCH");
    // The pair CHECK ties the kind to the FK presence, mirroring the JOB/RUN columns.
    const pair = await db().one<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
       WHERE conname = 'outbox_tmdb_fetch_target_check'`,
    );
    expect(pair.consrc).toMatch(/target_kind = 'TMDB_FETCH'::text/);
  });

  it("creates the catalogue crawl state with exactly the five S26 columns", async () => {
    const columns = await db().rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'catalogue_crawl_state'`,
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "cursor",
      "last_pass_completed_at",
      "last_pass_started_at",
      "provider_id",
      "updated_at",
    ]);
    const pk = await db().one<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'catalogue_crawl_state'::regclass AND i.indisprimary`,
    );
    expect(pk.column_name).toBe("provider_id");
  });

  it("adds only nullable-or-defaulted product columns and the layout FK", async () => {
    const columns = await db().rows<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'performance'
         AND column_name = ANY($1::text[])`,
      [
        [
          "movie_id",
          "auditorium",
          "utc_offset",
          "runtime_minutes",
          "status",
          "format_code",
          "min_price",
          "currency",
          "price_basis",
          "deep_link_url",
          "provider_meta",
          "layout_id",
        ],
      ],
    );
    expect(columns).toHaveLength(12);
    for (const column of columns) {
      expect(
        column.is_nullable === "YES" || column.column_default !== null,
        `${column.column_name} blocks schedule acceptance`,
      ).toBe(true);
    }

    const layoutFk = await db().one<{ target: string }>(
      `SELECT confrelid::regclass::text AS target
       FROM pg_constraint
       WHERE conrelid = 'performance'::regclass AND contype = 'f'
         AND conname = 'performance_layout_id_fkey'`,
    );
    expect(layoutFk.target).toBe("auditorium_layout");
  });

  it("adds nullable evidence to search_aggregate (S60.1, migration 021)", async () => {
    const column = await db().one<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'search_aggregate'
         AND column_name = 'evidence'`,
    );
    expect(column.is_nullable).toBe("YES");
    expect(column.data_type).toBe("jsonb");
  });

  it("partitions open-typed events by generated month with a default alarm child", async () => {
    const parent = await db().one<{ strategy: string }>(
      `SELECT partstrat AS strategy
       FROM pg_partitioned_table
       WHERE partrelid = 'events'::regclass`,
    );
    expect(parent.strategy).toBe("r");

    const partitions = await db().one<{
      current_child: string;
      default_child: string;
      expected_month: string;
    }>(
      `SELECT
         to_char(date_trunc('month', now()), 'YYYY_MM') AS expected_month,
         to_regclass(format('events_%s', to_char(date_trunc('month', now()), 'YYYY_MM')))::text
           AS current_child,
         to_regclass('events_default')::text AS default_child`,
    );
    // `expected_month` is derived from the same DB session's clock (`date_trunc('month',
    // now())`, the identical formula `ensure_event_partitions()` uses in
    // migrations/003_catalog.sql), not the host's wall clock and not a hardcoded UTC
    // calendar month — so this stays correct even if the server session TimeZone is ever
    // non-UTC. `current_child` is still an independent catalog fact (a real to_regclass
    // lookup), so this still asserts the actual current month's child exists — not just
    // that some monthly-shaped partition exists.
    expect(partitions.current_child).toBe(`events_${partitions.expected_month}`);
    expect(partitions.default_child).toBe("events_default");

    const typeChecks = await db().rows(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'events'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%type%'`,
    );
    expect(typeChecks).toEqual([]);
  });

  it("every foreign key is validated and every table has a primary key", async () => {
    const unvalidated = await db().rows(
      `SELECT conrelid::regclass::text AS tbl, conname
       FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`,
    );
    expect(unvalidated).toEqual([]);

    const fkCount = await db().one<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f'`,
    );
    expect(fkCount.n).toBeGreaterThan(10);

    const pkless = await db().rows(
      `SELECT c.relname
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind IN ('r','p')
         AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                         WHERE k.conrelid = c.oid AND k.contype = 'p')`,
    );
    expect(pkless).toEqual([]);
  });

  it("the composite FK targets exist (R1#2, R4#6): job kind, subscription triple, observation pairing", async () => {
    const uniques = await db().rows<{ tbl: string; cols: string }>(
      `SELECT conrelid::regclass::text AS tbl,
              (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols
       FROM pg_constraint con
       WHERE contype IN ('u','p')`,
    );
    const has = (tbl: string, cols: string) =>
      uniques.some((u) => u.tbl === tbl && u.cols === cols);

    expect(has("run_key", "run_key_id,kind")).toBe(true);
    expect(has("search_job", "job_id,search_id,run_key_id")).toBe(true);
    expect(has("provider_run", "run_id,run_key_id")).toBe(true);
    expect(has("search", "session_id,idempotency_key")).toBe(true);
  });

  it("every partitioned table has a partition, including a default (R5#14)", async () => {
    const partitioned = await db().rows<{ parent: string; children: number; has_default: boolean }>(
      `SELECT p.relname AS parent,
              count(i.inhrelid)::int AS children,
              bool_or(pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT') AS has_default
       FROM pg_class p
       JOIN pg_namespace ns ON ns.oid = p.relnamespace AND ns.nspname = 'public'
       LEFT JOIN pg_inherits i ON i.inhparent = p.oid
       LEFT JOIN pg_class c ON c.oid = i.inhrelid
       WHERE p.relkind = 'p'
       GROUP BY p.relname`,
    );
    expect(partitioned.length).toBeGreaterThan(0);
    for (const t of partitioned) {
      expect(t.children, `${t.parent} has no partitions`).toBeGreaterThanOrEqual(2);
      expect(t.has_default, `${t.parent} has no default partition`).toBe(true);
    }
  });

  it("the first snapshot insert on a fresh database lands in a month partition, not the default (T42)", async () => {
    await db().query(
      `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
       VALUES ('k1','SHOWTIME_FETCH','amc','seat','st1')`,
    );
    await db().query(
      `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
       VALUES ('r1','k1','o1',0)`,
    );
    await db().query(
      `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
       VALUES ('o1','k1','r1', now(), 1)`,
    );

    const row = await db().one<{ part: string; month: string }>(
      `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
       VALUES ('o1','st1', now(), '\\x00', 3)
       RETURNING tableoid::regclass::text AS part,
                 to_char(date_trunc('month', now()), 'YYYY_MM') AS month`,
    );
    // `month` is derived from the same statement's `now()` (transaction-stable, so it's the
    // exact same instant used for `captured_at`), formatted with the identical
    // `date_trunc('month', …)`/`to_char(…, 'YYYY_MM')` formula `ensure_snapshot_partitions()`
    // uses in migrations/002_partitions.sql — not the host's wall clock and not a hardcoded
    // UTC calendar month, so this stays correct even under a non-UTC server session
    // TimeZone. `part` is still an independent catalog fact (the row's actual physical
    // partition), so this still asserts the row landed in the actual current month's child —
    // not just some monthly-shaped partition, which would still pass for a wrong-month
    // child.
    expect(row.part).toBe(`availability_snapshot_${row.month}`);
  });

  it("the snapshot FK rejects an orphan observation (R5#13)", async () => {
    await expect(
      db().query(
        `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
         VALUES ('nope','st1', now(), '\\x00', 3)`,
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("ensure_snapshot_partitions is idempotent and creates months ahead", async () => {
    const again = await db().one<{ ensure_snapshot_partitions: number }>(
      `SELECT ensure_snapshot_partitions(3)`,
    );
    expect(again.ensure_snapshot_partitions).toBe(0);

    const more = await db().one<{ ensure_snapshot_partitions: number }>(
      `SELECT ensure_snapshot_partitions(6)`,
    );
    expect(more.ensure_snapshot_partitions).toBe(3);
  });

  it("run_key CHECKs tie route_class to kind and forbid mixed key parts (R4#4)", async () => {
    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
         VALUES ('bad1','SHOWTIME_FETCH','amc','schedule','st9')`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      db().query(
        `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, theatre_id, local_date)
         VALUES ('bad2','SCHEDULE_RESOLUTION','amc','schedule','st9','t1','2026-08-02')`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("outbox cannot name a target it does not have (R4#8)", async () => {
    await expect(
      db().query(`INSERT INTO outbox (outbox_id, target_kind) VALUES ('ob1','JOB')`),
    ).rejects.toThrow(/check constraint/i);
  });

  it("cost_event: gate-19 columns, per-type CHECKs, four partial unique indexes, CASCADE search FK (S17.0)", async () => {
    const cols = await db().rows<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'cost_event'
       ORDER BY ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      "event_id",
      "event_type",
      "run_id",
      "attempt",
      "search_id",
      "run_key_id",
      "units",
      "created_at",
    ]);
    expect(cols.find((c) => c.column_name === "units")).toMatchObject({
      data_type: "bigint",
      is_nullable: "NO",
    });
    // Nullability is per event_type: the identity columns are nullable in general but
    // pinned by the per-type CHECK, never by NOT NULL.
    const checks = await db().rows<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'cost_event'::regclass AND contype = 'c'`,
    );
    const typeCheck = checks.find(
      (c) => c.def.includes("'PROVIDER_WORK'") && !c.def.includes("IS NOT NULL"),
    );
    const perType = checks.find(
      (c) => c.def.includes("'PROVIDER_WORK'") && c.def.includes("IS NOT NULL"),
    );
    expect(typeCheck, "the four-value event_type CHECK").toBeDefined();
    for (const t of [
      "PROVIDER_WORK",
      "ABUSE_WEIGHTED",
      "ADMISSION_RESERVATION",
      "ADMISSION_RECONCILED",
    ]) {
      expect(typeCheck!.def).toContain(`'${t}'`);
    }
    expect(perType, "the per-type nullability CHECK").toBeDefined();
    // pg_get_constraintdef fully parenthesizes and casts each term; match each arm by
    // its type marker and the four identity columns' exact nullability shape.
    const arm = (type: string) => {
      const start = perType!.def.indexOf(`'${type}'::text`);
      const end = perType!.def.indexOf(")) OR", start);
      return perType!.def.slice(start, end === -1 ? undefined : end + 1);
    };
    for (const [type, cols] of [
      [
        "PROVIDER_WORK",
        [
          "(run_id IS NOT NULL)",
          "(attempt IS NOT NULL)",
          "(search_id IS NULL)",
          "(run_key_id IS NULL)",
        ],
      ],
      [
        "ABUSE_WEIGHTED",
        [
          "(run_id IS NOT NULL)",
          "(attempt IS NOT NULL)",
          "(search_id IS NOT NULL)",
          "(run_key_id IS NULL)",
        ],
      ],
      [
        "ADMISSION_RESERVATION",
        [
          "(run_id IS NULL)",
          "(attempt IS NULL)",
          "(search_id IS NOT NULL)",
          "(run_key_id IS NULL)",
        ],
      ],
      [
        "ADMISSION_RECONCILED",
        ["(run_id IS NULL)", "(attempt IS NULL)", "(search_id IS NOT NULL)"],
      ],
    ] as const) {
      const def = arm(type);
      expect(def, `per-type arm for ${type}`).toContain(`'${type}'::text`);
      for (const col of cols) expect(def).toContain(col);
    }

    const indexes = await db().rows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cost_event'`,
    );
    const partial = indexes.filter((i) => i.indexdef.includes(" WHERE "));
    expect(partial.map((i) => i.indexname).sort()).toEqual([
      "cost_event_abuse_weighted",
      "cost_event_admission_reconciled_per_key",
      "cost_event_admission_reconciled_per_search",
      "cost_event_admission_reservation",
      "cost_event_provider_work",
    ]);
    const byName = new Map(partial.map((i) => [i.indexname, i.indexdef]));
    expect(byName.get("cost_event_provider_work")).toContain("event_type = 'PROVIDER_WORK'::text");
    expect(byName.get("cost_event_abuse_weighted")).toContain(
      "event_type = 'ABUSE_WEIGHTED'::text",
    );
    expect(byName.get("cost_event_admission_reservation")).toContain(
      "event_type = 'ADMISSION_RESERVATION'::text",
    );
    expect(byName.get("cost_event_admission_reconciled_per_key")).toContain(
      "event_type = 'ADMISSION_RECONCILED'::text",
    );
    expect(byName.get("cost_event_admission_reconciled_per_search")).toContain(
      "event_type = 'ADMISSION_RECONCILED'::text",
    );

    const fk = await db().one<{ column: string; on_delete: string }>(
      `SELECT a.attname AS column, con.confdeltype::text AS on_delete
       FROM pg_constraint con
       JOIN unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE con.conrelid = 'cost_event'::regclass
         AND con.contype = 'f'
         AND con.confrelid = 'search'::regclass`,
    );
    expect(fk.column).toBe("search_id");
    expect(fk.on_delete).toBe("c"); // pg_constraint.confdeltype: 'c' = ON DELETE CASCADE
  });
});

describe("tier 0 — retention least-privilege boundary (ADR 0077 D7, migration 022)", () => {
  const db = useDatabase();

  // The scheduler's only authority: the seven 006_retention.sql maintenance wrappers
  // plus the check wrapper 022 adds. Every name below is an exact regprocedure
  // signature — a near-miss (wrong arg type, missing arg) fails to cast and fails loud.
  const ENTRY_POINTS = [
    "maintain_partition_lookahead()",
    "drop_snapshot_partitions(integer)",
    "drop_event_partitions(integer)",
    "delete_expired_snapshot_default_rows(integer)",
    "delete_expired_event_default_rows(integer)",
    "delete_expired_sessions(integer)",
    "delete_expired_searches(integer)",
    "check_default_partitions_empty()",
  ] as const;

  it("all eight entry points are SECURITY DEFINER with the fixed search path", async () => {
    const rows = await db().rows<{ signature: string; secdef: boolean; config: string[] | null }>(
      `SELECT sig AS signature, p.prosecdef AS secdef, p.proconfig AS config
       FROM unnest($1::text[]) AS sig
       JOIN pg_proc p ON p.oid = sig::regprocedure`,
      [[...ENTRY_POINTS]],
    );
    expect(rows.map((row) => row.signature).sort()).toEqual([...ENTRY_POINTS].sort());
    for (const row of rows) {
      // prosecdef pins DEFINER; the exact one-element proconfig pins
      // SET search_path = public, pg_temp (trailing pg_temp keeps temp objects from
      // shadowing catalog tables — any reordering or extra entry fails here).
      expect(row.secdef, row.signature).toBe(true);
      expect(row.config, row.signature).toEqual(["search_path=public, pg_temp"]);
    }
  });

  it("the worker holds EXECUTE on all eight and no direct SELECT on either DEFAULT table", async () => {
    const exec = await db().rows<{ signature: string; can: boolean }>(
      `SELECT sig AS signature,
              has_function_privilege('retention_worker', sig::regprocedure, 'EXECUTE') AS can
       FROM unnest($1::text[]) AS sig`,
      [[...ENTRY_POINTS]],
    );
    expect(exec.map((row) => row.signature).sort()).toEqual([...ENTRY_POINTS].sort());
    for (const row of exec) expect(row.can, row.signature).toBe(true);

    const tables = await db().rows<{ name: string; can: boolean }>(
      `SELECT rel AS name,
              has_table_privilege('retention_worker', 'public.' || rel, 'SELECT') AS can
       FROM unnest($1::text[]) AS rel`,
      [["availability_snapshot_default", "events_default"]],
    );
    expect(tables.map((row) => row.name).sort()).toEqual([
      "availability_snapshot_default",
      "events_default",
    ]);
    for (const row of tables) expect(row.can, row.name).toBe(false);
  });

  it("as the worker, the check wrapper reads true on an empty database while a direct DEFAULT read is denied", async () => {
    // SET ROLE on a second connection: no worker credential exists (the global-setup
    // role is NOLOGIN), and the main db() handle must stay superuser for the
    // afterEach invariant sweep. A fresh template clone has empty DEFAULT tables, so
    // the wrapper — SECURITY DEFINER over tables the caller cannot read — is true.
    const worker = await db().connect();
    try {
      await worker.query(`SET ROLE retention_worker`);
      const { rows } = await worker.query(`SELECT check_default_partitions_empty() AS empty`);
      expect(rows[0].empty).toBe(true);
      await expect(
        worker.query(`SELECT 1 FROM availability_snapshot_default LIMIT 1`),
      ).rejects.toThrow(/permission denied/i);
      await expect(worker.query(`SELECT 1 FROM events_default LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await worker.query(`RESET ROLE`).catch(() => undefined);
      await worker.end().catch(() => undefined);
    }
  });
});

describe("tier 0 — seatfirst_app least-privilege boundary (ADR 0081 §9)", () => {
  const db = useDatabase();

  it("the runtime query set succeeds as seatfirst_app while DDL, TRUNCATE, and ALTER ROLE are denied", async () => {
    // SET ROLE on a second connection: no app credential exists (the global-setup
    // role is NOLOGIN), and the main db() handle must stay superuser for the
    // afterEach invariant sweep.
    const app = await db().connect();
    try {
      await app.query(`SET ROLE seatfirst_app`);
      const appDb = session(app);
      // Positive controls first: the denials below can only mean "outside the
      // grant" if the same role demonstrably reads and writes. Both go through
      // the repository's real query paths, never hand-rolled SQL.
      expect(await browseTheatres(appDb)).toEqual([]);
      const sess = await upsertSession(appDb, { sessionId: "sess_app_boundary_probe" });
      expect(sess.sessionId).toBe("sess_app_boundary_probe");
      // DDL needs CREATE on the schema (the role holds USAGE only), TRUNCATE
      // needs the TRUNCATE privilege (the blanket grant is
      // SELECT/INSERT/UPDATE/DELETE), and ALTER ROLE needs CREATEROLE — all
      // three fail before touching anything.
      await expect(
        app.query(`CREATE TABLE app_boundary_probe (id text PRIMARY KEY)`),
      ).rejects.toThrow(/permission denied/i);
      await expect(app.query(`TRUNCATE session`)).rejects.toThrow(/permission denied/i);
      await expect(app.query(`ALTER ROLE seatfirst_app WITH NOLOGIN`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await app.query(`RESET ROLE`).catch(() => undefined);
      await app.end().catch(() => undefined);
    }
  });

  it("the function allowlist is explicit: a granted runtime function executes while a worker-only maintenance function is denied", async () => {
    // New functions grant EXECUTE TO PUBLIC by default, so each probe revokes
    // PUBLIC first — otherwise the denial below would rest on the default
    // rather than on the allowlist (the pitfall 14-app-role.sh closes).
    await db().query(
      `CREATE FUNCTION app_allowlist_runtime_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`,
    );
    await db().query(`REVOKE ALL ON FUNCTION app_allowlist_runtime_probe() FROM PUBLIC`);
    await db().query(`GRANT EXECUTE ON FUNCTION app_allowlist_runtime_probe() TO seatfirst_app`);
    await db().query(
      `CREATE FUNCTION app_allowlist_maintenance_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$`,
    );
    await db().query(`REVOKE ALL ON FUNCTION app_allowlist_maintenance_probe() FROM PUBLIC`);
    await db().query(
      `GRANT EXECUTE ON FUNCTION app_allowlist_maintenance_probe() TO retention_worker`,
    );
    const caller = await db().connect();
    try {
      await caller.query(`SET ROLE seatfirst_app`);
      const { rows } = await caller.query(`SELECT app_allowlist_runtime_probe() AS v`);
      expect(rows[0].v).toBe(1);
      await expect(caller.query(`SELECT app_allowlist_maintenance_probe()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await caller.query(`RESET ROLE`).catch(() => undefined);
      await caller.end().catch(() => undefined);
    }
  });
});

describe("tier 0 — restore_sentinel retirement (ADR 0090 §3, migration 024)", () => {
  const db = useDatabase();

  it("drops both the heartbeat table and its prune function; neither exists after migration", async () => {
    // ADR 0081 §8 introduced an hourly restore_sentinel heartbeat table and a
    // prune_restore_sentinel() function to prove PITR attainment. ADR 0090 §3
    // retires both as unnecessary given the simplified restore posture —
    // migration 024 drops them. This replaces the old privilege-boundary tests
    // for a table and function that no longer exist.
    const table = await db().one<{ regclass: string | null }>(
      `SELECT to_regclass('public.restore_sentinel')::text AS regclass`,
    );
    expect(table.regclass).toBeNull();

    const fn = await db().rows<{ oid: number }>(
      `SELECT oid FROM pg_proc WHERE proname = 'prune_restore_sentinel'`,
    );
    expect(fn).toHaveLength(0);
  });
});
