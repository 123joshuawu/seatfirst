import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

import { createResultContractSchemas } from "@seatfirst/core";
import type {
  GroupShowtime,
  Placement,
  RecheckResult,
  ResultGroup,
  SearchSpec,
} from "@seatfirst/core";

import { createRecoverySeam } from "../src/routes/showtimes/recovery-seam.js";
import { signRecheckNonce } from "../src/session/nonce.js";
import type { RecheckNonce } from "../src/session/nonce.js";
import { sessionCookieHeader, startTestServer, TEST_NONCE_SECRET } from "./support/app.js";
import type { TestServer } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S32.10/S32.11 verification — the REAL `createRecoverySeam` path, from a seeded terminal
 * `search_result_version.payload` through `assembleRecoveryLadder` (S32.17), plus the real
 * HTTP route's GONE branch wired end-to-end. Every expectation is hand-derived grid arithmetic
 * (the winner's `|Δrow|·W + |Δcol|`, its member-cell seat names, and the ADR 0023
 * decision-1 `placementKey` golden) — never recomputed by calling the implementation's own
 * logic (CONTRIBUTING.md §3). Real Postgres/Redis via testcontainers (the `recheck.test.ts`
 * pattern), never live AMC traffic.
 *
 * The seeded payload is a full `SearchResult` (parsed against `SearchResultSchema` by the
 * seam), carrying a CONFIDENT answer whose gone placement is matched by `placementKey`, and
 * one group whose `groupHits` hold a same-shape, same-showtime, within-±2-rows candidate.
 */

const PROVIDER = "amc";
const THEATRE_ID = "amc:theatre:recovery";
const MOVIE_ID = "amc:movie:recovery";
const SHOWTIME_ID = "amc:showtime:recovery";
const LAYOUT_ID = "amc:layout:recovery";
const PLACEMENT_KEY = "plc_recovery_gone";
const CAPTURED_AT = "2026-08-16T18:00:00Z";
const SESSION = "sess_recovery_owner";
const ROWS = 4;
const COLUMNS = 8;
/** The seam's own provider allowlist — the deep-link host in every fixture offer. */
const ALLOWLIST: Record<string, string[]> = { amc: ["www.amctheatres.com"] };

const contracts = createResultContractSchemas({ providerHostAllowlists: ALLOWLIST });

/** The gone placement the answer carries, matched by `PLACEMENT_KEY`. */
const GONE_PLACEMENT: Placement = {
  layoutId: LAYOUT_ID,
  row: 2,
  startCol: 3,
  rowSpan: 1,
  count: 2,
  seatNames: ["R2C3", "R2C4"],
  placementKey: PLACEMENT_KEY,
};

let searchSeq = 0;
function searchId(): string {
  searchSeq += 1;
  return `srch_recovery_${Date.now().toString(36)}_${searchSeq}`;
}

function makeSpec(): SearchSpec {
  return {
    specVersion: 1,
    providerId: PROVIDER,
    theatres: { kind: "LIST", refs: [{ id: THEATRE_ID }] },
    where: {
      kind: "AND",
      of: [
        { kind: "MOVIE", ids: [MOVIE_ID] },
        { kind: "DATE_RANGE", from: "2026-08-16", to: "2026-08-16" },
      ],
    },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
    groupStrict: false,
    rank: "SCORE",
  };
}

function groupShowtime(): GroupShowtime {
  return {
    showtimeId: SHOWTIME_ID,
    theatreId: THEATRE_ID,
    distanceKm: null,
    showDateTimeUtc: "2026-08-16T19:00:00Z",
    timezone: "America/New_York",
    minPrice: { amount: 1200, currency: "USD", basis: "TICKET_ONLY" },
    status: "OPEN",
    deepLinkUrl: "https://www.amctheatres.com/showtimes/recovery",
    resolved: true,
    openCount: 0,
    capturedAt: CAPTURED_AT,
    staleAfter: "2026-08-16T20:00:00Z",
  };
}

/**
 * Hand-builds a schema-valid `ResultGroup` (4 rows × 8 columns, one gone showtime) whose
 * `groupHits` are injected verbatim for exact control over the distance objective. Every
 * seat is a named STANDARD cell `R<row>C<col>`.
 */
function makeGroup(hits: readonly { row: number; startCol: number }[]): ResultGroup {
  const cellCount = ROWS * COLUMNS;
  const seatNames: Record<string, string> = {};
  for (let cell = 0; cell < cellCount; cell += 1) {
    seatNames[String(cell)] = `R${Math.floor(cell / COLUMNS)}C${cell % COLUMNS}`;
  }
  const group: ResultGroup = {
    layoutId: LAYOUT_ID,
    theatreId: THEATRE_ID,
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: null,
    attributes: [],
    rows: ROWS,
    columns: COLUMNS,
    seatKinds: new Array<number>(cellCount).fill(1),
    seatNames,
    seatScores: new Array<number>(cellCount).fill(0.5),
    showtimes: [groupShowtime()],
    freeCount: new Array<number>(cellCount).fill(1),
    freeIn: Array.from({ length: cellCount }, () => [0]),
    groupHits: hits.map((hit) => ({
      row: hit.row,
      startCol: hit.startCol,
      rowSpan: 1,
      runScore: 0.5,
      showtimeIndices: [0],
    })),
  };
  expect(contracts.ResultGroupSchema.safeParse(group).success).toBe(true);
  return group;
}

/**
 * A full terminal `SearchResult` payload (parsed against `SearchResultSchema` by the seam):
 * COMPLETE status, a CONFIDENT answer carrying `GONE_PLACEMENT`, and one group for
 * `LAYOUT_ID` whose `groupHits` are the supplied same-shape candidates.
 */
