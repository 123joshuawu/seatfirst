/**
 * Read-only lookups against the durability schema (`packages/durability/migrations/`) for
 * the dispatch harness (S11.2/S11.3). No boundary statement is involved: these reads
 * transition nothing — the same posture as `../streaming/queries.ts` (S12).
 *
 * `provider_run` carries no `search_id` column (§4.4: a run is shared by every search that
 * subscribes to its `run_key`, via `run_subscription`). `findRunContext`'s `search` is
 * therefore a best-effort context object — one LIVE subscriber, deterministically chosen —
 * useful for logging and for handlers that want *a* search to look at, never an identity
 * claim. Nothing in the RUN branch's dispatch decision (S11.4/S11.5) depends on it: B2 fences
 * on `run_id`/`generation` alone, and B4 (the run handler's own responsibility) fences on
 * `run_id`/`generation`/the run key's provider, not on any one subscriber.
 */

import { rowBuffer, rowNullableString, rowNumber, rowString } from "../pg-row.js";

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}
export type JobKind = "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION" | "MOVIE_SCHEDULE_RESOLUTION";
export type RunKeyKind =
  "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION" | "MOVIE_SCHEDULE_RESOLUTION" | "RECHECK";

export interface RunKeyRow {
  readonly runKeyId: string;
  readonly kind: RunKeyKind;
  readonly providerId: string;
  readonly routeClass: string;
  readonly showtimeId: string | null;
  readonly theatreId: string | null;
  readonly localDate: string | null;
  readonly movieSlug: string | null;
  readonly acceptedRevision: string;
  readonly projectedRevision: string;
  readonly latestObservationId: string | null;
  readonly latestCapturedAt: string | null;
  readonly recheckPlacement: unknown;
}

export interface JobRow {
  readonly jobId: string;
  readonly searchId: string;
  readonly kind: JobKind;
  readonly runKeyId: string;
  readonly generation: number;
  readonly state: string;
  readonly leaseExpiresAt: string | null;
  readonly attempt: number;
  readonly deadlineAt: string;
  readonly failCause: string | null;
  readonly createdAt: string;
}

export interface RunRow {
  readonly runId: string;
  readonly runKeyId: string;
  readonly observationId: string;
  readonly state: string;
  readonly generation: number;
  readonly leaseExpiresAt: string | null;
  readonly attempt: number;
  readonly providerEpoch: string;
  readonly failCause: string | null;
  readonly createdAt: string;
}

export interface SearchRow {
  readonly searchId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly spec: unknown;
  readonly specHash: string;
  readonly status: string;
  readonly terminalCause: string | null;
  readonly capacityDeniedAt: string | null;
  readonly deadlineAt: string;
  readonly projectedThrough: string;
  readonly aggRequestedRev: string;
  readonly aggProcessedRev: string;
  readonly aggLeaseExpires: string | null;
  readonly aggGeneration: number;
  readonly nextSeq: string;
  readonly createdAt: string;
  readonly terminalizedAt: string | null;
}

/** `search_job.state`/`provider_run.state` terminal values — never dispatched (S11.2). */
const TERMINAL_JOB_OR_RUN_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
/** `search.status` terminal values — never claimed for AGGREGATE (S11.2). */
const TERMINAL_SEARCH_STATUSES = new Set(["COMPLETE", "PARTIAL", "HALTED"]);

export function isTerminalJobOrRunState(state: string): boolean {
  return TERMINAL_JOB_OR_RUN_STATES.has(state);
}

export function isTerminalSearchStatus(status: string): boolean {
  return TERMINAL_SEARCH_STATUSES.has(status);
}

/**
 * pg returns `timestamptz`/`date` columns as `Date` objects by default (no custom type
 * parser is registered in this package); every other timestamp this repo surfaces is an
 * ISO-8601 string (e.g. `../relay/health.ts:26`), so every timestamp read here goes
 * through this normalizer rather than `Date`'s locale-dependent `toString()`.
 */
function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function toIsoStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

/**
 * `local_date` is a `date` column (not a timestamp): pg hands it back as a `Date` at local
 * midnight, so it must round-trip to a `YYYY-MM-DD` string — never the full ISO instant
 * `toIsoString` produces (which would shift a day in a UTC+ timezone). Local getters mirror
 * pg's own local-midnight construction and recover the stored date exactly.
 */
