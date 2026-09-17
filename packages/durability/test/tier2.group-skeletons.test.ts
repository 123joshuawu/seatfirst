import { describe, expect, it } from "vitest";

import { readCachedSchedule, updatePerformanceProduct } from "../src/repository.js";

import { acceptSchedule, dispatchRun, scheduleKey, seedProvider } from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — E5.13's durability half: `readCachedSchedule` carries the three product
 * columns the warm-create group skeleton consumes (`layout_id`, `format_code`,
 * `auditorium`), verbatim and nullable — no shaping here, the route maps them.
 *
 * The import binds DIRECTLY to `../src/repository.js` (not the fixture mirrors), so
 * deleting the columns from production's read fails this file — the revert-sensitivity
 * discipline every tier file here follows. Seeding goes through S14's write path:
 * `scheduleKey` → `dispatchRun` → `acceptSchedule` → `updatePerformanceProduct`, the
 * same composition the provider fetch actor uses, never a hand-built performance row.
 */

const PROVIDER = "amc";

describe("tier 2 — E5 group-skeleton cache columns", () => {
  const db = useDatabase();

  it("readCachedSchedule carries layoutId/formatCode/auditorium verbatim from the product write, null passthrough (E5.13)", async () => {
    await seedProvider(db());
    // Scaffolding: `layout_id` references the content-addressed `auditorium_layout`
    // table (not truncated by the sweep) — the same minimal row the catalog tier
    // fixture inserts (`tier2.catalog.test.ts:168-172`).
    await db().query(
      `INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (layout_id) DO NOTHING`,
      ["lay_product", Buffer.from([0]), 1, 1],
    );

    const key = await scheduleKey(db(), "theatre_skel", "2026-08-20");
    const run = await dispatchRun(db(), key);
    const capturedAt = new Date();
    await acceptSchedule(
      db(),
      run,
      [
        {
          showtimeId: "st_lay",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-20T19:00:00.000Z"),
          skipFetch: false,
        },
        {
          showtimeId: "st_none",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-20T20:00:00.000Z"),
          skipFetch: true,
        },
      ],
      { capturedAt },
    );
    // One performance gets a full product write with a layout; the second gets none —
    // its three columns stay NULL on the schedule write and must pass through as nulls.
    await updatePerformanceProduct(db(), {
      showtimeId: "st_lay",
      movieId: "amc:movie:42",
      auditorium: "9",
      utcOffset: "-05:00",
      runtimeMinutes: 120,
      status: "OPEN",
      formatCode: "IMAX",
      minPrice: null,
      deepLinkUrl: "https://example.invalid/showtime",
      providerMeta: {},
      layoutId: "lay_product",
      updatedAt: capturedAt,
    });

    const cached = await readCachedSchedule(db(), {
      providerId: PROVIDER,
      theatreId: "theatre_skel",
      localDate: "2026-08-20",
      freshnessMs: 10 * 60_000,
      now: new Date(capturedAt.getTime() + 1_000),
    });

    expect(cached?.performances).toEqual([
      {
        showtimeId: "st_lay",
        status: "OPEN",
        layoutId: "lay_product",
        formatCode: "IMAX",
        auditorium: "9",
      },
      { showtimeId: "st_none", status: null, layoutId: null, formatCode: null, auditorium: null },
    ]);
  });

  it("a capture without any layout id still reads warm with all-null skeleton columns (E5.13)", async () => {
    await seedProvider(db());
    const key = await scheduleKey(db(), "theatre_nolayout", "2026-08-20");
    const run = await dispatchRun(db(), key);
    const capturedAt = new Date();
    await acceptSchedule(
      db(),
      run,
      [
        {
          showtimeId: "st_plain",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-20T19:00:00.000Z"),
          skipFetch: false,
        },
      ],
      { capturedAt },
    );
    await updatePerformanceProduct(db(), {
      showtimeId: "st_plain",
      movieId: "amc:movie:42",
      auditorium: "7",
      utcOffset: "-05:00",
      runtimeMinutes: 120,
      status: "OPEN",
      formatCode: "DIGITAL",
      minPrice: null,
      deepLinkUrl: "https://example.invalid/showtime",
      providerMeta: {},
      layoutId: null,
      updatedAt: capturedAt,
    });

    const cached = await readCachedSchedule(db(), {
      providerId: PROVIDER,
      theatreId: "theatre_nolayout",
      localDate: "2026-08-20",
      freshnessMs: 10 * 60_000,
      now: new Date(capturedAt.getTime() + 1_000),
    });

    // E5.13's "no layout id" case: the read stays warm and truthful; the route turns
    // this into `groups: []` (proven at the apps/server tier, not re-proven here).
    expect(cached?.performances).toEqual([
      {
        showtimeId: "st_plain",
        status: "OPEN",
        layoutId: null,
        formatCode: "DIGITAL",
        auditorium: "7",
      },
    ]);
  });
});
