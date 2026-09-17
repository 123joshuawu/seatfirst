import { describe, expect, it } from "vitest";

import { ALL_STATEMENTS } from "../src/boundaries.js";

import { useSharedDatabase } from "./support/pg.js";

/**
 * Tier 1 — every boundary statement PREPAREs against the live schema.
 *
 * `PREPARE` parses, rewrites and plans without executing: a column that does not exist, a
 * table that moved, a CTE referenced outside the statement that declares it, or a
 * parameter whose type cannot be resolved all fail here, in milliseconds, naming the
 * statement. Would have caught immediately: R4#4 (`route_class` derived from a column that
 * did not exist), R3#7 (`epoch` selected from the wrong table after round 2 moved it),
 * R3#5 (`WITH` scoped to one statement).
 */
describe("tier 1 — statements execute", () => {
  const db = useSharedDatabase();

  it("statement names are unique — the ADR cites them, so they must resolve", () => {
    const names = ALL_STATEMENTS.map((s) => s.name);
    expect(new Set(names).size, `duplicates in ${names.join(", ")}`).toBe(names.length);
  });

  it.each(ALL_STATEMENTS.map((s) => [s.name, s] as const))(
    "%s prepares, and takes exactly the parameters it documents",
    async (_name, s) => {
      const handle = `p_${s.name.toLowerCase()}`;
      await db().query(`PREPARE ${handle} AS ${s.text}`);

      const { parameter_types } = await db().one<{ parameter_types: string[] }>(
        `SELECT parameter_types::text[] AS parameter_types
         FROM pg_prepared_statements WHERE name = $1`,
        [handle],
      );
      expect(
        parameter_types.length,
        `${s.name} documents ${s.params.length} params (${s.params.join(", ") || "none"}) but ` +
          `the statement takes ${parameter_types.length} (${parameter_types.join(", ")})`,
      ).toBe(s.params.length);
    },
  );

  it('every statement returns rows, so "0 rows means the caller lost" is checkable', () => {
    const firstKeyword = (sql: string) =>
      sql
        .split("\n")
        .map((l) => l.replace(/--.*$/, "").trim())
        .find((l) => l.length > 0) ?? "";
    const silent = ALL_STATEMENTS.filter(
      (s) => !/\bRETURNING\b/i.test(s.text) && !/^SELECT/i.test(firstKeyword(s.text)),
    );
    expect(silent.map((s) => s.name)).toEqual([]);
  });

  it("the movie catalogue write path carries no image-shaped field or URL (S24 verification 6; S25)", () => {
    const imageish = /image|poster|thumbnail|avatar|\.jpe?g|\.png|\.webp|srcset|cloudinary/i;
    // S24 kept the AMC `movie` write path clean of any poster/media data (ADR 0002 §2.8
    // constraint 3). S25 widens MOVIE_READ_BY_ID to LEFT JOIN the decoupled tmdb_movie
    // table and expose poster_path at read time (ADR 0019 §2) — so only the write
    // boundary (MOVIE_UPSERT) is held to the no-image rule; the read boundary is now a
    // TMDB-augmented projection, which is the point of S25.
    const write = ALL_STATEMENTS.find((s) => s.name === "MOVIE_UPSERT");
    expect(write, "MOVIE_UPSERT boundary missing").toBeDefined();
    expect(write!.text).not.toMatch(imageish);
    expect(write!.params.join(" ")).not.toMatch(imageish);
  });

  it("every boundary named in ADR 0001 §2 has at least one statement", () => {
    const covered = new Set(ALL_STATEMENTS.map((s) => s.boundary.replace(/\(.*/, "")));
    for (const b of ["B1", "B2", "B3", "B4", "B5", "B5F", "B6", "B7", "B8", "B9", "B10"]) {
      expect([...covered], `no statement carries boundary ${b}`).toContain(b);
    }
  });
});
