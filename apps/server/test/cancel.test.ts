import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { Client, Pool } from "pg";

import type { TestServer } from "./support/app.js";
import { sessionCookieHeader, startTestServer } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase, seedSearchRow } from "./support/db.js";
import type { AppRouter } from "../src/routes/searches/router.js";

/**
 * S23 verification — the `searches.cancel` mutation end to end (S23.0/S23.1/S23.5/S23.6):
 * Zod boundary, ownership, idempotency, and the ADR 0018 CANCELLED response contract.
 *
 * S60: the route's `frozenEvidence` line is now wired to the persisted
 * `search_aggregate.evidence` (ADR 0066), so reveal-derivation cases with real
 * partial state are exercised below alongside the ownership / Zod / idempotency
 * cases (which never reach that line).
 */

let seq = 0;
function searchId(): string {
  seq += 1;
  return `srch_s23_${Date.now().toString(36)}_${seq}`;
}

let fetchSeq = 0;
/**
 * S60 — seeds one accepted SHOWTIME_FETCH observation plus its
 * `availability_snapshot` and `run_application` link for a search: exactly the
 * accepted-fetch shape `readCancelFrozenFacts` counts. `freeCount` drives the
 * frozen `freeSeats` fact.
 */
async function seedAcceptedFetch(pool: Pool, searchId: string, freeCount: number): Promise<void> {
  fetchSeq += 1;
  const tag = `${Date.now().toString(36)}_${fetchSeq}`;
  const runKeyId = `rk_cancel_${tag}`;
  const runId = `run_cancel_${tag}`;
  const observationId = `obs_cancel_${tag}`;
  const showtimeId = `st_cancel_${tag}`;
  const capturedAt = "2026-08-19T12:00:00.000Z";
  await pool.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc', 'seat', $2)`,
    [runKeyId, showtimeId],
  );
  await pool.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, state, generation, provider_epoch)
     VALUES ($1, $2, $3, 'DONE', 0, 0)`,
    [runId, runKeyId, observationId],
  );
  await pool.query(
    `INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
     VALUES ($1, $2, $3, $4, 0)`,
    [observationId, runKeyId, runId, capturedAt],
  );
  await pool.query(
    `INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at, bitmap, free_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [observationId, showtimeId, capturedAt, Buffer.from([0xff]), freeCount],
  );
  await pool.query(`INSERT INTO run_application (run_id, search_id) VALUES ($1, $2)`, [
    runId,
    searchId,
  ]);
}

/** One minimal hedged alternative with the real `HedgedRecommendation` field shape. */
function hedgedAlternative(seat: string): Record<string, unknown> {
  return {
    placement: {
      layoutId: "layout_cancel_test",
      row: 0,
      startCol: 0,
      rowSpan: 1,
      count: 1,
      seatNames: [seat],
      placementKey: `key_${seat}`,
    },
    reasons: [],
    relaxed: [{ kind: "AT_LEAST", threshold: 1 }],
    showtimes: [],
  };
}
/** A mutation-capable client (httpLink + session cookie), like create.test.ts — the SSE
 * `makeClient` in support/app.ts only serves subscriptions. */
function makeClient(baseUrl: string, sessionId: string) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: baseUrl, headers: { cookie: sessionCookieHeader(sessionId) } })],
  });
}
type MutationClient = ReturnType<typeof makeClient>;

