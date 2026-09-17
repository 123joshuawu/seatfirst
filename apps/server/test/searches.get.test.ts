import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

import { verifyRecheckNonce } from "../src/session/nonce.js";

import type { TestServer } from "./support/app.js";
import { sessionCookieHeader, startTestServer, TEST_NONCE_SECRET } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S19 verification — `searches.get` against a real Fastify server and real Postgres
 * (verification items 1–8). The route is BESPOKE (`registerSearchGet`, exactly like
 * `session.bootstrap`/`showtimes.recheck`), served as a GET query, so it is driven with raw
 * `fetch` (the same pattern the `session.bootstrap` tests use) — the only way to exercise
 * the ETag/`If-None-Match`/304 wire contract.
 *
 * The search rows and their serving payloads are seeded directly (raw INSERTs): this
 * simulates the AGGREGATE dispatch handler's output — precondition simulation, which the
 * spec explicitly permits ("the seed simulates the future AGGREGATE handler's output —
 * precondition simulation is allowed", `docs/tasks/README.md:133-134`). The terminalization
 * and aggregate-upsert transitions themselves are tier-proven in the durability suite; the
 * route is a pure reader of their stored rows, and this suite asserts the route's serving
 * contract — byte-equal serve, fail-closed schema parse, ownership, the ETag/304 round-trip,
 * and the fail-loud nonterminal-no-aggregate guard.
 */

const PROVIDER = "amc";
const THEATRE = "amc:theatre:t1";
const MOVIE = "amc:movie:m1";
const LOCAL_DATE = "2026-08-20";
const FUTURE = new Date(Date.now() + 60_000 * 60).toISOString();
const OWNER = "sess_get_owner";

let searchSeq = 0;
function searchId(): string {
  searchSeq += 1;
  return `srch_get_${Date.now().toString(36)}_${searchSeq}`;
}

function makeSpec(): Record<string, unknown> {
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [MOVIE] },
        { kind: "DATE_RANGE", from: LOCAL_DATE, to: LOCAL_DATE },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  };
}

/** The shared zero `ExcludedCounts` bucket (all-zero in the seeded payloads). */
function excludedCounts(): Record<string, unknown> {
  return {
    soldOut: 0,
    outsideWindow: 0,
    outsideRegion: 0,
    outsideArea: 0,
    wrongAttributes: 0,
    overPrice: 0,
    notReservedSeating: 0,
    fetchFailed: 0,
    fetchFailedByCause: {},
    byTheatre: {},
  };
}

/** A terminal COMPLETE `SearchResult` — EMPTY:HALTED is valid for COMPLETE (result-contracts). */
function terminalPayload(searchIdValue: string): Record<string, unknown> {
  return {
    searchId: searchIdValue,
    spec: makeSpec(),
    status: "COMPLETE",
    resolved: 0,
    total: 0,
    capturedAtRange: null,
    groups: [],
    excluded: excludedCounts(),
    answer: { mode: "EMPTY", cause: "HALTED", suggestions: [] },
  };
}

/**
 * A terminal COMPLETE `SearchResult` with a CONFIDENT answer carrying one offer
 * (`nonce: null`). Used to assert serve-time nonce issuance (S34): the served offer must
 * carry a fresh, correctly-bound, verifiable nonce. The offer's `capturedAt` forces a
 * non-null `capturedAtRange` (result-contracts requires the range when offers carry
 * `capturedAt`), and its deep link host `example.invalid` is allowlisted for `amc`.
 */
function confidentTerminalPayload(searchIdValue: string): Record<string, unknown> {
  return {
    searchId: searchIdValue,
    spec: makeSpec(),
    status: "COMPLETE",
    resolved: 1,
    total: 1,
    capturedAtRange: ["2026-08-19T12:00:00.000Z", "2026-08-19T12:00:00.000Z"],
    groups: [],
    excluded: excludedCounts(),
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
            theatreId: THEATRE,
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
  };
}

/** A nonterminal RUNNING `SearchResult` — `answer: null` (schema-enforced), total 5. */
function nonterminalPayload(searchIdValue: string): Record<string, unknown> {
  return {
    searchId: searchIdValue,
    spec: makeSpec(),
    status: "RUNNING",
    resolved: 1,
    total: 5,
    capturedAtRange: null,
    groups: [],
    excluded: excludedCounts(),
    answer: null,
  };
}