function toDateOnly(value: unknown): string {
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(value);
}
function toDateOnlyOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toDateOnly(value);
}

/**
 * Runtime guard replacing the module's former whole-row casts (`rows[0] as Record<…>`,
 * `rows as …[]`): written as a type predicate so the narrowing carries no unchecked
 * cast. A pg row must be a non-null object; anything else is driver drift and fails
 * loudly instead of being trusted.
 */
function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRow(value: unknown): Record<string, unknown> {
  if (!isRow(value)) {
    throw new TypeError(
      `pg result row: expected an object, received ${
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      }`,
    );
  }
  return value;
}

/* S40: the two enum-ish columns narrow through explicit membership guards, so a
 * drifted state-machine value throws here instead of masquerading as its TS union. */
function isJobKind(value: string): value is JobKind {
  return (
    value === "SHOWTIME_FETCH" ||
    value === "SCHEDULE_RESOLUTION" ||
    value === "MOVIE_SCHEDULE_RESOLUTION"
  );
}

function requireJobKind(row: Record<string, unknown>): JobKind {
  const kind = rowString(row, "job_kind");
  if (!isJobKind(kind)) {
    throw new TypeError(
      `pg row column "job_kind": unexpected search_job.kind ${JSON.stringify(kind)}`,
    );
  }
  return kind;
}

function isRunKeyKind(value: string): value is RunKeyKind {
  return (
    value === "SHOWTIME_FETCH" ||
    value === "SCHEDULE_RESOLUTION" ||
    value === "MOVIE_SCHEDULE_RESOLUTION" ||
    value === "RECHECK"
  );
}

function requireRunKeyKind(row: Record<string, unknown>): RunKeyKind {
  const kind = rowString(row, "key_kind");
  if (!isRunKeyKind(kind)) {
    throw new TypeError(
      `pg row column "key_kind": unexpected run_key.kind ${JSON.stringify(kind)}`,
    );
  }
  return kind;
}

function mapRunKeyRow(row: Record<string, unknown>): RunKeyRow {
  return {
    runKeyId: rowString(row, "run_key_id"),
    kind: requireRunKeyKind(row),
    providerId: rowString(row, "provider_id"),
    routeClass: rowString(row, "route_class"),
    showtimeId: rowNullableString(row, "showtime_id"),
    theatreId: rowNullableString(row, "theatre_id"),
    localDate: toDateOnlyOrNull(row["local_date"]),
    movieSlug: rowNullableString(row, "movie_slug"),
    acceptedRevision: rowString(row, "accepted_revision"),
    projectedRevision: rowString(row, "projected_revision"),
    latestObservationId: rowNullableString(row, "latest_observation_id"),
    latestCapturedAt: toIsoStringOrNull(row["latest_captured_at"]),
    recheckPlacement: row["recheck_placement"] ?? null,
  };
}

function mapSearchRow(row: Record<string, unknown>, prefix: string): SearchRow {
  return {
    searchId: rowString(row, "search_id"),
    sessionId: rowString(row, "session_id"),
    idempotencyKey: rowString(row, "idempotency_key"),
    spec: row["spec"],
    specHash: rowString(row, "spec_hash"),
    status: rowString(row, "status"),
    terminalCause: rowNullableString(row, "terminal_cause"),
    capacityDeniedAt: toIsoStringOrNull(row["capacity_denied_at"]),
    deadlineAt: toIsoString(row[`${prefix}deadline_at`]),
    projectedThrough: rowString(row, "projected_through"),
    aggRequestedRev: rowString(row, "agg_requested_rev"),
    aggProcessedRev: rowString(row, "agg_processed_rev"),
    aggLeaseExpires: toIsoStringOrNull(row["agg_lease_expires"]),
    aggGeneration: rowNumber(row, "agg_generation"),
    nextSeq: rowString(row, "next_seq"),
    createdAt: toIsoString(row[`${prefix}created_at`]),
    terminalizedAt: toIsoStringOrNull(row["terminalized_at"]),
  };
}

export interface JobContext {
  readonly job: JobRow;
  readonly runKey: RunKeyRow;
  readonly search: SearchRow;
}

