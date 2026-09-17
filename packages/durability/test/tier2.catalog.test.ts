import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import { checkInvariants, INVARIANTS } from "../src/invariants.js";
import {
  appendEvent,
  browseTheatres,
  findTheatresWithinRadius,
  readMovieById,
  readTheatreById,
  updatePerformanceProduct,
  upsertMovie,
  upsertTheatre,
  upsertTmdbMovie,
} from "../src/repository.js";
import type {
  UpdatePerformanceProductInput,
  UpsertMovieInput,
  UpsertTheatreInput,
} from "../src/repository.js";

import {
  acceptFetch,
  acceptSchedule,
  createSearch,
  dispatchRun,
  fetchKey,
  scheduleKey,
  seedProvider,
  subscribe,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

const seenFirst = new Date("2026-08-01T00:00:00.000Z");
const seenLater = new Date("2026-08-02T00:00:00.000Z");

function theatreInput(
  theatreId: string,
  name: string,
  lat: number,
  lng: number,
  firstSeenAt = seenFirst,
  lastSeenAt = seenFirst,
): UpsertTheatreInput {
  return {
    theatreId,
    providerId: "amc",
    name,
    lat,
    lng,
    marketSlug: null,
    timezone: "America/Chicago",
    city: null,
    address: null,
    slugs: { detail: theatreId },
    firstSeenAt,
    lastSeenAt,
  };
}

describe("tier 2 — theatre catalogue and product persistence", () => {
  const db = useDatabase();

  it("upserts theatre observations without refreshing first_seen_at", async () => {
    const theatreId = "amc:theatre:upsert";
    const inserted = expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput(theatreId, "Original", 41.88, -87.63, seenFirst, seenFirst),
      ),
    );
    expect(inserted.name).toBe("Original");

    // A separate autocommitted observation claims a LATER first_seen_at too, not just a
    // later last_seen_at. That makes the "unchanged" assertion below falsifiable: a wrong
    // implementation that refreshes first_seen_at on conflict would set it to seenLater,
    // which would differ from inserted.first_seen_at (seenFirst) — if both calls passed the
    // same firstSeenAt, that bug would be invisible because EXCLUDED.first_seen_at would
    // happen to equal the stored value either way.
    const updated = expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(
        db(),
        theatreInput(theatreId, "Renamed", 41.88, -87.63, seenLater, seenLater),
      ),
    );
    expect(updated.name).toBe("Renamed");
    expect(updated.first_seen_at).toEqual(inserted.first_seen_at);
    expect(updated.last_seen_at.getTime()).toBeGreaterThan(inserted.last_seen_at.getTime());
  });

  it("does not let a stale observation regress last_seen_at (B2a monotonicity)", async () => {
    const theatreId = "amc:theatre:monotonic";
    const fresh = expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput(theatreId, "Fresh", 10, 10, seenFirst, seenLater)),
    );
    expect(fresh.last_seen_at).toEqual(seenLater);

    // A late-arriving, stale observation reports an EARLIER last_seen_at than what is
    // already stored (seenFirst < seenLater). The greatest() guard must keep the later
    // value: a wrong implementation that does `last_seen_at = EXCLUDED.last_seen_at`
    // unconditionally would regress it to seenFirst here.
    const stale = expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput(theatreId, "Stale", 10, 10, seenFirst, seenFirst)),
    );
    expect(stale.last_seen_at).toEqual(seenLater);
    expect(stale.first_seen_at).toEqual(seenFirst);
  });

  it("reads exactly the requested theatre and exposes its zero-row meaning", async () => {
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:one", "One", 41, -87)),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:two", "Two", 42, -88)),
    );

    expect(await readTheatreById(db(), "amc:theatre:two")).toMatchObject([
      { theatre_id: "amc:theatre:two", name: "Two" },
    ]);
    const missing = await readTheatreById(db(), "amc:theatre:missing");
    expect(missing).toEqual([]);
    expect(() => expectRow(B.THEATRE_READ_BY_ID, missing)).toThrow(
      B.THEATRE_READ_BY_ID.zeroRowsMeans,
    );
  });

  it("honours the caller's radius with independently derived inside and outside points", async () => {
    // At the equator, one degree of latitude is about 111.195 km. Therefore 0.1° is
    // about 11.12 km and 0.2° about 22.24 km, independently of the SQL implementation.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:inside", "Inside", 0.1, 0)),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:outside", "Outside", 0.2, 0)),
    );

    const narrow = await findTheatresWithinRadius(db(), {
      originLat: 0,
      originLng: 0,
      radiusKm: 15,
    });
    expect(narrow.map((row) => row.theatre_id)).toEqual(["amc:theatre:inside"]);

    const wide = await findTheatresWithinRadius(db(), {
      originLat: 0,
      originLng: 0,
      radiusKm: 25,
    });
    expect(wide.map((row) => row.theatre_id)).toEqual([
      "amc:theatre:inside",
      "amc:theatre:outside",
    ]);
    expect(
      await findTheatresWithinRadius(db(), { originLat: 40, originLng: 40, radiusKm: 1 }),
    ).toEqual([]);
  });

  it("browses the catalogue in name, theatre_id order and exposes its zero-row meaning (S49.5)", async () => {
    // Insert out of alphabetical order to prove the boundary's ORDER BY, not insertion order.
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:zeta", "Zeta", 41, -87)),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:alpha-b", "Alpha", 41, -87)),
    );
    expectRow(
      B.THEATRE_UPSERT,
      await upsertTheatre(db(), theatreInput("amc:theatre:alpha-a", "Alpha", 41, -87)),
    );

    const rows = await browseTheatres(db());
    expect(rows.map((row) => row.theatre_id)).toEqual([
      "amc:theatre:alpha-a",
      "amc:theatre:alpha-b",
      "amc:theatre:zeta",
    ]);
    // Empty catalogue still respects the boundary: use a fresh truncation to prove zero-row path.
    await db().query("TRUNCATE theatre CASCADE");
    const empty = await browseTheatres(db());
    expect(empty).toEqual([]);
    expect(() => expectRow(B.THEATRE_BROWSE, empty)).toThrow(B.THEATRE_BROWSE.zeroRowsMeans);
    expect(B.THEATRE_BROWSE.boundary).toBe("catalogue");
    expect(B.THEATRE_BROWSE.zeroRowsMeans).toBe("the theatre catalogue is empty.");
  });

  it("updates product fields without replacing schedule lifecycle data", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "amc:theatre:product", "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 1 });
    await subscribe(db(), search, key);
    const run = await dispatchRun(db(), key);
    const showtimeId = "amc:showtime:product";
    await acceptSchedule(db(), run, [
      {
        showtimeId,
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T20:00:00.000Z"),
        skipFetch: false,
      },
    ]);

    // Product-resolution seed data: the FK target is content-addressed layout state.
    await db().query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2, $3, $4)`,
      ["layout_product", Buffer.from([0]), 1, 1],
    );
    // Test scaffolding, not a boundary transition: seed a non-empty attributes value. B5C_
    // PERFORMANCE always writes attributes as {} (test/support/fixtures.ts:268), and {} is
    // matched by ANY object under `toMatchObject({ attributes: {} })` — so leaving it at {}
    // would let a product-column write that clobbers attributes pass by coincidence.
    await db().query(`UPDATE performance SET attributes = $2::jsonb WHERE showtime_id = $1`, [
      showtimeId,
      JSON.stringify({ seeded: true }),
    ]);

    const before = await db().one<{
      local_date: string;
      observation_id: string;
      attributes: unknown;
      created_at: Date;
    }>(
      `SELECT local_date, observation_id, attributes, created_at
       FROM performance WHERE showtime_id = $1`,
      [showtimeId],
    );
    const firstUpdatedAt = new Date();
    const secondUpdatedAt = new Date(firstUpdatedAt.getTime() + 1_000);
    const productInput = (minPrice: number, updatedAt: Date): UpdatePerformanceProductInput => ({
      showtimeId,
      movieId: "amc:movie:product",
      auditorium: "Auditorium 7",
      utcOffset: "-05:00",
      runtimeMinutes: 120,
      status: "OPEN",
      formatCode: "IMAX",
      minPrice,
      deepLinkUrl: "https://example.invalid/showtime/product",
      providerMeta: { rawStatus: "Available" },
      layoutId: "layout_product",
      updatedAt,
    });

    // The typed wrapper preserves the statement's zero-row loser path too.
    expect(
      await updatePerformanceProduct(db(), {
        ...productInput(1, firstUpdatedAt),
        showtimeId: "amc:showtime:missing",
        layoutId: null,
      }),
    ).toEqual([]);

    const first = expectRow(
      B.PERFORMANCE_UPDATE_PRODUCT,
      await updatePerformanceProduct(db(), productInput(17.5, firstUpdatedAt)),
    );
    expect(first.showtime_id).toBe(showtimeId);

    const afterFirst = await db().one<{
      movie_id: string;
      status: string;
      min_price: string;
      provider_meta: unknown;
      local_date: string;
      observation_id: string;
      attributes: unknown;
      created_at: Date;
    }>(`SELECT * FROM performance WHERE showtime_id = $1`, [showtimeId]);
    expect(afterFirst).toMatchObject({
      movie_id: "amc:movie:product",
      status: "OPEN",
      min_price: "17.5",
      provider_meta: { rawStatus: "Available" },
      local_date: before.local_date,
      observation_id: before.observation_id,
    });
    // toMatchObject({ attributes: {} }) would match ANY object value, so the seeded
    // non-empty attributes above plus a strict toEqual are both required for this to be
    // falsifiable against a SET list that clobbers attributes.
    expect(afterFirst.attributes).toEqual(before.attributes);
    expect(afterFirst.created_at).toEqual(before.created_at);

    const second = expectRow(
      B.PERFORMANCE_UPDATE_PRODUCT,
      await updatePerformanceProduct(db(), productInput(18.25, secondUpdatedAt)),
    );
    const afterSecond = await db().one<{ min_price: string; created_at: Date }>(
      `SELECT min_price, created_at FROM performance WHERE showtime_id = $1`,
      [showtimeId],
    );
    expect(afterSecond.min_price).toBe("18.25");
    expect(afterSecond.created_at).toEqual(before.created_at);
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
  });
});

describe("tier 2 — movie catalogue", () => {
  const db = useDatabase();

  function movieInput(
    movieId: string,
    title: string,
    firstSeenAt = seenFirst,
    lastSeenAt = seenFirst,
  ): UpsertMovieInput {
    return { movieId, providerId: "amc", title, firstSeenAt, lastSeenAt };
  }

  it("upserts movie observations without refreshing first_seen_at", async () => {
    const movieId = "amc:movie:upsert";
    const inserted = expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(db(), movieInput(movieId, "The Odyssey", seenFirst, seenFirst)),
    );
    expect(inserted.title).toBe("The Odyssey");

    // A separate autocommitted observation claims a LATER first_seen_at too, not just a
    // later last_seen_at — the same falsifiability discipline as the theatre mirror above:
    // a wrong implementation that refreshed first_seen_at on conflict would set it to
    // seenLater, which differs from inserted.first_seen_at (seenFirst).
    const updated = expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(db(), movieInput(movieId, "The Odyssey: Reloaded", seenLater, seenLater)),
    );
    expect(updated.title).toBe("The Odyssey: Reloaded");
    expect(updated.first_seen_at).toEqual(inserted.first_seen_at);
    expect(updated.last_seen_at.getTime()).toBeGreaterThan(inserted.last_seen_at.getTime());
  });

  it("does not let a stale observation regress last_seen_at (MOVIE_UPSERT monotonicity)", async () => {
    const movieId = "amc:movie:monotonic";
    const fresh = expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(db(), movieInput(movieId, "Fresh", seenFirst, seenLater)),
    );
    expect(fresh.last_seen_at).toEqual(seenLater);

    // A late-arriving, stale observation reports an EARLIER last_seen_at (seenFirst <
    // seenLater); the greatest() guard must keep the later value.
    const stale = expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(db(), movieInput(movieId, "Stale", seenFirst, seenFirst)),
    );
    expect(stale.last_seen_at).toEqual(seenLater);
    expect(stale.first_seen_at).toEqual(seenFirst);
  });

  it("reads exactly the requested movie and exposes its zero-row meaning", async () => {
    expectRow(B.MOVIE_UPSERT, await upsertMovie(db(), movieInput("amc:movie:one", "One")));
    expectRow(B.MOVIE_UPSERT, await upsertMovie(db(), movieInput("amc:movie:two", "Two")));

    expect(await readMovieById(db(), "amc:movie:two")).toMatchObject([
      { movie_id: "amc:movie:two", title: "Two" },
    ]);
    const missing = await readMovieById(db(), "amc:movie:missing");
    expect(missing).toEqual([]);
    expect(() => expectRow(B.MOVIE_READ_BY_ID, missing)).toThrow(B.MOVIE_READ_BY_ID.zeroRowsMeans);
  });

  it("rejects movie rows that violate the movie table CHECKs", async () => {
    // Unnamespaced id — no `:movie:` segment at all.
    await expect(upsertMovie(db(), movieInput("plain-id", "No"))).rejects.toThrow();
    // Foreign kind — theatre, not movie.
    await expect(upsertMovie(db(), movieInput("amc:theatre:one", "No"))).rejects.toThrow();
    // Blank (whitespace-only) title trips `btrim(title) <> ''`.
    await expect(upsertMovie(db(), movieInput("amc:movie:blank", "   "))).rejects.toThrow();
    // split_part(movie_id, ':', 1) must equal provider_id.
    await expect(
      upsertMovie(db(), {
        movieId: "other:movie:1",
        providerId: "amc",
        title: "No",
        firstSeenAt: seenFirst,
        lastSeenAt: seenFirst,
      }),
    ).rejects.toThrow();
    // last_seen_at must be >= first_seen_at.
    await expect(
      upsertMovie(db(), movieInput("amc:movie:order", "No", seenLater, seenFirst)),
    ).rejects.toThrow();
  });

  it("upserts tmdb_movie metadata and refreshes updated_at on conflict (TMDB_MOVIE_UPSERT)", async () => {
    const inserted = expectRow(
      B.TMDB_MOVIE_UPSERT,
      await upsertTmdbMovie(db(), {
        tmdbId: 123,
        normalizedTitle: "the odyssey",
        posterPath: "/abc.jpg",
        runtimeMinutes: 128,
        genres: ["Action", "Adventure"],
      }),
    );
    expect(inserted.tmdb_id).toBe(123);
    expect(inserted.normalized_title).toBe("the odyssey");
    expect(inserted.poster_path).toBe("/abc.jpg");
    expect(inserted.runtime_minutes).toBe(128);
    expect(inserted.genres).toEqual(["Action", "Adventure"]);
    expect(inserted.updated_at).toBeInstanceOf(Date);

    // A later upsert for the same tmdb_id refreshes poster_path, runtime, genres, updated_at.
    const reupserted = expectRow(
      B.TMDB_MOVIE_UPSERT,
      await upsertTmdbMovie(db(), {
        tmdbId: 123,
        normalizedTitle: "the odyssey",
        posterPath: "/new.jpg",
        runtimeMinutes: 130,
        genres: ["Drama"],
      }),
    );
    expect(reupserted.poster_path).toBe("/new.jpg");
    expect(reupserted.runtime_minutes).toBe(130);
    expect(reupserted.genres).toEqual(["Drama"]);
    expect(reupserted.normalized_title).toBe("the odyssey");
    expect(reupserted.updated_at.getTime()).toBeGreaterThanOrEqual(inserted.updated_at.getTime());
  });

  it("normalized_title UNIQUE rejects two distinct tmdb_ids for the same normalized title", async () => {
    expectRow(
      B.TMDB_MOVIE_UPSERT,
      await upsertTmdbMovie(db(), {
        tmdbId: 1,
        normalizedTitle: "duplicate",
        posterPath: "/a.jpg",
        runtimeMinutes: null,
        genres: [],
      }),
    );
    await expect(
      upsertTmdbMovie(db(), {
        tmdbId: 2,
        normalizedTitle: "duplicate",
        posterPath: "/b.jpg",
        runtimeMinutes: null,
        genres: [],
      }),
    ).rejects.toThrow();
  });

  it("MOVIE_READ_BY_ID resolves the poster via the tmdb_movie LEFT JOIN (S25.2)", async () => {
    // A movie with no matching tmdb_movie row reads back poster_path = null,
    // runtime_minutes = null, genres = [] — never undefined, never fabricated.
    const bare = expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(
        db(),
        movieInput("amc:movie:poster-null", "No Poster", seenFirst, seenFirst),
      ),
    );
    expect(bare.title).toBe("No Poster");
    const readNull = await readMovieById(db(), "amc:movie:poster-null");
    expect(readNull).toHaveLength(1);
    expect(readNull[0]!.poster_path).toBeNull();
    expect(readNull[0]!.runtime_minutes).toBeNull();
    expect(readNull[0]!.genres).toEqual([]);

    // A movie whose lower(title) equals a tmdb_movie.normalized_title resolves the poster.
    await upsertTmdbMovie(db(), {
      tmdbId: 7,
      normalizedTitle: "the odyssey",
      posterPath: "/poster.jpg",
      runtimeMinutes: 128,
      genres: ["Action", "Adventure"],
    });
    expectRow(
      B.MOVIE_UPSERT,
      await upsertMovie(
        db(),
        movieInput("amc:movie:poster-yes", "The Odyssey", seenFirst, seenFirst),
      ),
    );
    const readPoster = await readMovieById(db(), "amc:movie:poster-yes");
    expect(readPoster).toHaveLength(1);
    expect(readPoster[0]!.poster_path).toBe("/poster.jpg");
    expect(readPoster[0]!.runtime_minutes).toBe(128);
    expect(readPoster[0]!.genres).toEqual(["Action", "Adventure"]);
  });
});

describe("tier 2 — first-party event partitions", () => {
  const db = useDatabase();

  it("appends duplicate payloads as distinct current-month events", async () => {
    const createdAt = new Date();
    const payload = { step: "viewed" };
    const first = expectRow(
      B.EVENT_APPEND,
      await appendEvent(db(), {
        eventId: "evt_first",
        type: "SEARCH_VIEWED",
        payload,
        createdAt,
      }),
    );
    const second = expectRow(
      B.EVENT_APPEND,
      await appendEvent(db(), {
        eventId: "evt_second",
        type: "SEARCH_VIEWED",
        payload,
        createdAt,
      }),
    );
    expect([first.event_id, second.event_id]).toEqual(["evt_first", "evt_second"]);

    const rows = await db().rows<{ event_id: string; part: string; month: string }>(
      `SELECT event_id, tableoid::regclass::text AS part,
              to_char(date_trunc('month', created_at), 'YYYY_MM') AS month
       FROM events ORDER BY event_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event_id)).toEqual(["evt_first", "evt_second"]);
    // `month` is derived from each row's own stored `created_at`, formatted in the DB
    // session (not the host's wall clock, and not a hardcoded UTC calendar month via
    // `createdAt.getUTCFullYear()`/`getUTCMonth()` — that would drift from the partition
    // formula if the server session TimeZone is ever non-UTC). `part` is still an
    // independent catalog fact (the row's actual physical partition), so this still catches
    // an event landed in a monthly-named but WRONG child (e.g. next month's), not just one
    // that lands in the un-named DEFAULT child.
    for (const row of rows) expect(row.part).toBe(`events_${row.month}`);
  });

  it("the invariant names an event routed through the parent into the default child", async () => {
    expect(INVARIANTS).toHaveLength(25); // 21 baseline + S22's recheck_outcome_run_is_terminal, recheck_key_never_projects + S36's search_window_accounting + ADR 0039 Amendment A1's preview_runs_never_stranded
    const outsideGeneratedRange = new Date();
    outsideGeneratedRange.setUTCFullYear(outsideGeneratedRange.getUTCFullYear() + 100);
    expectRow(
      B.EVENT_APPEND,
      await appendEvent(db(), {
        eventId: "evt_default_alarm",
        type: "PARTITION_ALARM_PROBE",
        payload: { synthetic: true },
        createdAt: outsideGeneratedRange,
      }),
    );

    const violation = (await checkInvariants(db())).find(
      (candidate) => candidate.invariant === "events_default_partition_empty",
    );
    expect(violation?.rows).toEqual([
      expect.objectContaining({ event_id: "evt_default_alarm", type: "PARTITION_ALARM_PROBE" }),
    ]);

    // Test cleanup only: production events are append-only and expose no deletion boundary.
    await db().query(`DELETE FROM events_default WHERE event_id = $1`, ["evt_default_alarm"]);
  });
});

