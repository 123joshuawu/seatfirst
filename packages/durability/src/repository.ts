import * as B from "./boundaries.js";
import type { Statement } from "./boundaries.js";
import { firstRow, requireFields } from "./transactions.js";
import type { SqlClient } from "./transactions.js";

/**
 * Generic statement executor — the escape hatch for every boundary family that has no named
 * wrapper below (B2, B3, B4, B5a–f, B5F, B6, B7, B8, B9, B10, the `sweeper(n)` statements).
 * Runs any `Statement` from `boundaries.ts` against an `SqlClient`, checking its declared
 * `params.length` against the arguments given and throwing before the query is issued on a
 * mismatch. It is exported from the package root (`index.ts`) precisely so a caller that
 * needs one of those 22 un-wrapped families is never forced to write a raw query at the call
 * site — see the S1 goal in `docs/backend-work-plan.md`.
 *
 * It does not special-case `zeroRowsMeans`: like every named wrapper below, it returns
 * whatever rows the statement produced, and the caller pairs the result with `expectRow`
 * (`expect-row.ts`) to enforce the statement's conditional-loser contract. That is the same
 * two-step every typed wrapper's caller already follows, so the generic and named paths
 * behave identically — the generic path does not bypass anything the wrappers enforce.
 */
export async function runStatement<Row>(
  db: SqlClient,
  statement: Statement,
  params: readonly unknown[],
): Promise<Row[]> {
  if (params.length !== statement.params.length) {
    throw new Error(
      `${statement.name} expects ${statement.params.length} parameters ` +
        `(${statement.params.join(", ")}); received ${params.length}.`,
    );
  }
  const result = await db.query(statement.text, params);
  // S39.8 (CONTRIBUTING §2) — tolerated cast: Row[] is the caller's declared row shape (doc above), pinned by tiers 1–2.
  return result.rows as Row[];
}

