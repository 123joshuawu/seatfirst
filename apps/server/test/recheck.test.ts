import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

import type { RecheckResult, RecoveryOption, SearchSpec } from "@seatfirst/core";
import { signRecheckNonce } from "../src/session/nonce.js";
import type { RecheckNonce } from "../src/session/nonce.js";

import type { TestServer } from "./support/app.js";
import { sessionCookieHeader, startTestServer, TEST_NONCE_SECRET } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S22 route verification (items 3–5, 7–9), over HTTP against a real Fastify server and
 * real Postgres. The recheck route is a BESPOKE route (`registerShowtimesRecheck`, exactly
 * like `session.bootstrap`), so it is driven with raw `fetch` — the same pattern the
 * `session.bootstrap` tests use (`session-rate-limit.test.ts`), never the SSE-only
 * `httpSubscriptionLink`.
 *
 * The worker (the capacity-1 actor + synthetic corridor) is out of scope for this suite —
 * that navigation is S8/S11's verified surface (`provider-fetch-actor.test.ts`). Here the
 * worker's terminal effect is simulated by writing `recheck_outcome` directly once the
 * route has staged its run, which is exactly the cross-process hand-off the route's
 * `readRecheckOutcome` poll observes (S22.11). This lets the suite assert the route's own
 * contract — nonce discipline, ownership, and the AVAILABLE/GONE/UNAVAILABLE/TIMEOUT
 * assembly — without a browser.
 *
 * Verification 6 (the 429-at-the-11th-call) reuses S16's limiter mechanics verbatim (the
 * `recheck` dimension shipped with no caller in S16; this route is the first caller) and
 * is covered by `session-rate-limit.test.ts`'s dimension tests — no new limiter code is
 * added here. Items 10 (B4 fence) and 11 (priority) are actor/dispatch concerns covered by
 * `provider-fetch-actor.test.ts`/`dispatch.test.ts` and the durability tier.
 */

const PROVIDER = "amc";
const THEATRE = "amc:theatre:t1";
const MOVIE = "amc:movie:m1";
const SHOWTIME_ID = "amc:showtime:st1";
const PLACEMENT_KEY = "plc_recheck_1";
const CAPTURED_AT = "2026-08-01T00:00:00.000Z";
const SESSION = "sess_recheck_owner";

const PLACEMENT = {
  layoutId: "lay_1",
  row: 0,
  startCol: 0,
  rowSpan: 1,
  count: 2,
  seatNames: ["A1", "A2"],
  placementKey: PLACEMENT_KEY,
};

let searchSeq = 0;
function searchId(): string {
  searchSeq += 1;
  return `srch_recheck_${Date.now().toString(36)}_${searchSeq}`;
}

function makeSpec(): SearchSpec {
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: { kind: "LIST", refs: [{ id: THEATRE }] },
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [MOVIE] },
        { kind: "DATE_RANGE", from: "2026-08-03", to: "2026-08-03" },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  };
}

/** The terminal `search_result_version.payload` carrying the CONFIDENT placement. */
function terminalAnswerPayload(): unknown {
  return {
    status: "COMPLETE",
    answer: {
      mode: "CONFIDENT",
      primary: {
        placement: PLACEMENT,
        showtimes: [{ showtimeId: SHOWTIME_ID, capturedAt: CAPTURED_AT }],
      },
    },
  };
}