describe("tier 2 — seat-fetch price persistence (S59, ADR 0062 §3)", () => {
  const db = useDatabase();

  async function acceptPricedFetch(
    showtimeId: string,
    opts: {
      readonly minPrice?: number | null;
      readonly currency?: string | null;
      readonly priceBasis?: "TICKET_ONLY" | "UNKNOWN" | null;
    } = {},
  ): Promise<void> {
    // Schedule acceptance births the performance row first (schedule-acceptance
    // precedence): the price UPDATE's zero-row loser path is unreachable here.
    const schedKey = await scheduleKey(db(), `theatre_${showtimeId}`, "2026-08-02");
    const search = await createSearch(db(), 1, { reserve: 3 });
    await subscribe(db(), search, schedKey);
    await acceptSchedule(db(), await dispatchRun(db(), schedKey), [
      {
        showtimeId,
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T19:00:00.000Z"),
        skipFetch: false,
      },
    ]);
    await acceptFetch(db(), await dispatchRun(db(), await fetchKey(db(), showtimeId)), {
      bitmap: Buffer.from([0b1010_1010]),
      freeCount: 4,
      ...opts,
    });
  }

  it("persists min_price, currency, and price_basis atomically with the snapshot", async () => {
    await seedProvider(db());
    await acceptPricedFetch("st_price", {
      minPrice: 16.99,
      currency: "USD",
      priceBasis: "TICKET_ONLY",
    });

    const row = await db().one<{
      min_price: string;
      currency: string;
      price_basis: string;
      free_count: number;
    }>(
      `SELECT p.min_price, p.currency, p.price_basis, s.free_count
       FROM performance p JOIN availability_snapshot s ON s.showtime_id = p.showtime_id
       WHERE p.showtime_id = $1`,
      ["st_price"],
    );
    // min_price arrives as pg's decimal string; the snapshot proves the price landed
    // in the SAME acceptance (delete the B5C_PERFORMANCE_PRICE execution and the
    // price columns stay null while the snapshot row still commits).
    expect(row.min_price).toBe("16.99");
    expect(row.currency).toBe("USD");
    expect(row.price_basis).toBe("TICKET_ONLY");
    expect(row.free_count).toBe(4);
  });

  it("leaves price columns null when the fetch carries no price (negative control)", async () => {
    await seedProvider(db());
    await acceptPricedFetch("st_unpriced");

    const row = await db().one<{
      min_price: string | null;
      currency: string | null;
      price_basis: string | null;
    }>(`SELECT min_price, currency, price_basis FROM performance WHERE showtime_id = $1`, [
      "st_unpriced",
    ]);
    expect(row).toEqual({ min_price: null, currency: null, price_basis: null });
  });
});
