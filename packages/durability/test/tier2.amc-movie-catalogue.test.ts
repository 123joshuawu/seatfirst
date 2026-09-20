import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import {
  browseAmcMovieCatalogue,
  completeAmcMovieCatalogueCrawl,
  readAmcMovieCatalogueState,
  upsertAmcMovieCatalogue,
  upsertMovie,
} from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

const seenAt = new Date("2026-09-01T00:00:00.000Z");

/**
 * Tier 2 — the AMC movies catalogue's boundaries (ADR 0102 decisions 1 and 4): the
 * daily-pass checkpoint (zero rows = immediately due, COMPLETE upserts the singleton)
 * and the upsert-only catalogue write with its schedule-matched browse read. Lowest
 * tier that catches each bug (the checkpoint is a singleton upsert; the browse is a
 * LEFT JOIN effect against the AMC-observed `movie` catalogue by normalized title).
 */
describe("tier 2 — AMC movies catalogue state and browse (ADR 0102)", () => {
  const db = useDatabase();

  it("AMC_MOVIE_CATALOGUE_STATE_READ returns [] before any pass, and COMPLETE upserts the singleton", async () => {
    expect(await readAmcMovieCatalogueState(db())).toEqual([]);

    const first = expectRow(
      B.AMC_MOVIE_CATALOGUE_STATE_COMPLETE,
      await completeAmcMovieCatalogueCrawl(db()),
    );
    expect(first.last_completed_at).toBeInstanceOf(Date);

    const state = await readAmcMovieCatalogueState(db());
    expect(state).toHaveLength(1);
    expect(state[0]!.last_completed_at).toEqual(first.last_completed_at);

    const second = expectRow(
      B.AMC_MOVIE_CATALOGUE_STATE_COMPLETE,
      await completeAmcMovieCatalogueCrawl(db()),
    );
    expect(second.last_completed_at!.getTime()).toBeGreaterThanOrEqual(
      first.last_completed_at!.getTime(),
    );
    const count = await db().one<{ n: string }>(
      `SELECT count(*)::text AS n FROM amc_movie_catalogue_state`,
    );
    expect(count.n).toBe("1");
  });

  it("AMC_MOVIE_CATALOGUE_UPSERT round-trips a row, and BROWSE LEFT JOINs the AMC-observed schedule by normalized title", async () => {
    // The schedule-observed side: a `movie` row whose title the catalogue row matches
    // only after the two-sided lower(btrim(...)) normalization (mixed case + padding).
    expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(db(), {
        movieId: "amc:movie:odyssey",
        providerId: "amc",
        title: "The Odyssey",
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      }),
    );

    const upserted = expectRow(
      B.AMC_MOVIE_CATALOGUE_UPSERT,
      await upsertAmcMovieCatalogue(db(), {
        movieId: 101,
        slug: "the-odyssey",
        name: "  THE ODYSSEY ",
        mpaaRating: "PG-13",
        runtimeMinutes: 142,
        releaseDate: "2026-07-01",
        status: "Now Playing",
        imageUrl: "https://example.com/odyssey.jpg",
        detailsPath: "/movies/the-odyssey",
        showtimesPath: "/movies/the-odyssey/showtimes",
      }),
    );
    expect(upserted).toMatchObject({
      movie_id: 101,
      slug: "the-odyssey",
      mpaa_rating: "PG-13",
      runtime_minutes: 142,
      release_date: "2026-07-01",
      status: "Now Playing",
    });
    expect(upserted.first_seen_at).toBeInstanceOf(Date);
    expect(upserted.updated_at).toBeInstanceOf(Date);

    // Catalogue-only: never observed on a live schedule, so the JOIN yields nulls.
    expectRow(
      B.AMC_MOVIE_CATALOGUE_UPSERT,
      await upsertAmcMovieCatalogue(db(), {
        movieId: 202,
        slug: "catalogue-only-film",
        name: "Catalogue Only Film",
        mpaaRating: null,
        runtimeMinutes: null,
        releaseDate: null,
        status: null,
        imageUrl: null,
        detailsPath: null,
        showtimesPath: null,
      }),
    );

    const slate = await browseAmcMovieCatalogue(db(), 10);
    expect(slate).toHaveLength(2);

    const matched = slate.find((row) => row.movie_id === 101)!;
    expect(matched.amc_movie_id).toBe("amc:movie:odyssey");
    expect(matched.amc_title).toBe("The Odyssey");

    const unmatched = slate.find((row) => row.movie_id === 202)!;
    expect(unmatched.amc_movie_id).toBeNull();
    expect(unmatched.amc_title).toBeNull();
  });
});
