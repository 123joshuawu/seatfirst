import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import {
  completeTmdbPrewarm,
  dispatchTmdbFetch,
  markTmdbFetchDone,
  markTmdbFetchFailed,
  readTmdbFetchById,
  readTmdbPrewarmState,
} from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the S25 TMDB fetch machinery's boundaries (ADR 0019 amendment decisions 2 and
 * 5): the idempotent read-time dispatch, the searchless fetch row's lifecycle transitions,
 * and the pre-warm checkpoint. Lowest tier that catches each bug (dispatch dedup is a
 * conditional-insert effect; the transitions are guarded UPDATEs; the checkpoint is a
 * singleton upsert).
 */
describe("tier 2 — TMDB fetch dispatch and pre-warm state", () => {
  const db = useDatabase();

  it("TMDB_FETCH_DISPATCH inserts a PENDING fetch + TMDB_FETCH outbox, then dedups on repeat", async () => {
    const first = await dispatchTmdbFetch(db(), {
      tmdbFetchId: "fetch-dispatch",
      movieTitle: "The Odyssey",
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.tmdb_fetch_id).toBe("fetch-dispatch");
    expect(first[0]!.outbox_id).toMatch(/\S+/);

    // The fetch row exists, PENDING, with the outbox row pointing at it.
    const fetched = await readTmdbFetchById(db(), "fetch-dispatch");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({
      tmdb_fetch_id: "fetch-dispatch",
      movie_title: "The Odyssey",
      state: "PENDING",
      attempt: 0,
      fail_cause: null,
    });
    const outbox = await db().rows<{ target_kind: string; tmdb_fetch_id: string }>(
      `SELECT target_kind, tmdb_fetch_id FROM outbox WHERE outbox_id = $1`,
      [first[0]!.outbox_id],
    );
    expect(outbox).toEqual([{ target_kind: "TMDB_FETCH", tmdb_fetch_id: "fetch-dispatch" }]);

    // A repeat miss while the fetch is still PENDING is a no-op: zero rows, no new outbox.
    const repeat = await dispatchTmdbFetch(db(), {
      tmdbFetchId: "fetch-dispatch-2",
      movieTitle: "The Odyssey",
    });
    expect(repeat).toEqual([]);
    const outboxCount = await db().one<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE target_kind = 'TMDB_FETCH'`,
    );
    expect(outboxCount.n).toBe("1");
  });

  it("a DONE fetch no longer blocks a later re-dispatch for the same title", async () => {
    await dispatchTmdbFetch(db(), { tmdbFetchId: "fetch-redo", movieTitle: "Reloaded" });
    expectRow(B.TMDB_FETCH_DONE, await markTmdbFetchDone(db(), "fetch-redo"));

    // After DONE, the partial unique index (WHERE state = 'PENDING') no longer matches, so
    // a fresh dispatch for the same title wins.
    const redone = await dispatchTmdbFetch(db(), {
      tmdbFetchId: "fetch-redo-2",
      movieTitle: "Reloaded",
    });
    expect(redone).toHaveLength(1);
    expect(redone[0]!.tmdb_fetch_id).toBe("fetch-redo-2");
  });

  it("TMDB_FETCH_READ_BY_ID returns the row, or [] for a vanished id", async () => {
    await dispatchTmdbFetch(db(), { tmdbFetchId: "fetch-read", movieTitle: "Reader" });
    const row = await readTmdbFetchById(db(), "fetch-read");
    expect(row).toHaveLength(1);
    expect(row[0]!.movie_title).toBe("Reader");
    expect(await readTmdbFetchById(db(), "fetch-missing")).toEqual([]);
  });

  it("TMDB_FETCH_DONE transitions PENDING → DONE with attempt + 1, and is idempotent against re-mark", async () => {
    await dispatchTmdbFetch(db(), { tmdbFetchId: "fetch-done", movieTitle: "Done" });
    const done = expectRow(B.TMDB_FETCH_DONE, await markTmdbFetchDone(db(), "fetch-done"));
    expect(done).toMatchObject({ state: "DONE", attempt: 1, fail_cause: null });

    // A second mark is a no-op (the row is no longer PENDING).
    expect(await markTmdbFetchDone(db(), "fetch-done")).toEqual([]);
  });

  it("TMDB_FETCH_FAIL transitions PENDING → FAILED with the fail cause and attempt + 1", async () => {
    await dispatchTmdbFetch(db(), { tmdbFetchId: "fetch-fail", movieTitle: "Fail" });
    const failed = expectRow(
      B.TMDB_FETCH_FAIL,
      await markTmdbFetchFailed(db(), "fetch-fail", "no TMDB match"),
    );
    expect(failed).toMatchObject({ state: "FAILED", attempt: 1, fail_cause: "no TMDB match" });
    expect(await markTmdbFetchFailed(db(), "fetch-fail", "again")).toEqual([]);
  });

  it("TMDB_PREWARM_STATE_READ returns [] before any pass, and COMPLETE upserts the singleton", async () => {
    expect(await readTmdbPrewarmState(db())).toEqual([]);

    const first = expectRow(B.TMDB_PREWARM_COMPLETE, await completeTmdbPrewarm(db()));
    expect(first.last_completed_at).toBeInstanceOf(Date);

    const state = await readTmdbPrewarmState(db());
    expect(state).toHaveLength(1);
    expect(state[0]!.last_completed_at).toEqual(first.last_completed_at);

    const second = expectRow(B.TMDB_PREWARM_COMPLETE, await completeTmdbPrewarm(db()));
    expect(second.last_completed_at!.getTime()).toBeGreaterThanOrEqual(
      first.last_completed_at!.getTime(),
    );
    const count = await db().one<{ n: string }>(
      `SELECT count(*)::text AS n FROM tmdb_prewarm_state`,
    );
    expect(count.n).toBe("1");
  });
});
