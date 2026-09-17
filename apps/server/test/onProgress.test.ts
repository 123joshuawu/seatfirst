import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import IORedis from "ioredis";
import { Client, Pool } from "pg";

import { deriveRankedAnswer, terminalize } from "@seatfirst/durability";
import type { LifecycleStatus, RankedAnswer } from "@seatfirst/durability";

import { verifyRecheckNonce } from "../src/session/nonce.js";
import type { ProgressEvent } from "../src/streaming/reader.js";
import {
  makeClient,
  sessionCookieHeader,
  startTestServer,
  TEST_NONCE_SECRET,
} from "./support/app.js";
import type { TestClient, TestServer } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import {
  asTransactionClient,
  migrateDatabase,
  projectEvents,
  seedEvents,
  seedSearchEligibleForTerminalization,
  seedSearchRow,
} from "./support/db.js";

/**
 * S12 verification: the `searches.onProgress` transport, end to end, against real
 * Postgres 16 and Redis 7 (testcontainers, or `SERVER_PG_URL`/`SERVER_REDIS_URL`).
 *
 * Every item of the spec's verification list is a `it()` below, plus one extra test for
 * the S12.5 keepalive comment, which the nine items do not cover but the spec requires.
 * Events are seeded directly (this task does not generate events, S12.8); the
 * terminal-close test calls the real `terminalize()` composition from
 * `@seatfirst/durability` rather than hand-setting `search.status`.
 */

interface Tracked {
  readonly id: string;
  readonly data: ProgressEvent;
}

interface TestIterator {
  next(): Promise<IteratorResult<Tracked>>;
  close(): void;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * tRPC v11's `subscribe()` is observer-style (it returns an `Unsubscribable`, not an
 * async iterator), so the tests bridge it to the iterator shape they assert against.
 * `onError` is delivered as a rejection from the next `next()` call — the same observable
 * contract the async-generator client would expose.
 */
function subscribe(client: TestClient, searchId: string, lastEventId?: string): TestIterator {
  const queued: Promise<IteratorResult<Tracked>>[] = [];
  let waiting: ((result: Promise<IteratorResult<Tracked>>) => void) | null = null;
  const deliver = (result: IteratorResult<Tracked> | Promise<never>): void => {
    if (waiting !== null) {
      const wake = waiting;
      waiting = null;
      wake(Promise.resolve(result));
    } else {
      queued.push(Promise.resolve(result));
    }
  };

  const subscription = client.searches.onProgress.subscribe(
    lastEventId === undefined ? { searchId } : { searchId, lastEventId },
    {
      onData: (value) => deliver({ done: false, value: value as Tracked }),
      onError: (cause) => deliver(Promise.reject(cause)),
      onComplete: () => deliver({ done: true, value: undefined as never }),
    },
  );

  return {
    next: async () => {
      const head = queued.shift();
      if (head !== undefined) return head;
      return new Promise<IteratorResult<Tracked>>((resolve) => {
        waiting = resolve;
      });
    },
    close: () => {
      subscription.unsubscribe();
    },
  };
}

async function nextEvent(
  iterator: TestIterator,
  ms = 10_000,
  label = "next event",
): Promise<Tracked> {
  const result = await withDeadline(iterator.next(), ms, label);
  if (result.done) throw new Error(`subscription closed before ${label}`);
  return result.value;
}

/**
 * The seeded terminalization world is a warm no-job search: COMPLETE, null cause, zero
 * accepted fetch observations — so ADR 0009's absence-of-data guard classifies
 * EMPTY:HALTED (`packages/durability/src/lifecycle.ts:135`). S6U3.9: the payload the
 * transport reveals must be exactly `deriveRankedAnswer`'s return for the facts.
 */
function revealResult(state: { status: string; cause: string | null }): {
  status: string;
  answer: RankedAnswer;
} {
  return {
    status: state.status,
    answer: deriveRankedAnswer(
      {
        status: state.status as LifecycleStatus,
        terminalCause: state.cause,
        scheduleOutcome: null,
        acceptedFetches: 0,
        freeSeats: 0,
      },
      { exact: null, hedged: null },
    ) as RankedAnswer, // terminal facts — the null return is only for the two live statuses
  };
}

let seqCounter = 0;
function searchId(prefix = "s12"): string {
  seqCounter += 1;
  return `srch_${prefix}_${Date.now().toString(36)}_${seqCounter}`;
}