/** S11.2/S11.3: job + its run_key (for `kind`/provider context) + its owning search. */
export async function findJobContext(db: Queryable, jobId: string): Promise<JobContext | null> {
  const result = await db.query(
    `SELECT
       j.job_id, j.search_id, j.kind AS job_kind, j.run_key_id, j.generation, j.state,
       j.lease_expires_at, j.attempt, j.deadline_at, j.fail_cause, j.created_at,
       k.kind AS key_kind, k.provider_id, k.route_class, k.showtime_id, k.theatre_id,
       k.local_date, k.movie_slug, k.accepted_revision, k.projected_revision, k.latest_observation_id,
       k.latest_captured_at, k.recheck_placement,
       s.session_id, s.idempotency_key, s.spec, s.spec_hash, s.status, s.terminal_cause,
       s.capacity_denied_at, s.deadline_at AS search_deadline_at, s.projected_through,
       s.agg_requested_rev, s.agg_processed_rev, s.agg_lease_expires, s.agg_generation,
       s.next_seq, s.created_at AS search_created_at, s.terminalized_at
     FROM search_job j
     JOIN run_key k ON k.run_key_id = j.run_key_id
     JOIN search s ON s.search_id = j.search_id
     WHERE j.job_id = $1`,
    [jobId],
  );
  const first = result.rows[0];
  if (first === undefined) {
    return null;
  }
  const row = requireRow(first);
  return {
    job: {
      jobId: rowString(row, "job_id"),
      searchId: rowString(row, "search_id"),
      kind: requireJobKind(row),
      runKeyId: rowString(row, "run_key_id"),
      generation: rowNumber(row, "generation"),
      state: rowString(row, "state"),
      leaseExpiresAt: toIsoStringOrNull(row["lease_expires_at"]),
      attempt: rowNumber(row, "attempt"),
      deadlineAt: toIsoString(row["deadline_at"]),
      failCause: rowNullableString(row, "fail_cause"),
      createdAt: toIsoString(row["created_at"]),
    },
    runKey: mapRunKeyRow(row),
    search: mapSearchRow(row, "search_"),
  };
}

export interface RunContext {
  readonly run: RunRow;
  readonly runKey: RunKeyRow;
  /** Best-effort — `null` when the run key currently has no LIVE subscriber. See header. */
  readonly search: SearchRow | null;
}

/** S11.2/S11.3: run + its run_key (for `kind`) + a best-effort subscribing search. */
export async function findRunContext(db: Queryable, runId: string): Promise<RunContext | null> {
  const result = await db.query(
    `SELECT
       r.run_id, r.run_key_id, r.observation_id, r.state, r.generation, r.lease_expires_at,
       r.attempt, r.provider_epoch, r.fail_cause, r.created_at,
       k.kind AS key_kind, k.provider_id, k.route_class, k.showtime_id, k.theatre_id,
       k.local_date, k.movie_slug, k.accepted_revision, k.projected_revision, k.latest_observation_id,
       k.latest_captured_at, k.recheck_placement,
       s.search_id, s.session_id, s.idempotency_key, s.spec, s.spec_hash, s.status,
       s.terminal_cause, s.capacity_denied_at, s.deadline_at, s.projected_through,
       s.agg_requested_rev, s.agg_processed_rev, s.agg_lease_expires, s.agg_generation,
       s.next_seq, s.created_at AS search_created_at, s.terminalized_at
     FROM provider_run r
     JOIN run_key k ON k.run_key_id = r.run_key_id
     LEFT JOIN LATERAL (
       SELECT rs.search_id
       FROM run_subscription rs
       WHERE rs.run_key_id = r.run_key_id AND rs.state = 'LIVE'
       ORDER BY rs.deadline_at
       LIMIT 1
     ) live_sub ON true
     LEFT JOIN search s ON s.search_id = live_sub.search_id
     WHERE r.run_id = $1`,
    [runId],
  );
  const first = result.rows[0];
  if (first === undefined) {
    return null;
  }
  const row = requireRow(first);
  return {
    run: {
      runId: rowString(row, "run_id"),
      runKeyId: rowString(row, "run_key_id"),
      observationId: rowString(row, "observation_id"),
      state: rowString(row, "state"),
      generation: rowNumber(row, "generation"),
      leaseExpiresAt: toIsoStringOrNull(row["lease_expires_at"]),
      attempt: rowNumber(row, "attempt"),
      providerEpoch: rowString(row, "provider_epoch"),
      failCause: rowNullableString(row, "fail_cause"),
      createdAt: toIsoString(row["created_at"]),
    },
    runKey: mapRunKeyRow(row),
    search: row["search_id"] === null ? null : mapSearchRow(row, ""),
  };
}

