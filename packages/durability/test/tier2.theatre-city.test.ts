import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import { searchTheatresByName, upsertTheatre } from "../src/repository.js";
import type { UpsertTheatreInput } from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

const seenAt = new Date("2026-08-01T00:00:00.000Z");

function theatreInput(theatreId: string, name: string, city: string | null): UpsertTheatreInput {
  return {
    theatreId,
    providerId: "amc",
    name,
    lat: 41,
    lng: -87,
    marketSlug: null,
    timezone: "America/Chicago",
    city,
    address: city ? `123 Main St, ${city}, IL, 60601` : null,
    slugs: { detail: theatreId },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}

describe("tier 2 — theatre city search (ADR 0029 §7)", () => {
  const db = useDatabase();

  it("finds a theatre by city alone, not by name (ADR 0029 §7 (a))", async () => {
    // Theatre named "Riverside Cinema" located in Sunnyvale — q=Sunnyvale should match via city,
    // even though name contains no "Sunnyvale".
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput("amc:theatre:sunnyvale", "Riverside Cinema", "Sunnyvale"),
      ),
    );
    // Control theatre in different city, different name.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:other", "Grand Palace", "Chicago")),
    );

    const sunnyvale = await searchTheatresByName(db(), "Sunnyvale");
    expect(sunnyvale.map((r) => r.theatre_id)).toEqual(["amc:theatre:sunnyvale"]);
    expect(sunnyvale[0]?.city).toBe("Sunnyvale");

    // Case-insensitive: lowercase query matches city.
    const lower = await searchTheatresByName(db(), "sunnyvale");
    expect(lower.map((r) => r.theatre_id)).toEqual(["amc:theatre:sunnyvale"]);

    // Uppercase likewise.
    const upper = await searchTheatresByName(db(), "SUNNYVALE");
    expect(upper.map((r) => r.theatre_id)).toEqual(["amc:theatre:sunnyvale"]);

    // Positive control: query matching no city's theatre returns zero.
    expect(await searchTheatresByName(db(), "NoSuchCity")).toEqual([]);
  });

  it("leaves theatres with no city unaffected — still findable by name, never errors on null city", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:nocity", "Alpha Cinemas", null)),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:withcity", "Beta Cinemas", "Sunnyvale")),
    );

    // Name search still works for the null-city theatre.
    const byName = await searchTheatresByName(db(), "Alpha");
    expect(byName.map((r) => r.theatre_id)).toEqual(["amc:theatre:nocity"]);
    expect(byName[0]?.city).toBeNull();

    // City search does not error when rows have null city; it returns only the city-matching row.
    const byCity = await searchTheatresByName(db(), "Sunnyvale");
    expect(byCity.map((r) => r.theatre_id)).toEqual(["amc:theatre:withcity"]);

    // Searching for a string that matches neither name nor city returns zero, exercising zeroRowsMeans.
    const missing = await searchTheatresByName(db(), "zzzz-no-such-theatre-or-city");
    expect(missing).toEqual([]);
    expect(() => expectRow(B.THEATRE_NAME_SEARCH, missing)).toThrow(
      B.THEATRE_NAME_SEARCH.zeroRowsMeans,
    );
  });

  it("preserves existing name-only behavior for queries that don't match any city", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:alpha", "Alpha Cinemas", "Sunnyvale")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:beta", "beta Cinemas", "Chicago")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:gamma", "Gamma Palace", "Sunnyvale")),
    );

    // Substring "cinemas" matches two theatres by name, in name order, regardless of city.
    const cinemas = await searchTheatresByName(db(), "cinemas");
    expect(cinemas.map((r) => r.name)).toEqual(["Alpha Cinemas", "beta Cinemas"]);

    // A name-only query that matches no city still returns name matches only.
    const alpha = await searchTheatresByName(db(), "alpha");
    expect(alpha.map((r) => r.name)).toEqual(["Alpha Cinemas"]);

    // City query still works alongside.
    const chicago = await searchTheatresByName(db(), "Chicago");
    expect(chicago.map((r) => r.theatre_id)).toEqual(["amc:theatre:beta"]);
  });

  it("treats LIKE metacharacters literally in city matching (same escaping as name)", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput("amc:theatre:pctcity", "Riverside Cinema", "100% City"),
      ),
    );
    // Positive control: a city that would falsely match if `%` were wildcard.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:nopctcity", "Other Cinema", "100 City")),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput("amc:theatre:underscorecity", "Third Cinema", "Old_Town"),
      ),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput("amc:theatre:nounderscorecity", "Fourth Cinema", "OldTown"),
      ),
    );

    const pct = await searchTheatresByName(db(), "100% City");
    expect(pct.map((r) => r.city)).toEqual(["100% City"]);

    const underscore = await searchTheatresByName(db(), "Old_Town");
    expect(underscore.map((r) => r.city)).toEqual(["Old_Town"]);
  });
});
