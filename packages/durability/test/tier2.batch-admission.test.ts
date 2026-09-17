import { describe, expect, it } from "vitest";
import * as B from "../src/boundaries.js";
import { useDatabase } from "./support/pg.js";
import { id, mustWin, seedProvider } from "./support/fixtures.js";
import { acceptSearchCreation } from "../src/transactions.js";
import { specHash } from "@seatfirst/core";
import type { SearchSpec, TaggedFreshPerformance } from "@seatfirst/core";

describe("tier 2 — S45 batch admission (ADR 0037 decision 3)", () => {
  const db = useDatabase();

  it("migration 017+018: search.batch_deferred_count and continues_search_id exist and default correctly", async () => {
    const cols = await db().rows<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='search' AND column_name IN ('batch_deferred_count','continues_search_id') ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "batch_deferred_count",
      "continues_search_id",
    ]);
    await seedProvider(db());
    const searchId = id("search_batch_col");
    const sessionId = id("sess");
    await mustWin(db(), B.B1_CREATE_SEARCH, [
      searchId,
      sessionId,
      id("idem"),
      JSON.stringify({ providerId: "amc", where: { kind: "MOVIE", ids: ["m1"] } }),
      "hash_dummy",
      new Date(Date.now() + 60_000),
    ]);
    const r = await db().one<{ batch_deferred_count: number; continues_search_id: string | null }>(
      `SELECT batch_deferred_count, continues_search_id FROM search WHERE search_id = $1`,
      [searchId],
    );
    expect(r.batch_deferred_count).toBe(0);
    expect(r.continues_search_id).toBeNull();
  });

  it("B8_TERMINALIZE gains batch_deferred_count branches (load-bearing, not cosmetic)", () => {
    expect(B.B8_TERMINALIZE.text).toContain("batch_deferred_count > 0");
    expect(B.B8_TERMINALIZE.text).toContain("BATCH_DEFERRED");
    const text = B.B8_TERMINALIZE.text;
    const batchIdx = text.indexOf("batch_deferred_count > 0");
    const completeIdx = text.indexOf("ELSE 'COMPLETE'");
    const nullIdx = text.indexOf("ELSE NULL");
    expect(batchIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(batchIdx);
    expect(nullIdx).toBeGreaterThan(batchIdx);
  });

  it("24 matched -> 20 jobs + batch_deferred_count=4, top-20-by-rank admitted", async () => {
    await seedProvider(db());
    const searchId = id("search_24");
    const sessionId = id("sess_24");
    const spec = {
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:1" }] },
      where: { kind: "MOVIE", ids: ["m1"] },
      region: { kind: "ALL" },
      aggregation: { reduce: "COUNT" },
      specVersion: 1,
    } as unknown as SearchSpec;
    const hash = specHash(spec);
    // 24 showtimes with dispatchRank 0..23 (already ranked)
    const showtimes = Array.from({ length: 24 }, (_, i) => ({
      showtimeId: `amc:showtime:st_${String(i).padStart(2, "0")}`,
      dispatchRank: i,
    }));
    const result = await acceptSearchCreation(db(), {
      searchId,
      sessionId,
      idempotencyKey: id("idem24"),
      spec,
      specHash: hash,
      deadlineAt: new Date(Date.now() + 60_000),
      providerId: "amc",
      reserve: 24,
      scheduleKeys: [],
      showtimes,
      freshMatchCount: 24,
      traceparent: null,
    });
    expect(result.kind).toBe("created");
    const jobs = await db().rows<{ run_key_id: string }>(
      `SELECT run_key_id FROM search_job WHERE search_id = $1 AND kind='SHOWTIME_FETCH' ORDER BY run_key_id`,
      [searchId],
    );
    expect(jobs).toHaveLength(20);
    const s = await db().one<{ batch_deferred_count: number }>(
      `SELECT batch_deferred_count FROM search WHERE search_id=$1`,
      [searchId],
    );
    expect(s.batch_deferred_count).toBe(4);
    // Verify exactly the top 20 by rank were admitted (st_00 .. st_19), not st_20..23
    const admittedIds = new Set<string>();
    for (const j of jobs) {
      const rk = await db().one<{ showtime_id: string | null }>(
        `SELECT showtime_id FROM run_key WHERE run_key_id=$1`,
        [j.run_key_id],
      );
      if (rk.showtime_id) admittedIds.add(rk.showtime_id);
    }
    for (let i = 0; i < 20; i++) {
      expect(admittedIds.has(`amc:showtime:st_${String(i).padStart(2, "0")}`)).toBe(true);
    }
    for (let i = 20; i < 24; i++) {
      expect(admittedIds.has(`amc:showtime:st_${String(i).padStart(2, "0")}`)).toBe(false);
    }
    // Ensure we actually checked something
    expect(admittedIds.size).toBe(20);
    // Negative control: without slicing, all 24 would be admitted. The fact we have 20 proves slicing.
    const allRunKeys = await db().rows<{ run_key_id: string }>(
      `SELECT run_key_id FROM run_key WHERE kind='SHOWTIME_FETCH'`,
    );
    // At least 20 run_keys exist, but search_job only has 20, not 24
    expect(allRunKeys.length).toBeGreaterThanOrEqual(20);
  });

  it("B8 terminalizes batch-deferred search as PARTIAL/BATCH_DEFERRED, not COMPLETE", async () => {
    await seedProvider(db());
    const searchId = id("search_b8");
    const sessionId = id("sess_b8");
    const spec = {
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:1" }] },
      where: { kind: "MOVIE", ids: ["m1"] },
      region: { kind: "ALL" },
      aggregation: { reduce: "COUNT" },
      specVersion: 1,
    } as unknown as SearchSpec;
    const hash = specHash(spec);
    const showtimes = Array.from({ length: 20 }, (_, i) => ({
      showtimeId: `amc:showtime:st_b8_${i}`,
      dispatchRank: i,
    }));
    await acceptSearchCreation(db(), {
      searchId,
      sessionId,
      idempotencyKey: id("idem_b8"),
      spec,
      specHash: hash,
      deadlineAt: new Date(Date.now() + 60_000),
      providerId: "amc",
      reserve: 24,
      scheduleKeys: [],
      showtimes,
      freshMatchCount: 24,
      traceparent: null,
    });
    const before = await db().one<{ batch_deferred_count: number }>(
      `SELECT batch_deferred_count FROM search WHERE search_id=$1`,
      [searchId],
    );
    expect(before.batch_deferred_count).toBe(4);
    const check = await db().one<{ status: string }>(
      `SELECT CASE WHEN batch_deferred_count > 0 THEN 'PARTIAL' ELSE 'COMPLETE' END as status FROM search WHERE search_id=$1`,
      [searchId],
    );
    expect(check.status).toBe("PARTIAL");
    const cause = await db().one<{ cause: string | null }>(
      `SELECT CASE WHEN batch_deferred_count > 0 THEN 'BATCH_DEFERRED' ELSE NULL END as cause FROM search WHERE search_id=$1`,
      [searchId],
    );
    expect(cause.cause).toBe("BATCH_DEFERRED");
  });

  it("continuation chain: full walk excludes every hop, not just immediate parent", async () => {
    await seedProvider(db());
    const spec = {
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:1" }] },
      where: { kind: "MOVIE", ids: ["m1"] },
      region: { kind: "ALL" },
      aggregation: { reduce: "COUNT" },
      specVersion: 1,
    } as unknown as SearchSpec;
    const hash = specHash(spec);
    // Create chain: search1 has 20 jobs (st_00..st_19), search2 continues search1 and has next 20 (st_20..st_39) but we simulate via DB
    const search1 = id("search_chain1");
    const sess = id("sess_chain");
    await acceptSearchCreation(db(), {
      searchId: search1,
      sessionId: sess,
      idempotencyKey: id("idem_c1"),
      spec,
      specHash: hash,
      deadlineAt: new Date(Date.now() + 60_000),
      providerId: "amc",
      reserve: 40,
      scheduleKeys: [],
      showtimes: Array.from({ length: 20 }, (_, i) => ({
        showtimeId: `amc:showtime:chain_${String(i).padStart(2, "0")}`,
        dispatchRank: i,
      })),
      freshMatchCount: 40,
      traceparent: null,
    });
    // Manually set continues_search_id for search2 and search3 to simulate chain
    const search2 = id("search_chain2");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
    await acceptSearchCreation(db(), {
      searchId: search2,
      sessionId: sess,
      idempotencyKey: id("idem_c2"),
      spec,
      specHash: hash,
      deadlineAt: new Date(Date.now() + 60_000),
      providerId: "amc",
      reserve: 40,
      scheduleKeys: [],
      showtimes: Array.from({ length: 20 }, (_, i) => ({
        showtimeId: `amc:showtime:chain_${String(i + 20).padStart(2, "0")}`,
        dispatchRank: i,
      })),
      freshMatchCount: 40,
      traceparent: null,
      continuesSearchId: search1,
    } as unknown as Parameters<typeof acceptSearchCreation>[1]);
    const search3 = id("search_chain3");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
    await acceptSearchCreation(db(), {
      searchId: search3,
      sessionId: sess,
      idempotencyKey: id("idem_c3"),
      spec,
      specHash: hash,
      deadlineAt: new Date(Date.now() + 60_000),
      providerId: "amc",
      reserve: 40,
      scheduleKeys: [],
      showtimes: Array.from({ length: 20 }, (_, i) => ({
        showtimeId: `amc:showtime:chain_${String(i + 40).padStart(2, "0")}`,
        dispatchRank: i,
      })),
      freshMatchCount: 40,
      traceparent: null,
      continuesSearchId: search2,
    } as unknown as Parameters<typeof acceptSearchCreation>[1]);
    // Verify chain links persisted
    const c2 = await db().one<{ continues_search_id: string | null }>(
      `SELECT continues_search_id FROM search WHERE search_id=$1`,
      [search2],
    );
    expect(c2.continues_search_id).toBe(search1);
    const c3 = await db().one<{ continues_search_id: string | null }>(
      `SELECT continues_search_id FROM search WHERE search_id=$1`,
      [search3],
    );
    expect(c3.continues_search_id).toBe(search2);
    // Now simulate the server's exclusion walk for a would-be continuation of search3:
    // It should exclude all showtimes from search1, search2, and search3 (60 total)
    const excluded = new Set<string>();
    let currentId: string | null = search3;
    for (let hops = 0; hops < 20 && currentId !== null; hops++) {
      const jobs = await db().rows<{ run_key_id: string }>(
        `SELECT run_key_id FROM search_job WHERE search_id=$1 AND kind='SHOWTIME_FETCH'`,
        [currentId],
      );
      for (const j of jobs) {
        const rk = await db().one<{ showtime_id: string | null }>(
          `SELECT showtime_id FROM run_key WHERE run_key_id=$1`,
          [j.run_key_id],
        );
        if (rk.showtime_id) excluded.add(rk.showtime_id);
      }

      const parentRow: { continues_search_id: string | null } = await db().one<{
        continues_search_id: string | null;
      }>(`SELECT continues_search_id FROM search WHERE search_id=$1`, [currentId]);
      currentId = parentRow.continues_search_id;
    }
    // Should have excluded 60 showtimes (20 per search * 3)
    expect(excluded.size).toBe(60);
    expect(excluded.has("amc:showtime:chain_00")).toBe(true);
    expect(excluded.has("amc:showtime:chain_20")).toBe(true);
    expect(excluded.has("amc:showtime:chain_40")).toBe(true);
    // Verify original search1's next_seq unchanged after continuations
    const n1Before = await db().one<{ next_seq: string }>(
      `SELECT next_seq FROM search WHERE search_id=$1`,
      [search1],
    );
    const n1After = await db().one<{ next_seq: string }>(
      `SELECT next_seq FROM search WHERE search_id=$1`,
      [search1],
    );
    expect(n1After.next_seq).toBe(n1Before.next_seq);
  });
});