/** S11.2/S11.6 (AGGREGATE branch): the search a hint names. */
export async function findSearchById(db: Queryable, searchId: string): Promise<SearchRow | null> {
  const result = await db.query(
    `SELECT search_id, session_id, idempotency_key, spec, spec_hash, status, terminal_cause,
            capacity_denied_at, deadline_at, projected_through, agg_requested_rev,
            agg_processed_rev, agg_lease_expires, agg_generation, next_seq, created_at,
            terminalized_at
     FROM search
     WHERE search_id = $1`,
    [searchId],
  );
  const first = result.rows[0];
  return first === undefined ? null : mapSearchRow(requireRow(first), "");
}

/* ------------------------------------------------------------------ aggregate reads */
/* S27.4/S27.8/S27.15 — read-only lookups the AGGREGATE handler consumes. These follow the
 * S11.2 module's charter: single SELECTs over real durability columns, no write. The
 * durability tier deliberately adds no read statement for them (S27.4 non-goal) — S11's
 * module owns handler-side read-only SQL against the durability schema. */

/** One schedule-resolved performance of a search, plus its theatre's IANA timezone. */
export interface AggregatePerformance {
  readonly showtimeId: string;
  readonly providerId: string;
  readonly theatreId: string;
  readonly localDate: string;
  readonly startsAt: string;
  readonly observationId: string;
  readonly attributes: readonly string[];
  readonly movieId: string | null;
  readonly auditorium: string | null;
  readonly utcOffset: string | null;
  readonly runtimeMinutes: number | null;
  readonly status: string | null;
  readonly formatCode: string | null;
  readonly minPrice: string | null;
  readonly currency: string | null;
  readonly priceBasis: string | null;
  readonly deepLinkUrl: string | null;
  readonly layoutId: string | null;
  readonly timezone: string;
}

/** The latest accepted availability snapshot for one showtime (S27.4(b)). */
export interface ShowtimeSnapshot {
  readonly showtimeId: string;
  readonly bitmap: Buffer;
  readonly freeCount: number;
  readonly capturedAt: string;
}

/** An `auditorium_layout` row plus the theatre timezone for offer assembly (S27.4(c)). */
export interface AuditoriumLayoutRow {
  readonly layoutId: string;
  readonly geometry: Buffer;
  readonly rows: number;
  readonly columns: number;
  readonly timezone: string;
}

/** `performance.attributes` shim: non-array jsonb coerces to `[]`; array entries are
 * validated strings, so a drifted element fails loudly instead of masquerading as
 * `string[]` (S40). */
function attributesOrEmpty(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new TypeError(
        `pg row column "attributes": expected string entries, received ${JSON.stringify(entry)}`,
      );
    }
    return entry;
  });
}

function mapAggregatePerformance(row: Record<string, unknown>): AggregatePerformance {
  return {
    showtimeId: rowString(row, "showtime_id"),
    providerId: rowString(row, "provider_id"),
    theatreId: rowString(row, "theatre_id"),
    // Shipped behavior kept verbatim (S40 removes casts, not coercions): this is the
    // pre-S40 expression, whether pg delivered a Date or a string.
    localDate: String(row["local_date"]),
    startsAt: toIsoString(row["starts_at"]),
    observationId: rowString(row, "observation_id"),
    // The jsonb column holds real attribute arrays (see `repository.ts`'s
    // `ScheduleRangePerformance.attributes` doc): `stageScheduleAcceptance` persists
    // the parse seam's `performance.attributes` per showtime (S62 dual-tier pipeline),
    // so coerce non-arrays to `[]` only as a defensive compatibility shim for legacy
    // rows written before the pipeline existed.
    attributes: attributesOrEmpty(row["attributes"]),
    movieId: rowNullableString(row, "movie_id"),
    auditorium: rowNullableString(row, "auditorium"),
    utcOffset: rowNullableString(row, "utc_offset"),
    runtimeMinutes: row["runtime_minutes"] === null ? null : rowNumber(row, "runtime_minutes"),
    status: rowNullableString(row, "status"),
    formatCode: rowNullableString(row, "format_code"),
    minPrice: row["min_price"] === null ? null : rowString(row, "min_price"),
    currency: rowNullableString(row, "currency"),
    priceBasis: rowNullableString(row, "price_basis"),
    deepLinkUrl: rowNullableString(row, "deep_link_url"),
    layoutId: rowNullableString(row, "layout_id"),
    timezone: rowString(row, "timezone"),
  };
}

