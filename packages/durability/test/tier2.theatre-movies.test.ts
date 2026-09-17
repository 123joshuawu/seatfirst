import { describe, expect, it } from "vitest";

import {
  readMovieById,
  readScheduleRange,
  updatePerformanceProduct,
  upsertMovie,
} from "../src/repository.js";

import { acceptSchedule, dispatchRun, scheduleKey, seedProvider } from "./support/fixtures.js";
import type { Db } from "./support/pg.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — S21.4's durability half: `SCHEDULE_RANGE_READ` (one statement, a span of
 * days) and its typed wrapper `readScheduleRange`. The import binds DIRECTLY to
 * `../src/repository.js` so deleting the wrapper from production fails this file. The
 * route-side behavior (freshness gate, movie grouping/ordering, drop rules, 404) lives in
 * `apps/server/test/theatres.movies.test.ts` — this file proves the boundary returns the
 * seeded days, carries S14's product columns + S24's `title` verbatim, honors the
 * inclusive `[from, to]` span in one call, and reports the per-day `latest_captured_at`
 * the route's freshness gate consumes.
 *
 * Seeding goes through S14's write path extended by S24 (`scheduleKey` → `dispatchRun` →
 * `acceptSchedule` → `updatePerformanceProduct` → `upsertMovie`), never a hand-built
 * performance row (S24.8). `attributes` is asserted as `[]`: the only write path that
 * touches the column writes `{}` today (S21 Finding, resolved defensively in
 * `readScheduleRange`), so the honest regression is that it coerces to the wire's empty
 * array.
 */

const PROVIDER = "amc";

/** Seed one cached schedule day and apply its product + movie writes. */
async function seedDay(
  db: Db,
  theatreId: string,
  localDate: string,
  capturedAt: Date,
  shows: ReadonlyArray<{
    showtimeId: string;
    movieId: string;
    movieTitle: string;
    startsAt: Date;
    status: string;
    formatCode: string | null;
    auditorium: string | null;
    runtimeMinutes: number | null;
  }>,
): Promise<void> {
  const key = await scheduleKey(db, theatreId, localDate);
  const run = await dispatchRun(db, key);
  await acceptSchedule(
    db,
    run,
    shows.map((show) => ({
      showtimeId: show.showtimeId,
      movieId: "amc:movie:test",
      startsAt: show.startsAt,
      skipFetch: false,
    })),
    { capturedAt },
  );
  for (const show of shows) {
    await upsertMovie(db, {
      movieId: show.movieId,
      providerId: PROVIDER,
      title: show.movieTitle,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
    });
    await updatePerformanceProduct(db, {
      showtimeId: show.showtimeId,
      movieId: show.movieId,
      auditorium: show.auditorium,
      utcOffset: "-05:00",
      runtimeMinutes: show.runtimeMinutes,
      status: show.status as "OPEN" | "LOW_AVAILABILITY" | "SOLD_OUT" | "CANCELED" | "UNKNOWN",
      formatCode: show.formatCode,
      minPrice: null,
      deepLinkUrl: `https://example.invalid/showtime/${show.showtimeId}`,
      providerMeta: {},
      layoutId: null,
      updatedAt: capturedAt,
    });
  }
}