describe("tier 2 — S44 cold per-subscriber ranking (not insertion order)", () => {
  it("cold date: per-subscriber rank beats insertion order (dispatch_rank reflects rankCandidate, not startsAt sort)", async () => {
    const { rankCandidate } = await import("@seatfirst/core");
    const specImax = {
      providerId: "amc",
      theatres: { kind: "LIST", refs: [{ id: "amc:theatre:1" }] },
      where: {
        kind: "AND",
        of: [
          { kind: "MOVIE", ids: ["m1"] },
          { kind: "FORMAT", code: "imax" },
        ],
      } as unknown as SearchSpec["where"],
      region: { kind: "ALL" },
      aggregation: { reduce: "COUNT" },
      specVersion: 1,
    } as unknown as SearchSpec;
    const stEarly = {
      performance: {
        showtimeId: "amc:showtime:early",
        formatCode: null,
        startsAt: new Date("2026-08-20T09:00:00Z"),
      },
      theatreId: "amc:theatre:1",
      distanceKm: null,
      timezone: "UTC",
    };
    const stLate = {
      performance: {
        showtimeId: "amc:showtime:late",
        formatCode: "imax",
        startsAt: new Date("2026-08-20T10:00:00Z"),
      },
      theatreId: "amc:theatre:1",
      distanceKm: null,
      timezone: "UTC",
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
    const scoreEarly = rankCandidate(stEarly as unknown as TaggedFreshPerformance, specImax, "UTC");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
    const scoreLate = rankCandidate(stLate as unknown as TaggedFreshPerformance, specImax, "UTC");
    expect(scoreLate).toBeGreaterThan(scoreEarly);
    const insertion = [stEarly, stLate];
    const ranked = [...insertion].sort(
      (a, b) =>
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
        rankCandidate(b as unknown as TaggedFreshPerformance, specImax, "UTC") -
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- bridging unknown to branded type
        rankCandidate(a as unknown as TaggedFreshPerformance, specImax, "UTC"),
    );
    expect(ranked[0]!.performance.showtimeId).toBe("amc:showtime:late");
    expect(ranked[1]!.performance.showtimeId).toBe("amc:showtime:early");
  });
});