/** S40 — the inline closure of `readLatestShowtimeSnapshots`, extracted into a named
 * mapper over guarded accessor reads. */
function mapShowtimeSnapshot(row: Record<string, unknown>): ShowtimeSnapshot {
  return {
    showtimeId: rowString(row, "showtime_id"),
    bitmap: rowBuffer(row, "bitmap"),
    freeCount: rowNumber(row, "free_count"),
    capturedAt: toIsoString(row["captured_at"]),
  };
}

/** S40 — the inline closure of `readAuditoriumLayouts`, extracted into a named mapper
 * over guarded accessor reads. */
function mapAuditoriumLayoutRow(row: Record<string, unknown>): AuditoriumLayoutRow {
  return {
    layoutId: rowString(row, "layout_id"),
    geometry: rowBuffer(row, "geometry"),
    rows: rowNumber(row, "rows"),
    columns: rowNumber(row, "columns"),
    timezone: rowString(row, "timezone"),
  };
}

/**
 * S27.4(a) — the schedule-resolved performances of this search, fresh-aware (S36.2/S36.6).
 * Unions the cold `SCHEDULE_RESOLUTION` path (via `provider_run.observation_id`) with the
 * fresh `SHOWTIME_FETCH` path (via `k.showtime_id = p.showtime_id`), deduped by
 * `showtime_id` via `UNION` (not `UNION ALL`). Each branch projects the same
 * `AggregatePerformance` columns; the shared movie and schedule-window evaluators are
 * applied downstream in `aggregate-answer-assembler.ts` before snapshots/counts/evidence.
 */
export async function readAggregatePerformances(
  db: Queryable,
  searchId: string,
): Promise<AggregatePerformance[]> {
  const result = await db.query(
    `SELECT
       p.showtime_id, p.provider_id, p.theatre_id, p.local_date, p.starts_at,
       p.observation_id, p.attributes, p.movie_id, p.auditorium, p.utc_offset,
       p.runtime_minutes, p.status, p.format_code, p.min_price, p.currency, p.price_basis,
       p.deep_link_url, p.layout_id,
       t.timezone
     FROM run_subscription rs
     JOIN run_key k ON k.run_key_id = rs.run_key_id
     JOIN provider_run pr ON pr.run_key_id = k.run_key_id
     JOIN observation o ON o.observation_id = pr.observation_id
     JOIN performance p ON p.observation_id = o.observation_id
     JOIN theatre t ON t.theatre_id = p.theatre_id
     WHERE rs.search_id = $1 AND k.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION')
     UNION
     SELECT
       p.showtime_id, p.provider_id, p.theatre_id, p.local_date, p.starts_at,
       p.observation_id, p.attributes, p.movie_id, p.auditorium, p.utc_offset,
       p.runtime_minutes, p.status, p.format_code, p.min_price, p.currency, p.price_basis,
       p.deep_link_url, p.layout_id,
       t.timezone
     FROM run_subscription rs
     JOIN run_key k ON k.run_key_id = rs.run_key_id
     JOIN performance p ON p.showtime_id = k.showtime_id
     JOIN theatre t ON t.theatre_id = p.theatre_id
     WHERE rs.search_id = $1 AND k.kind = 'SHOWTIME_FETCH'
     ORDER BY showtime_id`,
    [searchId],
  );
  return result.rows.map((value) => mapAggregatePerformance(requireRow(value)));
}