function json(value: unknown, field: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${field} must be JSON-serializable.`);
  }
  return encoded;
}

export interface CreateSearchInput {
  readonly searchId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly spec: unknown;
  readonly specHash: string;
  readonly deadlineAt: Date;
}

export interface SearchCreatedRow {
  readonly search_id: string;
}

/** B1 search insert/idempotency fence. Zero rows means the caller must read the existing row. */
export function createSearch(db: SqlClient, input: CreateSearchInput): Promise<SearchCreatedRow[]> {
  return runStatement(db, B.B1_CREATE_SEARCH, [
    input.searchId,
    input.sessionId,
    input.idempotencyKey,
    json(input.spec, "spec"),
    input.specHash,
    input.deadlineAt.toISOString(),
  ]);
}

export interface OutboxCreatedRow {
  readonly outbox_id: string;
}

export interface OutboxPublishedRow {
  readonly outbox_id: string;
  readonly state: "PUBLISHED";
}

export function createJobOutbox(
  db: SqlClient,
  jobId: string,
  traceparent: string | null,
): Promise<OutboxCreatedRow[]> {
  return runStatement(db, B.OUTBOX_CREATE_JOB, [jobId, traceparent]);
}

export function createRunOutbox(
  db: SqlClient,
  runId: string,
  traceparent: string | null,
): Promise<OutboxCreatedRow[]> {
  return runStatement(db, B.OUTBOX_CREATE_RUN, [runId, traceparent]);
}

/** S3 PENDING → PUBLISHED transition, fenced by the outbox row's primary key. */
export function markOutboxPublished(
  db: SqlClient,
  outboxId: string,
): Promise<OutboxPublishedRow[]> {
  return runStatement(db, B.OUTBOX_MARK_PUBLISHED, [outboxId]);
}

export type TheatreSlugs = Readonly<Record<string, string>>;

export interface UpsertTheatreInput {
  readonly theatreId: string;
  readonly providerId: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly marketSlug: string | null;
  readonly timezone: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly slugs: TheatreSlugs | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}
export interface TheatreRow {
  readonly theatre_id: string;
  readonly provider_id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly market_slug: string | null;
  readonly timezone: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly slugs: Record<string, string> | null;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
}
export function upsertTheatre(db: SqlClient, input: UpsertTheatreInput): Promise<TheatreRow[]> {
  return runStatement(db, B.THEATRE_UPSERT, [
    input.theatreId,
    input.providerId,
    input.name,
    input.lat,
    input.lng,
    input.marketSlug,
    input.timezone,
    input.city,
    input.address,
    input.slugs === null ? null : json(input.slugs, "slugs"),
    input.firstSeenAt.toISOString(),
    input.lastSeenAt.toISOString(),
  ]);
}

export function readTheatreById(db: SqlClient, theatreId: string): Promise<TheatreRow[]> {
  return runStatement(db, B.THEATRE_READ_BY_ID, [theatreId]);
}

/**
 * Free-text search over the catalogue (`THEATRE_NAME_SEARCH`, S20 + ADR 0029 §7). `query` is
 * escaped caller-side so LIKE metacharacters (`\`, `%`, `_`) match only literally, then
 * wrapped as a substring pattern (`%…%`) and matched case-insensitively by `ILIKE` against
 * both `name` and `city` (`city ILIKE` is `NULL`-safe — rows with no city are unaffected).
 * No `LIMIT`: the 50-result cap (ADR 0016) is applied route-side, after the nearest-first
 * sort (S20.2/S20.4), so this boundary returns every match and the sort sees the full set.
 */
export function searchTheatresByName(db: SqlClient, query: string): Promise<TheatreRow[]> {
  const escaped = query.replace(/[\\%_]/g, (metachar) => `\\${metachar}`);
  return runStatement(db, B.THEATRE_NAME_SEARCH, [`%${escaped}%`]);
}

export function browseTheatres(db: SqlClient): Promise<TheatreRow[]> {
  return runStatement(db, B.THEATRE_BROWSE, []);
}

export interface UpsertMovieInput {
  readonly movieId: string;
  readonly providerId: string;
  readonly title: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface MovieRow {
  readonly movie_id: string;
  readonly provider_id: string;
  readonly title: string;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
}

/** `MOVIE_READ_BY_ID`'s row: widens `MovieRow` with the S25 TMDB poster (null when the
 *  LEFT JOIN finds no tmdb_movie row) plus the S55 runtime/genre details from the same
 *  row. `genres` is never null here: the column is `NOT NULL DEFAULT '{}'`, and
 *  `readMovieById` coalesces the LEFT JOIN's zero-row null to `[]` — mirroring
 *  `poster_path: null`'s "not resolved yet" state without ever surfacing undefined.
 *  `MOVIE_UPSERT` does not select these columns, so `upsertMovie` keeps returning the
 *  base `MovieRow`. */
export interface MovieRowWithPoster extends MovieRow {
  readonly poster_path: string | null;
  readonly runtime_minutes: number | null;
  readonly genres: readonly string[];
}

export async function readMovieById(db: SqlClient, movieId: string): Promise<MovieRowWithPoster[]> {
  const rows = await runStatement<MovieRowWithPoster & { genres: readonly string[] | null }>(
    db,
    B.MOVIE_READ_BY_ID,
    [movieId],
  );
  // S55.3 — the LEFT JOIN yields null `genres` when no tmdb_movie row matches; the
  // column itself is NOT NULL, so coalesce here keeps every consumer on "[] means
  // not resolved yet" (never undefined) with no second read.
  return rows.map((row) => ({ ...row, genres: row.genres ?? [] }));
}

export function upsertMovie(db: SqlClient, input: UpsertMovieInput): Promise<MovieRow[]> {
  return runStatement(db, B.MOVIE_UPSERT, [
    input.movieId,
    input.providerId,
    input.title,
    input.firstSeenAt.toISOString(),
    input.lastSeenAt.toISOString(),
  ]);
}

export interface UpsertTmdbMovieInput {
  readonly tmdbId: number;
  readonly normalizedTitle: string;
  readonly posterPath: string | null;
  readonly runtimeMinutes: number | null;
  readonly genres: readonly string[];
}

export interface TmdbMovieRow {
  readonly tmdb_id: number;
  readonly normalized_title: string;
  readonly poster_path: string | null;
  readonly runtime_minutes: number | null;
  readonly genres: readonly string[];
  readonly updated_at: Date;
}

export function upsertTmdbMovie(
  db: SqlClient,
  input: UpsertTmdbMovieInput,
): Promise<TmdbMovieRow[]> {
  return runStatement(db, B.TMDB_MOVIE_UPSERT, [
    input.tmdbId,
    input.normalizedTitle,
    input.posterPath,
    input.runtimeMinutes,
    [...input.genres],
  ]);
}

export interface DispatchTmdbFetchInput {
  /** Caller-minted text ULID: the fetch row's identity (mirrors search_job.job_id). */
  readonly tmdbFetchId: string;
  /** The AMC `movie.title` to search TMDB for — also the row's dedup key. */
  readonly movieTitle: string;
}

export interface TmdbFetchDispatchedRow {
  readonly outbox_id: string;
  readonly tmdb_fetch_id: string;
}

/**
 * S25.4 — the read-time cache-miss dispatch. One statement: insert the fetch row (idempotent
 * on `movie_title` while a live fetch is PENDING) and, only if it won, its TMDB_FETCH outbox
 * row. Zero rows means an identical live fetch already exists — the caller enqueues nothing.
 */
export function dispatchTmdbFetch(
  db: SqlClient,
  input: DispatchTmdbFetchInput,
): Promise<TmdbFetchDispatchedRow[]> {
  return runStatement(db, B.TMDB_FETCH_DISPATCH, [input.tmdbFetchId, input.movieTitle]);
}

export interface TmdbFetchRow {
  readonly tmdb_fetch_id: string;
  readonly movie_title: string;
  readonly state: "PENDING" | "DONE" | "FAILED";
  readonly attempt: number;
  readonly fail_cause: string | null;
  readonly created_at: Date;
}
/**
 * S25.5 — the fetch worker's read: loads the searchless fetch row by id so the worker can
 * learn the `movie_title` to search TMDB for. Zero rows means the row vanished (a worker
 * delivery after an out-of-band delete) — the caller acks without a fetch.
 */
export function readTmdbFetchById(db: SqlClient, tmdbFetchId: string): Promise<TmdbFetchRow[]> {
  return runStatement(db, B.TMDB_FETCH_READ_BY_ID, [tmdbFetchId]);
}

/** S25.5 — the fetch worker's success transition (PENDING → DONE, attempt + 1). */
export function markTmdbFetchDone(db: SqlClient, tmdbFetchId: string): Promise<TmdbFetchRow[]> {
  return runStatement(db, B.TMDB_FETCH_DONE, [tmdbFetchId]);
}

/** S25.5 — the fetch worker's failure transition (PENDING → FAILED, attempt + 1). */
export function markTmdbFetchFailed(
  db: SqlClient,
  tmdbFetchId: string,
  failCause: string,
): Promise<TmdbFetchRow[]> {
  return runStatement(db, B.TMDB_FETCH_FAIL, [tmdbFetchId, failCause]);
}

export interface TmdbPrewarmStateRow {
  readonly last_completed_at: Date | null;
}

/** S25.3 — the pre-warm due-ness read. Zero rows means no pass has ever completed. */
export function readTmdbPrewarmState(db: SqlClient): Promise<TmdbPrewarmStateRow[]> {
  return runStatement(db, B.TMDB_PREWARM_STATE_READ, []);
}

/** S25.3 — records the pre-warm pass's completion instant (checkpoint for due-ness). */
export function completeTmdbPrewarm(db: SqlClient): Promise<TmdbPrewarmStateRow[]> {
  return runStatement(db, B.TMDB_PREWARM_COMPLETE, []);
}

export interface TheatreRadiusInput {
  readonly originLat: number;
  readonly originLng: number;
  readonly radiusKm: number;
}

export interface TheatreRadiusRow extends TheatreRow {
  readonly distance_km: number;
}

export function findTheatresWithinRadius(
  db: SqlClient,
  input: TheatreRadiusInput,
): Promise<TheatreRadiusRow[]> {
  return runStatement(db, B.THEATRE_RADIUS_QUERY, [
    input.originLat,
    input.originLng,
    input.radiusKm,
  ]);
}

export interface CatalogueCrawlStateRow {
  readonly provider_id: string;
  readonly last_pass_started_at: Date | null;
  readonly last_pass_completed_at: Date | null;
  /** Opaque to the schema layer: the worker's cursor shape, round-tripped through jsonb. */
  readonly cursor: unknown;
  readonly updated_at: Date;
}

/** S26.7 — the due-ness read. Zero rows means the provider has never run a pass. */
export function readCatalogueCrawlState(
  db: SqlClient,
  providerId: string,
): Promise<CatalogueCrawlStateRow[]> {
  return runStatement(db, B.CATALOGUE_CRAWL_STATE_READ, [providerId]);
}

/** S26.9 — marks a new monthly pass in progress and resets the cursor. */
export function beginCatalogueCrawlPass(
  db: SqlClient,
  providerId: string,
): Promise<CatalogueCrawlStateRow[]> {
  return runStatement(db, B.CATALOGUE_CRAWL_STATE_BEGIN_PASS, [providerId]);
}

/** S26.10 — the restart-safety checkpoint, called after every successfully processed page. */
export function advanceCatalogueCrawlCursor(
  db: SqlClient,
  providerId: string,
  cursor: unknown,
): Promise<CatalogueCrawlStateRow[]> {
  return runStatement(db, B.CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR, [
    providerId,
    json(cursor, "cursor"),
  ]);
}

/** S26.9 — records pass completion and clears the cursor. */
export function completeCatalogueCrawlPass(
  db: SqlClient,
  providerId: string,
): Promise<CatalogueCrawlStateRow[]> {
  return runStatement(db, B.CATALOGUE_CRAWL_STATE_COMPLETE_PASS, [providerId]);
}

export interface UpdatePerformanceProductInput {
  readonly showtimeId: string;
  readonly movieId: string | null;
  readonly auditorium: string | null;
  readonly utcOffset: string | null;
  readonly runtimeMinutes: number | null;
  readonly status: "OPEN" | "LOW_AVAILABILITY" | "SOLD_OUT" | "CANCELED" | "UNKNOWN" | null;
  readonly formatCode: string | null;
  readonly minPrice: number | null;
  readonly deepLinkUrl: string | null;
  readonly providerMeta: Readonly<Record<string, unknown>>;
  readonly layoutId: string | null;
  readonly updatedAt: Date;
}

export interface PerformanceProductUpdatedRow {
  readonly showtime_id: string;
  readonly updated_at: Date;
}

export function updatePerformanceProduct(
  db: SqlClient,
  input: UpdatePerformanceProductInput,
): Promise<PerformanceProductUpdatedRow[]> {
  return runStatement(db, B.PERFORMANCE_UPDATE_PRODUCT, [
    input.showtimeId,
    input.movieId,
    input.auditorium,
    input.utcOffset,
    input.runtimeMinutes,
    input.status,
    input.formatCode,
    input.minPrice,
    input.deepLinkUrl,
    json(input.providerMeta, "providerMeta"),
    input.layoutId,
    input.updatedAt.toISOString(),
  ]);
}

export interface AppendEventInput {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface EventAppendedRow {
  readonly event_id: string;
  readonly type: string;
  readonly created_at: Date;
  readonly partition_name: string;
}

export function appendEvent(db: SqlClient, input: AppendEventInput): Promise<EventAppendedRow[]> {
  return runStatement(db, B.EVENT_APPEND, [
    input.eventId,
    input.type,
    json(input.payload, "payload"),
    input.createdAt.toISOString(),
  ]);
}

export interface CachedScheduleInput {
  readonly providerId: string;
  readonly theatreId: string;
  readonly localDate: string;
  /**
   * The ADR 0006 §A.1 showtimes freshness ceiling (≤ 10 minutes,
   * `docs/adr/0006-capacity-cost-model-numeric-acceptance-criteria.md:188`) — injected as
   * a caller-supplied parameter, never a literal here (S15.4, the fetch-layer-tunables
   * discipline).
   */
  readonly freshnessMs: number;
  /** Injectable clock so the exact-capture-time freshness edge test can hold time. */
  readonly now?: Date;
}

export interface CachedPerformance {
  readonly showtimeId: string;
  /**
   * S14's product status, verbatim from the column. `null` only for rows written before
   * S14 landed — unreachable on fresh schemas, and the caller maps it fail-open to
   * `UNKNOWN` rather than guessing. `string` (not a core `ShowtimeStatus`) because
   * durability must not depend on `@seatfirst/core` (S15.13/ADR 0009).
   */
  readonly status: string | null;
  /**
   * E5.13 warm-create group skeleton inputs, all nullable product columns: `layout_id`
   * is the content-addressed identity (migration 003, `docs/adr/0011...`), `auditorium`
   * an upstream display hint, `format_code` the projection format. Nullable because
   * rows captured before a layout was attached have no value to report.
   */
  readonly layoutId: string | null;
  readonly formatCode: string | null;
  readonly auditorium: string | null;
}

export interface CachedSchedule {
  readonly runKeyId: string;
  readonly capturedAt: Date;
  /** Every performance the schedule key resolved, ordered by `showtime_id`; empty when it resolved `EMPTY_RESOLVED`. */
  readonly performances: readonly CachedPerformance[];
}

/** `SCHEDULE_CACHE_READ`'s row: the run_key columns plus the LEFT-JOINed performance
 * columns, each nullable because a key may exist without having resolved any showtime. */
interface ScheduleCacheReadRow {
  readonly run_key_id: string;
  readonly latest_captured_at: string | null;
  readonly showtime_id: string | null;
  readonly status: string | null;
  readonly layout_id: string | null;
  readonly format_code: string | null;
  readonly auditorium: string | null;
}

/**
 * `searches.create` warm-path cache read (S15.4). One boundary, two row shapes: the
 * SCHEDULE_RESOLUTION `run_key` row for `(provider_id, theatre_id, local_date)` plus
 * every `performance` row it resolved (`SCHEDULE_CACHE_READ`'s LEFT JOIN emits a
 * synthetic null-showtime row when the key exists but has never resolved non-empty).
 *
 * COLD — returns `null` — when there is no `run_key` row at all, when
 * `latest_captured_at IS NULL`, or when the capture is strictly older than the injected
 * ceiling. A capture exactly AT the ceiling is still WARM: ADR 0006 §A.1's bound is
 * "≤ 10 minutes", and the ≤ edge must not silently serve a stale schedule as fresh
 * (S15 verification item 6). The comparison runs here in TypeScript, not SQL, so the
 * boundary's caller can hold the clock deterministically.
 */
export async function readCachedSchedule(
  db: SqlClient,
  input: CachedScheduleInput,
): Promise<CachedSchedule | null> {
  const rows = await runStatement<ScheduleCacheReadRow>(db, B.SCHEDULE_CACHE_READ, [
    input.providerId,
    input.theatreId,
    input.localDate,
  ]);
  const first = rows[0];
  if (first === undefined) {
    return null;
  }
  const captured = first.latest_captured_at;
  if (captured === null) {
    return null;
  }
  const capturedAt = new Date(captured);
  const now = input.now ?? new Date();
  if (now.getTime() - capturedAt.getTime() > input.freshnessMs) {
    return null;
  }
  return {
    runKeyId: first.run_key_id,
    capturedAt,
    performances: rows
      .filter(
        (row): row is ScheduleCacheReadRow & { showtime_id: string } => row.showtime_id !== null,
      )
      .map((row) => ({
        showtimeId: row.showtime_id,
        status: row.status,
        layoutId: row.layout_id,
        formatCode: row.format_code,
        auditorium: row.auditorium,
      })),
  };
}

/** One performance row the range read resolved (S21.4), carrying S14's product columns
 * verbatim plus the S24 `movie` title (NULL for pre-S24 rows).
 *
 * `attributes` is the wire's array of normalized attribute codes (P5.4's contract shape,
 * `contract.ts:204`). The durable jsonb column is coerced here to `[]` whenever it is not
 * already an array: the only write path that touches it (`stageScheduleAcceptance`,
 * `transactions.ts:248`) hardcodes `{}`, and the parse seam's attributes payload "still
 * [has] no schema home today" (`provider-fetch-actor.ts:520`), so every current value is
 * `{}`/empty. This is a defensive compatibility shim, not a data source: no real value is
 * ever lost because nothing non-empty is ever written. */
export interface ScheduleRangePerformance {
  readonly showtimeId: string;
  readonly localDate: string;
  readonly movieId: string | null;
  readonly title: string | null;
  readonly startsAt: Date;
  readonly status: string | null;
  readonly formatCode: string | null;
  readonly auditorium: string | null;
  readonly runtimeMinutes: number | null;
  readonly deepLinkUrl: string | null;
  readonly layoutId: string | null;
  readonly attributes: readonly string[];
}
/** One `run_key` day in the span (S21.4). `capturedAt` is `null` when the key never captured
 * (`latest_captured_at IS NULL`) — the route's freshness gate drops such days (S21.5). */
export interface ScheduleRangeDay {
  readonly localDate: string;
  readonly capturedAt: Date | null;
  readonly performances: readonly ScheduleRangePerformance[];
}

export interface ScheduleRange {
  readonly days: readonly ScheduleRangeDay[];
}

export interface ScheduleRangeInput {
  readonly providerId: string;
  readonly theatreId: string;
  readonly dateFrom: string;
  readonly dateTo: string;
}

/**
 * `theatres.movies` range read (S21.4) — one boundary call over the inclusive
 * `[dateFrom, dateTo]` span (never a per-day loop), grouped by day in boundary
 * (`local_date`) order. Freshness is NOT applied here: the ceiling is a route-side
 * injected figure compared per day (S21.5), so this wrapper returns every day's
 * `capturedAt` and lets the route drop stale/null-capture days.
 */
export async function readScheduleRange(
  db: SqlClient,
  input: ScheduleRangeInput,
): Promise<ScheduleRange> {
  const rows = await runStatement<{
    local_date: string;
    latest_captured_at: string | null;
    showtime_id: string | null;
    movie_id: string | null;
    title: string | null;
    starts_at: Date;
    status: string | null;
    format_code: string | null;
    auditorium: string | null;
    runtime_minutes: number | null;
    deep_link_url: string | null;
    layout_id: string | null;
    attributes: unknown;
  }>(db, B.SCHEDULE_RANGE_READ, [input.providerId, input.theatreId, input.dateFrom, input.dateTo]);
  const days: ScheduleRangeDay[] = [];
  // A mutable working type so the loop can push performances; the exported
  // `ScheduleRangeDay` exposes the same shape with `readonly` performances.
  interface MutableDay {
    localDate: string;
    capturedAt: Date | null;
    performances: ScheduleRangePerformance[];
  }
  let current: MutableDay | undefined;
  for (const row of rows) {
    if (current === undefined || current.localDate !== row.local_date) {
      current = {
        localDate: row.local_date,
        capturedAt: row.latest_captured_at === null ? null : new Date(row.latest_captured_at),
        performances: [],
      };
      days.push(current);
    }
    if (row.showtime_id !== null) {
      current.performances.push({
        showtimeId: row.showtime_id,
        localDate: row.local_date,
        movieId: row.movie_id,
        title: row.title,
        startsAt: row.starts_at,
        status: row.status,
        formatCode: row.format_code,
        auditorium: row.auditorium,
        runtimeMinutes: row.runtime_minutes,
        deepLinkUrl: row.deep_link_url,
        layoutId: row.layout_id,
        // S21.6 wire shape is `z.array(z.string())`; the jsonb column only ever holds
        // `{}` today (see the type doc above), so coerce non-arrays to `[]`.
        attributes: Array.isArray(row.attributes) ? row.attributes : [],
      });
    }
  }
  return { days };
}

export interface SessionRow {
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface UpsertSessionInput {
  readonly sessionId: string;
}

/**
 * S16.2 — `session.bootstrap`'s idempotent session upsert (ADR 0005 §F). The upsert —
 * not a plain insert — is what makes bootstrap idempotent and keeps `last_seen_at`
 * meaningful for S18's retention DELETE job. A `session` row is standalone state (no
 * children, nothing released), so no `invariants.ts` entry is required (S16.2).
 *
 * Deliberately not a `boundaries.ts` statement: it is no ADR 0001 crash-boundary family's
 * transition, and the S16.2 spec fixes its SQL verbatim — the single-statement discipline
 * is kept by the typed shape rather than a Statement registration.
 */
export async function upsertSession(db: SqlClient, input: UpsertSessionInput): Promise<SessionRow> {
  const result = await db.query(
    `INSERT INTO session (session_id) VALUES ($1::text)
     ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now()
     RETURNING session_id, created_at, last_seen_at`,
    [input.sessionId],
  );
  const row = firstRow(result.rows, "upsertSession");
  requireFields(row, "upsertSession", {
    session_id: "string",
    created_at: "date",
    last_seen_at: "date",
  });
  return {
    sessionId: row["session_id"] as string,
    createdAt: row["created_at"] as Date,
    lastSeenAt: row["last_seen_at"] as Date,
  };
}

/**
 * S16.3 — the per-session concurrency gauge: open (non-terminal) searches. Postgres is
 * the store by design: ADR 0006 §A.6 defines the limit as "open (non-terminal) searches"
 * and `search.status` is the authoritative fact; a Redis gauge would need decrement hooks
 * inside B8 and would not survive the persistence-disabled Redis restart (S16.3).
 * Served by the `search_open_per_session` partial index (004_session.sql).
 */
export async function countOpenSearches(db: SqlClient, sessionId: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::integer AS n FROM search
     WHERE session_id = $1::text AND status IN ('PENDING_SCHEDULE','RUNNING')`,
    [sessionId],
  );
  const row = firstRow(result.rows, "countOpenSearches");
  requireFields(row, "countOpenSearches", { n: "number" });
  return row["n"] as number;
}

export interface RecheckOutcomeRow {
  readonly status: "AVAILABLE" | "GONE" | "UNAVAILABLE";
  readonly payload: unknown;
}

/**
 * S22.5(c) — the recheck run's verdict, read by the route's await (S22.11). `null` means the
 * run has not written its outcome yet; the route polls until it appears or the deadline expires.
 */
export async function readRecheckOutcome(
  db: SqlClient,
  runId: string,
): Promise<RecheckOutcomeRow | null> {
  const rows = await runStatement<RecheckOutcomeRow>(db, B.RECHECK_OUTCOME_READ, [runId]);
  return rows[0] ?? null;
}
