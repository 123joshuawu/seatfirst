/**
 * Read-only queries against the durability schema (`packages/durability/migrations/`).
 *
 * This package is a CONSUMER of the durability tier's tables — the transport layer reads
 * `search`/`search_event` and never writes them (S12.8: events are written by the
 * acceptance transactions B5/B5F/B8 and the sweeper). The SQL lives here, in one place,
 * rather than inline at call sites. No boundary statement is involved: these reads
 * transition nothing.
 */

import { rowNumber, rowString } from "../pg-row.js";

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface EventRow {
  readonly seq: string;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Ownership fact for the mandatory pre-stream check (S12.2, architecture §6.7): the
 * session that created the search. `null` means no such search row exists.
 */
export async function readSearchSession(db: Queryable, searchId: string): Promise<string | null> {
  const result = await db.query(`SELECT session_id FROM search WHERE search_id = $1`, [searchId]);
  const row = result.rows[0];
  return row === undefined ? null : rowString(row, "session_id");
}

/** Terminal `search.status` values — after B8, status never moves backward. */
export const TERMINAL_SEARCH_STATUSES = ["COMPLETE", "PARTIAL", "HALTED", "CANCELLED"] as const;

export function isTerminalStatus(status: string | null): boolean {
  return status !== null && (TERMINAL_SEARCH_STATUSES as readonly string[]).includes(status);
}

/**
 * The search's status — the S6U3.6 already-terminal fact. Status and the
 * `SEARCH_TERMINAL` row commit in one transaction (`packages/durability/src/
 * transactions.ts`), and status never moves backward, so "status is terminal" implies
 * "the terminal row exists, and the table catch-up serves it if the cursor precedes it".
 * `null` means no such search row exists.
 */
export async function readSearchStatus(db: Queryable, searchId: string): Promise<string | null> {
  const result = await db.query(`SELECT status FROM search WHERE search_id = $1`, [searchId]);
  const row = result.rows[0];
  return row === undefined ? null : rowString(row, "status");
}

/**
 * All `search_event` rows with `seq > afterSeq`, in seq order — the authoritative
 * catch-up source. `seq` is per-search monotonic and gapless
 * (`packages/durability/migrations/001_schema.sql:153`), so "greater than the cursor"
 * is exactly "everything not yet delivered".
 *
 * No LIMIT: the whole remainder of a search's event history is the contract here, and a
 * read cap would be a number nobody has written down (gate 14, `docs/gates.md`).
 */
export async function readEventsAfter(
  db: Queryable,
  searchId: string,
  afterSeq: bigint,
): Promise<EventRow[]> {
  const result = await db.query(
    `SELECT seq, type, payload
     FROM search_event
     WHERE search_id = $1 AND seq > $2
     ORDER BY seq`,
    [searchId, afterSeq.toString()],
  );
  return result.rows.map((row) => ({
    seq: rowString(row, "seq"),
    type: rowString(row, "type"),
    payload: row["payload"],
  }));
}

/**
 * `search_aggregate.revision` is a `bigint` column: pg hands it back as a decimal
 * string (no int8 parser is registered anywhere in this repo), yet the row interfaces
 * model it as `number` and every consumer interpolates it into wire strings. Explicit
 * guard branch, not a cast (S40.4): accept the driver's decimal string or an actual
 * number, coerce with `Number()` exactly as the wire has always rendered it, and fail
 * loudly on anything else.
 */
function rowRevision(row: Record<string, unknown>): number {
  const value = row["revision"];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const revision = Number(value);
    if (!Number.isNaN(revision)) return revision;
  }
  throw new TypeError(
    `pg row column "revision": expected a number or decimal string, received ${JSON.stringify(value)}`,
  );
}

/** The latest `search_aggregate` row's revision, payload, and evidence, or `null` when none exists. */
export interface FrozenAggregateRow {
  readonly revision: number;
  readonly payload: unknown;
  readonly evidence: unknown;
}

