import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import { searchTheatresByName, upsertTheatre } from "../src/repository.js";
import type { UpsertTheatreInput } from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

const seenAt = new Date("2026-08-01T00:00:00.000Z");

function theatreInput(theatreId: string, name: string): UpsertTheatreInput {
  return {
    theatreId,
    providerId: "amc",
    name,
    lat: 41,
    lng: -87,
    marketSlug: null,
    timezone: "America/Chicago",
    city: null,
    address: null,
    slugs: { detail: theatreId },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}

describe("tier 2 — theatre name search (S20)", () => {
  const db = useDatabase();

  it("matches only the catalogued rows, case-insensitively, in name order", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:a", "Alpha Cinemas")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:b", "beta Cinemas")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:c", "Gamma Palace")),
    );

    // Case-insensitive ILIKE: a lowercase and an UPPERCASE query both match the row.
    const lower = await searchTheatresByName(db(), "alpha");
    expect(lower.map((r) => r.name)).toEqual(["Alpha Cinemas"]);
    const upper = await searchTheatresByName(db(), "ALPHA");
    expect(upper.map((r) => r.name)).toEqual(["Alpha Cinemas"]);

    // Substring match returns every match in deterministic `name, theatre_id` order.
    const cinemas = await searchTheatresByName(db(), "cinemas");
    expect(cinemas.map((r) => r.name)).toEqual(["Alpha Cinemas", "beta Cinemas"]);

    // A query matching no row returns zero rows (positive control for the above).
    expect(await searchTheatresByName(db(), "planetarium")).toEqual([]);
  });

  it("treats LIKE metacharacters literally (no wildcard expansion)", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:pct", "Riverside 100% Cinema")),
    );
    // Positive control: a name that would FALSELY match if `%` were a wildcard.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:space", "Riverside 100 Cinema")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:under", "Old_Town Theatre")),
    );
    // Positive control: a name that would FALSELY match if `_` were a wildcard.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:nounderscore", "OldTown Theatre")),
    );

    const pct = await searchTheatresByName(db(), "100%");
    expect(pct.map((r) => r.name)).toEqual(["Riverside 100% Cinema"]);

    const underscore = await searchTheatresByName(db(), "Old_Town");
    expect(underscore.map((r) => r.name)).toEqual(["Old_Town Theatre"]);
  });

  it("orders equal-name ties by theatre_id deterministically", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:b", "Same Name")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:a", "Same Name")),
    );
    const rows = await searchTheatresByName(db(), "Same Name");
    expect(rows.map((r) => r.theatre_id)).toEqual(["amc:theatre:a", "amc:theatre:b"]);
  });

  it("returns 0 rows for an unknown name and exposes the zero-row meaning", async () => {
    expectRow(B.THEATRE_UPSERT, await upsertTheatre(db(), theatreInput("amc:theatre:a", "Alpha")));
    const missing = await searchTheatresByName(db(), "zzzz-no-such-theatre");
    expect(missing).toEqual([]);
    expect(() => expectRow(B.THEATRE_NAME_SEARCH, missing)).toThrow(
      B.THEATRE_NAME_SEARCH.zeroRowsMeans,
    );
  });
});