describe("tier 2 — theatres.movies range read (SCHEDULE_RANGE_READ)", () => {
  const db = useDatabase();

  it("returns every seeded day over a multi-day, multi-movie span with product columns and title verbatim (items 2)", async () => {
    await seedProvider(db());
    const capturedAt = new Date("2026-08-14T12:00:00.000Z");
    await seedDay(db(), "amc:theatre:movie", "2026-08-20", capturedAt, [
      {
        showtimeId: "amc:showtime:one",
        movieId: "amc:movie:one",
        movieTitle: "The Odyssey",
        startsAt: new Date("2026-08-20T19:00:00.000Z"),
        status: "OPEN",
        formatCode: "DIGITAL",
        auditorium: "7",
        runtimeMinutes: 120,
      },
    ]);
    await seedDay(db(), "amc:theatre:movie", "2026-08-21", capturedAt, [
      {
        showtimeId: "amc:showtime:two",
        movieId: "amc:movie:two",
        movieTitle: "Reloaded",
        startsAt: new Date("2026-08-21T20:00:00.000Z"),
        status: "SOLD_OUT",
        formatCode: "IMAX",
        auditorium: "8",
        runtimeMinutes: 95,
      },
    ]);
    await seedDay(db(), "amc:theatre:movie", "2026-08-22", capturedAt, [
      {
        showtimeId: "amc:showtime:three",
        movieId: "amc:movie:one",
        movieTitle: "The Odyssey",
        startsAt: new Date("2026-08-22T21:00:00.000Z"),
        status: "CANCELED",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);

    // ONE call over the whole span returns all three days (no per-day loop).
    const range = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:movie",
      dateFrom: "2026-08-20",
      dateTo: "2026-08-22",
    });

    expect(range.days.map((day) => day.localDate)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
    ]);
    const dayOne = range.days[0];
    expect(dayOne?.capturedAt).toEqual(capturedAt);
    expect(dayOne?.performances).toEqual([
      {
        showtimeId: "amc:showtime:one",
        localDate: "2026-08-20",
        movieId: "amc:movie:one",
        title: "The Odyssey",
        startsAt: new Date("2026-08-20T19:00:00.000Z"),
        status: "OPEN",
        formatCode: "DIGITAL",
        auditorium: "7",
        runtimeMinutes: 120,
        deepLinkUrl: "https://example.invalid/showtime/amc:showtime:one",
        layoutId: null,
        attributes: [],
      },
    ]);

    const dayTwo = range.days[1];
    expect(dayTwo?.performances).toHaveLength(1);
    expect(dayTwo?.performances[0]).toMatchObject({
      showtimeId: "amc:showtime:two",
      movieId: "amc:movie:two",
      title: "Reloaded",
      status: "SOLD_OUT",
      formatCode: "IMAX",
      auditorium: "8",
      runtimeMinutes: 95,
    });

    const dayThree = range.days[2];
    expect(dayThree?.performances[0]).toMatchObject({
      showtimeId: "amc:showtime:three",
      movieId: "amc:movie:one",
      title: "The Odyssey",
      status: "CANCELED",
      formatCode: null,
      auditorium: null,
      runtimeMinutes: null,
    });
  });

  it("honors the inclusive [from, to] span — days outside it appear nowhere (item 3)", async () => {
    await seedProvider(db());
    const capturedAt = new Date("2026-08-14T12:00:00.000Z");
    await seedDay(db(), "amc:theatre:edge", "2026-08-20", capturedAt, [
      {
        showtimeId: "amc:showtime:edge1",
        movieId: "amc:movie:edge",
        movieTitle: "Edge",
        startsAt: new Date("2026-08-20T19:00:00.000Z"),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);
    await seedDay(db(), "amc:theatre:edge", "2026-08-21", capturedAt, [
      {
        showtimeId: "amc:showtime:edge2",
        movieId: "amc:movie:edge",
        movieTitle: "Edge",
        startsAt: new Date("2026-08-21T19:00:00.000Z"),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);
    await seedDay(db(), "amc:theatre:edge", "2026-08-22", capturedAt, [
      {
        showtimeId: "amc:showtime:edge3",
        movieId: "amc:movie:edge",
        movieTitle: "Edge",
        startsAt: new Date("2026-08-22T19:00:00.000Z"),
        status: "OPEN",
        formatCode: null,
        auditorium: null,
        runtimeMinutes: null,
      },
    ]);

    // Both endpoints inclusive, the outside day excluded.
    const range = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:edge",
      dateFrom: "2026-08-20",
      dateTo: "2026-08-21",
    });
    expect(range.days.map((day) => day.localDate)).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("exposes pre-S14 rows (movie_id IS NULL) with null movie_id and title (item 7)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "amc:theatre:pres14", "2026-08-20");
    const run = await dispatchRun(db(), key);
    const capturedAt = new Date("2026-08-14T12:00:00.000Z");
    // Bare acceptSchedule writes a performance with movie_id NULL (pre-S14 posture).
    await acceptSchedule(
      db(),
      run,
      [
        {
          showtimeId: "amc:showtime:pres14",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
      ],
      { capturedAt },
    );

    const range = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:pres14",
      dateFrom: "2026-08-20",
      dateTo: "2026-08-20",
    });
    expect(range.days).toHaveLength(1);
    expect(range.days[0]?.performances[0]).toMatchObject({
      showtimeId: "amc:showtime:pres14",
      movieId: null,
      title: null,
    });
  });

  it("exposes pre-S24 rows (movie_id set, no movie row) with null title (item 7)", async () => {
    await seedProvider(db());
    const capturedAt = new Date("2026-08-14T12:00:00.000Z");
    // movie_id set by the product write, but NO upsertMovie — the pre-S24 posture.
    const key = await scheduleKey(db(), "amc:theatre:pres24", "2026-08-20");
    const run = await dispatchRun(db(), key);
    await acceptSchedule(
      db(),
      run,
      [
        {
          showtimeId: "amc:showtime:pres24",
          movieId: "amc:movie:test",
          startsAt: new Date(),
          skipFetch: false,
        },
      ],
      { capturedAt },
    );
    await updatePerformanceProduct(db(), {
      showtimeId: "amc:showtime:pres24",
      movieId: "amc:movie:orphan",
      auditorium: null,
      utcOffset: "-05:00",
      runtimeMinutes: null,
      status: "OPEN",
      formatCode: null,
      minPrice: null,
      deepLinkUrl: "https://example.invalid/showtime/amc:showtime:pres24",
      providerMeta: {},
      layoutId: null,
      updatedAt: capturedAt,
    });

    expect(await readMovieById(db(), "amc:movie:orphan")).toEqual([]);

    const range = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:pres24",
      dateFrom: "2026-08-20",
      dateTo: "2026-08-20",
    });
    expect(range.days[0]?.performances[0]).toMatchObject({
      movieId: "amc:movie:orphan",
      title: null,
    });
  });

  it("reports a key that never captured with a null capturedAt, and omits no-key days (item 4)", async () => {
    await seedProvider(db());
    // A run_key row that exists but never accepted (latest_captured_at IS NULL).
    await scheduleKey(db(), "amc:theatre:never", "2026-08-20");

    const range = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:never",
      dateFrom: "2026-08-20",
      dateTo: "2026-08-20",
    });
    expect(range.days).toHaveLength(1);
    expect(range.days[0]?.capturedAt).toBeNull();
    expect(range.days[0]?.performances).toEqual([]);

    // A date with no key at all contributes no day.
    const noKey = await readScheduleRange(db(), {
      providerId: PROVIDER,
      theatreId: "amc:theatre:never",
      dateFrom: "2026-08-21",
      dateTo: "2026-08-21",
    });
    expect(noKey.days).toEqual([]);
  });
});