/**
 * The pre-cancel frozen facts a `searches.cancel` reveal is derived from (S23.3 step (2);
 * ADR 0018's frozen-answer rule, `docs/adr/0018-cancelled-search-terminal-status.md`).
 * Reads the search's accepted-fetch count / free seats (tier 3's `readFacts` pattern,
 * `test/tier3.lifecycle.test.ts:139-163`) plus the latest `search_aggregate` row — the
 * progressive partial state ADR 0003 A2 says progressive groups come from
 * (`docs/adr/0003-searchspec-result-contracts.md:417`). The caller derives the frozen
 * answer from these with `deriveRankedAnswer`; the search is already owned (ownership
 * guard ran first) and its status is nonterminal (the S23.5 pre-read), so a missing
 * aggregate row simply means no partial state existed yet.
 */
export async function readCancelFrozenFacts(
  db: Queryable,
  searchId: string,
): Promise<{
  acceptedFetches: number;
  freeSeats: number;
  aggregate: FrozenAggregateRow | null;
  aggRequestedRev: number;
}> {
  const accepted = await db.query(
    `SELECT count(*)::integer AS accepted_fetches,
            coalesce(sum(snap.free_count), 0)::integer AS free_seats
     FROM run_application ra
     JOIN provider_run pr ON pr.run_id = ra.run_id
     JOIN run_key k ON k.run_key_id = pr.run_key_id AND k.kind = 'SHOWTIME_FETCH'
     JOIN observation o ON o.run_id = pr.run_id
     JOIN availability_snapshot snap ON snap.observation_id = o.observation_id
     WHERE ra.search_id = $1`,
    [searchId],
  );
  const counts = accepted.rows[0] ?? { accepted_fetches: 0, free_seats: 0 };
  const aggregate = await db.query(
    `SELECT revision, payload, evidence FROM search_aggregate WHERE search_id = $1 ORDER BY revision DESC LIMIT 1`,
    [searchId],
  );
  const row = aggregate.rows[0];
  const requested = await db.query(
    `SELECT agg_requested_rev::integer AS agg_requested_rev FROM search WHERE search_id = $1`,
    [searchId],
  );
  const requestedRow = requested.rows[0];
  return {
    acceptedFetches: rowNumber(counts, "accepted_fetches"),
    freeSeats: rowNumber(counts, "free_seats"),
    aggregate:
      row === undefined
        ? null
        : { revision: rowRevision(row), payload: row["payload"], evidence: row["evidence"] },
    aggRequestedRev: requestedRow === undefined ? 0 : rowNumber(requestedRow, "agg_requested_rev"),
  };
}

/** The latest `search_aggregate` row's revision + payload, or `null` when none exists. */
export interface SearchAggregateRow {
  readonly revision: number;
  readonly payload: unknown;
}

/**
 * S19.4 — the nonterminal serving read: the latest `search_aggregate` row (ADR 0001
 * §4.1 nonterminal materialization; the decided nonterminal source — "commits either a
 * nonterminal `search_aggregate` upsert or the terminal transaction",
 * `docs/adr/0001-durability-search-lifecycle.md:967-971`). `null` means the search has no
 * aggregate row yet — in a correct deployment (S19.5) the AGGREGATE dispatch handler has
 * written one before `searches.get` serves it, so the route treats `null` as fail-loud.
 */
export async function readLatestSearchAggregate(
  db: Queryable,
  searchId: string,
): Promise<SearchAggregateRow | null> {
  const result = await db.query(
    `SELECT revision, payload FROM search_aggregate WHERE search_id = $1 ORDER BY revision DESC LIMIT 1`,
    [searchId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { revision: rowRevision(row), payload: row["payload"] };
}

/** The latest `search_result_version` row's version + payload, or `null` when none exists. */
export interface SearchResultVersionRow {
  readonly version: number;
  readonly payload: unknown;
}

/**
 * S22.12 — the terminal answer read: the latest `search_result_version` for a search
 * (version for nonce `resultVersion` binding, payload for the placement matched by
 * `placementKey`). `null` means the search has no terminal result yet — ADR 0012 reveals
 * at terminal only, so no valid recheck nonce can exist for such a search.
 */
export async function readLatestSearchResultVersion(
  db: Queryable,
  searchId: string,
): Promise<SearchResultVersionRow | null> {
  const result = await db.query(
    `SELECT version, payload FROM search_result_version WHERE search_id = $1 ORDER BY version DESC LIMIT 1`,
    [searchId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { version: rowNumber(row, "version"), payload: row["payload"] };
}