/**
 * S27.4(b) — per showtime, the snapshot of its latest accepted fetch observation
 * (`run_key.latest_observation_id`).
 */
export async function readLatestShowtimeSnapshots(
  db: Queryable,
  showtimeIds: readonly string[],
): Promise<ShowtimeSnapshot[]> {
  if (showtimeIds.length === 0) return [];
  const result = await db.query(
    `SELECT s.showtime_id, s.bitmap, s.free_count, s.captured_at
     FROM availability_snapshot s
     JOIN observation o ON o.observation_id = s.observation_id
     JOIN run_key k ON k.run_key_id = o.run_key_id
     WHERE k.kind = 'SHOWTIME_FETCH'
       AND o.observation_id = k.latest_observation_id
       AND s.showtime_id = ANY($1::text[])`,
    [showtimeIds],
  );
  return result.rows.map((value) => mapShowtimeSnapshot(requireRow(value)));
}

/**
 * S27.4(c) — `auditorium_layout` rows by `layout_id`, plus the theatre timezone (via the
 * performance rows that reference the layout). A globally content-addressed layout may be
 * shared; the DISTINCT collapses the per-performance theatre join to one row per layout.
 */
export async function readAuditoriumLayouts(
  db: Queryable,
  layoutIds: readonly string[],
): Promise<AuditoriumLayoutRow[]> {
  if (layoutIds.length === 0) return [];
  const result = await db.query(
    `SELECT DISTINCT al.layout_id, al.geometry, al.rows, al.columns, t.timezone
     FROM auditorium_layout al
     JOIN performance p ON p.layout_id = al.layout_id
     JOIN theatre t ON t.theatre_id = p.theatre_id
     WHERE al.layout_id = ANY($1::text[])`,
    [layoutIds],
  );
  return result.rows.map((value) => mapAuditoriumLayoutRow(requireRow(value)));
}

/**
 * `admission_reservation.fresh_match_seed`: the shipped read tolerated both primitives
 * pg may deliver for it (`number | string`), so that tolerance stays — as an explicit
 * guard branch, never a cast (S40.3). Coercion is unchanged (`Number(...)`); a
 * non-numeric value now fails loudly instead of becoming a silent NaN.
 */
function freshMatchSeed(row: Record<string, unknown>): number {
  const value = row["fresh_match_seed"];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const seed = Number(value);
    if (!Number.isNaN(seed)) return seed;
  }
  throw new TypeError(
    `pg row column "fresh_match_seed": expected a number or numeric string, received ${JSON.stringify(value)}`,
  );
}

/**
 * S27.8 — the aggregate schedule outcome over this search's `SCHEDULE_RESOLUTION`
 * subscriptions, fresh-aware (S36.9). The tier-3-proven shape (`tier3.lifecycle.test.ts:117-137`)
 * is extended with `fresh_match_seed`: when `fresh_match_seed > 0` the search already owns
 * usable `SHOWTIME_FETCH` work, so an all-`FAILED` cold set is `MIXED` not `FAILED`, and an
 * all-`EMPTY_RESOLVED` cold set is `RESOLVED` not `EMPTY_RESOLVED` — preserving the usable
 * fresh work per `B8_TERMINALIZE`'s fresh-aware `HALTED`/`TOO_FEW_SHOWTIMES` guards. `MIXED`
 * and `null` (pending) are returned unchanged.
 */
export async function readAggregateScheduleOutcome(
  db: Queryable,
  searchId: string,
): Promise<"RESOLVED" | "EMPTY_RESOLVED" | "FAILED" | "MIXED" | null> {
  const freshRows = await db.query(
    `SELECT fresh_match_seed FROM admission_reservation WHERE search_id = $1`,
    [searchId],
  );
  const seeded = freshRows.rows[0];
  const fresh = seeded === undefined ? 0 : freshMatchSeed(requireRow(seeded));
  const result = await db.query(
    `SELECT rs.schedule_outcome
     FROM run_subscription rs
     JOIN run_key k USING (run_key_id)
     WHERE rs.search_id = $1 AND k.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION')`,
    [searchId],
  );
  const outcomes = result.rows.map((value) =>
    rowNullableString(requireRow(value), "schedule_outcome"),
  );
  if (outcomes.length === 0) return fresh > 0 ? "RESOLVED" : null;
  const failed = outcomes.filter((outcome) => outcome === "FAILED").length;
  if (failed === outcomes.length) return fresh > 0 ? "MIXED" : "FAILED";
  if (failed > 0) return "MIXED";
  if (outcomes.some((outcome) => outcome === null)) return null;
  if (outcomes.every((outcome) => outcome === "EMPTY_RESOLVED"))
    return fresh > 0 ? "RESOLVED" : "EMPTY_RESOLVED";
  return "RESOLVED";
}

