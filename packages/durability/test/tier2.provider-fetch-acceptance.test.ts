import { describe, expect, it } from "vitest";

import {
  acceptFetch,
  acceptSchedule,
  stageMovieScheduleAcceptance,
  stageScheduleAcceptance,
} from "../src/transactions.js";

import {
  createSearch,
  dispatchRun,
  fetchKey,
  movieScheduleKey,
  scheduleKey,
  seedProvider,
  subscribe,
  subscribeMovieSchedule,
} from "./support/fixtures.js";
import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — S8's two additive durability seams (S8.10/S8.11), against the real schema:
 * the caller-supplied `bitmap` on `acceptFetch` (spec verification item 14) and the
 * SCHEDULE_RESOLUTION composition promoted from the test fixture (item 15).
 *
 * `acceptSchedule`/`stageScheduleAcceptance` are imported DIRECTLY from
 * `src/transactions.ts` — not through `support/fixtures.ts` — so these tests bind to the
 * production home of the composition: deleting the promoted functions would fail this
 * file, not silently re-route through a fixture.
 */

describe("tier 2 — S8 provider-fetch acceptance seams", () => {
  const db = useDatabase();

  describe("acceptFetch bitmap (S8.10)", () => {
    it("round-trips the caller's bitmap into availability_snapshot.bitmap byte-for-byte", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_bitmap");
      const run = await dispatchRun(db(), key);

      const bitmap = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff]);
      await acceptFetch(db(), run, { bitmap, freeCount: 12 });

      const row = await db().one<{ bitmap: Buffer; free_count: number }>(
        `SELECT bitmap, free_count FROM availability_snapshot`,
      );
      expect(row.bitmap.equals(bitmap)).toBe(true);
      expect(row.free_count).toBe(12);
    });

    it("without opts.bitmap still writes the placeholder byte (regression control)", async () => {
      await seedProvider(db());
      const key = await fetchKey(db(), "st_placeholder");
      const run = await dispatchRun(db(), key);

      await acceptFetch(db(), run);

      const row = await db().one<{ bitmap: Buffer }>(`SELECT bitmap FROM availability_snapshot`);
      expect(row.bitmap.equals(Buffer.from([0b1010_1010]))).toBe(true);
    });
  });

  describe("schedule acceptance promotion (S8.11)", () => {
    const showtimes = [
      {
        showtimeId: "st_s8_a",
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T19:00:00.000Z"),
        skipFetch: false,
      },
      {
        showtimeId: "st_s8_b",
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T21:30:00.000Z"),
        skipFetch: false,
      },
      {
        showtimeId: "st_s8_c",
        movieId: "amc:movie:test",
        startsAt: new Date("2026-08-02T23:45:00.000Z"),
        skipFetch: false,
      },
    ];
    it("acceptSchedule writes one performance row per showtime and fans in the subscriber", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_s8", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 3 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      const result = await acceptSchedule(db(), run, showtimes);

      expect(result.expandedFor).toEqual([search.searchId]);
      expect(result.fannedIn).toEqual([{ search_id: search.searchId, seq: expect.any(String) }]);
      const rows = await db().rows<{ showtime_id: string; theatre_id: string }>(
        `SELECT showtime_id, theatre_id FROM performance ORDER BY showtime_id`,
      );
      expect(rows).toEqual([
        { showtime_id: "st_s8_a", theatre_id: "theatre_s8" },
        { showtime_id: "st_s8_b", theatre_id: "theatre_s8" },
        { showtime_id: "st_s8_c", theatre_id: "theatre_s8" },
      ]);
    });

    it("persists multi-theatre movie observations without warming theatre schedules and falls back for an omitted candidate (S65)", async () => {
      await seedProvider(db());
      const theatreA = "amc:theatre:movie_a";
      const theatreB = "amc:theatre:movie_b";
      await db().query(
        `INSERT INTO theatre (theatre_id, provider_id, name, lat, lng, timezone, first_seen_at, last_seen_at)
         VALUES
           ($1, 'amc', 'Movie A', 0, 0, 'UTC', now(), now()),
           ($2, 'amc', 'Movie B', 0, 0, 'UTC', now(), now())`,
        [theatreA, theatreB],
      );
      const key = await movieScheduleKey(db(), "dune-part-3", theatreA, "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 2 });
      await subscribeMovieSchedule(db(), search, key, [theatreA, theatreB]);
      const run = await dispatchRun(db(), key);

      const result = await stageMovieScheduleAcceptance(db(), run, [
        {
          theatreId: theatreA,
          showtimeId: "st_movie_a",
          movieId: "amc:movie:42",
          movieTitle: "Dune Part 3",
          startsAt: new Date("2026-08-02T19:00:00.000Z"),
          skipFetch: false,
          formatCode: "IMAX",
          auditorium: null,
          utcOffset: "+00:00",
          runtimeMinutes: 155,
          status: "OPEN",
          deepLinkUrl: "https://example.test/showtimes/st_movie_a/seats",
          providerMeta: { rawStatus: "Sellable" },
        },
      ]);

      expect(result.expandedFor).toEqual([search.searchId]);
      expect(
        await db().rows<{ theatre_id: string; movie_id: string }>(
          `SELECT theatre_id, movie_id FROM performance ORDER BY showtime_id`,
        ),
      ).toEqual([{ theatre_id: theatreA, movie_id: "amc:movie:42" }]);
      expect(
        await db().one<{ n: string }>(
          `SELECT count(*) AS n FROM run_key
           WHERE kind = 'SCHEDULE_RESOLUTION' AND theatre_id = $1 AND local_date = $2`,
          [theatreA, "2026-08-02"],
        ),
      ).toEqual({ n: "0" });
      expect(
        await db().rows<{ kind: string; theatre_id: string | null }>(
          `SELECT rk.kind, rk.theatre_id
           FROM search_job sj JOIN run_key rk ON rk.run_key_id = sj.run_key_id
           WHERE sj.search_id = $1 ORDER BY rk.kind`,
          [search.searchId],
        ),
      ).toEqual([
        { kind: "MOVIE_SCHEDULE_RESOLUTION", theatre_id: theatreA },
        { kind: "SCHEDULE_RESOLUTION", theatre_id: theatreB },
        { kind: "SHOWTIME_FETCH", theatre_id: null },
      ]);
    });

    it("stageScheduleAcceptance composes the whole body without transaction control", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_stage", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 3 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      const result = await stageScheduleAcceptance(db(), run, showtimes.slice(0, 2));

      expect(result.expandedFor).toEqual([search.searchId]);
      const n = await db().one<{ n: string }>(`SELECT count(*) AS n FROM performance`);
      expect(n.n).toBe("2");
    });

    it("keeps an existing warm showtime subscription when cold schedule expansion overlaps it", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_overlap", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 2, freshMatchSeed: 1 });
      await subscribe(db(), search, key);
      const warmKey = await fetchKey(db(), showtimes[0]!.showtimeId);
      const warmSubscription = await subscribe(db(), search, warmKey);
      const run = await dispatchRun(db(), key);

      const result = await acceptSchedule(db(), run, showtimes.slice(0, 1));

      expect(result.expandedFor).toEqual([search.searchId]);
      const subscriptions = await db().rows<{ run_key_id: string; job_id: string }>(
        `SELECT run_key_id, job_id FROM run_subscription WHERE search_id = $1 ORDER BY run_key_id`,
        [search.searchId],
      );
      expect(subscriptions).toEqual([
        { run_key_id: warmKey.runKeyId, job_id: warmSubscription.jobId },
        { run_key_id: key.runKeyId, job_id: expect.any(String) },
      ]);
      const jobs = await db().one<{ n: string }>(
        `SELECT count(*) AS n FROM search_job WHERE search_id = $1`,
        [search.searchId],
      );
      expect(jobs.n).toBe("2");
    });

    it("a stale generation is fenced: acceptSchedule throws without writing anything", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_fenced", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 3 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      // the lease was reclaimed and the generation moved on: this handle is a zombie
      await db().query(`UPDATE provider_run SET generation = generation + 1 WHERE run_id = $1`, [
        run.runId,
      ]);

      await expect(acceptSchedule(db(), run, showtimes)).rejects.toThrow(/B5A_FENCE/);

      const n = await db().one<{ n: string }>(`SELECT count(*) AS n FROM performance`);
      expect(n.n).toBe("0");
    });
  });

  describe("S57 cold schedule-resolution skeleton emission (ADR 0054 decision 2)", () => {
    interface SkeletonEntry {
      showtimeId: string;
      theatreId: string;
      showDateTimeLocal: string;
      formatCode: string | null;
      distanceKm: number | null;
      rank: number;
      admitted: boolean;
      resolved: boolean;
    }

    async function skeletonEvents(searchId: string): Promise<{ type: string; payload: unknown }[]> {
      return db().rows<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
        [searchId],
      );
    }

    it("gate-passed cold acceptance emits one skeleton event echoing admitted showtimes", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_s57", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 3 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      const showtimes = [
        {
          showtimeId: "st_s57_a",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-02T19:00:00.000Z"),
          skipFetch: false,
          formatCode: "STANDARD",
          distanceKm: 2.5,
          theatreId: "theatre_s57",
        },
        {
          showtimeId: "st_s57_b",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-02T21:30:00.000Z"),
          skipFetch: false,
          formatCode: "IMAX",
          distanceKm: null,
          theatreId: "theatre_s57",
        },
        {
          showtimeId: "st_s57_skip",
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-02T23:45:00.000Z"),
          skipFetch: true,
        },
      ];
      // Mirror the production filter: it annotates dispatchRank + showDateTimeLocal
      // (via toTheatreLocal) on top of the accepted showtimes. Values pinned here.
      const localByIndex = ["2026-08-02T19:00:00", "2026-08-02T20:00:00", "2026-08-02T21:00:00"];
      const result = await acceptSchedule(db(), run, showtimes, {
        filter: ({ showtimes: sts }) =>
          sts.map((st, index) => ({
            ...st,
            dispatchRank: index,
            showDateTimeLocal: localByIndex[index]!,
          })),
      });
      expect(result.expandedFor).toEqual([search.searchId]);

      const events = await skeletonEvents(search.searchId);
      // B5_FANIN already notifies each transitioned subscriber with FETCH_ACCEPTED;
      // the S57 emission streams one skeleton event after it.
      const skeletons = events.filter((e) => e.type === "skeleton");
      expect(skeletons).toHaveLength(1);
      expect(skeletons[0]!.type).toBe("skeleton");
      const payload = skeletons[0]!.payload as { scheduleSkeleton: SkeletonEntry[] };
      // skipFetch entries create no fetch work, so they are not echoed.
      expect(payload.scheduleSkeleton).toEqual([
        {
          showtimeId: "st_s57_a",
          theatreId: "theatre_s57",
          showDateTimeLocal: "2026-08-02T19:00:00",
          formatCode: "STANDARD",
          distanceKm: 2.5,
          rank: 0,
          admitted: true,
          resolved: false,
        },
        {
          showtimeId: "st_s57_b",
          theatreId: "theatre_s57",
          showDateTimeLocal: "2026-08-02T20:00:00",
          formatCode: "IMAX",
          distanceKm: null,
          rank: 1,
          admitted: true,
          resolved: false,
        },
      ]);

      // admitted:true is truthful: one SHOWTIME_FETCH job per echoed entry exists
      // (plus the schedule subscription's own job from the fixture).
      const jobs = await db().one<{ n: string }>(
        `SELECT count(*) AS n FROM search_job WHERE search_id = $1`,
        [search.searchId],
      );
      expect(jobs.n).toBe("3");
    });

    it("a subscriber denied by the cumulative capacity gate gets no skeleton event", async () => {
      await seedProvider(db(), { pendingCostLimit: 6 });
      const key = await scheduleKey(db(), "theatre_s57_deny", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 2 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      await acceptSchedule(
        db(),
        run,
        ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => ({
          showtimeId: `st_s57_deny_${x}`,
          movieId: "amc:movie:test",
          startsAt: new Date("2026-08-02T19:00:00.000Z"),
          skipFetch: false,
        })),
        {
          // Annotate showDateTimeLocal so the absence of an event pins the denial
          // branch, not the missing-field defensive skip.
          filter: ({ showtimes: sts }) =>
            sts.map((st, index) => ({
              ...st,
              dispatchRank: index,
              showDateTimeLocal: "2026-08-02T19:00:00",
            })),
          stage1Share: 2,
        },
      );

      // Prove the denial actually fired.
      const s = await db().one<{ capacity_denied_at: Date | null }>(
        `SELECT capacity_denied_at FROM search WHERE search_id = $1`,
        [search.searchId],
      );
      expect(s.capacity_denied_at).not.toBeNull();
      // ...and that it emitted no skeleton entries for the denied date.
      const events = await skeletonEvents(search.searchId);
      expect(events.filter((e) => e.type === "skeleton")).toEqual([]);
    });

    it("entries missing showDateTimeLocal are skipped defensively, without failing the acceptance", async () => {
      await seedProvider(db());
      const key = await scheduleKey(db(), "theatre_s57_bare", "2026-08-02");
      const search = await createSearch(db(), 1, { reserve: 3 });
      await subscribe(db(), search, key);
      const run = await dispatchRun(db(), key);

      const result = await acceptSchedule(
        db(),
        run,
        [
          {
            showtimeId: "st_s57_bare",
            movieId: "amc:movie:test",
            startsAt: new Date("2026-08-02T19:00:00.000Z"),
            skipFetch: false,
          },
        ],
        { filter: ({ showtimes: sts }) => sts },
      );
      expect(result.expandedFor).toEqual([search.searchId]);

      // Fetch work still expands (the gate passed); only the malformed skeleton
      // entry is withheld, never a fatal error.
      const jobs = await db().one<{ n: string }>(
        `SELECT count(*) AS n FROM search_job WHERE search_id = $1`,
        [search.searchId],
      );
      expect(jobs.n).toBe("2");
      const events = await skeletonEvents(search.searchId);
      expect(events.filter((e) => e.type === "skeleton")).toEqual([]);
    });
  });
});