function makePayload(
  searchIdValue: string,
  hits: readonly { row: number; startCol: number }[],
): unknown {
  const payload = {
    searchId: searchIdValue,
    spec: makeSpec(),
    status: "COMPLETE",
    resolved: 1,
    total: 1,
    capturedAtRange: [CAPTURED_AT, CAPTURED_AT],
    groups: [makeGroup(hits)],
    excluded: {
      soldOut: 0,
      outsideWindow: 0,
      outsideRegion: 0,
      outsideArea: 0,
      wrongAttributes: 0,
      overPrice: 0,
      notReservedSeating: 0,
      fetchFailed: 0,
      fetchFailedByCause: {},
    },
    answer: {
      mode: "CONFIDENT",
      primary: {
        placement: GONE_PLACEMENT,
        reasons: [{ kind: "TOGETHER", count: 2 }],
        relaxed: [],
        showtimes: [
          {
            showtimeId: SHOWTIME_ID,
            theatreId: THEATRE_ID,
            distanceKm: null,
            showDateTimeUtc: "2026-08-16T19:00:00Z",
            timezone: "America/New_York",
            minPrice: { amount: 1200, currency: "USD", basis: "TICKET_ONLY" },
            status: "OPEN",
            deepLinkUrl: "https://www.amctheatres.com/showtimes/recovery",
            capturedAt: CAPTURED_AT,
            staleAfter: "2026-08-16T20:00:00Z",
            nonce: null,
          },
        ],
      },
      otherFormats: [],
    },
  };
  // Fixture sanity: the hand-built payload must itself satisfy the shipped contract.
  expect(contracts.SearchResultSchema.safeParse(payload).success).toBe(true);
  return payload;
}

function mintNonce(searchIdValue: string): string {
  const nonce: RecheckNonce = {
    id: `nonce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    sessionId: SESSION,
    searchId: searchIdValue,
    resultVersion: 1,
    showtimeId: SHOWTIME_ID,
    placementKey: PLACEMENT_KEY,
    expiry: Date.now() + 60_000,
  };
  return signRecheckNonce(nonce, TEST_NONCE_SECRET);
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

async function resultBody(raw: Response): Promise<RecheckResult> {
  const body = (await raw.json()) as { result: { data: RecheckResult } };
  return body.result.data;
}

describe("recovery seam (S32.10 / S32.11)", () => {
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
      recheckRecovery: createRecoverySeam({
        db: pool,
        rowWeight: 2,
        providerHostAllowlists: ALLOWLIST,
      }),
    });
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE search, run_key, consumed_nonce, provider_admission, provider_fence CASCADE",
    );
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
    payload: unknown,
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
    await admin.query(
      `INSERT INTO search_result_version (search_id, version, payload) VALUES ($1, 1, $2::jsonb)`,
      [searchIdValue, JSON.stringify(payload)],
    );
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

  it("S32.10 — the seam returns the hand-derived level-1 nearest equivalent", async () => {
    const id = searchId();
    // Gone placement row=2/startCol=3. With W=2:
    //   (row 1, startCol 3) → 2·|1-2| + |3-3| = 2   ← winner
    //   (row 2, startCol 6) → 2·|2-2| + |6-3| = 3
    await seedSearch(
      id,
      SESSION,
      makePayload(id, [
        { row: 1, startCol: 3 },
        { row: 2, startCol: 6 },
      ]),
    );

    const seam = createRecoverySeam({
      db: pool,
      rowWeight: 2,
      providerHostAllowlists: ALLOWLIST,
    });
    const options = await seam({
      searchId: id,
      showtimeId: SHOWTIME_ID,
      placementKey: PLACEMENT_KEY,
    });

    expect(options).toEqual([
      {
        level: 1,
        placement: {
          layoutId: LAYOUT_ID,
          row: 1,
          startCol: 3,
          rowSpan: 1,
          count: 2,
          seatNames: ["R1C3", "R1C4"],
          // ADR 0023 decision-1 hash of "amc:layout:recovery|1|3|1|2", first 16 hex chars.
          placementKey: "59a6c6347065101f",
        },
        showtimeId: SHOWTIME_ID,
        relaxed: [],
        requiresConsent: false,
      },
    ]);
  });

  it("S32.10/S32.17 — the seam throws (never returns []) when no rung survives at any level", async () => {
    const id = searchId();
    // The only hit is the gone seat itself, at its only showtime → every rung fails:
    // Level 1 excludes it as its own alternative, Level 2 has no other showtime, Level 3's
    // ±2-row window excludes Δrow=0, and Level 4 excludes the gone-showtime pairing.
    await seedSearch(id, SESSION, makePayload(id, [{ row: 2, startCol: 3 }]));

    const seam = createRecoverySeam({
      db: pool,
      rowWeight: 2,
      providerHostAllowlists: ALLOWLIST,
    });
    await expect(
      seam({ searchId: id, showtimeId: SHOWTIME_ID, placementKey: PLACEMENT_KEY }),
    ).rejects.toThrow(/no recovery option survives at any level/);
  });

  it("S32.11 — the GONE branch returns the real ladder end-to-end", async () => {
    const id = searchId();
    await seedSearch(
      id,
      SESSION,
      makePayload(id, [
        { row: 1, startCol: 3 },
        { row: 2, startCol: 6 },
      ]),
    );
    const nonce = mintNonce(id);

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
      expect(result.recovery).toEqual([
        {
          level: 1,
          placement: {
            layoutId: LAYOUT_ID,
            row: 1,
            startCol: 3,
            rowSpan: 1,
            count: 2,
            seatNames: ["R1C3", "R1C4"],
            placementKey: "59a6c6347065101f",
          },
          showtimeId: SHOWTIME_ID,
          relaxed: [],
          requiresConsent: false,
        },
      ]);
    }
  });
});