/** S27.8 — accepted-fetch count and summed free seats (tier-3-proven `readFacts` shape). */
export interface AggregateFetchFacts {
  readonly acceptedFetches: number;
  readonly freeSeats: number;
}

export async function readAggregateFetchFacts(
  db: Queryable,
  searchId: string,
): Promise<AggregateFetchFacts> {
  const result = await db.query(
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
  const first = result.rows[0];
  if (first === undefined) {
    return { acceptedFetches: 0, freeSeats: 0 };
  }
  const row = requireRow(first);
  return {
    acceptedFetches: rowNumber(row, "accepted_fetches"),
    freeSeats: rowNumber(row, "free_seats"),
  };
}

/**
 * S27.15 — failed `SHOWTIME_FETCH` jobs of this search, grouped by `fail_cause` and
 * theatre. Theatre attribution is via `run_key.showtime_id -> performance.theatre_id`
 * (LEFT JOIN, so a failure whose showtime has no performance row still counts toward
 * the aggregate with `theatreId: null`). Jobs are the search-scoped fetch record
 * (`search_job.search_id`); a NULL cause is keyed `UNKNOWN` so the
 * `fetchFailedByCause` key stays non-empty while the total still reconciles.
 * ADR 0029 §5 item 3 — `theatreId` is the additive column for per-theatre `excluded`
 * breakdown; existing `failCause`/`count` fields are unchanged.
 */
export interface AggregateFetchFailure {
  readonly failCause: string;
  readonly theatreId: string | null;
  readonly count: number;
}

/** S40 — per-field accessor reads replace the former whole-row-object cast. */
function mapAggregateFetchFailure(row: Record<string, unknown>): AggregateFetchFailure {
  return {
    failCause: rowString(row, "fail_cause"),
    theatreId: rowNullableString(row, "theatre_id"),
    count: rowNumber(row, "count"),
  };
}

export async function readAggregateFetchFailures(
  db: Queryable,
  searchId: string,
): Promise<AggregateFetchFailure[]> {
  const result = await db.query(
    `SELECT coalesce(j.fail_cause, 'UNKNOWN') AS fail_cause, p.theatre_id AS theatre_id, count(*)::integer AS count
     FROM search_job j
     JOIN run_key k ON k.run_key_id = j.run_key_id
     LEFT JOIN performance p ON p.showtime_id = k.showtime_id
     WHERE j.search_id = $1 AND j.kind = 'SHOWTIME_FETCH' AND j.state = 'FAILED'
     GROUP BY j.fail_cause, p.theatre_id`,
    [searchId],
  );
  return result.rows.map((value) => mapAggregateFetchFailure(requireRow(value)));
}

/**
 * S58/ADR 0057 Rec 3.1 — the distinct set of showtimeIds whose `SHOWTIME_FETCH` job for this
 * search terminalized as `FAILED`. Same join as `readAggregateFetchFailures` (search_job -> run_key),
 * without the `fail_cause`/theatre aggregation — this is per-showtime attribution, not a count.
 */
export async function readAggregateFailedShowtimeIds(
  db: Queryable,
  searchId: string,
): Promise<ReadonlySet<string>> {
  const result = await db.query(
    `SELECT DISTINCT k.showtime_id
     FROM search_job j
     JOIN run_key k ON k.run_key_id = j.run_key_id
     WHERE j.search_id = $1 AND j.kind = 'SHOWTIME_FETCH' AND j.state = 'FAILED'
       AND k.showtime_id IS NOT NULL`,
    [searchId],
  );
  return new Set(result.rows.map((row) => rowString(requireRow(row), "showtime_id")));
}
