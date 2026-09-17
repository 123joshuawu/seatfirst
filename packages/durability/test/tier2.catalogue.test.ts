import { describe, expect, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import {
  advanceCatalogueCrawlCursor,
  beginCatalogueCrawlPass,
  completeCatalogueCrawlPass,
  readCatalogueCrawlState,
} from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the theatre-catalogue crawl's restart-safe state (S26.1/S26.2/S26.3/S26.10).
 *
 * The four boundaries are the worker's only durable checkpoint: READ for due-ness, BEGIN
 * to open a pass, ADVANCE to persist the jsonb cursor after each page, COMPLETE to close a
 * pass. These tests assert the observable contract the worker depends on — zero rows =
 * immediately due, cursor round-trip, and the started/completed timestamp semantics that
 * must NOT be a monotonicity CHECK (completed_at lags behind started_at mid-pass).
 */
describe("tier 2 — catalogue crawl state (S26)", () => {
  const db = useDatabase();

  it("reports zero rows before any pass has run (the worker treats this as immediately due)", async () => {
    expect(await readCatalogueCrawlState(db(), "amc")).toEqual([]);
  });

  it("begins a pass, recording the start instant and clearing the cursor", async () => {
    const row = expectRow(
      B.CATALOGUE_CRAWL_STATE_BEGIN_PASS,
      await beginCatalogueCrawlPass(db(), "amc"),
    );
    expect(row.provider_id).toBe("amc");
    expect(row.last_pass_started_at).toBeInstanceOf(Date);
    expect(row.last_pass_completed_at).toBeNull();
    expect(row.cursor).toBeNull();
  });

  it("round-trips the restart-safety cursor through jsonb", async () => {
    expectRow(B.CATALOGUE_CRAWL_STATE_BEGIN_PASS, await beginCatalogueCrawlPass(db(), "amc"));

    const cursor = { slugs: ["albany-ga", "atlanta", "wichita"], nextIndex: 2 };
    const advanced = expectRow(
      B.CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR,
      await advanceCatalogueCrawlCursor(db(), "amc", cursor),
    );
    expect(advanced.cursor).toEqual(cursor);

    // A fresh read (the process-restart read) returns the persisted cursor unchanged, so
    // the next tick resumes mid-pass without re-fetching the directory page.
    const restored = expectRow(
      B.CATALOGUE_CRAWL_STATE_READ,
      await readCatalogueCrawlState(db(), "amc"),
    );
    expect(restored.cursor).toEqual(cursor);
    expect(restored.last_pass_started_at).toBeInstanceOf(Date);
  });

  it("completes a pass, recording completion and clearing the cursor", async () => {
    expectRow(B.CATALOGUE_CRAWL_STATE_BEGIN_PASS, await beginCatalogueCrawlPass(db(), "amc"));
    await advanceCatalogueCrawlCursor(db(), "amc", { slugs: ["a"], nextIndex: 1 });

    const completed = expectRow(
      B.CATALOGUE_CRAWL_STATE_COMPLETE_PASS,
      await completeCatalogueCrawlPass(db(), "amc"),
    );
    expect(completed.last_pass_completed_at).toBeInstanceOf(Date);
    expect(completed.cursor).toBeNull();

    const finalRow = expectRow(
      B.CATALOGUE_CRAWL_STATE_READ,
      await readCatalogueCrawlState(db(), "amc"),
    );
    expect(finalRow.last_pass_completed_at).toBeInstanceOf(Date);
    expect(finalRow.cursor).toBeNull();
  });

  it("keeps the prior pass's completed_at when a new pass begins (no monotonicity CHECK)", async () => {
    const first = expectRow(
      B.CATALOGUE_CRAWL_STATE_BEGIN_PASS,
      await beginCatalogueCrawlPass(db(), "amc"),
    );
    const done = expectRow(
      B.CATALOGUE_CRAWL_STATE_COMPLETE_PASS,
      await completeCatalogueCrawlPass(db(), "amc"),
    );

    // A new pass resets started_at to now() but keeps completed_at at the PREVIOUS pass's
    // instant until this pass finishes — so completed_at < started_at mid-pass. A schema
    // CHECK like movie's (last_seen_at >= first_seen_at) would reject this exact state.
    const next = expectRow(
      B.CATALOGUE_CRAWL_STATE_BEGIN_PASS,
      await beginCatalogueCrawlPass(db(), "amc"),
    );
    expect(next.last_pass_completed_at).toEqual(done.last_pass_completed_at);

    const nextStarted = next.last_pass_started_at;
    const firstStarted = first.last_pass_started_at;
    expect(nextStarted).toBeInstanceOf(Date);
    expect(firstStarted).toBeInstanceOf(Date);
    if (nextStarted === null || firstStarted === null) {
      throw new Error("BEGIN_PASS must record a non-null last_pass_started_at");
    }
    expect(nextStarted.getTime()).toBeGreaterThanOrEqual(firstStarted.getTime());
  });

  it("returns zero rows when advancing a cursor with no in-progress pass", async () => {
    const rows = await advanceCatalogueCrawlCursor(db(), "amc", { slugs: [], nextIndex: 0 });
    expect(rows).toEqual([]);
    expect(() => expectRow(B.CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR, rows)).toThrow(
      B.CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR.zeroRowsMeans,
    );
  });
});