function mintNonce(searchIdValue: string, overrides: Partial<RecheckNonce> = {}): string {
  const nonce: RecheckNonce = {
    id: `nonce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    sessionId: SESSION,
    searchId: searchIdValue,
    resultVersion: 1,
    showtimeId: SHOWTIME_ID,
    placementKey: PLACEMENT_KEY,
    expiry: Date.now() + 60_000,
    ...overrides,
  };
  return signRecheckNonce(nonce, TEST_NONCE_SECRET);
}

/** The GONE recovery ladder the injected seam returns (mutable per test). */
let recoveryLadder: RecoveryOption[] = [];

function recoverySeam(): Promise<readonly RecoveryOption[]> {
  return Promise.resolve(recoveryLadder);
}

function recoveryOption(level: 1 | 2 | 3 | 4): RecoveryOption {
  return {
    level,
    placement: PLACEMENT,
    showtimeId: SHOWTIME_ID,
    relaxed: level === 4 ? [{ kind: "FEWER_SHOWTIMES" }] : [],
    requiresConsent: level === 4,
  } as RecoveryOption;
}

interface RecheckRawInput {
  searchId: string;
  showtimeId: string;
  placementKey: string;
  nonce: string;
}

async function recheckRaw(
  url: string,
  sessionId: string,
  input: RecheckRawInput,
): Promise<Response> {
  return fetch(`${url}/trpc/showtimes.recheck`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookieHeader(sessionId) },
    body: JSON.stringify(input),
  });
}

describe("showtimes.recheck (S22)", () => {
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
      recheckDeadlineMs: 2000,
      recheckRecovery: recoverySeam,
    });
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE search, run_key, consumed_nonce, provider_admission, provider_fence CASCADE",
    );
    recoveryLadder = [];
  });

  afterAll(async () => {
    await server.close();
    await admin.end();
    await pool.end();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  /** Seed a search (owned by `sessionId`) + its terminal result version + the fence. */
  async function seedSearch(
    searchIdValue: string,
    sessionId: string,
    withVersion = true,
  ): Promise<void> {
    await admin.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [PROVIDER]);
    await admin.query(
      `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'COMPLETE', now() + interval '10 minutes')`,
      [
        searchIdValue,
        sessionId,
        `idem_${searchIdValue}`,
        JSON.stringify(makeSpec()),
        `hash_${searchIdValue}`,
      ],
    );
    if (withVersion) {
      await admin.query(
        `INSERT INTO search_result_version (search_id, version, payload) VALUES ($1, 1, $2::jsonb)`,
        [searchIdValue, JSON.stringify(terminalAnswerPayload())],
      );
    }
  }

  /** Write the worker's outcome once the route has staged its run. */
  async function writeOutcome(status: string, payload: unknown): Promise<void> {
    const deadline = Date.now() + 3000;
    let runId: string | null = null;
    while (Date.now() < deadline) {
      const res = await pool.query(
        `SELECT pr.run_id FROM provider_run pr
         JOIN run_key k ON k.run_key_id = pr.run_key_id
         WHERE k.kind = 'RECHECK' AND k.showtime_id = $1
         ORDER BY pr.created_at DESC LIMIT 1`,
        [SHOWTIME_ID],
      );
      const row = res.rows[0] as { run_id: string } | undefined;
      if (row !== undefined) {
        runId = row.run_id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (runId === null) throw new Error("recheck run was never staged");
    await pool.query(
      `INSERT INTO recheck_outcome (run_id, status, payload) VALUES ($1, $2, $3::jsonb)`,
      [runId, status, JSON.stringify(payload)],
    );
  }

  async function resultBody(raw: Response): Promise<RecheckResult> {
    const body = (await raw.json()) as { result: { data: RecheckResult } };
    return body.result.data;
  }

  it("a sessionless caller is UNAUTHORIZED (fail closed)", async () => {
    const raw = await fetch(`${server.url}/trpc/showtimes.recheck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        searchId: "srch_none",
        showtimeId: SHOWTIME_ID,
        placementKey: PLACEMENT_KEY,
        nonce: "x",
      }),
    });
    expect(raw.status).toBe(401);
    const body = (await raw.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe("UNAUTHORIZED");
  });

  it("a non-owner, an anonymous caller, and an unknown search are UNAUTHORIZED, never NOT_FOUND", async () => {
    const id = searchId();
    await seedSearch(id, "sess_real_owner");

    const other = await recheckRaw(server.url, "sess_other", {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce: "x",
    });
    expect(other.status).toBe(401);
    expect(((await other.json()) as { error: { data: { code: string } } }).error.data.code).toBe(
      "UNAUTHORIZED",
    );

    const unknown = await recheckRaw(server.url, "sess_real_owner", {
      searchId: "srch_does_not_exist",
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce: "x",
    });
    expect(unknown.status).toBe(401);
  });

  it("a tampered nonce is UNAUTHORIZED", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce: `${nonce}tampered`,
    });
    expect(raw.status).toBe(401);
    expect(((await raw.json()) as { error: { data: { code: string } } }).error.data.code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("an expired nonce is UNAUTHORIZED", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id, { expiry: Date.now() - 1000 });
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(raw.status).toBe(401);
  });

  it("a nonce transplanted to another placement is UNAUTHORIZED", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: "plc_some_other_key",
      nonce,
    });
    expect(raw.status).toBe(401);
  });

  it("a nonce minted for a different session is UNAUTHORIZED", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id, { sessionId: "sess_someone_else" });
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(raw.status).toBe(401);
  });

  it("a nonce bound to a superseded result version is UNAUTHORIZED", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id, { resultVersion: 2 });
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(raw.status).toBe(401);
  });

  it("a search with no terminal result version can present no valid nonce", async () => {
    const id = searchId();
    await seedSearch(id, SESSION, /* withVersion */ false);
    const nonce = mintNonce(id);
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(raw.status).toBe(401);
  });

  it("AVAILABLE: the route returns the placement with a fresh checkedAt (verification 3)", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);

    const [raw] = await Promise.all([
      recheckRaw(server.url, SESSION, {
        searchId: id,
        showtimeId: SHOWTIME_ID,
        placementKey: PLACEMENT_KEY,
        nonce,
      }),
      writeOutcome("AVAILABLE", { placementKey: PLACEMENT_KEY }),
    ]);
    expect(raw.status).toBe(200);
    const result = await resultBody(raw);
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.placement).toEqual(PLACEMENT);
      expect(typeof result.checkedAt).toBe("string");
      expect(result.checkedAt).not.toBe(CAPTURED_AT); // a fresh observation, not the cached stamp
    }
  });

  it("GONE: the route returns the injected recovery ladder (verification 4)", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);
    recoveryLadder = [recoveryOption(1), recoveryOption(2)];

    const [raw] = await Promise.all([
      recheckRaw(server.url, SESSION, {
        searchId: id,
        showtimeId: SHOWTIME_ID,
        placementKey: PLACEMENT_KEY,
        nonce,
      }),
      writeOutcome("GONE", { placementKey: PLACEMENT_KEY }),
    ]);
    expect(raw.status).toBe(200);
    const result = await resultBody(raw);
    expect(result.status).toBe("GONE");
    if (result.status === "GONE") {
      expect(result.recovery).toHaveLength(2);
      expect(result.recovery[0]?.level).toBe(1);
      expect(result.recovery[1]?.level).toBe(2);
    }
  });

  it("UNAVAILABLE: the route maps the actor's cause and carries lastKnown (verification 5)", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);

    const [raw] = await Promise.all([
      recheckRaw(server.url, SESSION, {
        searchId: id,
        showtimeId: SHOWTIME_ID,
        placementKey: PLACEMENT_KEY,
        nonce,
      }),
      writeOutcome("UNAVAILABLE", { cause: "UPSTREAM_CHANGED" }),
    ]);
    expect(raw.status).toBe(200);
    const result = await resultBody(raw);
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status === "UNAVAILABLE") {
      expect(result.cause).toBe("UPSTREAM_CHANGED");
      expect(result.lastKnown).toEqual({ placement: PLACEMENT, capturedAt: CAPTURED_AT });
    }
  });

  it("TIMEOUT: a deadline with no outcome yields UNAVAILABLE/TIMEOUT (verification 9)", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);

    // No outcome is written — the route's poll must hit the deadline and return TIMEOUT.
    const raw = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(raw.status).toBe(200);
    const result = await resultBody(raw);
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status === "UNAVAILABLE") {
      expect(result.cause).toBe("TIMEOUT");
      expect(result.lastKnown).toEqual({ placement: PLACEMENT, capturedAt: CAPTURED_AT });
    }
  });

  it("a replayed nonce is rejected with CONFLICT and does not navigate twice (verification 7)", async () => {
    const id = searchId();
    await seedSearch(id, SESSION);
    const nonce = mintNonce(id);

    // First call consumes the nonce and completes AVAILABLE.
    const [first] = await Promise.all([
      recheckRaw(server.url, SESSION, {
        searchId: id,
        showtimeId: SHOWTIME_ID,
        placementKey: PLACEMENT_KEY,
        nonce,
      }),
      writeOutcome("AVAILABLE", { placementKey: PLACEMENT_KEY }),
    ]);
    expect(first.status).toBe(200);

    // Replay the same nonce → CONFLICT, and no second run is created.
    const replay = await recheckRaw(server.url, SESSION, {
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
      nonce,
    });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { data: { code: string } } }).error.data.code).toBe(
      "CONFLICT",
    );

    const runs = await pool.query(
      `SELECT count(*) AS n FROM provider_run pr
       JOIN run_key k ON k.run_key_id = pr.run_key_id WHERE k.kind = 'RECHECK'`,
    );
    expect((runs.rows[0] as { n: string } | undefined)?.n).toBe("1");
  });
});