describe("searches.cancel (S23)", () => {
  let pg: TestService;
  let redis: TestService;
  let server: TestServer;
  let pool: Pool;
  let admin: Client;
  let client: MutationClient;

  beforeEach(async () => {
    await admin.query("TRUNCATE search, provider_admission, provider_fence CASCADE");
  });

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = await startTestRedis();
    await migrateDatabase(pg.url);

    pool = new Pool({ connectionString: pg.url });
    admin = new Client({ connectionString: pg.url });
    await admin.connect();

    server = await startTestServer({ db: pool, redisUrl: redis.url, blockTimeoutMs: 250 });
    client = makeClient(server.baseUrl, "sess_owner");
  });

  afterAll(async () => {
    await server.close();
    await admin.end();
    await pool.end();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it("Zod boundary: a searchId failing ^srch_.+$ is BAD_REQUEST before any read or write", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await expect(
      client.searches.cancel.mutate({ searchId: "not-a-search-id" }),
    ).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
  });

  it("ownership: a different valid session, no session, and an unknown searchId are UNAUTHORIZED, never NOT_FOUND", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });

    const other = makeClient(server.baseUrl, "sess_other");
    await expect(other.searches.cancel.mutate({ searchId: id })).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });

    const anonymous = makeClient(server.baseUrl, "sess_ghost"); // no row owns it
    await expect(anonymous.searches.cancel.mutate({ searchId: id })).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });

    const unknown = makeClient(server.baseUrl, "sess_other");
    await expect(
      unknown.searches.cancel.mutate({ searchId: "srch_does_not_exist" }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  });

  it("ownership positive control: the owner can cancel (already-terminal no-op path, no answer derivation)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner", status: "HALTED" });
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "HALTED" });
  });

  it("idempotency: cancel of an already-terminal search is a no-op success echoing its status, with zero writes", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner", status: "HALTED" });
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "HALTED" });

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe("HALTED");
  });

  it("owner cancels a nonterminal search → the response echoes { searchId, status: 'CANCELLED' } (ADR 0018)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" }); // PENDING_SCHEDULE
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "CANCELLED" });
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe("CANCELLED");
  });

  it("no retroactive erasure: a search that already revealed an event keeps that row byte-identical after cancel", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    // Allocate seq 1 for the pre-existing event and advance next_seq so the terminal
    // event lands at the next free seq (search_event_pkey + event_seq_gapless).
    await pool.query(`UPDATE search SET next_seq = next_seq + 1 WHERE search_id = $1`, [id]);
    await pool.query(
      `INSERT INTO search_event (search_id, seq, type, payload)
       VALUES ($1, 1, 'SEARCH_STARTED', '{"n":1}'::jsonb)`,
      [id],
    );
    const before = await pool.query(
      `SELECT seq, type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [id],
    );

    await client.searches.cancel.mutate({ searchId: id });

    const after = await pool.query(
      `SELECT seq, type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [id],
    );
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
    expect(after.rows).toHaveLength(before.rows.length + 1);
  });

  it("S60 partial cancel: acceptedFetches > 0 with no persisted evidence returns CANCELLED EMPTY:HALTED (no S23 F1 throw)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await seedAcceptedFetch(pool, id, 0);
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "CANCELLED" });
    const version = await pool.query<{ payload: { answer: unknown } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    expect(version.rows[0]?.payload.answer).toEqual({
      mode: "EMPTY",
      cause: "HALTED",
      suggestions: [],
    });
  });

  it("S60 revision-skew masking: agg_requested_rev ahead of the materialized revision with empty evidence cancels EMPTY:HALTED, not NO_SHAPE_MATCH", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await seedAcceptedFetch(pool, id, 5);
    // New fetches accepted after the last materialized aggregate: the frozen
    // evidence (nothing persisted) is stale relative to freeSeats = 5, so the
    // route must mask freeSeats to 0 instead of misreporting NO_SHAPE_MATCH.
    await pool.query(`UPDATE search SET agg_requested_rev = 1 WHERE search_id = $1`, [id]);
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "CANCELLED" });
    const version = await pool.query<{ payload: { answer: unknown } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    expect(version.rows[0]?.payload.answer).toEqual({
      mode: "EMPTY",
      cause: "HALTED",
      suggestions: [],
    });
  });

  it("S60 persisted evidence: a search_aggregate row carrying hedged evidence reveals HEDGED on cancel", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await seedAcceptedFetch(pool, id, 2);
    const hedged = [hedgedAlternative("A1"), hedgedAlternative("A2")];
    await pool.query(
      `INSERT INTO search_aggregate (search_id, revision, payload, evidence)
       VALUES ($1, 0, '{}'::jsonb, $2::jsonb)`,
      [id, JSON.stringify({ exact: null, hedged, hitPlacementKeys: [[], []] })],
    );
    const res = await client.searches.cancel.mutate({ searchId: id });
    expect(res).toEqual({ searchId: id, status: "CANCELLED" });
    const version = await pool.query<{
      payload: { answer: { mode: string; alternatives: unknown[] } };
    }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    expect(version.rows[0]?.payload.answer.mode).toBe("HEDGED");
    expect(version.rows[0]?.payload.answer.alternatives).toHaveLength(2);
  });
});