/** A schema-invalid terminal payload (missing `answer`, no `groups`/`spec`) — fail-closed. */
function invalidTerminalPayload(searchIdValue: string): Record<string, unknown> {
  return { status: "COMPLETE", searchId: searchIdValue };
}

interface SeedSearchOptions {
  status?: string;
  versionPayload?: Record<string, unknown> | null;
  aggregatePayload?: Record<string, unknown> | null;
  aggregateRevision?: number;
}

async function seedSearch(
  admin: Client,
  searchIdValue: string,
  sessionId: string,
  opts: SeedSearchOptions = {},
): Promise<void> {
  await admin.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      searchIdValue,
      sessionId,
      `idem_${searchIdValue}`,
      JSON.stringify(makeSpec()),
      `hash_${searchIdValue}`,
      opts.status ?? "COMPLETE",
      FUTURE,
    ],
  );
  if (opts.versionPayload !== null && opts.versionPayload !== undefined) {
    await admin.query(
      `INSERT INTO search_result_version (search_id, version, payload) VALUES ($1, 1, $2::jsonb)`,
      [searchIdValue, JSON.stringify(opts.versionPayload)],
    );
  }
  if (opts.aggregatePayload !== null && opts.aggregatePayload !== undefined) {
    await admin.query(
      `INSERT INTO search_aggregate (search_id, revision, payload) VALUES ($1, $2, $3::jsonb)`,
      [searchIdValue, opts.aggregateRevision ?? 1, JSON.stringify(opts.aggregatePayload)],
    );
  }
}

interface GetOptions {
  sessionId?: string;
  ifNoneMatch?: string;
  searchId?: string;
}

/** Performs the raw GET query and returns status + parsed envelope + etag header. */
async function getResult(
  url: string,
  opts: GetOptions,
): Promise<{ status: number; etag: string | null; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.sessionId !== undefined) headers.cookie = sessionCookieHeader(opts.sessionId);
  if (opts.ifNoneMatch !== undefined) headers["if-none-match"] = opts.ifNoneMatch;
  const input = encodeURIComponent(JSON.stringify({ searchId: opts.searchId ?? "srch_none" }));
  const raw = await fetch(`${url}/trpc/searches.get?input=${input}`, { headers });
  const text = await raw.text();
  return {
    status: raw.status,
    etag: raw.headers.get("etag"),
    body: text === "" ? {} : ((await JSON.parse(text)) as Record<string, unknown>),
  };
}