describe("searches.onProgress (S12)", () => {
  let pg: TestService;
  let redis: TestService;
  let server: TestServer;
  let pool: Pool;
  let admin: Client;
  let redisAdmin: IORedis.Redis;
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
    redisAdmin = new IORedis.Redis(redis.url, { lazyConnect: true });
    await redisAdmin.connect();

    server = await startTestServer({ db: pool, redisUrl: redis.url, blockTimeoutMs: 250 });
  });

  afterAll(async () => {
    await server.close();
    redisAdmin.disconnect();
    await admin.end();
    await pool.end();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it("happy path: seeds 1-3 stream in order, a mid-subscription seed arrives after the block cycle (item 1)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });
    await seedEvents(pool, id, [
      { type: "PROGRESS", payload: { note: "one" } },
      { type: "PROGRESS", payload: { note: "two" } },
      { type: "PROGRESS", payload: { note: "three" } },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_a"), id);

    const first = await nextEvent(iterator);
    expect(first).toEqual({
      id: "1-0",
      data: { seq: 1, type: "PROGRESS", payload: { note: "one" } },
    });
    expect((await nextEvent(iterator)).id).toBe("2-0");
    expect((await nextEvent(iterator)).id).toBe("3-0");

    // The fourth event lands mid-subscription, projected to the stream like the real
    // projector would (table row + XADD), and is delivered by the next read cycle.
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: { note: "four" } }], {
      firstSeq: 4,
    });
    await projectEvents(redisAdmin, id, [{ seq: 4, type: "PROGRESS", payload: { note: "four" } }]);

    const fourth = await nextEvent(iterator);
    expect(fourth).toEqual({
      id: "4-0",
      data: { seq: 4, type: "PROGRESS", payload: { note: "four" } },
    });

    iterator.close();
  });
  it("tracked reconnect with a valid cursor skips everything at or before it (item 2)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });
    const events = [1, 2, 3, 4, 5].map((n) => ({ type: "PROGRESS", payload: { n } }));
    await seedEvents(pool, id, events);
    await projectEvents(
      redisAdmin,
      id,
      events.map((e, i) => ({ seq: i + 1, ...e })),
    );

    // lastEventId "2-0" ⇒ resume from the event AFTER that id (S12.3).
    const iterator = subscribe(makeClient(server.baseUrl, "sess_a"), id, "2-0");

    // Each delivered value carries the tracked id exactly as the `tracked()` argument set
    // it — on the wire that is the SSE `id:` field, which the client surfaces here.
    expect(await nextEvent(iterator)).toEqual({
      id: "3-0",
      data: { seq: 3, type: "PROGRESS", payload: { n: 3 } },
    });
    expect((await nextEvent(iterator)).id).toBe("4-0");
    expect((await nextEvent(iterator)).id).toBe("5-0");

    iterator.close();
  });

  it("a non-conforming lastEventId is rejected with BAD_REQUEST, not treated as zero (item 3)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: {} }]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_a"), id, "garbage");
    await expect(
      withDeadline(iterator.next(), 10_000, "BAD_REQUEST rejection"),
    ).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
  });

  it("ownership: a session that does not own the search is rejected before any event (item 4)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_A" });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: {} }]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_B"), id);
    await expect(
      withDeadline(iterator.next(), 10_000, "UNAUTHORIZED rejection"),
    ).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });
  });

  it("ownership: the owning session receives events normally (item 5)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_A" });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: { ok: true } }]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_A"), id);
    expect((await nextEvent(iterator)).data).toMatchObject({
      seq: 1,
      type: "PROGRESS",
      payload: { ok: true },
    });

    iterator.close();
  });

  it("terminal close: the real terminalize() composition's SEARCH_TERMINAL row is delivered and the stream closes (item 6)", async () => {
    const id = searchId("term");
    await seedSearchEligibleForTerminalization(asTransactionClient(admin), {
      searchId: id,
      sessionId: "sess_term",
    });

    const terminal = await terminalize(asTransactionClient(admin), id, {
      // S6U3.9: the payload must supply the reveal answer (deriveRankedAnswer on the
      // seeded facts — a warm no-job world, so the ADR 0009 absence-of-data guard
      // classifies EMPTY:HALTED). An answer-less payload would now throw (S6U3.1).
      resultPayload: (state) => revealResult(state),
    });
    expect(terminal).toEqual({ status: "COMPLETE", cause: null });

    // The subscription must deliver the SEARCH_TERMINAL row and close from the server
    // side — nothing hand-set here; the row came from B8_TERMINAL_EVENT.
    const iterator = subscribe(makeClient(server.baseUrl, "sess_term"), id);
    const event = await nextEvent(iterator);
    expect(event.id).toBe("1-0");
    expect(event.data).toEqual({
      seq: 1,
      type: "SEARCH_TERMINAL",
      payload: {
        status: "COMPLETE",
        cause: null,
        answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
      },
    });
    expect((await withDeadline(iterator.next(), 10_000, "generator close")).done).toBe(true);
  });

  it("redis stream fallback: unprojected events are served straight from the table (item 7)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });
    // Deliberately NOT projected to the Redis Stream — simulating a pre-projection or
    // post-Redis-loss state.
    await seedEvents(pool, id, [
      { type: "PROGRESS", payload: { n: 1 } },
      { type: "PROGRESS", payload: { n: 2 } },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_a"), id);
    expect((await nextEvent(iterator)).id).toBe("1-0");
    expect((await nextEvent(iterator)).id).toBe("2-0");

    iterator.close();
  });

  it("client disconnect releases the blocked XREAD connection (item 8)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: {} }]);
    await projectEvents(redisAdmin, id, [{ seq: 1, type: "PROGRESS", payload: {} }]);

    const clientCount = async (): Promise<number> => {
      const list = (await redisAdmin.call("CLIENT", "LIST")) as string;
      return list.split("\n").filter((line) => line.startsWith("id=")).length;
    };

    // A prior test's `iterator.close()` only requests teardown — it does not wait for
    // the underlying Redis connection to actually disconnect, so a straggler from an
    // earlier test can still be mid-teardown when this test starts (or even mid-test,
    // since Vitest itself never blocks on it). A short "two reads 100ms apart agree"
    // settle check is not long enough: under CI's shared-runner network jitter, a
    // socket FIN can take well over 200ms to actually land while `CLIENT LIST` still
    // reports the connection present the whole time, so a short window can accept a
    // reading that later drops on its own — inflating `baseline` — well after the
    // check declared it "settled" (observed directly in CI: `baseline` read 2,
    // survived the two-read check, then still dropped to 1 within the final
    // wait for a straggler was still finishing up). Require a much longer run of
    // agreeing reads — enough continuous quiescence that a straggler already this far
    // into teardown has had time to actually finish — before treating a count as
    // ground truth. This fixes the actual defect (a too-short settle window) rather
    // than retrying the assertion in hopes of getting lucky.
    const settledClientCount = async (): Promise<number> => {
      const requiredAgreeingReads = 15;
      const readIntervalMs = 200;
      const deadline = Date.now() + 30_000;
      let candidate = await clientCount();
      let agreeingReads = 1;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, readIntervalMs));
        const current = await clientCount();
        if (current === candidate) {
          agreeingReads += 1;
          if (agreeingReads >= requiredAgreeingReads) {
            return candidate;
          }
        } else {
          candidate = current;
          agreeingReads = 1;
        }
        if (Date.now() > deadline) {
          throw new Error(`client count never settled (last saw ${candidate})`);
        }
      }
    };

    const baseline = await settledClientCount();
    const iterator = subscribe(makeClient(server.baseUrl, "sess_a"), id);
    expect((await nextEvent(iterator)).id).toBe("1-0");

    // The reader is now inside its blocked XREAD on a dedicated connection. Wait until
    // that connection is actually up, then disconnect — the released count is what
    // "no resource leak" means on the Redis side.
    await vi.waitFor(
      async () => {
        expect(await clientCount()).toBeGreaterThan(baseline);
      },
      { timeout: 10_000, interval: 100 },
    );
    iterator.close();
    expect(await settledClientCount()).toBe(baseline);
  });

  it("two simultaneous subscribers each receive every event independently (item 9)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_a" });

    const iteratorA = subscribe(makeClient(server.baseUrl, "sess_a"), id);
    const iteratorB = subscribe(makeClient(server.baseUrl, "sess_a"), id);

    await seedEvents(pool, id, [{ type: "PROGRESS", payload: { shared: true } }]);
    await projectEvents(redisAdmin, id, [{ seq: 1, type: "PROGRESS", payload: { shared: true } }]);

    const [a, b] = await Promise.all([nextEvent(iteratorA), nextEvent(iteratorB)]);
    expect(a).toEqual({ id: "1-0", data: { seq: 1, type: "PROGRESS", payload: { shared: true } } });
    expect(b).toEqual(a);

    iteratorA.close();
    iteratorB.close();
  });

  it("an XREAD block timeout emits an SSE keepalive comment, not a domain event (S12.5)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_keep" });

    const url =
      `${server.url}/trpc/searches.onProgress?input=` +
      encodeURIComponent(JSON.stringify({ searchId: id }));
    const response = await fetch(url, { headers: { cookie: sessionCookieHeader("sess_keep") } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no response body");

    const decoder = new TextDecoder();
    let text = "";
    let sawConnected = false;
    let sawKeepAlive = false;
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline && !(sawConnected && sawKeepAlive)) {
        const result: { value: Uint8Array | undefined; done: boolean } = await reader.read();
        if (result.done) break;
        text += decoder.decode(result.value, { stream: true });
        sawConnected ||= text.includes("event: connected");
        sawKeepAlive ||= text.includes(": keepalive");
      }
    } finally {
      await reader.cancel();
    }

    expect(sawConnected).toBe(true);
    expect(sawKeepAlive).toBe(true);
    // Beyond the connected frame there must be no `data:` frame: the keepalive is
    // transport-level, never a fabricated domain event.
    const connectedFrame = "event: connected\ndata: {}\n\n";
    const afterConnected = text.slice(text.indexOf(connectedFrame) + connectedFrame.length);
    expect(afterConnected).not.toContain("data:");
  });

  it("keeps credentialed CORS headers on the hijacked SSE response", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_cors" });
    const origin = "http://localhost:8081";
    const url =
      `${server.url}/trpc/searches.onProgress?input=` +
      encodeURIComponent(JSON.stringify({ searchId: id }));

    const response = await fetch(url, {
      headers: { cookie: sessionCookieHeader("sess_cors"), origin },
    });
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await response.body?.cancel();
    }
  });

  // ── S6U3 (ADR 0012) — answer-stability over the S12 transport ────────────────────
  // The reveal contract: exactly the SEARCH_TERMINAL row carries a schema-valid
  // `answer`; delivery validates it fail-closed; an already-terminal search never
  // keepalives forever; re-delivery is byte-identical and at most once per subscriber.

  it("reveal at terminal, never before, matching the persisted result (verification 1)", async () => {
    const id = searchId("reveal");
    await seedSearchEligibleForTerminalization(asTransactionClient(admin), {
      searchId: id,
      sessionId: "sess_reveal",
    });
    // Pre-terminal window: FETCH_* payload shapes (S12's seed convention).
    await seedEvents(pool, id, [
      { type: "FETCH_ACCEPTED", payload: { observationId: "obs_a", outcome: "ACCEPTED" } },
      { type: "FETCH_FAILED", payload: { cause: "TIMEOUT" } },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_reveal"), id);
    // Every pre-terminal row streams as a progress type with NO answer key.
    expect((await nextEvent(iterator)).data).toEqual({
      seq: 1,
      type: "FETCH_ACCEPTED",
      payload: { observationId: "obs_a", outcome: "ACCEPTED" },
    });
    expect((await nextEvent(iterator)).data).toEqual({
      seq: 2,
      type: "FETCH_FAILED",
      payload: { cause: "TIMEOUT" },
    });

    // Terminalize mid-subscription through the real composition; phase A picks the
    // reveal up on the next cycle.
    const terminal = await terminalize(asTransactionClient(admin), id, {
      resultPayload: (state) => revealResult(state),
    });
    expect(terminal).toEqual({ status: "COMPLETE", cause: null });

    const reveal = await nextEvent(iterator);
    expect(reveal).toEqual({
      id: "3-0",
      data: {
        seq: 3,
        type: "SEARCH_TERMINAL",
        payload: {
          status: "COMPLETE",
          cause: null,
          answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
        },
      },
    });
    // S6U3.3(a): reveal and immutable result are the same object from one transaction.
    const version = await pool.query<{ payload: { answer: unknown } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1`,
      [id],
    );
    const persisted = version.rows[0];
    if (persisted === undefined) throw new Error("terminalize wrote no result version");
    expect(persisted.payload.answer).toEqual((reveal.data.payload as { answer: unknown }).answer);
    expect((await withDeadline(iterator.next(), 10_000, "close after reveal")).done).toBe(true);
  });

  it("fail-closed: a terminal row without a valid answer errors the stream (verification 4a)", async () => {
    const id = searchId("badreveal");
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_bad" });
    // The pre-task payload shape — S6U3.0's schema requires `answer`, so this row is
    // evidence of a corrupted/legacy producer and must never reach the client.
    await seedEvents(pool, id, [
      { type: "PROGRESS", payload: { note: "first" } },
      { type: "SEARCH_TERMINAL", payload: { status: "COMPLETE", cause: null } },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_bad"), id);
    expect((await nextEvent(iterator)).id).toBe("1-0"); // earlier rows still deliver
    await expect(withDeadline(iterator.next(), 10_000, "fail-closed error")).rejects.toThrow(
      /reveal validation/,
    );
  });

  it("positive control: a valid reveal payload streams and closes cleanly (verification 4b)", async () => {
    const id = searchId("goodreveal");
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_good" });
    await seedEvents(pool, id, [
      {
        type: "SEARCH_TERMINAL",
        payload: {
          status: "COMPLETE",
          cause: null,
          answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
        },
      },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_good"), id);
    expect((await nextEvent(iterator)).data).toEqual({
      seq: 1,
      type: "SEARCH_TERMINAL",
      payload: {
        status: "COMPLETE",
        cause: null,
        answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
      },
    });
    expect((await withDeadline(iterator.next(), 10_000, "clean close")).done).toBe(true);
  });

  it("signs a per-offer recheck nonce at the terminal reveal (S34)", async () => {
    const id = searchId("confreveal");
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_conf" });
    await admin.query(
      `INSERT INTO search_result_version (search_id, version, payload) VALUES ($1, 1, $2::jsonb)`,
      [id, JSON.stringify({ status: "COMPLETE", answer: null })],
    );
    await seedEvents(pool, id, [
      {
        type: "SEARCH_TERMINAL",
        payload: {
          status: "COMPLETE",
          cause: null,
          answer: {
            mode: "CONFIDENT",
            primary: {
              placement: {
                layoutId: "layout_1",
                row: 0,
                startCol: 0,
                rowSpan: 1,
                count: 2,
                seatNames: ["A1", "A2"],
                placementKey: "placement_1",
              },
              reasons: [{ kind: "TOGETHER", count: 2 }],
              relaxed: [],
              showtimes: [
                {
                  showtimeId: "amc:showtime:1",
                  theatreId: "amc:theatre:t1",
                  distanceKm: null,
                  showDateTimeUtc: "2026-08-20T19:00:00.000Z",
                  timezone: "America/Los_Angeles",
                  minPrice: { amount: 18.5, currency: "USD", basis: "TICKET_ONLY" },
                  status: "OPEN",
                  deepLinkUrl: "https://example.invalid/showtime",
                  capturedAt: "2026-08-19T12:00:00.000Z",
                  staleAfter: "2026-08-19T12:15:00.000Z",
                  nonce: null,
                },
              ],
            },
            otherFormats: [],
          },
        },
      },
    ]);

    const before = Date.now();
    const iterator = subscribe(makeClient(server.baseUrl, "sess_conf"), id);
    const event = await nextEvent(iterator);
    const after = Date.now();
    expect(event.data.type).toBe("SEARCH_TERMINAL");
    const payload = event.data.payload as {
      status: string;
      cause: string | null;
      answer: {
        mode: string;
        primary: {
          placement: { placementKey: string };
          showtimes: Array<{ showtimeId: string; nonce: string | null }>;
        };
      };
    };
    expect(payload.answer.mode).toBe("CONFIDENT");
    const offer = payload.answer.primary.showtimes[0]!;
    expect(offer.nonce).not.toBeNull();

    const nonce = verifyRecheckNonce(offer.nonce as string, TEST_NONCE_SECRET);
    expect(nonce).not.toBeNull();
    expect(nonce!.sessionId).toBe("sess_conf");
    expect(nonce!.searchId).toBe(id);
    expect(nonce!.resultVersion).toBe(1);
    expect(nonce!.showtimeId).toBe("amc:showtime:1");
    expect(nonce!.placementKey).toBe("placement_1");
    expect(nonce!.expiry).toBeGreaterThan(before);
    expect(nonce!.expiry).toBeLessThanOrEqual(after + 10 * 60 * 1000);

    expect((await withDeadline(iterator.next(), 10_000, "close")).done).toBe(true);
  });

  it("fail-closed: a non-terminal row carrying an answer key errors the stream (verification 5a)", async () => {
    const id = searchId("badfetch");
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_bad2" });
    await seedEvents(pool, id, [
      {
        type: "FETCH_ACCEPTED",
        payload: {
          observationId: "obs_x",
          outcome: "ACCEPTED",
          answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
        },
      },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_bad2"), id);
    await expect(withDeadline(iterator.next(), 10_000, "fail-closed error")).rejects.toThrow(
      /carries an answer/,
    );
  });

  it("positive control: normal FETCH_ACCEPTED rows stream (verification 5b)", async () => {
    const id = searchId("goodfetch");
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_good2" });
    await seedEvents(pool, id, [
      { type: "FETCH_ACCEPTED", payload: { observationId: "obs_a", outcome: "ACCEPTED" } },
      { type: "FETCH_FAILED", payload: { cause: "TIMEOUT" } },
    ]);

    const iterator = subscribe(makeClient(server.baseUrl, "sess_good2"), id);
    expect((await nextEvent(iterator)).id).toBe("1-0");
    expect((await nextEvent(iterator)).id).toBe("2-0");
    iterator.close();
  });

  it("already-terminal reconnect: prompt close at the reveal, delivery when the cursor precedes it (verification 6)", async () => {
    const id = searchId("reconnect");
    await seedSearchEligibleForTerminalization(asTransactionClient(admin), {
      searchId: id,
      sessionId: "sess_re",
    });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: { note: "early" } }]);
    await terminalize(asTransactionClient(admin), id, {
      resultPayload: (state) => revealResult(state),
    }); // reveal lands at seq 2

    // No cursor: the full history streams, ending with the reveal (existing close).
    const noCursor = subscribe(makeClient(server.baseUrl, "sess_re"), id);
    expect((await nextEvent(noCursor)).data).toMatchObject({ seq: 1, type: "PROGRESS" });
    expect((await nextEvent(noCursor)).data).toMatchObject({ seq: 2, type: "SEARCH_TERMINAL" });
    expect((await withDeadline(noCursor.next(), 10_000, "close")).done).toBe(true);

    // Cursor AT the reveal: prompt close with no events — and NO keepalive loop (the
    // deadline would trip on an endless `: keepalive` stream).
    const atReveal = subscribe(makeClient(server.baseUrl, "sess_re"), id, "2-0");
    expect((await withDeadline(atReveal.next(), 5_000, "prompt close")).done).toBe(true);

    // Cursor BEFORE the reveal: only the rows after it arrive, ending with the reveal.
    const beforeReveal = subscribe(makeClient(server.baseUrl, "sess_re"), id, "1-0");
    expect((await nextEvent(beforeReveal)).data).toMatchObject({
      seq: 2,
      type: "SEARCH_TERMINAL",
    });
    expect((await withDeadline(beforeReveal.next(), 10_000, "close")).done).toBe(true);
  });

  it("monotonicity: byte-identical re-delivery, no second reveal, identical simultaneous reveals (verification 7)", async () => {
    const id = searchId("replay");
    await seedSearchEligibleForTerminalization(asTransactionClient(admin), {
      searchId: id,
      sessionId: "sess_rep",
    });
    await seedEvents(pool, id, [{ type: "PROGRESS", payload: { note: "early" } }]);
    await terminalize(asTransactionClient(admin), id, {
      resultPayload: (state) => revealResult(state),
    }); // reveal lands at seq 2

    const first = subscribe(makeClient(server.baseUrl, "sess_rep"), id);
    await nextEvent(first); // seq 1
    const revealA = await nextEvent(first); // seq 2 — first delivery

    // Cursor just before the terminal row: the reveal is re-delivered byte-identically.
    const replay = subscribe(makeClient(server.baseUrl, "sess_rep"), id, "1-0");
    const revealB = await nextEvent(replay);
    expect(revealB).toEqual(revealA);

    // Two simultaneous subscribers see the identical reveal (S12.9's independence).
    const [c, d] = await Promise.all([
      nextEvent(subscribe(makeClient(server.baseUrl, "sess_rep"), id, "1-0")),
      nextEvent(subscribe(makeClient(server.baseUrl, "sess_rep"), id, "1-0")),
    ]);
    expect(c).toEqual(revealA);
    expect(d).toEqual(revealA);

    // Cursor AT the terminal row: no second reveal, prompt close.
    const atReveal = subscribe(makeClient(server.baseUrl, "sess_rep"), id, "2-0");
    expect((await withDeadline(atReveal.next(), 5_000, "no second reveal")).done).toBe(true);
  });
});