describe("searches.get (S19)", () => {
  let pg: TestService;
  let redis: TestService;
  let server: TestServer;
  let pool: Pool;
  let admin: Client;

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = await startTestRedis();
    await migrateDatabase(pg.url);
    pool = new Pool({ connectionString: pg.url });
    admin = new Client({ connectionString: pg.url });
    await admin.connect();
    server = await startTestServer({
      db: pool,
      redisUrl: redis.url,
      blockTimeoutMs: 250,
    });
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE search, search_event, search_aggregate, search_result_version CASCADE",
    );
  });

  afterAll(async () => {
    await server.close();
    await admin.end();
    await pool.end();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it("serves a terminal result version byte-equal to the stored payload (verification 1)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, { status: "COMPLETE", versionPayload: terminalPayload(id) });

    const first = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(first.status).toBe(200);
    expect(first.etag).toBe(`W/"${id}.v1"`);
    const data = (first.body as { result: { data: Record<string, unknown> } }).result.data;
    expect(data).toEqual(terminalPayload(id));
    // answer is non-null and equal to the stored answer
    expect(data.answer).toEqual({ mode: "EMPTY", cause: "HALTED", suggestions: [] });

    // A second GET serves the same immutable version unchanged.
    const second = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(second.status).toBe(200);
    expect(second.etag).toBe(`W/"${id}.v1"`);
    expect((second.body as { result: { data: Record<string, unknown> } }).result.data).toEqual(
      terminalPayload(id),
    );
  });

  it("signs a per-offer recheck nonce at serve time, bound to the terminal version (S34)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, {
      status: "COMPLETE",
      versionPayload: confidentTerminalPayload(id),
    });

    const before = Date.now();
    const result = await getResult(server.url, { sessionId: OWNER, searchId: id });
    const after = Date.now();
    expect(result.status).toBe(200);
    expect(result.etag).toBe(`W/"${id}.v1"`);

    const data = (result.body as { result: { data: Record<string, unknown> } }).result.data;
    const answer = data.answer as {
      mode: string;
      primary: {
        placement: { placementKey: string };
        showtimes: Array<{ showtimeId: string; nonce: string | null }>;
      };
    };
    expect(answer.mode).toBe("CONFIDENT");
    const offer = answer.primary.showtimes[0]!;
    expect(offer.showtimeId).toBe("amc:showtime:1");
    expect(offer.nonce).not.toBeNull();

    const nonce = verifyRecheckNonce(offer.nonce as string, TEST_NONCE_SECRET);
    expect(nonce).not.toBeNull();
    expect(nonce!.sessionId).toBe(OWNER);
    expect(nonce!.searchId).toBe(id);
    expect(nonce!.resultVersion).toBe(1);
    expect(nonce!.showtimeId).toBe("amc:showtime:1");
    expect(nonce!.placementKey).toBe("placement_1");
    // The 10-minute expiry starts at serve time (issuance), not assembly time.
    expect(nonce!.expiry).toBeGreaterThan(before);
    expect(nonce!.expiry).toBeLessThanOrEqual(after + 10 * 60 * 1000);

    // The persisted `nonce: null` placeholder is never mutated: a second serve mints a
    // FRESH nonce (a fresh ULID + expiry), so two serves are non-byte-identical.
    const again = await getResult(server.url, { sessionId: OWNER, searchId: id });
    const againData = (again.body as { result: { data: Record<string, unknown> } }).result.data;
    const againOffer = (
      againData.answer as {
        primary: { showtimes: Array<{ nonce: string | null }> };
      }
    ).primary.showtimes[0]!;
    expect(againOffer.nonce).not.toBe(offer.nonce);
    expect(verifyRecheckNonce(againOffer.nonce as string, TEST_NONCE_SECRET)).not.toBeNull();
  });

  it("serves the stored aggregate, not a count derivable from events (verification 2)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, {
      status: "RUNNING",
      aggregatePayload: nonterminalPayload(id),
    });
    // A progress event implies a different total (2) than the aggregate's (5) — the route
    // must serve the aggregate, never derive from events (ADR 0003 A2).
    await admin.query(
      `INSERT INTO search_event (search_id, seq, type, payload) VALUES ($1, 1, 'progress', $2::jsonb)`,
      [id, JSON.stringify({ resolved: 0, total: 2 })],
    );

    const result = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(result.status).toBe(200);
    expect(result.etag).toBe(`W/"${id}.r1"`);
    const data = (result.body as { result: { data: Record<string, unknown> } }).result.data;
    expect(data.status).toBe("RUNNING");
    expect(data.total).toBe(5); // the aggregate's total, not the event-derived 2
    expect(data.answer).toBeNull();
  });

  it("fails loudly when a nonterminal search has no aggregate row (verification 3)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, { status: "RUNNING", versionPayload: null });

    const result = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(result.status).toBe(500);
    expect((result.body as { error: { data: { code: string } } }).error.data.code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    // No fabricated resolved/total/groups body is served.
    expect((result.body as { result?: unknown }).result).toBeUndefined();
  });

  it("ownership: owner serves, foreign/anonymous/unknown are UNAUTHORIZED, never NOT_FOUND (verification 4)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, { status: "COMPLETE", versionPayload: terminalPayload(id) });

    const owner = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(owner.status).toBe(200);

    const foreign = await getResult(server.url, { sessionId: "sess_other", searchId: id });
    expect(foreign.status).toBe(401);
    expect((foreign.body as { error: { data: { code: string } } }).error.data.code).toBe(
      "UNAUTHORIZED",
    );

    const anonymous = await getResult(server.url, { searchId: id });
    expect(anonymous.status).toBe(401);

    const unknown = await getResult(server.url, {
      sessionId: OWNER,
      searchId: "srch_does_not_exist",
    });
    expect(unknown.status).toBe(401);
    expect((unknown.body as { error: { data: { code: string } } }).error.data.code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("a non-conforming searchId is BAD_REQUEST before any read (verification 5)", async () => {
    const result = await getResult(server.url, { sessionId: OWNER, searchId: "not-a-search-id" });
    expect(result.status).toBe(400);
    expect((result.body as { error: { data: { code: string } } }).error.data.code).toBe(
      "BAD_REQUEST",
    );
  });

  it("ETag round-trip: strong tag (weak-compared), weak tag, * match, and non-match (verification 6)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, { status: "COMPLETE", versionPayload: terminalPayload(id) });

    const first = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(first.etag).toBe(`W/"${id}.v1"`);

    // A client holding a STRONG tag still 304s — `matchesIfNoneMatch` weak-compares in all
    // cases (RFC 9110 §13.1.2), so the now-weak terminal validator matches the strong opaque-tag.
    const exact = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `"${id}.v1"`,
    });
    expect(exact.status).toBe(304);
    expect(exact.body).toEqual({});

    // Weak-prefixed tag still matches (weak comparison in all cases, ADR 0006).
    const weak = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `W/"${id}.v1"`,
    });
    expect(weak.status).toBe(304);

    // `*` matches any current representation.
    const star = await getResult(server.url, { sessionId: OWNER, searchId: id, ifNoneMatch: "*" });
    expect(star.status).toBe(304);

    // A comma-separated list containing the tag matches.
    const list = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `"other", "${id}.v1"`,
    });
    expect(list.status).toBe(304);

    // A non-matching tag → 200 with the body.
    const miss = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `"${id}.v999"`,
    });
    expect(miss.status).toBe(200);
    expect((miss.body as { result: { data: Record<string, unknown> } }).result.data).toEqual(
      terminalPayload(id),
    );
  });

  it("ETag round-trip on the nonterminal weak validator (verification 6)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, {
      status: "RUNNING",
      aggregatePayload: nonterminalPayload(id),
    });

    const first = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(first.etag).toBe(`W/"${id}.r1"`);

    const match = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `W/"${id}.r1"`,
    });
    expect(match.status).toBe(304);

    const star = await getResult(server.url, { sessionId: OWNER, searchId: id, ifNoneMatch: "*" });
    expect(star.status).toBe(304);

    const miss = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `"${id}.r9"`,
    });
    expect(miss.status).toBe(200);
  });

  it("a schema-invalid stored payload fails closed, raw payload never served (verification 7)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, {
      status: "COMPLETE",
      versionPayload: invalidTerminalPayload(id),
    });

    const result = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(result.status).toBe(500);
    expect((result.body as { error: { data: { code: string } } }).error.data.code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect((result.body as { result?: unknown }).result).toBeUndefined();
  });

  it("zero writes: a GET — including a 304 — creates no rows in any durability table (verification 8)", async () => {
    const id = searchId();
    await seedSearch(admin, id, OWNER, { status: "COMPLETE", versionPayload: terminalPayload(id) });

    async function tableCounts(): Promise<Record<string, number>> {
      const rows = await admin.query<{ name: string; n: number }>(
        `SELECT 'search' AS name, count(*)::integer AS n FROM search
         UNION ALL SELECT 'search_result_version', count(*)::integer FROM search_result_version
         UNION ALL SELECT 'search_aggregate', count(*)::integer FROM search_aggregate
         UNION ALL SELECT 'search_event', count(*)::integer FROM search_event`,
      );
      return Object.fromEntries(rows.rows.map((r) => [r.name, r.n]));
    }

    const before = await tableCounts();

    const body = await getResult(server.url, { sessionId: OWNER, searchId: id });
    expect(body.status).toBe(200);

    const notModified = await getResult(server.url, {
      sessionId: OWNER,
      searchId: id,
      ifNoneMatch: `"${id}.v1"`,
    });
    expect(notModified.status).toBe(304);

    const after = await tableCounts();
    expect(after).toEqual(before);
  });
});
