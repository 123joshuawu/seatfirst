/**
 * ADR 0001 §2 — every crash boundary as a named, exported, single statement.
 *
 * Per docs/durability-harness-plan.md the ADR stops being the source of SQL truth: these
 * statements are, and the ADR cites `@seatfirst/durability` + symbol. Rules that make
 * that work:
 *
 *   1. **One statement per export.** `PREPARE` accepts exactly one, and tier 1 prepares
 *      every export against the live schema. A boundary that is several statements (B1,
 *      B5, B8, B9, B10) is split into named parts, and the parts carry the boundary label.
 *   2. **Every parameter is cast.** `$1::text`, not `$1` — partly so `PREPARE` can infer,
 *      mostly so the intended type is stated rather than inferred by a reader.
 *   3. **Every statement returns something.** The ADR's contract is "0 rows means the
 *      caller lost, and it must abort": a statement with no `RETURNING` cannot be checked
 *      by tier 2, and `rowCount` on a bare `UPDATE` inside a CTE chain is not the number
 *      the caller cares about. `RETURNING` clauses added for this reason are noted.
 *
 * Naming: `B5_FANIN` is B5(e)+(f), the acceptance fan-in. `B5F_*` is B5F, *failure*
 * acceptance — a different boundary that the ADR unfortunately names one letter away.
 */

/** A single SQL statement at a named crash boundary. */
export interface Statement {
  /** ADR 0001 §2 boundary label, e.g. `B5(f)`. Several statements may share one. */
  readonly boundary: string;
  /** Stable symbol name; this is what the ADR cites. */
  readonly name: string;
  /** What losing (0 rows) means, in the caller's terms. Empty when 0 rows is normal. */
  readonly zeroRowsMeans: string;
  /** Positional parameter documentation, `$1` first. */
  readonly params: readonly string[];
  readonly text: string;
}

const statements: Statement[] = [];

function define(s: Statement): Statement {
  statements.push(s);
  return s;
}

/* ------------------------------------------------------ catalogue + analytics (S2) */

export const THEATRE_UPSERT = define({
  boundary: "catalogue",
  name: "THEATRE_UPSERT",
  zeroRowsMeans: "the theatre catalogue upsert unexpectedly returned no row.",
  params: [
    "theatre_id",
    "provider_id",
    "name",
    "lat",
    "lng",
    "market_slug",
    "timezone",
    "city",
    "address",
    "slugs",
    "first_seen_at",
    "last_seen_at",
  ],
  text: `
    INSERT INTO theatre
      (theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
       first_seen_at, last_seen_at)
    VALUES
      ($1::text, $2::text, $3::text, $4::double precision, $5::double precision,
       $6::text, $7::text, $8::text, $9::text, $10::jsonb, $11::timestamptz, $12::timestamptz)
    ON CONFLICT (theatre_id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      market_slug = EXCLUDED.market_slug,
      timezone = EXCLUDED.timezone,
      city = EXCLUDED.city,
      address = EXCLUDED.address,
      slugs = EXCLUDED.slugs,
      last_seen_at = greatest(theatre.last_seen_at, EXCLUDED.last_seen_at)
    RETURNING theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
              first_seen_at, last_seen_at`,
});

export const THEATRE_READ_BY_ID = define({
  boundary: "catalogue",
  name: "THEATRE_READ_BY_ID",
  zeroRowsMeans: "no theatre catalogue row exists for that theatre_id.",
  params: ["theatre_id"],
  text: `
    SELECT theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
           first_seen_at, last_seen_at
    FROM theatre
    WHERE theatre_id = $1::text`,
});

export const THEATRE_NAME_SEARCH = define({
  boundary: "catalogue",
  name: "THEATRE_NAME_SEARCH",
  zeroRowsMeans: "no catalogued theatre matches the caller's query.",
  params: ["pattern"],
  text: `
    SELECT theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
           first_seen_at, last_seen_at
    FROM theatre
    WHERE name ILIKE $1::text OR city ILIKE $1::text
    ORDER BY name, theatre_id`,
});

export const THEATRE_BROWSE = define({
  boundary: "catalogue",
  name: "THEATRE_BROWSE",
  zeroRowsMeans: "the theatre catalogue is empty.",
  params: [],
  text: `
    SELECT theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
           first_seen_at, last_seen_at
    FROM theatre
    ORDER BY name, theatre_id`,
});

export const MOVIE_UPSERT = define({
  boundary: "catalogue",
  name: "MOVIE_UPSERT",
  zeroRowsMeans: "the movie catalogue upsert unexpectedly returned no row.",
  params: ["movie_id", "provider_id", "title", "first_seen_at", "last_seen_at"],
  text: `
    INSERT INTO movie
      (movie_id, provider_id, title, first_seen_at, last_seen_at)
    VALUES
      ($1::text, $2::text, $3::text, $4::timestamptz, $5::timestamptz)
    ON CONFLICT (movie_id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      title = EXCLUDED.title,
      last_seen_at = greatest(movie.last_seen_at, EXCLUDED.last_seen_at)
    RETURNING movie_id, provider_id, title, first_seen_at, last_seen_at`,
});

export const MOVIE_READ_BY_ID = define({
  boundary: "catalogue",
  name: "MOVIE_READ_BY_ID",
  zeroRowsMeans: "no movie catalogue row exists for that movie_id.",
  params: ["movie_id"],
  text: `
    SELECT movie_id, provider_id, title, first_seen_at, last_seen_at, t.poster_path, t.runtime_minutes, t.genres
    FROM movie
    LEFT JOIN tmdb_movie t ON lower(movie.title) = t.normalized_title
    WHERE movie_id = $1::text`,
});

export const TMDB_MOVIE_UPSERT = define({
  boundary: "catalogue",
  name: "TMDB_MOVIE_UPSERT",
  zeroRowsMeans: "the tmdb_movie upsert unexpectedly returned no row.",
  params: ["tmdb_id", "normalized_title", "poster_path", "runtime_minutes", "genres"],
  text: `
    INSERT INTO tmdb_movie
      (tmdb_id, normalized_title, poster_path, runtime_minutes, genres, updated_at)
    VALUES
      ($1::int, $2::text, $3::text, $4::int, $5::text[], now())
    ON CONFLICT (tmdb_id) DO UPDATE SET
      normalized_title = EXCLUDED.normalized_title,
      poster_path = EXCLUDED.poster_path,
      runtime_minutes = EXCLUDED.runtime_minutes,
      genres = EXCLUDED.genres,
      updated_at = now()
    RETURNING tmdb_id, normalized_title, poster_path, runtime_minutes, genres, updated_at`,
});

/* -------------------------------------------------- S25 — TMDB metadata fetch (ADR 0019) */

export const TMDB_FETCH_DISPATCH = define({
  boundary: "S25",
  name: "TMDB_FETCH_DISPATCH",
  zeroRowsMeans: "a live fetch for that title is already pending — nothing new was enqueued.",
  params: ["tmdb_fetch_id", "movie_title"],
  text: `
    -- Idempotent dispatch (one statement): insert the searchless fetch row, then — only
    -- if the insert won (no live fetch for that title) — create the TMDB_FETCH outbox row
    -- that the relay publishes. A conflict on the partial UNIQUE index (movie_title WHERE
    -- state = 'PENDING') leaves both inserts empty, so the caller observes zero rows and
    -- enqueues nothing: the duplicate read-time miss is a no-op, never a duplicate fetch.
    WITH inserted AS (
      INSERT INTO tmdb_fetch (tmdb_fetch_id, movie_title)
      VALUES ($1::text, $2::text)
      ON CONFLICT (movie_title) WHERE state = 'PENDING' DO NOTHING
      RETURNING tmdb_fetch_id
    ), enqueued AS (
      -- No HTTP origin here (a read-time cache miss, not a request-scoped write), so
      -- traceparent is NULL explicitly — a fabricated parent would graft a retry onto a
      -- stale trace (ADR 0031).
      INSERT INTO outbox (outbox_id, target_kind, tmdb_fetch_id, traceparent)
      SELECT gen_random_uuid()::text, 'TMDB_FETCH', inserted.tmdb_fetch_id, NULL
      FROM inserted
      RETURNING outbox_id, tmdb_fetch_id
    )
    SELECT outbox_id, tmdb_fetch_id FROM enqueued`,
});

export const TMDB_FETCH_READ_BY_ID = define({
  boundary: "S25",
  name: "TMDB_FETCH_READ_BY_ID",
  zeroRowsMeans: "the fetch row vanished — nothing to process (ack without a fetch).",
  params: ["tmdb_fetch_id"],
  text: `
    SELECT tmdb_fetch_id, movie_title, state, attempt, fail_cause, created_at
    FROM tmdb_fetch
    WHERE tmdb_fetch_id = $1::text`,
});

export const TMDB_FETCH_DONE = define({
  boundary: "S25",
  name: "TMDB_FETCH_DONE",
  zeroRowsMeans: "the fetch was already completed, failed, or vanished — nothing to mark.",
  params: ["tmdb_fetch_id"],
  text: `
    UPDATE tmdb_fetch
    SET state = 'DONE', attempt = attempt + 1
    WHERE tmdb_fetch_id = $1::text AND state = 'PENDING'
    RETURNING tmdb_fetch_id, movie_title, state, attempt, fail_cause, created_at`,
});

export const TMDB_FETCH_FAIL = define({
  boundary: "S25",
  name: "TMDB_FETCH_FAIL",
  zeroRowsMeans: "the fetch was already completed, failed, or vanished — nothing to mark.",
  params: ["tmdb_fetch_id", "fail_cause"],
  text: `
    UPDATE tmdb_fetch
    SET state = 'FAILED', attempt = attempt + 1, fail_cause = $2::text
    WHERE tmdb_fetch_id = $1::text AND state = 'PENDING'
    RETURNING tmdb_fetch_id, movie_title, state, attempt, fail_cause, created_at`,
});

export const TMDB_PREWARM_STATE_READ = define({
  boundary: "catalogue",
  name: "TMDB_PREWARM_STATE_READ",
  zeroRowsMeans:
    "no pre-warm pass has ever run — the worker treats this as immediately due (ADR 0019 amendment decision 1).",
  params: [],
  text: `
    SELECT last_completed_at
    FROM tmdb_prewarm_state
    WHERE singleton = true`,
});

export const TMDB_PREWARM_COMPLETE = define({
  boundary: "catalogue",
  name: "TMDB_PREWARM_COMPLETE",
  zeroRowsMeans: "the pre-warm checkpoint upsert unexpectedly returned no row.",
  params: [],
  text: `
    INSERT INTO tmdb_prewarm_state (singleton, last_completed_at)
    VALUES (true, now())
    ON CONFLICT (singleton) DO UPDATE SET
      last_completed_at = now(),
      updated_at = now()
    RETURNING last_completed_at`,
});

export const THEATRE_RADIUS_QUERY = define({
  boundary: "catalogue",
  name: "THEATRE_RADIUS_QUERY",
  zeroRowsMeans: "no catalogued theatre lies within the caller-supplied radius.",
  params: ["origin_lat", "origin_lng", "radius_km"],
  text: `
    SELECT theatre_id, provider_id, name, lat, lng, market_slug, timezone, city, address, slugs,
           first_seen_at, last_seen_at, distance_km
    FROM (
      SELECT candidates.*,
             -- 6371.0088 km: mean Earth radius (IUGG), a physical constant, not a product
             -- number. Mirrors MEAN_EARTH_RADIUS_KM at packages/core/src/theatre.ts:29 — the
             -- two are independent literals and must be kept in sync by hand.
             2::double precision * 6371.0088::double precision
               * asin(sqrt(least(1::double precision,
                                 greatest(0::double precision, haversine)))) AS distance_km
      FROM (
        SELECT t.*,
               power(sin(radians(t.lat - $1::double precision) / 2), 2)
                 + cos(radians($1::double precision)) * cos(radians(t.lat))
                 * power(sin(radians(t.lng - $2::double precision) / 2), 2) AS haversine
        FROM theatre t
        WHERE t.lat BETWEEN
          greatest(-90::double precision,
                   $1::double precision
                     -- 6371.0088 km: mean Earth radius (IUGG), same physical constant as
                     -- above and as MEAN_EARTH_RADIUS_KM (packages/core/src/theatre.ts:29).
                     - degrees($3::double precision / 6371.0088::double precision))
          AND least(90::double precision,
                    $1::double precision
                      -- Same Earth-radius constant as the lower bound immediately above.
                      + degrees($3::double precision / 6371.0088::double precision))
      ) AS candidates
    ) AS distances
    WHERE distance_km <= $3::double precision
    ORDER BY distance_km, theatre_id`,
});

export const PERFORMANCE_UPDATE_PRODUCT = define({
  boundary: "catalogue",
  name: "PERFORMANCE_UPDATE_PRODUCT",
  zeroRowsMeans:
    "no performance row exists for that showtime_id — its schedule was never accepted.",
  params: [
    "showtime_id",
    "movie_id",
    "auditorium",
    "utc_offset",
    "runtime_minutes",
    "status",
    "format_code",
    "min_price",
    "deep_link_url",
    "provider_meta",
    "layout_id",
    "updated_at",
  ],
  text: `
    UPDATE performance SET
      movie_id = $2::text,
      auditorium = $3::text,
      utc_offset = $4::text,
      runtime_minutes = $5::integer,
      status = $6::text,
      format_code = $7::text,
      min_price = $8::numeric,
      deep_link_url = $9::text,
      provider_meta = $10::jsonb,
      layout_id = $11::text,
      updated_at = $12::timestamptz
    WHERE showtime_id = $1::text
    RETURNING showtime_id, updated_at`,
});

export const EVENT_APPEND = define({
  boundary: "analytics",
  name: "EVENT_APPEND",
  zeroRowsMeans: "the event append unexpectedly returned no row.",
  params: ["event_id", "type", "payload", "created_at"],
  text: `
    INSERT INTO events (event_id, type, payload, created_at)
    VALUES ($1::text, $2::text, $3::jsonb, $4::timestamptz)
    RETURNING event_id, type, created_at, tableoid::regclass::text AS partition_name`,
});

/* ---------------------------------------------- S26 — catalogue crawl state (ADR 0022) */

/**
 * The monthly theatre-catalogue crawl's restart-safe checkpoint (S26.1/S26.10). Four
 * statements on one single-row-per-provider table: read (due-ness), begin a pass, advance
 * the cursor after each processed page, and complete a pass. ADR 0022 §6 fixes the crawl's
 * scope — no separate run_key lane, no separate egress, no exception — so none of these
 * participate in any B1–B10 transition; they are plain catalogue-adjacent state.
 */
export const CATALOGUE_CRAWL_STATE_READ = define({
  boundary: "catalogue",
  name: "CATALOGUE_CRAWL_STATE_READ",
  zeroRowsMeans:
    "no catalogue crawl pass has ever run for that provider — the worker treats this as immediately due (S26.7).",
  params: ["provider_id"],
  text: `
    SELECT provider_id, last_pass_started_at, last_pass_completed_at, cursor, updated_at
    FROM catalogue_crawl_state
    WHERE provider_id = $1::text`,
});

export const CATALOGUE_CRAWL_STATE_BEGIN_PASS = define({
  boundary: "catalogue",
  name: "CATALOGUE_CRAWL_STATE_BEGIN_PASS",
  zeroRowsMeans: "the catalogue crawl pass upsert unexpectedly returned no row.",
  params: ["provider_id"],
  text: `
    INSERT INTO catalogue_crawl_state (provider_id, last_pass_started_at, cursor)
    VALUES ($1::text, now(), NULL)
    ON CONFLICT (provider_id) DO UPDATE SET
      last_pass_started_at = now(),
      cursor = NULL,
      updated_at = now()
    RETURNING provider_id, last_pass_started_at, last_pass_completed_at, cursor, updated_at`,
});

export const CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR = define({
  boundary: "catalogue",
  name: "CATALOGUE_CRAWL_STATE_ADVANCE_CURSOR",
  zeroRowsMeans:
    "no catalogue crawl pass is in progress for that provider (BEGIN_PASS was never called).",
  params: ["provider_id", "cursor"],
  text: `
    UPDATE catalogue_crawl_state
    SET cursor = $2::jsonb, updated_at = now()
    WHERE provider_id = $1::text
    RETURNING provider_id, last_pass_started_at, last_pass_completed_at, cursor, updated_at`,
});

export const CATALOGUE_CRAWL_STATE_COMPLETE_PASS = define({
  boundary: "catalogue",
  name: "CATALOGUE_CRAWL_STATE_COMPLETE_PASS",
  zeroRowsMeans:
    "no catalogue crawl pass is in progress for that provider (BEGIN_PASS was never called).",
  params: ["provider_id"],
  text: `
    UPDATE catalogue_crawl_state
    SET last_pass_completed_at = now(), cursor = NULL, updated_at = now()
    WHERE provider_id = $1::text
    RETURNING provider_id, last_pass_started_at, last_pass_completed_at, cursor, updated_at`,
});

/* ------------------------------------------------------------------ B1 — create */

export const B1_CREATE_SEARCH = define({
  boundary: "B1",
  name: "B1_CREATE_SEARCH",
  zeroRowsMeans:
    "a row already exists for this (session_id, idempotency_key). Read it and compare " +
    "spec_hash: same → return the existing search unchanged; different → 409 CONFLICT. " +
    "Never silently reuse, never fork a second search onto the same key.",
  params: ["search_id", "session_id", "idempotency_key", "spec", "spec_hash", "deadline_at"],
  text: `
    INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, deadline_at)
    VALUES ($1::text, $2::text, $3::text, $4::jsonb, $5::text, $6::timestamptz)
    ON CONFLICT (session_id, idempotency_key) DO NOTHING
    RETURNING search_id`,
});

export const B1_STAGE1_ADMISSION = define({
  boundary: "B1",
  name: "B1_STAGE1_ADMISSION",
  zeroRowsMeans:
    "reject/queue with estimatedMs BEFORE any quota is spent (§4.4). The reservation row " +
    "is created here or B6 has nothing to reconcile and B8 nothing to release.",
  params: ["provider_id", "reserve", "cold_delta", "search_id", "fresh_match_seed"],
  text: `
    WITH gate AS (
      UPDATE provider_admission
      SET pending_cost = pending_cost + $2::bigint,
          unresolved_schedules = unresolved_schedules + $3::integer
      WHERE provider_id = $1::text
        AND pending_cost + $2::bigint <= pending_cost_limit
        AND unresolved_schedules + $3::integer <= unresolved_limit
      RETURNING provider_id
    ),
    event AS (
      -- ADR 0005 §I: the ADMISSION_RESERVATION ledger event rides in the SAME statement as
      -- the reservation row it records, so a gate failure inserts no event and a success
      -- inserts exactly one ("inserted alongside the existing admission_reservation row at
      -- commit", docs/adr/0005-security-privacy-operations.md:881-886). units = $2 (reserve):
      -- the stage-1 reserved_total — validator maximum cold / real count warm.
      INSERT INTO cost_event (event_id, event_type, search_id, units)
      SELECT gen_random_uuid()::text, 'ADMISSION_RESERVATION', $4::text, $2::bigint
      FROM gate
      ON CONFLICT (search_id) WHERE event_type = 'ADMISSION_RESERVATION' DO NOTHING
      RETURNING event_id
    )
    INSERT INTO admission_reservation
      (search_id, provider_id, reserved_total, reserved_remaining, schedule_slot_held, fresh_match_seed, schedule_reconciled)
    SELECT $4::text, provider_id, $2::bigint, $2::bigint, ($3::integer = 1), $5::integer, false FROM gate
    RETURNING search_id`,
});

/**
 * Warm-path RUNNING transition (S15.8), fenced on the current status exactly like every
 * other boundary in this file — never an unconditional write. It only ever moves
 * `PENDING_SCHEDULE → RUNNING`, so a racing sweeper terminalization (B7/B8) or an
 * idempotent replay that already transitioned the row loses the fence instead of
 * resurrecting a terminal search. Cold creations stay `PENDING_SCHEDULE`, the column's
 * own default (`001_schema.sql:26-28`) — architecture §13 step 3's split
 * (`docs/seatfirst-architecture.md:700`).
 */
export const B1_MARK_RUNNING = define({
  boundary: "B1",
  name: "B1_MARK_RUNNING",
  zeroRowsMeans:
    "the search is not PENDING_SCHEDULE — it already transitioned, or a sweeper " +
    "terminalized it between create and mark. Nothing more to do.",
  params: ["search_id"],
  text: `
    UPDATE search SET status = 'RUNNING'
    WHERE search_id = $1::text AND status = 'PENDING_SCHEDULE'
    RETURNING search_id`,
});

/**
 * Idempotent-replay companion read (S15.3): how many SHOWTIME_FETCH jobs a pre-existing
 * search already has. Only consulted when `B1_CREATE_SEARCH` zero-rows on an identical
 * `spec_hash` — a lost-response retry reconstructs its 202 body's warm counts from this
 * when the schedule cache has since gone cold. An aggregate always returns one row;
 * `zeroRowsMeans` describes the `n = 0` case (created cold, or warm with zero
 * policy-eligible showtimes).
 */
export const SEARCH_SET_BATCH_DEFERRED = define({
  boundary: "B1",
  name: "SEARCH_SET_BATCH_DEFERRED",
  zeroRowsMeans: "search not found — the B1_CREATE_SEARCH insert failed.",
  params: ["search_id", "batch_deferred_count"],
  text: `
    UPDATE search SET batch_deferred_count = $2::integer
    WHERE search_id = $1::text
    RETURNING search_id`,
});

export const SEARCH_SET_CONTINUES = define({
  boundary: "B1",
  name: "SEARCH_SET_CONTINUES",
  zeroRowsMeans: "search not found — the B1_CREATE_SEARCH insert failed.",
  params: ["search_id", "continues_search_id"],
  text: `
    UPDATE search SET continues_search_id = $2::text
    WHERE search_id = $1::text
    RETURNING search_id`,
});

export const B1_SEARCH_FETCH_JOB_COUNT = define({
  boundary: "B1",
  name: "B1_SEARCH_FETCH_JOB_COUNT",
  zeroRowsMeans: "this search has no SHOWTIME_FETCH jobs (cold-created, or no eligible showtimes).",
  params: ["search_id"],
  text: `
    SELECT count(*)::integer AS n FROM search_job
    WHERE search_id = $1::text AND kind = 'SHOWTIME_FETCH'`,
});

/* ------------------------------------- work creation, shared by B1 and B6 expansion */

/**
 * Not quoted from the ADR: B1's warm path and B6's `RESOLVED` expansion both "insert
 * jobs + subscriptions + outbox rows" in prose only. One set of statements serves both,
 * which is the point of the shared work-creation surface.
 */
export const RUN_KEY_UPSERT = define({
  boundary: "B1/B6",
  name: "RUN_KEY_UPSERT",
  zeroRowsMeans: "",
  params: [
    "run_key_id",
    "kind",
    "provider_id",
    "route_class",
    "showtime_id",
    "theatre_id",
    "local_date",
  ],
  text: `
    INSERT INTO run_key (run_key_id, kind, provider_id, route_class,
                         showtime_id, theatre_id, local_date)
    VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::date)
    -- the deterministic run_key_id is the arbiter: concurrent creators converge on one
    -- row rather than racing (T3b). DO UPDATE (not DO NOTHING) so the winner and the
    -- loser both get the row back.
    ON CONFLICT (run_key_id) DO UPDATE SET provider_id = run_key.provider_id
    RETURNING run_key_id`,
});

export const JOB_CREATE = define({
  boundary: "B1/B6",
  name: "JOB_CREATE",
  zeroRowsMeans: "this job_id already exists — duplicate expansion, nothing more to do.",
  params: ["job_id", "search_id", "kind", "run_key_id", "deadline_at"],
  text: `
    INSERT INTO search_job (job_id, search_id, kind, run_key_id, deadline_at)
    VALUES ($1::text, $2::text, $3::text, $4::text, $5::timestamptz)
    ON CONFLICT (job_id) DO NOTHING
    RETURNING job_id`,
});

export const SUBSCRIPTION_CREATE = define({
  boundary: "B1/B6",
  name: "SUBSCRIPTION_CREATE",
  zeroRowsMeans: "this search already subscribes to this key.",
  params: ["run_key_id", "search_id", "job_id", "deadline_at"],
  text: `
    INSERT INTO run_subscription (run_key_id, search_id, job_id, deadline_at)
    VALUES ($1::text, $2::text, $3::text, $4::timestamptz)
    ON CONFLICT (run_key_id, search_id) DO NOTHING
    RETURNING job_id`,
});

/**
 * ADR 0005 §I point 2: the charge for a search that joins a `run_key` whose current
 * `provider_run` is already dispatched and still live ("the abuse meter charges every
 * subscriber session the full logical-navigation weight",
 * `docs/seatfirst-architecture.md:233`). Runs immediately after `SUBSCRIPTION_CREATE` at
 * the three subscription sites (see `transactions.ts`) — its zero rows are normal, not an
 * error: no live dispatched run means nothing owed.
 *
 * The "already dispatched and still live" predicate is three-part and race-free
 * (`docs/adr/0005-security-privacy-operations.md:829-852`), all checked FOR UPDATE on the
 * locked `provider_run` row: (1) a `PROVIDER_WORK` event exists for `(run_id, attempt)` —
 * `state = 'LEASED'` alone does not prove dispatch (B2 leases before B4 runs); (2)
 * `state = 'LEASED'` AND the lease is unexpired — a stale pre-reclaim attempt must not
 * bill a joiner; (3) the same openness re-check B4 performs — the fence epoch must match
 * and no `HALTED`/active-`PAUSED` scope may exist, or a B9-halted-but-still-`LEASED` run
 * would charge a joiner for an attempt already aborted.
 */
export const COST_ABUSE_JOIN = define({
  boundary: "B1/B6",
  name: "COST_ABUSE_JOIN",
  zeroRowsMeans: "no live dispatched run to charge — nothing owed, not an error.",
  params: ["run_key_id", "search_id"],
  text: `
    WITH keyed AS (
      SELECT provider_id, route_class FROM run_key WHERE run_key_id = $1::text
    ),
    locked AS (
      SELECT pr.run_id, pr.attempt
      FROM provider_run pr, keyed k, provider_fence f
      WHERE pr.run_key_id = $1::text
        AND pr.state = 'LEASED'
        AND pr.lease_expires_at > now()
        AND pr.provider_epoch = f.epoch
        AND f.provider_id = k.provider_id
        AND NOT EXISTS (SELECT 1 FROM provider_status ps
                        WHERE ps.provider_id = k.provider_id
                          AND ps.route_class IN ('', k.route_class)
                          AND (ps.state = 'HALTED'
                               OR (ps.state = 'PAUSED'
                                   AND (ps.not_before IS NULL OR ps.not_before > now()))))
        AND EXISTS (SELECT 1 FROM cost_event ce
                    WHERE ce.event_type = 'PROVIDER_WORK'
                      AND ce.run_id = pr.run_id
                      AND ce.attempt = pr.attempt)
      FOR UPDATE OF pr
    )
    INSERT INTO cost_event (event_id, event_type, run_id, attempt, search_id, units)
    SELECT gen_random_uuid()::text, 'ABUSE_WEIGHTED', locked.run_id, locked.attempt, $2::text, 1
    FROM locked
    ON CONFLICT (run_id, attempt, search_id) WHERE event_type = 'ABUSE_WEIGHTED' DO NOTHING
    RETURNING event_id`,
});

export const OUTBOX_CREATE_JOB = define({
  boundary: "B1/B6",
  name: "OUTBOX_CREATE_JOB",
  zeroRowsMeans: "",
  params: ["job_id", "traceparent"],
  text: `
    INSERT INTO outbox (outbox_id, target_kind, job_id, traceparent)
    VALUES (gen_random_uuid()::text, 'JOB', $1::text, $2::text)
    RETURNING outbox_id`,
});

export const OUTBOX_CREATE_RUN = define({
  boundary: "B1/B6",
  name: "OUTBOX_CREATE_RUN",
  zeroRowsMeans: "",
  params: ["run_id", "traceparent"],
  text: `
    INSERT INTO outbox (outbox_id, target_kind, run_id, traceparent)
    VALUES (gen_random_uuid()::text, 'RUN', $1::text, $2::text)
    RETURNING outbox_id`,
});

export const OUTBOX_MARK_PUBLISHED = define({
  boundary: "outbox relay",
  name: "OUTBOX_MARK_PUBLISHED",
  zeroRowsMeans: "that outbox row is not pending — it was already published, or it does not exist.",
  params: ["outbox_id"],
  text: `
    UPDATE outbox SET state = 'PUBLISHED'
    WHERE outbox_id = $1::text AND state = 'PENDING'
    RETURNING outbox_id, state`,
});

export const OUTBOX_MARK_RETRY = define({
  boundary: "outbox relay",
  name: "OUTBOX_MARK_RETRY",
  zeroRowsMeans:
    "the row was reclaimed or already published by a concurrent actor — it no longer needs this retry.",
  params: ["outbox_id", "backoff"],
  text: `
    UPDATE outbox SET attempt = attempt + 1, next_attempt_at = now() + $2::interval
    WHERE outbox_id = $1::text AND state = 'PENDING'
    RETURNING outbox_id, attempt, next_attempt_at`,
});

export const RUN_CREATE = define({
  boundary: "B1/B6",
  name: "RUN_CREATE",
  zeroRowsMeans:
    "a live run already exists for this key (§4.4 at-most-one). Subscribe to it; do not " +
    "dispatch a second.",
  params: ["run_id", "run_key_id", "observation_id", "dispatch_rank"],
  text: `
    -- provider_epoch is stamped from the fence at creation and REFRESHED by B4 before
    -- dispatch; a pending run that survives a pause/reopen must not carry a stale epoch.
    -- priority is derived from kind (S22.14, ADR 0017): RECHECK > SCHEDULE_RESOLUTION >
    -- SHOWTIME_FETCH, so the outbox drain (SWEEP_OVERDUE_OUTBOX) dispatches rechecks first.
    -- dispatch_rank is S44's ordinal position within the admitting search's ranked
    -- candidate list (0 = best, NULL = no rank for RECHECK/SCHEDULE_RESOLUTION or
    -- pre-S44 rows). On conflict the stored rank becomes the best (minimum) of the
    -- existing and incoming ranks, treating NULL as "no opinion" rather than 0/best
    -- — a second subscriber with a real rank must still improve a first subscriber's
    -- NULL, and a worse rank must not overwrite a better one.
    INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch, priority, dispatch_rank)
    SELECT $1::text, $2::text, $3::text, f.epoch,
           CASE k.kind WHEN 'RECHECK' THEN 2 WHEN 'SCHEDULE_RESOLUTION' THEN 1 ELSE 0 END,
           $4::smallint
    FROM run_key k JOIN provider_fence f ON f.provider_id = k.provider_id
    WHERE k.run_key_id = $2::text
    ON CONFLICT (run_key_id) WHERE state IN ('PENDING','LEASED') DO UPDATE SET
      dispatch_rank = COALESCE(
        LEAST(NULLIF(provider_run.dispatch_rank, NULL), NULLIF(EXCLUDED.dispatch_rank, NULL)),
        provider_run.dispatch_rank,
        EXCLUDED.dispatch_rank
      )
    RETURNING run_id`,
});

/* --------------------------------------------------------- S22 — recheck */

export const RECHECK_RUN_KEY_CREATE = define({
  boundary: "S22",
  name: "RECHECK_RUN_KEY_CREATE",
  zeroRowsMeans: "unreachable — a per-call run_key_id collision is a ULID minting bug.",
  params: ["run_key_id", "provider_id", "showtime_id", "recheck_placement"],
  text: `
    -- Per-call uniqueness is REQUIRED (S22.5): each recheck is a fresh logical navigation
    -- that must never coalesce onto an existing key (seatfirst-architecture.md:703). The
    -- run_key_id embeds a fresh ULID for that reason — unlike RUN_KEY_UPSERT's deterministic
    -- coalescing key, this is a plain INSERT (a collision is a minting bug, not a race).
    INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id, recheck_placement)
    VALUES ($1::text, 'RECHECK', $2::text, 'seat', $3::text, $4::jsonb)
    RETURNING run_key_id`,
});

export const RECHECK_COMPLETE = define({
  boundary: "S22",
  name: "RECHECK_COMPLETE",
  zeroRowsMeans:
    "the run was halted or reclaimed mid-flight — no outcome is written, and the route's " +
    "deadline yields TIMEOUT (an honest 'no verdict', never a wrong one).",
  params: ["run_id", "generation", "status", "payload"],
  text: `
    -- One statement: the run's terminal transition and its outcome write commit together
    -- or not at all (S22.5). The fence (state='LEASED' AND generation=$2) is what makes a
    -- halted/reclaimed run yield zero rows rather than writing an outcome for a stranded run.
    WITH done AS (
      UPDATE provider_run SET state = 'DONE'
      WHERE run_id = $1::text AND state = 'LEASED' AND generation = $2::integer
      RETURNING run_id
    )
    INSERT INTO recheck_outcome (run_id, status, payload)
    SELECT run_id, $3::text, $4::jsonb FROM done
    RETURNING run_id`,
});

export const RECHECK_FAIL = define({
  boundary: "S22",
  name: "RECHECK_FAIL",
  zeroRowsMeans: "unreachable — this is an insert of a fresh outcome row.",
  params: ["run_id", "payload"],
  text: `
    -- The failure outcome for a run already FAILED by failRun in the same transaction
    -- (S22.4): status is always UNAVAILABLE; the cause lives in payload.
    INSERT INTO recheck_outcome (run_id, status, payload)
    VALUES ($1::text, 'UNAVAILABLE', $2::jsonb)
    RETURNING run_id`,
});

export const RECHECK_OUTCOME_READ = define({
  boundary: "S22",
  name: "RECHECK_OUTCOME_READ",
  zeroRowsMeans: "no verdict yet — the run has not written its outcome.",
  params: ["run_id"],
  text: `
    SELECT status, payload FROM recheck_outcome WHERE run_id = $1::text`,
});

export const NONCE_CONSUME = define({
  boundary: "S22",
  name: "NONCE_CONSUME",
  zeroRowsMeans: "the nonce is already consumed — reject as a replay (S22.9).",
  params: ["nonce_id"],
  text: `
    INSERT INTO consumed_nonce (nonce_id) VALUES ($1::text)
    ON CONFLICT (nonce_id) DO NOTHING
    RETURNING nonce_id`,
});

/* --------------------------------------------------------- B2/B3 — lease, heartbeat */

export const B2_LEASE_JOB = define({
  boundary: "B2",
  name: "B2_LEASE_JOB",
  zeroRowsMeans: "duplicate delivery or CANCELLED — drop the message.",
  params: ["job_id", "lease_ttl"],
  text: `
    UPDATE search_job
    SET state = 'LEASED', generation = generation + 1,
        lease_expires_at = now() + $2::interval, attempt = attempt + 1
    WHERE job_id = $1::text AND state = 'PENDING'
    RETURNING generation`,
});

/** Identical statement, keyed on run_id — one implementation serves both run kinds. */
export const B2_LEASE_RUN = define({
  boundary: "B2",
  name: "B2_LEASE_RUN",
  zeroRowsMeans: "duplicate delivery or CANCELLED — drop the message.",
  params: ["run_id", "lease_ttl"],
  text: `
    UPDATE provider_run
    SET state = 'LEASED', generation = generation + 1,
        lease_expires_at = now() + $2::interval, attempt = attempt + 1
    WHERE run_id = $1::text AND state = 'PENDING'
    RETURNING generation`,
});
/** S60 (ADR 0066 §4) — atomic two-row admission fence: lock the job and its parent search before creating or leasing provider work. */
export const B2_ADMISSION_FENCE = define({
  boundary: "B2",
  name: "B2_ADMISSION_FENCE",
  zeroRowsMeans:
    "the search was cancelled or terminalized, or the job lease expired — do not admit; drop the pass.",
  params: ["job_id", "generation"],
  text: `
    SELECT 1 FROM search_job sj
    JOIN search s ON s.search_id = sj.search_id
    WHERE sj.job_id = $1::text
      AND sj.generation = $2::integer
      AND sj.state = 'LEASED'
      AND sj.lease_expires_at > now()
      AND s.status IN ('PENDING_SCHEDULE', 'RUNNING')
    FOR UPDATE OF s, sj;`,
});

export const B3_HEARTBEAT_JOB = define({
  boundary: "B3",
  name: "B3_HEARTBEAT_JOB",
  zeroRowsMeans: "lease lost — propagate AbortSignal into any in-flight HTTP request, stop.",
  params: ["job_id", "generation", "lease_ttl"],
  text: `
    UPDATE search_job SET lease_expires_at = now() + $3::interval
    WHERE job_id = $1::text AND generation = $2::integer AND state = 'LEASED'
    RETURNING job_id`,
});

export const B3_HEARTBEAT_RUN = define({
  boundary: "B3",
  name: "B3_HEARTBEAT_RUN",
  zeroRowsMeans: "lease lost — propagate AbortSignal into any in-flight HTTP request, stop.",
  params: ["run_id", "generation", "lease_ttl"],
  text: `
    UPDATE provider_run SET lease_expires_at = now() + $3::interval
    WHERE run_id = $1::text AND generation = $2::integer AND state = 'LEASED'
    RETURNING run_id`,
});

/**
 * S8/S10 — the capacity-one provider semaphore's durable shadow. When the fetch actor
 * loses the acquire race, the run its delivery carried must not sit `LEASED` until the
 * sweeper's lease expiry notices: this statement returns that delivery's run to
 * `PENDING` and, in the same atomic breath, mints the replacement delivery (one fresh
 * RUN outbox row, NULL traceparent — the defer happens off the request path). Fenced on
 * `(run_id, generation)` + `LEASED` exactly like every run transition: a stale delivery
 * or a run already reclaimed/dispatched by someone else loses, returns zero rows, and
 * writes nothing. A winning defer clears the attempt that B2 counted for this delivery
 * because no navigation occurred; the next B2 lease restores that attempt number.
 */
export const RUN_DEFER_BUSY = define({
  boundary: "B2(defer)",
  name: "RUN_DEFER_BUSY",
  zeroRowsMeans:
    "stale generation or the run is no longer LEASED — this delivery lost; resurrect nothing.",
  params: ["run_id", "generation"],
  text: `
    WITH deferred AS (
      UPDATE provider_run
      SET state = 'PENDING', lease_expires_at = NULL, attempt = attempt - 1
      WHERE run_id = $1::text AND generation = $2::integer AND state = 'LEASED'
      RETURNING run_id
    )
    INSERT INTO outbox (outbox_id, target_kind, run_id, traceparent)
    SELECT gen_random_uuid()::text, 'RUN', run_id, NULL
    FROM deferred
    RETURNING outbox_id`,
});

/* ------------------------------------------------- B4 — pre-dispatch fenced transition */

export const B4_PREDISPATCH = define({
  boundary: "B4",
  name: "B4_PREDISPATCH",
  zeroRowsMeans:
    "do NOT dispatch: halted, still cooling down, or lease lost. Dispatch immediately on " +
    "success, carrying the returned epoch into B5(b).",
  params: ["run_id", "generation"],
  text: `
    -- provider and route_class are derived from the run's key, never caller-supplied.
    -- This is a fenced TRANSITION, not a read: it refreshes the epoch atomically with
    -- verifying openness, so a run created before a pause/reopen is not stranded (T28).
    --
    -- ADR 0005 §I: the PROVIDER_WORK and dispatch-time ABUSE_WEIGHTED inserts chain off
    -- this UPDATE's RETURNING inside the SAME single statement — B4 succeeding and the
    -- ledger gaining the events are one atomic fact, stronger than the "same transaction"
    -- the ADR requires (docs/adr/0005-security-privacy-operations.md:761-785,814-817).
    -- attempt comes from the locked row, never a caller value; a denied fence returns
    -- zero rows and writes nothing.
    WITH upd AS (
      UPDATE provider_run pr
      SET provider_epoch = f.epoch
      FROM run_key k, provider_fence f
      WHERE pr.run_id = $1::text
        AND pr.generation = $2::integer
        AND pr.state = 'LEASED'
        AND k.run_key_id = pr.run_key_id
        AND f.provider_id = k.provider_id
        AND NOT EXISTS (SELECT 1 FROM provider_status ps
                        WHERE ps.provider_id = k.provider_id
                          AND ps.route_class IN ('', k.route_class)
                          AND (ps.state = 'HALTED'
                               OR (ps.state = 'PAUSED'
                                   AND (ps.not_before IS NULL OR ps.not_before > now()))))
      RETURNING pr.provider_epoch, pr.run_id, pr.run_key_id, pr.attempt
    ),
    provider_work AS (
      INSERT INTO cost_event (event_id, event_type, run_id, attempt, units)
      SELECT gen_random_uuid()::text, 'PROVIDER_WORK', u.run_id, u.attempt, 1
      FROM upd u
      ON CONFLICT (run_id, attempt) WHERE event_type = 'PROVIDER_WORK' DO NOTHING
      RETURNING event_id
    ),
    abuse_weighted AS (
      -- one charge per subscriber LIVE at this instant, units = 1 each (ADR 0005 §I point 1)
      INSERT INTO cost_event (event_id, event_type, run_id, attempt, search_id, units)
      SELECT gen_random_uuid()::text, 'ABUSE_WEIGHTED', u.run_id, u.attempt, rs.search_id, 1
      FROM upd u
      JOIN run_subscription rs
        ON rs.run_key_id = u.run_key_id AND rs.state = 'LIVE'
      ON CONFLICT (run_id, attempt, search_id) WHERE event_type = 'ABUSE_WEIGHTED' DO NOTHING
      RETURNING event_id
    )
    SELECT provider_epoch FROM upd`,
});

/* ------------------------------------------------------------- B5 — acceptance */

export const B5A_FENCE = define({
  boundary: "B5(a)",
  name: "B5A_FENCE",
  zeroRowsMeans: "ROLLBACK. Zombie write-back rejected in toto.",
  params: ["run_id", "generation"],
  text: `
    -- Everything the rest of the transaction needs is DERIVED from this row, never taken
    -- from the caller: $key, $obs, $observedEpoch, and (via run_key) $kind, $p, $rc.
    UPDATE provider_run SET state = 'DONE'
    WHERE run_id = $1::text AND generation = $2::integer AND state = 'LEASED'
    RETURNING run_key_id, observation_id, provider_epoch`,
});

export const B5A_DERIVE_KEY = define({
  boundary: "B5(a)",
  name: "B5A_DERIVE_KEY",
  zeroRowsMeans: "the fenced run references no key — impossible under the FK; abort loudly.",
  params: ["run_key_id"],
  text: `
    SELECT kind, provider_id, route_class
    FROM run_key WHERE run_key_id = $1::text`,
});

export const B5B_EPOCH_FENCE = define({
  boundary: "B5(b)",
  name: "B5B_EPOCH_FENCE",
  zeroRowsMeans:
    "ROLLBACK. Epoch equality alone is insufficient; effective state is re-checked here " +
    "for the same reason B4 re-checks before dispatch.",
  params: ["provider_id", "observed_epoch", "route_class"],
  text: `
    SELECT 1 FROM provider_fence f
    WHERE f.provider_id = $1::text
      AND f.epoch = $2::bigint
      AND NOT EXISTS (SELECT 1 FROM provider_status ps
                      WHERE ps.provider_id = $1::text
                        AND ps.route_class IN ('', $3::text)
                        AND (ps.state = 'HALTED'
                             OR (ps.state = 'PAUSED'
                                 AND (ps.not_before IS NULL OR ps.not_before > now()))))`,
});

/* --------------------------------- provider control reads (§4.3, fail-closed authority) */

export const PROVIDER_EFFECTIVE_STATE = define({
  boundary: "B4(read)",
  name: "PROVIDER_EFFECTIVE_STATE",
  zeroRowsMeans:
    "unreachable — this aggregate over zero provider_status rows still yields one OPEN row.",
  params: ["provider_id", "route_class"],
  text: `
    -- The Postgres authority behind every fail-closed control read (S5.5): the provider-wide
    -- ('' ) row and the route's scoped row together, with a global halt winning over every
    -- route state. The amended predicate treats a NULL deadline as an indefinite pause that
    -- blocks — only a concrete expired not_before self-resumes (ADR 0001 B4/B9).
    SELECT CASE
      WHEN coalesce(bool_or(state = 'HALTED'), false) THEN 'HALTED'
      WHEN coalesce(bool_or(state = 'PAUSED'
                            AND (not_before IS NULL OR not_before > now())), false) THEN 'PAUSED'
      ELSE 'OPEN'
    END AS state
    FROM provider_status
    WHERE provider_id = $1::text AND route_class IN ('', $2::text)`,
});

export const B5C_OBSERVATION = define({
  boundary: "B5(c)",
  name: "B5C_OBSERVATION",
  zeroRowsMeans:
    "this observation was already accepted; ROLLBACK. Retries cannot mint new snapshots " +
    "(T12c) — the property a captured_at-inclusive key would have lost.",
  params: ["observation_id", "run_key_id", "run_id", "captured_at"],
  text: `
    -- Registry first: the non-partitioned uniqueness enforcement point. UNIQUE(run_id)
    -- and the composite run/key FK reject a mismatched delivery in the database (T24).
    --
    -- Deviation from ADR 0001 B5(c): the revision is DERIVED here, not passed as $rev.
    -- It must equal the value B5(d) is about to write, and at most one live run per key
    -- means nothing else can move it inside this transaction — so taking it from the
    -- caller only creates a way for the registry and the key to disagree.
    INSERT INTO observation (observation_id, run_key_id, run_id, captured_at, accepted_revision)
    SELECT $1::text, $2::text, $3::text, $4::timestamptz, k.accepted_revision + 1
    FROM run_key k WHERE k.run_key_id = $2::text
    ON CONFLICT DO NOTHING
    RETURNING observation_id, accepted_revision`,
});

/** SHOWTIME_FETCH branch of B5(c). */
export const B5C_SNAPSHOT = define({
  boundary: "B5(c)",
  name: "B5C_SNAPSHOT",
  zeroRowsMeans: "",
  params: ["observation_id", "showtime_id", "captured_at", "bitmap", "free_count"],
  text: `
    INSERT INTO availability_snapshot (observation_id, showtime_id, captured_at,
                                       bitmap, free_count)
    VALUES ($1::text, $2::text, $3::timestamptz, $4::bytea, $5::integer)
    RETURNING observation_id`,
});

/**
 * SCHEDULE_RESOLUTION branch of B5(c). Mandatory, not stylistic:
 * `availability_snapshot.showtime_id` is NOT NULL and schedule keys have no showtime, so
 * sharing the fetch statement fails and rolls the acceptance back.
 */
export const B5C_PERFORMANCE = define({
  boundary: "B5(c)",
  name: "B5C_PERFORMANCE",
  zeroRowsMeans: "",
  params: [
    "showtime_id",
    "provider_id",
    "theatre_id",
    "local_date",
    "starts_at",
    "observation_id",
    "attributes",
  ],
  text: `
    INSERT INTO performance (showtime_id, provider_id, theatre_id, local_date,
                             starts_at, observation_id, attributes)
    VALUES ($1::text, $2::text, $3::text, $4::date, $5::timestamptz, $6::text, $7::jsonb)
    -- a later resolution of the same key re-states its showtimes; the newest accepted
    -- observation owns the row
    ON CONFLICT (showtime_id) DO UPDATE
    SET local_date = EXCLUDED.local_date, starts_at = EXCLUDED.starts_at, observation_id = EXCLUDED.observation_id,
        attributes = EXCLUDED.attributes, updated_at = now()
    RETURNING showtime_id`,
});

export const B5C_LAYOUT_UPSERT = define({
  boundary: "B5(c)",
  name: "B5C_LAYOUT_UPSERT",
  zeroRowsMeans:
    "an identical layout row already exists — the insert is a no-op, not a failure; " +
    "the caller must not treat zero rows here as an error",
  params: ["layout_id", "geometry", "rows", "columns"],
  text: `
    INSERT INTO auditorium_layout (layout_id, geometry, rows, columns)
    VALUES ($1::text, $2::bytea, $3::integer, $4::integer)
    ON CONFLICT (layout_id) DO NOTHING
    RETURNING layout_id`,
});

export const B5C_PERFORMANCE_LAYOUT = define({
  boundary: "B5(c)",
  name: "B5C_PERFORMANCE_LAYOUT",
  zeroRowsMeans:
    "no performance row exists for that showtime_id — impossible under schedule-acceptance " +
    "precedence (a SHOWTIME_FETCH run only exists for an already-accepted performance); " +
    "abort loudly",
  params: ["showtime_id", "layout_id"],
  text: `
    UPDATE performance SET layout_id = $2::text
    WHERE showtime_id = $1::text
    RETURNING showtime_id`,
});

/**
 * SHOWTIME_FETCH branch of B5(c) — the seat-fetch price write (S59, ADR 0062 §3).
 * Runs inside `stageFetchAcceptance`'s transaction, after the snapshot write: a
 * SHOWTIME_FETCH run only exists for an already-accepted performance, so the row
 * is always present under schedule-acceptance precedence.
 */
export const B5C_PERFORMANCE_PRICE = define({
  boundary: "B5(c)",
  name: "B5C_PERFORMANCE_PRICE",
  zeroRowsMeans:
    "no performance row exists for that showtime_id — impossible under schedule-acceptance " +
    "precedence (a SHOWTIME_FETCH run only exists for an already-accepted performance); " +
    "abort loudly",
  params: ["showtime_id", "min_price", "currency", "price_basis", "updated_at"],
  text: `
    UPDATE performance SET
      min_price = $2::numeric,
      currency = $3::text,
      price_basis = $4::text,
      updated_at = $5::timestamptz
    WHERE showtime_id = $1::text
    RETURNING showtime_id`,
});

export const B5D_ACCEPTED_REVISION = define({
  boundary: "B5(d)",
  name: "B5D_ACCEPTED_REVISION",
  zeroRowsMeans: "the key vanished — impossible under the FK; abort loudly.",
  params: ["run_key_id", "observation_id", "captured_at"],
  text: `
    -- monotonic accepted revision for the cache projector (NOT captured_at — §4.1)
    UPDATE run_key
    SET accepted_revision = accepted_revision + 1,
        latest_observation_id = $2::text, latest_captured_at = $3::timestamptz
    WHERE run_key_id = $1::text
    RETURNING accepted_revision`,
});

/**
 * B5(e)+(f) — the fan-in. ONE statement, deliberately: `WITH` is scoped to the statement
 * it prefixes, and the application must be written exactly once with every effect reading
 * its subscriber set from that write (round 4 finding 1: a standalone insert left this
 * chain's `RETURNING` empty and every effect processed zero rows).
 *
 * `locked` takes a row lock on each candidate parent, serializing the fan-in against B8.
 * Without it, `cap`/`seqs` act on a stale eligibility snapshot — charging capacity and
 * emitting FETCH_ACCEPTED after an immutable terminal result was written (T35).
 */
export const B5_FANIN = define({
  boundary: "B5(e)+(f)",
  name: "B5_FANIN",
  zeroRowsMeans:
    "no eligible subscriber — every candidate was already applied, terminal, or past its " +
    "own deadline. The acceptance still commits; the run is shared infrastructure.",
  params: ["run_key_id", "run_id", "provider_id", "kind", "payload"],
  text: `
    WITH locked AS (
      SELECT s.search_id
      FROM search s
      JOIN run_subscription sub ON sub.search_id = s.search_id
      WHERE sub.run_key_id = $1::text
        AND sub.state = 'LIVE'
        AND sub.deadline_at > now()
        AND s.status IN ('PENDING_SCHEDULE','RUNNING')
      FOR UPDATE OF s
    ),
    applied AS (
      INSERT INTO run_application (run_id, search_id)
      SELECT $2::text, search_id FROM locked
      ON CONFLICT DO NOTHING
      RETURNING search_id
    ),
    -- every downstream effect is sourced from rows that ACTUALLY transitioned under
    -- current state, never from the eligibility snapshot
    subs AS (
      UPDATE run_subscription SET state = 'SATISFIED'
      WHERE run_key_id = $1::text
        AND search_id IN (SELECT search_id FROM applied) AND state = 'LIVE'
      RETURNING search_id, job_id
    ),
    jobs AS (
      UPDATE search_job j SET state = 'DONE'
      FROM subs
      WHERE j.job_id = subs.job_id AND j.state IN ('PENDING','LEASED')
      RETURNING j.search_id
    ),
    -- Capacity release is FETCH-ONLY. A cold search's pending_cost reservation stands for
    -- future fetch keys; the schedule itself occupies unresolved_schedules, released only
    -- through B6's guarded stage-2 transition.
    cap AS (
      UPDATE provider_admission
      SET pending_cost = pending_cost - (SELECT count(*) FROM subs)
      WHERE provider_id = $3::text AND $4::text = 'SHOWTIME_FETCH'
      RETURNING provider_id
    ),
    res AS (
      UPDATE admission_reservation SET reserved_remaining = reserved_remaining - 1
      WHERE search_id IN (SELECT search_id FROM subs)
        AND reserved_remaining > 0 AND $4::text = 'SHOWTIME_FETCH'
      RETURNING search_id
    ),
    seqs AS (          -- one gapless seq per transitioned subscriber
      UPDATE search SET next_seq = next_seq + 1,
                        agg_requested_rev = agg_requested_rev + 1
      WHERE search_id IN (SELECT search_id FROM subs)
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'FETCH_ACCEPTED', $5::jsonb FROM seqs
    RETURNING search_id, seq`,
});

/* ------------------------------------------ B6 — schedule-resolution application (S36) */

/**
 * S36 search-wide reconciliation helpers.
 * B6_RECONCILE_STAGE2's per-key slot (run_subscription.admission_counted) is removed by
 * migration 013; the new model keeps one provisional 200 and one unresolved slot per
 * search, records a per-subscription filtered count once, and reconciles only when every
 * planned schedule date has reached a terminal outcome (including FAILED zero counts).
 */

export const B6_SET_SCHEDULE_MATCH_COUNT = define({
  boundary: "B6",
  name: "B6_SET_SCHEDULE_MATCH_COUNT",
  zeroRowsMeans: "already recorded — another acceptance won the race; first writer's count stands.",
  params: ["run_key_id", "search_id", "filtered_count"],
  text: `
    UPDATE run_subscription SET schedule_match_count = $3::integer
    WHERE run_key_id = $1::text AND search_id = $2::text AND schedule_match_count IS NULL
    RETURNING search_id`,
});

/**
 * S36 search-wide reconciliation — the B6_RECONCILE_STAGE2 successor.
 * Computes durableAggregate = fresh_match_seed + COALESCE(SUM(schedule_match_count),0)
 * in SQL from durable state, never recomputed from JS. Gates on:
 * - no schedule_match_count IS NULL remains (every planned date terminal, counting
 *   both RESOLVED/EMPTY_RESOLVED and FAILED zero counts),
 * - schedule_reconciled = false and schedule_slot_held = true,
 * - durableAggregate <= 200 and provider headroom (pending_cost + delta <= limit),
 * atomically updates admission_reservation (reserved_total/reserved_remaining,
 * schedule_reconciled), inserts exactly one ADMISSION_RECONCILED with units =
 * durable - 200 (delta from provisional 200, negative for under-fill), and updates
 * provider_admission pending_cost + unresolved. Zero rows means gate closed — caller
 * must invoke B6_DENY_CAPACITY path.
 */
export const B6_RECONCILE_SEARCH_WIDE = define({
  boundary: "B6",
  name: "B6_RECONCILE_SEARCH_WIDE",
  zeroRowsMeans:
    "not all schedule dates terminal, already reconciled, aggregate exceeds 200, " +
    "or provider headroom exceeded — caller must deny via B6_DENY_CAPACITY.",
  params: ["provider_id", "search_id"],
  text: `
    WITH d AS (
      SELECT ar.fresh_match_seed + COALESCE(
        (SELECT SUM(schedule_match_count)::bigint FROM run_subscription
         WHERE search_id = $2::text AND schedule_match_count IS NOT NULL), 0
      ) AS durable,
             ar.reserved_total, ar.reserved_remaining, ar.schedule_reconciled, ar.schedule_slot_held
      FROM admission_reservation ar WHERE ar.search_id = $2::text FOR UPDATE
    ),
    pa_locked AS (
      SELECT provider_id, pending_cost, pending_cost_limit
      FROM provider_admission WHERE provider_id = $1::text FOR UPDATE
    ),
    -- Gate: every schedule subscription for this search must have a match count (null = pending).
    -- Schedule keys are those with kind = 'SCHEDULE_RESOLUTION'; fetch keys have no match count
    -- and are excluded. Fresh-only searches have zero schedule subscriptions, so vacuously terminal.
    gate AS (
      SELECT 1 FROM d, pa_locked
      WHERE d.schedule_reconciled = false
        AND d.schedule_slot_held = true
        AND NOT EXISTS (
          SELECT 1 FROM run_subscription rs
          JOIN run_key rk USING (run_key_id)
          WHERE rs.search_id = $2::text AND rk.kind = 'SCHEDULE_RESOLUTION'
            AND rs.schedule_match_count IS NULL
        )
        AND d.durable <= 200
        AND pa_locked.pending_cost + (d.durable - d.reserved_total) <= pa_locked.pending_cost_limit
    ),
    r_upd AS (
      UPDATE admission_reservation r
      SET reserved_total = (SELECT durable FROM d),
          reserved_remaining = (SELECT durable FROM d) - (r.reserved_total - r.reserved_remaining),
          schedule_reconciled = true
      WHERE r.search_id = $2::text AND EXISTS (SELECT 1 FROM gate)
      RETURNING r.provider_id
    ),
    evt AS (
      INSERT INTO cost_event (event_id, event_type, search_id, units)
      SELECT gen_random_uuid()::text, 'ADMISSION_RECONCILED', $2::text,
             (SELECT durable FROM d) - (SELECT reserved_total FROM d)
      FROM r_upd
      ON CONFLICT (search_id) WHERE event_type = 'ADMISSION_RECONCILED' AND run_key_id IS NULL DO NOTHING
      RETURNING event_id
    )
    UPDATE provider_admission pa
    SET pending_cost = pa.pending_cost + (SELECT durable - reserved_total FROM d),
        unresolved_schedules = pa.unresolved_schedules - 1
    FROM r_upd, d WHERE pa.provider_id = r_upd.provider_id
    RETURNING pa.provider_id, pa.pending_cost, pa.unresolved_schedules`,
});

export const B6_DENY_CAPACITY = define({
  boundary: "B6",
  name: "B6_DENY_CAPACITY",
  zeroRowsMeans: "the denial was already recorded; the first one owns the cause.",
  params: ["search_id"],
  text: `
    UPDATE search
    SET capacity_denied_at = now(),
        agg_requested_rev = agg_requested_rev + 1
    WHERE search_id = $1::text AND capacity_denied_at IS NULL
    RETURNING search_id`,
});

/**
 * Defect 2 remediation (cancel-on-denial). Expansion writes jobs/subscriptions/outbox
 * rows BEFORE this key's B6_RECONCILE_SEARCH_WIDE runs (that ordering is unchanged — ADR 0001
 * §4.4 residual, decided, not reordered). Once B6_DENY_CAPACITY fires, this search's fate
 * is HALTED regardless of any other key it holds (B8_TERMINALIZE checks
 * `capacity_denied_at IS NOT NULL` before any per-key branch), so promptly cancelling its
 * live jobs and subscriptions is not premature — it is cleanup B8 would do anyway, done
 * now instead of leaving real upstream requests in flight for a search already rejected.
 *
 * `B8_CANCEL_JOBS` and `B8_EXPIRE_SUBSCRIPTIONS` are reused as-is (their predicates are
 * "this search's live work", not B8-specific) — see `cancelOrphanedWorkOnDenial` in
 * `src/transactions.ts` for the composed order: cancel jobs → expire subscriptions → void
 * outbox, so a job already re-armed by the sweeper cannot slip back to PENDING under the
 * subscription's now-EXPIRED state.
 *
 * Voiding outbox is the one step B8 does not otherwise need: DELETE, not a state change —
 * `outbox.state` has no CANCELLED value (only PENDING/PUBLISHED), and a row a publisher
 * has not yet read need never exist for the relay to skip it. A row a publisher HAS
 * already claimed is untouched here: the upstream request cannot be un-sent (the accepted
 * residual — see ADR 0001 §4.4). B2_LEASE_JOB's own fence (job no longer PENDING) drops
 * that delivery when it eventually arrives, so no invariant depends on catching it here.
 */
export const B6_VOID_ORPHANED_OUTBOX = define({
  boundary: "B6",
  name: "B6_VOID_ORPHANED_OUTBOX",
  zeroRowsMeans:
    "no unpublished outbox rows for this search's jobs — either none existed yet, a " +
    "publisher already claimed every one (the accepted residual), or a previous denial " +
    "pass already voided them.",
  params: ["search_id"],
  text: `
    DELETE FROM outbox
    WHERE state = 'PENDING'
      AND job_id IN (SELECT job_id FROM search_job WHERE search_id = $1::text)
    RETURNING outbox_id`,
});

export const B6_SUBSCRIPTION_OUTCOME = define({
  boundary: "B6",
  name: "B6_SUBSCRIPTION_OUTCOME",
  zeroRowsMeans: "this subscription already has an outcome; the first one stands.",
  params: ["run_key_id", "search_id", "outcome"],
  text: `
    -- per-subscription outcome: N schedule runs per search each record their own
    UPDATE run_subscription SET schedule_outcome = $3::text
    WHERE run_key_id = $1::text AND search_id = $2::text AND schedule_outcome IS NULL
    RETURNING search_id`,
});

export const B6_SEARCH_RUNNING = define({
  boundary: "B6",
  name: "B6_SEARCH_RUNNING",
  zeroRowsMeans: "the search vanished — impossible under the FK; abort loudly.",
  params: ["search_id", "outcome"],
  text: `
    -- NB: no next_seq / agg_requested_rev increment here. B5's fan-in already allocated a
    -- seq AND inserted its event for this application; bumping next_seq without an
    -- accompanying INSERT burns a sequence number and leaves a gap B10 can never pass.
    UPDATE search
    SET status = CASE WHEN status = 'PENDING_SCHEDULE' AND $2::text = 'RESOLVED'
                      THEN 'RUNNING' ELSE status END
    WHERE search_id = $1::text
    RETURNING status`,
});

/* --------------------------------------------------- B5F — failure acceptance */

export const B5F_FENCE = define({
  boundary: "B5F(a)",
  name: "B5F_FENCE",
  zeroRowsMeans: "ROLLBACK — still retriable, or already terminal.",
  params: ["run_id", "generation", "fail_cause", "max_attempts"],
  text: `
    -- Identities are DERIVED from the fenced row exactly as in B5: a delivery carrying
    -- valid run A / generation A but key B must not cancel B's subscribers (T36).
    UPDATE provider_run pr SET state = 'FAILED', fail_cause = $3::text
    WHERE pr.run_id = $1::text AND pr.generation = $2::integer AND pr.state = 'LEASED'
      AND pr.attempt >= $4::integer
    RETURNING pr.run_key_id`,
});

/**
 * B5F(b)+(c) — failure effects, one statement for the same CTE-scoping reason as B5.
 * The affected set applies the FULL four-condition filter including the subscriber
 * deadline, and every mutation is scoped to that exact set, never to "all live
 * subscriptions for the key".
 */
export const B5F_EFFECTS = define({
  boundary: "B5F(b)+(c)",
  name: "B5F_EFFECTS",
  zeroRowsMeans:
    "no live in-deadline subscriber — the failure strands nobody. Still commit the fence.",
  params: ["run_key_id", "kind", "fail_cause", "provider_id", "payload"],
  text: `
    WITH affected AS (
      UPDATE run_subscription rs
      SET state = 'CANCELLED',
          schedule_outcome = CASE WHEN $2::text = 'SCHEDULE_RESOLUTION'
                                  THEN 'FAILED' ELSE rs.schedule_outcome END
      FROM search s
      WHERE rs.run_key_id = $1::text AND rs.state = 'LIVE'
        AND rs.deadline_at > now()
        AND s.search_id = rs.search_id
        AND s.status IN ('PENDING_SCHEDULE','RUNNING')
      RETURNING rs.search_id, rs.job_id
    ),
    jobs AS (
      UPDATE search_job j SET state = 'FAILED', fail_cause = $3::text
      FROM affected a
      WHERE j.job_id = a.job_id AND j.state IN ('PENDING','LEASED')
      RETURNING j.search_id
    ),
    -- Deviation from ADR 0001 B5F: cap and res are fetch-only here. The ADR releases
    -- unconditionally, which is round-4 finding 3 (schedule applications must not release
    -- fetch capacity) reintroduced on the failure path — a failed schedule run would drop
    -- pending_cost by one per subscriber for capacity that stands for fetch keys it never
    -- created. Round 4 fixed B5 and left B5F, which did not exist yet at round 3.
    cap AS (
      UPDATE provider_admission
      SET pending_cost = pending_cost - (SELECT count(*) FROM affected)
      WHERE provider_id = $4::text AND $2::text = 'SHOWTIME_FETCH'
      RETURNING provider_id
    ),
    res AS (
      UPDATE admission_reservation SET reserved_remaining = reserved_remaining - 1
      WHERE search_id IN (SELECT search_id FROM affected)
        AND reserved_remaining > 0 AND $2::text = 'SHOWTIME_FETCH'
      RETURNING search_id
    ),
    seqs AS (
      UPDATE search SET next_seq = next_seq + 1, agg_requested_rev = agg_requested_rev + 1
      WHERE search_id IN (SELECT search_id FROM affected)
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'FETCH_FAILED', $5::jsonb FROM seqs
    RETURNING search_id, seq`,
});

/* ------ B5 adoption (S61; ADR 0065) ------ */

/**
 * S61 — most recent authoritative snapshot for a showtime key within the caller's
 * cutoff. 0 rows is the normal cache-miss path (caller falls back to
 * `stageFindOrCreateRun`), never a fence loss — read with a plain query or
 * `runRows`-style optional lookup, not `mustWin`.
 */
export const B5_FIND_RECENT_SNAPSHOT = define({
  boundary: "B5(adopt)",
  name: "B5_FIND_RECENT_SNAPSHOT",
  zeroRowsMeans: "no recent snapshot — normal; caller falls back to stageFindOrCreateRun.",
  params: ["run_key_id", "cutoff"],
  text: `
    SELECT o.observation_id, o.run_id, snap.free_count, snap.captured_at
    FROM run_key k
    JOIN observation o ON o.observation_id = k.latest_observation_id
    JOIN availability_snapshot snap ON snap.observation_id = o.observation_id
    WHERE k.run_key_id = $1::text
      AND snap.captured_at >= $2::timestamptz
    ORDER BY snap.captured_at DESC
    LIMIT 1`,
});

/**
 * S61 — idempotent application of an adopted historical run to this search.
 * `ON CONFLICT DO NOTHING` mirrors `B5_FANIN`'s own `applied` CTE: a concurrent
 * pass that already applied this (run_id, search_id) pair yields 0 rows, which is
 * an idempotent no-op — normal, not an error — and the caller still completes the
 * remaining adoption effects for its own job rather than failing closed. Failing
 * closed here would strand the job in LEASED after its fence already passed; the
 * downstream `B5_ADOPT_SHOWTIME_JOB_DONE` fence is the statement that actually
 * decides the race, so this one stays permissive.
 */
export const B5_ADOPT_RUN_APPLICATION = define({
  boundary: "B5(adopt)",
  name: "B5_ADOPT_RUN_APPLICATION",
  zeroRowsMeans: "already applied by a prior pass (idempotent no-op) — normal, not an error.",
  params: ["run_id", "search_id"],
  text: `
    INSERT INTO run_application (run_id, search_id)
    VALUES ($1::text, $2::text)
    ON CONFLICT (run_id, search_id) DO NOTHING
    RETURNING run_id`,
});

/**
 * S61 — `B5_FANIN` mirror for a single adopted subscriber: the fenced job goes
 * LEASED → DONE and its LIVE subscription goes LIVE → SATISFIED. The
 * `state = 'LIVE'` guard on `run_subscription` mirrors `B5_FANIN`'s own guard so
 * an already-satisfied/terminal subscription is never re-transitioned.
 */
export const B5_ADOPT_SHOWTIME_JOB_DONE = define({
  boundary: "B5(adopt)",
  name: "B5_ADOPT_SHOWTIME_JOB_DONE",
  zeroRowsMeans:
    "the job's lease/generation no longer matches (lost the fence) — FENCE_REJECTED. " +
    "This means a losing race on the SAME job that already passed the S60 two-row " +
    "admission fence one statement earlier in the same transaction, so it should be rare.",
  params: ["job_id", "generation", "run_key_id"],
  text: `
    WITH updated_job AS (
      UPDATE search_job
      SET state = 'DONE'
      WHERE job_id = $1::text AND state = 'LEASED' AND generation = $2::integer
      RETURNING search_id
    ),
    updated_sub AS (
      UPDATE run_subscription
      SET state = 'SATISFIED'
      WHERE run_key_id = $3::text
        AND search_id = (SELECT search_id FROM updated_job)
        AND state = 'LIVE'
      RETURNING search_id
    )
    SELECT search_id FROM updated_job`,
});

/**
 * S61 — mirrors `B5_FANIN`'s `res`+`cap` pair for a single adopted subscriber: the
 * search's `admission_reservation.reserved_remaining` is decremented exactly once, and
 * `provider_admission.pending_cost` is released in lockstep (capacity release is
 * FETCH-ONLY, and `stageAdoptOrCreateShowtimeWork` is SHOWTIME_FETCH-only) — otherwise
 * `pending_cost` would never fall on the adopted path and the `admission_conservation`
 * invariant (pending_cost = SUM(reserved_remaining)) would drift by one per adoption.
 * `prior` locks and captures the pre-update value so `cap`'s decrement is conditioned on
 * the SAME "had capacity to release" fact `res` used, never applied twice for one search.
 */
export const B5_ADOPT_RESERVED_REMAINING = define({
  boundary: "B5(adopt)",
  name: "B5_ADOPT_RESERVED_REMAINING",
  zeroRowsMeans:
    "no admission_reservation row for this search — should be impossible once a search " +
    "exists past S15 admission; abort loudly if reached.",
  params: ["search_id"],
  text: `
    WITH prior AS (
      SELECT search_id, provider_id, reserved_remaining AS prior_remaining
      FROM admission_reservation
      WHERE search_id = $1::text
      FOR UPDATE
    ),
    res AS (
      UPDATE admission_reservation r
      SET reserved_remaining = GREATEST(0, prior.prior_remaining - 1)
      FROM prior
      WHERE r.search_id = prior.search_id
      RETURNING r.search_id, prior.provider_id, prior.prior_remaining, r.reserved_remaining
    ),
    cap AS (
      UPDATE provider_admission pa
      SET pending_cost = pending_cost - 1
      FROM res
      WHERE pa.provider_id = res.provider_id AND res.prior_remaining > 0
      RETURNING pa.provider_id
    )
    SELECT search_id, reserved_remaining FROM res`,
});

/**
 * S61 — gapless `FETCH_ACCEPTED` emission for the adopted subscriber. 0 rows means
 * the search left PENDING_SCHEDULE/RUNNING concurrently (cancelled/terminalized):
 * the adoption's other effects already executed in this same transaction, so this
 * is a genuine race the caller must decide how to handle rather than a silent skip.
 */
export const B5_ADOPT_SEARCH_EVENT = define({
  boundary: "B5(adopt)",
  name: "B5_ADOPT_SEARCH_EVENT",
  zeroRowsMeans:
    "the search is no longer PENDING_SCHEDULE/RUNNING (cancelled/terminalized " +
    "concurrently) — the adoption's other effects already executed in this same " +
    "transaction, so this is a genuine race the caller must decide how to handle.",
  params: ["search_id", "payload"],
  text: `
    WITH seqs AS (
      UPDATE search
      SET next_seq = next_seq + 1,
          agg_requested_rev = agg_requested_rev + 1
      WHERE search_id = $1::text AND status IN ('PENDING_SCHEDULE', 'RUNNING')
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'FETCH_ACCEPTED', $2::jsonb
    FROM seqs
    RETURNING search_id, seq`,
});

/* ------------------------------------------------------------ B7 — AGGREGATE claim */

export const B7_CLAIM = define({
  boundary: "B7",
  name: "B7_CLAIM",
  zeroRowsMeans:
    "no work, or another claimant holds the lease. Drop the hint — messages are delivery " +
    "hints, the claim is the ownership mechanism.",
  params: ["search_id", "lease_ttl"],
  text: `
    UPDATE search s
    SET agg_lease_expires = now() + $2::interval, agg_generation = agg_generation + 1
    WHERE s.search_id = $1::text
      AND s.status IN ('PENDING_SCHEDULE','RUNNING')
      AND (s.agg_lease_expires IS NULL OR s.agg_lease_expires < now())
      AND ( s.agg_processed_rev < s.agg_requested_rev      -- new work to aggregate…
            -- …OR the search is terminal-ready. Without these two branches a search whose
            -- aggregation was already caught up can NEVER terminalize: the deadline
            -- passing is not a transaction and bumps no counter (T19).
            OR s.deadline_at <= now()
            -- halt scopes are DERIVED from this search's own work, not caller scalars
            OR EXISTS (SELECT 1
                       FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       JOIN provider_status ps
                         ON ps.provider_id = k.provider_id
                        AND ps.route_class IN ('', k.route_class)
                       WHERE rs.search_id = s.search_id
                         AND ps.state = 'HALTED') )
    RETURNING agg_generation, agg_requested_rev`,
});

export const B7_UPSERT_AGGREGATE = define({
  boundary: "B7",
  name: "B7_UPSERT_AGGREGATE",
  zeroRowsMeans: "a newer revision is already materialized; this pass is stale, discard it.",
  params: ["search_id", "revision", "payload", "evidence"],
  text: `
    INSERT INTO search_aggregate (search_id, revision, payload, evidence)
    VALUES ($1::text, $2::bigint, $3::jsonb, $4::jsonb)
    ON CONFLICT (search_id) DO UPDATE
    SET revision = EXCLUDED.revision,
        payload = EXCLUDED.payload,
        evidence = EXCLUDED.evidence,
        updated_at = now()
    WHERE search_aggregate.revision <= EXCLUDED.revision
    RETURNING search_id`,
});

export const B7_RELEASE = define({
  boundary: "B7",
  name: "B7_RELEASE",
  zeroRowsMeans: "the claim was fenced out mid-pass; the follow-up pass owns it.",
  params: ["search_id", "revision_it_read", "agg_generation"],
  text: `
    UPDATE search SET agg_processed_rev = $2::bigint, agg_lease_expires = NULL
    WHERE search_id = $1::text AND agg_generation = $3::integer
    RETURNING search_id`,
});

export const B7_GROUP_EVENT = define({
  boundary: "B7",
  name: "B7_GROUP_EVENT",
  zeroRowsMeans:
    "the search terminalized or vanished mid-pass — the pass is stale, ROLLBACK (the " +
    "companion B7_UPSERT_AGGREGATE/B8 guard fails identically).",
  params: ["search_id", "payload"],
  text: `
    -- Gapless seq allocation (the B5F_EFFECTS/B8 shape), bumping ONLY next_seq: the event
    -- is an effect of this pass, and the fact-producing rev bumps live in the writers of
    -- new data (B5_FANIN/B5_CAPACITY/B5F_EFFECTS). Bumping agg_requested_rev here would
    -- make every pass re-trigger itself forever.
    WITH seqs AS (
      UPDATE search SET next_seq = next_seq + 1
      WHERE search_id = $1::text AND status IN ('PENDING_SCHEDULE','RUNNING')
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'group', $2::jsonb FROM seqs
    RETURNING search_id, seq`,
});

export const B7_SKELETON_EVENT = define({
  boundary: "B7",
  name: "B7_SKELETON_EVENT",
  zeroRowsMeans:
    "the search terminalized or vanished mid-pass — the pass is stale, ROLLBACK (the " +
    "companion B7_UPSERT_AGGREGATE/B8 guard fails identically).",
  params: ["search_id", "payload"],
  text: `
    -- Gapless seq allocation mirroring B7_GROUP_EVENT: the skeleton is an effect of
    -- this pass (S46.5 creation-time emission and S46.6 resolved flips), bumping ONLY
    -- next_seq. Shares the same guard and debounce cadence as group events — no second
    -- timer, same transaction, same ordering discipline.
    WITH seqs AS (
      UPDATE search SET next_seq = next_seq + 1
      WHERE search_id = $1::text AND status IN ('PENDING_SCHEDULE','RUNNING')
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'skeleton', $2::jsonb FROM seqs
    RETURNING search_id, seq`,
});

/* ------------------------------------------------------------ B8 — terminalization */

export const B8_TERMINALIZE = define({
  boundary: "B8",
  name: "B8_TERMINALIZE",
  zeroRowsMeans:
    "another actor terminalized first, the guard is not met, OR a new aggregation request " +
    "landed mid-computation. ROLLBACK; agg_processed_rev < agg_requested_rev still holds, " +
    "so B7 runs a follow-up pass that recomputes against the newer revision.",
  params: ["search_id", "agg_generation", "rev_used_for_payload"],
  text: `
    UPDATE search s
    SET status = CASE
          -- derived from persisted facts, NOT supplied by the caller, so ADR 0003's
          -- answer matrix is structurally enforceable rather than merely documented
          WHEN EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       JOIN provider_status ps
                         ON ps.provider_id = k.provider_id
                        AND ps.route_class IN ('', k.route_class)
                       WHERE rs.search_id = s.search_id
                         AND ps.state = 'HALTED')                        THEN 'HALTED'
          WHEN s.capacity_denied_at IS NOT NULL                          THEN 'HALTED'
          -- every schedule subscription FAILED. Requires at least one to exist: the warm
          -- path creates none, so a bare NOT EXISTS is vacuously true and would derive
          -- HALTED for every warm search (T21). S36: preserve fresh coverage — a mixed
          -- search with fresh_match_seed >0 has usable SHOWTIME_FETCH work even if every
          -- cold date is FAILED; derive PARTIAL/COMPLETE via the fetch branch instead.
          WHEN EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION')
           AND NOT EXISTS (SELECT 1 FROM run_subscription rs
                           JOIN run_key k USING (run_key_id)
                           WHERE rs.search_id = $1::text
                             AND k.kind = 'SCHEDULE_RESOLUTION'
                             AND (rs.schedule_outcome IS DISTINCT FROM 'FAILED'))
           AND COALESCE((SELECT fresh_match_seed FROM admission_reservation WHERE search_id = $1::text), 0) = 0
                                                                         THEN 'HALTED'
          -- At least one failed schedule key plus at least one key that did not fail is
          -- partial coverage. Falling through to COMPLETE would claim knowledge of the
          -- failed theatre-date; a deadline may make the other outcome NULL, so use
          -- IS DISTINCT FROM rather than naming only the two successful outcomes.
          WHEN EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                         AND rs.schedule_outcome = 'FAILED')
           AND EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                         AND rs.schedule_outcome IS DISTINCT FROM 'FAILED')
                                                                         THEN 'PARTIAL'
          -- Deadline expiry with unfinished work is PARTIAL (ADR 0003 A9), tested BEFORE
          -- the zero-observation branch — otherwise a search that ran out of time with
          -- nothing back derives HALTED, claiming a failure that did not occur (T29).
          WHEN EXISTS (SELECT 1 FROM search_job j
                       WHERE j.search_id = $1::text
                         AND j.state IN ('PENDING','LEASED'))            THEN 'PARTIAL'
          -- Below here all fetch work is terminal, so HALTED means genuinely exhausted.
          -- Zero accepted FETCH observations *belonging to this search*: counting via
          -- run_application scopes it correctly; joining observation through run_key
          -- would also count the schedule observation and historical observations from
          -- earlier runs on the same permanent key (ADR 0003 A12).
          WHEN EXISTS (SELECT 1 FROM search_job j
                       WHERE j.search_id = $1::text AND j.kind = 'SHOWTIME_FETCH')
           AND NOT EXISTS (SELECT 1 FROM run_application ra
                           JOIN provider_run pr ON pr.run_id = ra.run_id
                           JOIN run_key k ON k.run_key_id = pr.run_key_id
                           WHERE ra.search_id = $1::text
                             AND k.kind = 'SHOWTIME_FETCH')              THEN 'HALTED'
          -- explicit all-fetches-failed branch (A12), not a fallthrough
          WHEN EXISTS (SELECT 1 FROM search_job j
                       WHERE j.search_id = $1::text AND j.kind = 'SHOWTIME_FETCH')
           AND NOT EXISTS (SELECT 1 FROM search_job j
                           WHERE j.search_id = $1::text AND j.kind = 'SHOWTIME_FETCH'
                             AND j.state <> 'FAILED')                    THEN 'HALTED'
          WHEN s.batch_deferred_count > 0                                       THEN 'PARTIAL'
          ELSE 'COMPLETE'
        END,
        -- cause is derived by the same discipline as status; accepting it from the caller
        -- would reintroduce exactly the hole this CASE chain closes
        terminal_cause = CASE
          WHEN s.capacity_denied_at IS NOT NULL THEN 'CAPACITY'
          WHEN EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       JOIN provider_status ps
                         ON ps.provider_id = k.provider_id
                        AND ps.route_class IN ('', k.route_class)
                       WHERE rs.search_id = s.search_id
                         AND ps.state = 'HALTED')                    THEN 'PROVIDER_HALTED'
          -- TOO_FEW_SHOWTIMES is universal, not existential: every schedule key must
          -- have resolved empty. One RESOLVED, FAILED, or still-NULL key means the search
          -- does not have complete evidence that there were no showtimes.
          -- S36: fresh work defeats TOO_FEW — a mixed search with usable fresh fetches
          -- is not empty even if every cold date is EMPTY_RESOLVED.
          WHEN COALESCE((SELECT fresh_match_seed FROM admission_reservation WHERE search_id = $1::text), 0) = 0
           AND EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                         AND rs.schedule_outcome = 'EMPTY_RESOLVED')
           AND NOT EXISTS (SELECT 1 FROM run_subscription rs
                           JOIN run_key k USING (run_key_id)
                           WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                             AND rs.schedule_outcome
                                   IS DISTINCT FROM 'EMPTY_RESOLVED') THEN 'TOO_FEW_SHOWTIMES'
          WHEN EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                         AND rs.schedule_outcome = 'FAILED')
           AND EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       WHERE rs.search_id = $1::text AND k.kind = 'SCHEDULE_RESOLUTION'
                         AND rs.schedule_outcome IS DISTINCT FROM 'FAILED')
                                                                    THEN 'PARTIAL_SCHEDULE'
          WHEN s.batch_deferred_count > 0                                       THEN 'BATCH_DEFERRED'
          ELSE NULL   -- COMPLETE/PARTIAL carry their cause in the answer, not here
        END,
        terminalized_at = now(),
        next_seq = next_seq + 1
    WHERE s.search_id = $1::text
      AND s.status IN ('PENDING_SCHEDULE','RUNNING')
      -- STALE-AGGREGATE FENCE: this terminalization may only publish a payload computed
      -- from the exact revision it claimed (T9b).
      AND s.agg_generation = $2::integer
      AND s.agg_requested_rev = $3::bigint
      AND ( -- guard: every schedule subscription terminal (via schedule_match_count, not just
            -- schedule_outcome, so a FAILED date that wrote its zero count counts as terminal)
            -- and all fetch jobs terminal. Fresh-only has zero schedule rows, vacuously terminal.
            -- (Vacuously true on the warm path, which is correct there.)
            ( NOT EXISTS (SELECT 1 FROM run_subscription rs
                          JOIN run_key k USING (run_key_id)
                          WHERE rs.search_id = $1::text
                            AND k.kind = 'SCHEDULE_RESOLUTION'
                            AND rs.schedule_match_count IS NULL)
              AND NOT EXISTS (SELECT 1 FROM search_job j
                              WHERE j.search_id = $1::text AND j.kind = 'SHOWTIME_FETCH'
                                AND j.state IN ('PENDING','LEASED')) )
            -- …or this search's provider is halted (PAUSED does not terminalize)
            OR EXISTS (SELECT 1 FROM run_subscription rs
                       JOIN run_key k USING (run_key_id)
                       JOIN provider_status ps
                         ON ps.provider_id = k.provider_id
                        AND ps.route_class IN ('', k.route_class)
                       WHERE rs.search_id = s.search_id
                         AND ps.state = 'HALTED')
            OR s.capacity_denied_at IS NOT NULL   -- …or stage-2 admission denied
            OR s.deadline_at <= now() )           -- …or deadline passed → PARTIAL
    RETURNING next_seq, status, terminal_cause`,
});

/**
 * S23.3 / ADR 0018 — the CANCELLED transition. A single fenced UPDATE moves a live
 * search to the new terminal status and allocates the `next_seq` the terminal event
 * publishes. Unlike B8_TERMINALIZE there is no guard: an explicit user cancel may stop a
 * search with unfinished work by design (S23.3 step (1) — cancel is always legal while
 * the search is not already terminal).
 */
export const B8_CANCEL_SEARCH = define({
  boundary: "B8",
  name: "B8_CANCEL_SEARCH",
  zeroRowsMeans:
    "already terminal (not PENDING_SCHEDULE/RUNNING) — the cancel is an idempotent no-op; " +
    "the caller re-reads and echoes the search's existing terminal status.",
  params: ["search_id"],
  text: `
    UPDATE search
    SET status = 'CANCELLED', terminal_cause = NULL, terminalized_at = now(),
        next_seq = next_seq + 1
    WHERE search_id = $1::text AND status IN ('PENDING_SCHEDULE','RUNNING')
    RETURNING next_seq`,
});

export const B8_RESULT_VERSION = define({
  boundary: "B8",
  name: "B8_RESULT_VERSION",
  zeroRowsMeans: "unreachable — a terminal status without a result version is the gate 9 bug.",
  params: ["search_id", "payload"],
  text: `
    INSERT INTO search_result_version (search_id, version, payload)
    SELECT $1::text, coalesce(max(version), 0) + 1, $2::jsonb
    FROM search_result_version WHERE search_id = $1::text
    RETURNING version`,
});

export const B8_CANCEL_JOBS = define({
  boundary: "B8",
  name: "B8_CANCEL_JOBS",
  zeroRowsMeans: "no live children — normal on a fully-satisfied search.",
  params: ["search_id"],
  text: `
    UPDATE search_job SET state = 'CANCELLED', generation = generation + 1
    WHERE search_id = $1::text AND state IN ('PENDING','LEASED')
    RETURNING job_id`,
});

export const B8_EXPIRE_SUBSCRIPTIONS = define({
  boundary: "B8",
  name: "B8_EXPIRE_SUBSCRIPTIONS",
  zeroRowsMeans: "no live subscriptions — normal on a fully-satisfied search.",
  params: ["search_id"],
  text: `
    UPDATE run_subscription SET state = 'EXPIRED'
    WHERE search_id = $1::text AND state = 'LIVE'
    RETURNING run_key_id`,
});

export const B8_RELEASE_ADMISSION = define({
  boundary: "B8",
  name: "B8_RELEASE_ADMISSION",
  zeroRowsMeans: "already released, or the search never reserved (warm path with no cost).",
  params: ["search_id"],
  text: `
    -- release exactly the outstanding remainder — never the total, which satisfaction has
    -- already been drawing down
    -- S36: unresolved_schedules counts held search reservations (schedule_slot_held AND NOT
    -- schedule_reconciled AND NOT released), not per-key run_subscription.admission_counted
    -- (migrated in 013). Pending cost still drains reserved_remaining.
    UPDATE provider_admission pa
    SET pending_cost = pending_cost - r.reserved_remaining,
        unresolved_schedules = unresolved_schedules
          - CASE WHEN r.schedule_slot_held AND NOT r.schedule_reconciled THEN 1 ELSE 0 END
    FROM admission_reservation r
    WHERE pa.provider_id = r.provider_id AND r.search_id = $1::text AND NOT r.released
    RETURNING pa.provider_id, pa.pending_cost, pa.unresolved_schedules`,
});

export const B8_CLEAR_SCHEDULE_SLOTS = define({
  boundary: "B8",
  name: "B8_CLEAR_SCHEDULE_SLOTS",
  zeroRowsMeans: "no outstanding schedule slots — B6 already reconciled every key.",
  params: ["search_id"],
  text: `
    -- S36: slots are search-level (admission_reservation.schedule_slot_held /
    -- schedule_reconciled), not per-key admission_counted. This statement is retained
    -- for transaction order parity (stageTerminalization's release→clear→mark order is
    -- load-bearing); the actual slot clear happens atomically with the released
    -- transition in B8_MARK_RESERVATION_RELEASED so no released row holds a slot
    -- (search_window_accounting held_on_released). Keep a harmless update that
    -- touches the reservation row to preserve the named boundary while the one-time
    -- unresolved_schedules decrement remains in B8_RELEASE_ADMISSION.
    UPDATE admission_reservation SET schedule_slot_held = schedule_slot_held
    WHERE search_id = $1::text AND schedule_slot_held AND NOT schedule_reconciled
    RETURNING search_id`,
});

export const B8_MARK_RESERVATION_RELEASED = define({
  boundary: "B8",
  name: "B8_MARK_RESERVATION_RELEASED",
  zeroRowsMeans: "already released; releasing twice is the double-release bug.",
  params: ["search_id"],
  text: `
    -- S36: clear the search-wide slot atomically with the released transition so no
    -- released row ever holds a slot (search_window_accounting held_on_released).
    -- The one-time unresolved_schedules decrement already happened in
    -- B8_RELEASE_ADMISSION (CASE on schedule_slot_held AND NOT schedule_reconciled
    -- WHERE NOT released), so this statement preserves counts and only clears the flag.
    UPDATE admission_reservation
    SET reserved_remaining = 0, released = true, schedule_slot_held = false
    WHERE search_id = $1::text AND NOT released
    RETURNING search_id`,
});

export const B8_TERMINAL_EVENT = define({
  boundary: "B8",
  name: "B8_TERMINAL_EVENT",
  zeroRowsMeans: "unreachable — the seq was allocated by B8_TERMINALIZE in this transaction.",
  params: ["search_id", "seq", "type", "payload"],
  text: `
    -- inserted at the seq B8_TERMINALIZE just allocated; no separate terminal-event
    -- mechanism exists
    INSERT INTO search_event (search_id, seq, type, payload)
    VALUES ($1::text, $2::bigint, $3::text, $4::jsonb)
    RETURNING seq`,
});

export const B8_CANCEL_ORPHANED_RUNS = define({
  boundary: "B8",
  name: "B8_CANCEL_ORPHANED_RUNS",
  zeroRowsMeans: "every run this search touched still has another live subscriber — correct.",
  params: ["search_id"],
  text: `
    -- Runs of EITHER kind are cancelled only when their live-subscription count reaches
    -- zero (checked AFTER B8_EXPIRE_SUBSCRIPTIONS): runs are shared infrastructure, and a
    -- terminalizing search must never cancel a run another search is waiting on (T17).
    UPDATE provider_run pr SET state = 'CANCELLED', generation = generation + 1
    WHERE pr.run_key_id IN (SELECT rs.run_key_id FROM run_subscription rs
                            WHERE rs.search_id = $1::text)
      AND pr.state IN ('PENDING','LEASED')
      AND NOT EXISTS (SELECT 1 FROM run_subscription live
                      WHERE live.run_key_id = pr.run_key_id AND live.state = 'LIVE')
    RETURNING pr.run_id`,
});

/* --------------------------------------------------------- B9 — halt-epoch raise */

export const B9_BUMP_FENCE = define({
  boundary: "B9",
  name: "B9_BUMP_FENCE",
  zeroRowsMeans: "no fence row for this provider — seed it; a provider with no fence is unfenced.",
  params: ["provider_id"],
  text: `
    -- the fence is provider-wide and bumps on ANY scoped transition, so a route-class halt
    -- cannot be masked by an equal provider-wide epoch (T12b)
    UPDATE provider_fence SET epoch = epoch + 1 WHERE provider_id = $1::text
    RETURNING epoch`,
});

export const B9_UPSERT_STATUS = define({
  boundary: "B9",
  name: "B9_UPSERT_STATUS",
  zeroRowsMeans: "unreachable — this is an upsert.",
  params: ["provider_id", "route_class", "state", "cause", "not_before"],
  text: `
    -- UPSERT, not UPDATE: the schema permits a scope with no row yet, and a bare UPDATE
    -- would advance the fence while changing zero status rows, after which B4 sees no halt
    -- and cheerfully dispatches into a blocked provider (T38).
    INSERT INTO provider_status (provider_id, route_class, state, cause, not_before, changed_at)
    VALUES ($1::text, $2::text, $3::text, $4::text, $5::timestamptz, now())
    ON CONFLICT (provider_id, route_class) DO UPDATE
    SET state = EXCLUDED.state, cause = EXCLUDED.cause,
        not_before = EXCLUDED.not_before, changed_at = EXCLUDED.changed_at
    RETURNING provider_id, route_class, state`,
});

export const B9_FENCE_JOBS = define({
  boundary: "B9",
  name: "B9_FENCE_JOBS",
  zeroRowsMeans: "no leased jobs for this provider — nothing to fence.",
  params: ["provider_id"],
  text: `
    UPDATE search_job SET generation = generation + 1
    WHERE state = 'LEASED'
      AND run_key_id IN (SELECT run_key_id FROM run_key WHERE provider_id = $1::text)
    RETURNING job_id`,
});

export const B9_FENCE_RUNS = define({
  boundary: "B9",
  name: "B9_FENCE_RUNS",
  zeroRowsMeans: "no leased runs for this provider — nothing to fence.",
  params: ["provider_id"],
  text: `
    -- one predicate fences BOTH run kinds — schedule and fetch alike
    UPDATE provider_run SET generation = generation + 1
    WHERE state = 'LEASED'
      AND run_key_id IN (SELECT run_key_id FROM run_key WHERE provider_id = $1::text)
    RETURNING run_id`,
});

export const B9_REQUEST_AGGREGATION = define({
  boundary: "B9",
  name: "B9_REQUEST_AGGREGATION",
  zeroRowsMeans: "no live search touches this provider.",
  params: ["provider_id"],
  text: `
    -- A halt must also make affected searches CLAIMABLE by B7. Bumping the counter here
    -- means the follow-up pass is scheduled by the transaction that caused it.
    UPDATE search SET agg_requested_rev = agg_requested_rev + 1
    WHERE status IN ('PENDING_SCHEDULE','RUNNING')
      AND search_id IN (SELECT rs.search_id FROM run_subscription rs
                        JOIN run_key k USING (run_key_id)
                        WHERE k.provider_id = $1::text AND rs.state = 'LIVE')
    RETURNING search_id`,
});

export const B9_REOPEN_SCOPE = define({
  boundary: "B9(reopen)",
  name: "B9_REOPEN_SCOPE",
  zeroRowsMeans:
    "no such scoped provider_status row exists — the operator asked to reopen a scope that " +
    "was never persisted. The reopen never creates a scope, so nothing to reopen.",
  params: ["provider_id", "route_class"],
  text: `
    -- Manual reopen only (ADR 0001 B9, amended): sets exactly the named existing scope to
    -- OPEN and clears cause/deadline. It cannot create a scope, and nothing in this package
    -- runs it automatically for block, challenge, queue, or legal-kill-switch causes. An
    -- unscoped halt still governs every route beneath it: B4/B5(b) read the '' row too, so
    -- reopening one route can never weaken the global stop (T44).
    UPDATE provider_status
    SET state = 'OPEN', cause = NULL, not_before = NULL
    WHERE provider_id = $1::text AND route_class = $2::text
    RETURNING provider_id, route_class, state`,
});

/* ------------------------------------------------------------- B10 — projection */

export const B10_ADVANCE_EVENT_WATERMARK = define({
  boundary: "B10",
  name: "B10_ADVANCE_EVENT_WATERMARK",
  zeroRowsMeans:
    "the watermark is not at seq-1: another projector advanced it, or an interior event is " +
    "missing. Contiguity is the point — re-read before writing.",
  params: ["search_id", "seq"],
  text: `
    UPDATE search SET projected_through = $2::bigint
    WHERE search_id = $1::text AND projected_through = $2::bigint - 1
    RETURNING projected_through`,
});

export const B10_UNPROJECTED_EVENTS = define({
  boundary: "B10",
  name: "B10_UNPROJECTED_EVENTS",
  zeroRowsMeans: "the stream is caught up.",
  params: ["search_id"],
  text: `
    SELECT e.seq, e.type, e.payload
    FROM search_event e
    JOIN search s ON s.search_id = e.search_id
    WHERE e.search_id = $1::text AND e.seq > s.projected_through
    ORDER BY e.seq`,
});

export const B10_RESET_EVENT_WATERMARK = define({
  boundary: "B10",
  name: "B10_RESET_EVENT_WATERMARK",
  zeroRowsMeans: "no nonterminal searches — nothing to rebuild.",
  params: [],
  text: `
    -- On detected stream loss. Only nonterminal searches need this: a terminal search's
    -- clients read searches.get, which serves the immutable SearchResultVersion (T18b).
    UPDATE search SET projected_through = 0
    WHERE status IN ('PENDING_SCHEDULE','RUNNING')
    RETURNING search_id`,
});

export const B10_RESET_EVENT_WATERMARK_FOR_SEARCH = define({
  boundary: "B10",
  name: "B10_RESET_EVENT_WATERMARK_FOR_SEARCH",
  zeroRowsMeans: "the target search is terminal or absent; its live stream is not rebuildable.",
  params: ["search_id"],
  text: `
    -- Interior-gap repair is per search. The global reset above is reserved for detected
    -- full Redis loss; using it here corrupts unrelated searches' projection work.
    UPDATE search SET projected_through = 0
    WHERE search_id = $1::text AND status IN ('PENDING_SCHEDULE','RUNNING')
    RETURNING search_id`,
});

export const B10_READ_EVENT_WATERMARK = define({
  boundary: "B10",
  name: "B10_READ_EVENT_WATERMARK",
  zeroRowsMeans: "the search vanished — impossible while its event row is being projected.",
  params: ["search_id"],
  text: `
    -- Used after a conditional advance loses: >= the attempted seq means another
    -- projector won, while a lower value is a genuine contiguity failure.
    SELECT projected_through FROM search WHERE search_id = $1::text`,
});

export const B10_CLAIM_SNAPSHOT_PROJECTION = define({
  boundary: "B10",
  name: "B10_CLAIM_SNAPSHOT_PROJECTION",
  zeroRowsMeans: "every key is projected.",
  params: [],
  text: `
    -- projected_revision < accepted_revision IS the pending-projection queue: a durable
    -- work record discoverable by scan, with none of a per-revision outbox's amplification
    SELECT run_key_id, accepted_revision, latest_observation_id
    FROM run_key WHERE projected_revision < accepted_revision`,
});

export const B10_ADVANCE_SNAPSHOT_WATERMARK = define({
  boundary: "B10",
  name: "B10_ADVANCE_SNAPSHOT_WATERMARK",
  zeroRowsMeans: "a newer projector already advanced past this revision; correct, do nothing.",
  params: ["run_key_id", "revision_it_read"],
  text: `
    UPDATE run_key SET projected_revision = $2::bigint
    WHERE run_key_id = $1::text AND projected_revision < $2::bigint
    RETURNING projected_revision`,
});

/**
 * The projection source for one claimed `(run_key, observation)` (S33.3). Resolves the
 * key's `kind` here — the claim carries no kind (`B10_CLAIM_SNAPSHOT_PROJECTION` returns
 * only `run_key_id, accepted_revision, latest_observation_id`) — and reads the accepted
 * payload for whichever shape that kind owns: the `availability_snapshot` for
 * SHOWTIME_FETCH and the resolved `performance` rows for SCHEDULE_RESOLUTION. One
 * LEFT JOIN per shape; an observation belongs to exactly one shape, so the joins never
 * cross-multiply. Reading either shape is harmless — the caller decides what it is
 * authorized to serialize (S33.7 writes only SHOWTIME_FETCH).
 */
export const SNAPSHOT_READ_FOR_PROJECTION = define({
  boundary: "B10",
  name: "SNAPSHOT_READ_FOR_PROJECTION",
  zeroRowsMeans: "the run_key vanished — impossible while its projection is being claimed.",
  params: ["run_key_id", "observation_id"],
  text: `
    SELECT rk.kind,
           a.showtime_id AS showtime_id,
           a.bitmap      AS bitmap,
           a.free_count  AS free_count,
           a.captured_at AS captured_at,
           p.showtime_id AS performance_showtime_id,
           p.provider_id AS performance_provider_id,
           p.theatre_id  AS performance_theatre_id,
           p.local_date  AS performance_local_date,
           p.starts_at   AS performance_starts_at,
           p.attributes  AS performance_attributes
    FROM run_key rk
    LEFT JOIN availability_snapshot a ON a.observation_id = $2::text
    LEFT JOIN performance p ON p.observation_id = $2::text
    WHERE rk.run_key_id = $1::text`,
});

/* ----------------------------------------------------------------- sweeper (§5) */

export const SWEEP_OVERDUE_OUTBOX = define({
  boundary: "sweeper(1)",
  name: "SWEEP_OVERDUE_OUTBOX",
  zeroRowsMeans: "the outbox is drained.",
  params: ["batch"],
  text: `
    SELECT o.outbox_id, o.target_kind, o.job_id, o.run_id, o.tmdb_fetch_id, o.traceparent
    FROM outbox o
    LEFT JOIN provider_run pr ON pr.run_id = o.run_id
    WHERE o.state = 'PENDING' AND o.next_attempt_at <= now()
    ORDER BY COALESCE(pr.priority, 0) DESC, COALESCE(pr.dispatch_rank, 32767) ASC, o.created_at
    LIMIT $1::integer`,
});

export const SWEEP_REARM_JOBS = define({
  boundary: "sweeper(2)",
  name: "SWEEP_REARM_JOBS",
  zeroRowsMeans: "no stranded jobs.",
  params: ["age"],
  text: `
    -- re-arm aged PENDING jobs REGARDLESS of outbox state, excluding jobs whose parent
    -- search is terminal (re-arm is for stranded live work, not resurrection)
    -- A sweeper-originated delivery has no HTTP origin, so traceparent is NULL explicitly —
    -- copying the original row's traceparent would graft this retry onto a stale trace (ADR 0031).
    INSERT INTO outbox (outbox_id, target_kind, job_id, traceparent)
    SELECT gen_random_uuid()::text, 'JOB', j.job_id, NULL
    FROM search_job j JOIN search s ON s.search_id = j.search_id
    WHERE j.state = 'PENDING'
      AND j.created_at < now() - $1::interval
      AND s.status IN ('PENDING_SCHEDULE','RUNNING')
    RETURNING outbox_id`,
});

export const SWEEP_REARM_RUNS = define({
  boundary: "sweeper(2)",
  name: "SWEEP_REARM_RUNS",
  zeroRowsMeans: "no stranded runs.",
  params: ["age"],
  text: `
    -- ADR 0001 §5 duty 6: duties 2–3 apply verbatim to both run kinds. The same shape as
    -- SWEEP_REARM_JOBS above, targeting provider_run with target_kind = 'RUN': re-arm aged
    -- PENDING runs REGARDLESS of outbox state. A run is shared infrastructure, so "parent
    -- search is live" means at least one LIVE subscription whose search is nonterminal —
    -- the mirror of B8_CANCEL_ORPHANED_RUNS's orphan test, never resurrection of a
    -- terminal search's stranded run.
    -- ADR 0039 Amendment A1: a SCHEDULE_RESOLUTION key with NO subscription of any kind is
    -- a capacity-preview run (search-created keys always have >=1 subscription from
    -- JOB/SUBSCRIPTION_CREATE). It has no parent search whose liveness could gate re-arm,
    -- so it re-arms on age alone; scoping to SCHEDULE_RESOLUTION keeps an expired-
    -- subscription SHOWTIME_FETCH run from ever being resurrected.
    INSERT INTO outbox (outbox_id, target_kind, run_id, traceparent)
    SELECT gen_random_uuid()::text, 'RUN', r.run_id, NULL
    FROM provider_run r JOIN run_key k ON k.run_key_id = r.run_key_id
    WHERE r.state = 'PENDING'
      AND r.created_at < now() - $1::interval
      AND (
        EXISTS (
          SELECT 1 FROM run_subscription rs JOIN search s ON s.search_id = rs.search_id
          WHERE rs.run_key_id = r.run_key_id AND rs.state = 'LIVE'
            AND s.status IN ('PENDING_SCHEDULE','RUNNING')
        )
        OR (k.kind = 'SCHEDULE_RESOLUTION'
            AND NOT EXISTS (SELECT 1 FROM run_subscription rs2
                            WHERE rs2.run_key_id = r.run_key_id))
      )
    RETURNING outbox_id`,
});

export const SWEEP_RECLAIM_JOBS = define({
  boundary: "sweeper(3)",
  name: "SWEEP_RECLAIM_JOBS",
  zeroRowsMeans: "no expired leases still under their attempt budget.",
  params: ["max_attempts"],
  text: `
    -- back to PENDING with a fresh outbox record, NOT left LEASED with a bumped
    -- generation: that fences the old holder but assigns the new generation to nobody,
    -- and the sweeper repeats forever (T37)
    -- Attempts exhausted is NOT handled here, same as the run side: it fails just this
    -- job's own subscription (SWEEP_DISCOVER_EXHAUSTED_JOBS / SWEEP_FAIL_EXHAUSTED_JOB /
    -- SWEEP_JOB_FAIL_EFFECTS below), never left LEASED.
    WITH reclaimed AS (
      UPDATE search_job SET state = 'PENDING', generation = generation + 1,
                            lease_expires_at = NULL
      WHERE state = 'LEASED' AND lease_expires_at < now()
        AND attempt < $1::integer
      RETURNING job_id
    )
    INSERT INTO outbox (outbox_id, target_kind, job_id, traceparent)
    SELECT gen_random_uuid()::text, 'JOB', job_id, NULL FROM reclaimed
    RETURNING outbox_id`,
});

/**
 * Job-side counterpart of `SWEEP_DISCOVER_EXHAUSTED_RUNS`. A `search_job` row is this
 * ONE search's own subscription record — unlike a run, it has no other subscribers, so its
 * exhaustion never needs the run-wide B5F fan-out; it needs exactly this subscription
 * failed. Discovery, fence, and effects are split into three statements (mirroring the
 * run path's SWEEP_DISCOVER_EXHAUSTED_RUNS / B5F_FENCE / B5F_EFFECTS split) so each is
 * independently re-checkable and no row is acted on twice.
 */
export const SWEEP_DISCOVER_EXHAUSTED_JOBS = define({
  boundary: "sweeper(3)",
  name: "SWEEP_DISCOVER_EXHAUSTED_JOBS",
  zeroRowsMeans: "no attempts-exhausted expired-lease jobs — nothing stranded.",
  params: ["max_attempts"],
  text: `
    SELECT job_id FROM search_job
    WHERE state = 'LEASED' AND lease_expires_at < now() AND attempt >= $1::integer`,
});

export const SWEEP_FAIL_EXHAUSTED_JOB = define({
  boundary: "sweeper(3)+B5F(job)",
  name: "SWEEP_FAIL_EXHAUSTED_JOB",
  zeroRowsMeans:
    "not LEASED-with-expired-lease-and-exhausted-attempts any more — the lease was renewed " +
    "or another actor already reclaimed/failed it. Skip; the next sweep reconsiders it.",
  params: ["job_id", "max_attempts", "fail_cause"],
  text: `
    UPDATE search_job j SET state = 'FAILED', fail_cause = $3::text
    WHERE j.job_id = $1::text AND j.state = 'LEASED' AND j.lease_expires_at < now()
      AND j.attempt >= $2::integer
    RETURNING j.search_id, j.run_key_id`,
});

/**
 * B5F(b)+(c) scoped to ONE subscription instead of the run-wide `affected` set: the same
 * shape as `B5F_EFFECTS` (subscription cancel → job already FAILED by the fence above →
 * fetch-only capacity release → gapless event), restricted to `$2::search_id`'s own row
 * rather than every live subscriber of `$1::run_key_id`.
 */
export const SWEEP_JOB_FAIL_EFFECTS = define({
  boundary: "sweeper(3)+B5F(job)",
  name: "SWEEP_JOB_FAIL_EFFECTS",
  zeroRowsMeans:
    "the subscription was already terminal or past its own deadline, or its search is " +
    "already terminal — the job failing strands nobody. The job's FAILED state still commits.",
  // NB: no fail_cause parameter — SWEEP_FAIL_EXHAUSTED_JOB already wrote it onto search_job
  // in the fence step; this statement never touches search_job again.
  params: ["run_key_id", "search_id", "kind", "provider_id", "payload"],
  text: `
    WITH affected AS (
      UPDATE run_subscription rs
      SET state = 'CANCELLED',
          schedule_outcome = CASE WHEN $3::text = 'SCHEDULE_RESOLUTION'
                                  THEN 'FAILED' ELSE rs.schedule_outcome END
      FROM search s
      WHERE rs.run_key_id = $1::text AND rs.search_id = $2::text AND rs.state = 'LIVE'
        AND rs.deadline_at > now()
        AND s.search_id = rs.search_id
        AND s.status IN ('PENDING_SCHEDULE','RUNNING')
      RETURNING rs.search_id
    ),
    cap AS (
      UPDATE provider_admission
      SET pending_cost = pending_cost - (SELECT count(*) FROM affected)
      WHERE provider_id = $4::text AND $3::text = 'SHOWTIME_FETCH'
      RETURNING provider_id
    ),
    res AS (
      UPDATE admission_reservation SET reserved_remaining = reserved_remaining - 1
      WHERE search_id IN (SELECT search_id FROM affected)
        AND reserved_remaining > 0 AND $3::text = 'SHOWTIME_FETCH'
      RETURNING search_id
    ),
    seqs AS (
      UPDATE search SET next_seq = next_seq + 1, agg_requested_rev = agg_requested_rev + 1
      WHERE search_id IN (SELECT search_id FROM affected)
      RETURNING search_id, next_seq AS seq
    )
    INSERT INTO search_event (search_id, seq, type, payload)
    SELECT search_id, seq, 'FETCH_FAILED', $5::jsonb FROM seqs
    RETURNING search_id, seq`,
});

export const SWEEP_RECLAIM_RUNS = define({
  boundary: "sweeper(3/7)",
  name: "SWEEP_RECLAIM_RUNS",
  zeroRowsMeans: "no expired leases still under their attempt budget.",
  params: ["max_attempts"],
  text: `
    -- same statement shape for provider_run with target_kind = 'RUN'; duties 2–3 apply
    -- verbatim to both run kinds, since polymorphism makes this one loop rather than two.
    -- Attempts exhausted is NOT handled here: it runs the full B5F effects, discovered by
    -- SWEEP_DISCOVER_EXHAUSTED_RUNS and routed through B5F_FENCE/B5A_DERIVE_KEY/B5F_EFFECTS
    -- (composed as sweepFailExhaustedRuns in src/transactions.ts), never left LEASED here.
    WITH reclaimed AS (
      UPDATE provider_run SET state = 'PENDING', generation = generation + 1,
                              lease_expires_at = NULL
      WHERE state = 'LEASED' AND lease_expires_at < now()
        AND attempt < $1::integer
      RETURNING run_id
    )
    INSERT INTO outbox (outbox_id, target_kind, run_id, traceparent)
    SELECT gen_random_uuid()::text, 'RUN', run_id, NULL FROM reclaimed
    RETURNING outbox_id`,
});

/**
 * Discovers `LEASED` runs whose lease has expired AND whose attempts are exhausted —
 * exactly the complement `SWEEP_RECLAIM_RUNS` excludes via `attempt < $1`. Discovery is a
 * plain SELECT (no side effect of its own, mirroring `SWEEP_OVERDUE_OUTBOX`): the actual
 * failure is fenced per-row by the EXISTING `B5F_FENCE`, which already re-checks
 * `generation`/`state`/`attempt` at the moment of failing, so a lease renewed between
 * discovery and failing loses the fence rather than being wrongly terminalized.
 */
export const SWEEP_DISCOVER_EXHAUSTED_RUNS = define({
  boundary: "sweeper(3/7)",
  name: "SWEEP_DISCOVER_EXHAUSTED_RUNS",
  zeroRowsMeans: "no attempts-exhausted expired-lease runs — nothing stranded.",
  params: ["max_attempts"],
  text: `
    SELECT run_id, generation FROM provider_run
    WHERE state = 'LEASED' AND lease_expires_at < now() AND attempt >= $1::integer`,
});

export const SWEEP_AGGREGATE_HINTS = define({
  boundary: "sweeper(4)",
  name: "SWEEP_AGGREGATE_HINTS",
  zeroRowsMeans: "nothing needs aggregating.",
  params: [],
  text: `
    -- the sweeper never sets terminal status directly — it only makes B7/B8 run
    SELECT s.search_id
    FROM search s
    WHERE s.status IN ('PENDING_SCHEDULE','RUNNING')
      AND (s.agg_lease_expires IS NULL OR s.agg_lease_expires < now())
      AND (s.agg_processed_rev < s.agg_requested_rev OR s.deadline_at <= now())`,
});

export const SWEEP_STALE_SNAPSHOT_PROJECTIONS = define({
  boundary: "sweeper(5)",
  name: "SWEEP_STALE_SNAPSHOT_PROJECTIONS",
  zeroRowsMeans:
    "every advanceable (SHOWTIME_FETCH) key is projected — other kinds are never candidates.",
  params: ["age"],
  text: `
    -- both projections need a backstop, not just the event one (B10). Only SHOWTIME_FETCH
    -- keys are advanceable here (S33): a real SCHEDULE_RESOLUTION acceptance bumps
    -- accepted_revision without ever writing an availability snapshot, so such a row is
    -- permanently stale — selecting it as a candidate would only throw and block its
    -- siblings, so it must be excluded from discovery entirely.
    SELECT run_key_id, accepted_revision, projected_revision
    FROM run_key
    WHERE projected_revision < accepted_revision
      AND latest_captured_at < now() - $1::interval
      AND kind = 'SHOWTIME_FETCH'`,
});

/**
 * `searches.create` warm-path cache read (S15.4): the SCHEDULE_RESOLUTION `run_key` for
 * `(provider_id, theatre_id, local_date)` — resolved through the existing
 * `run_key_schedule` unique index (`001_schema.sql:83-84`) — LEFT JOINed with every
 * `performance` row that key resolved, each carrying the `status` column S14 now
 * populates (`003_catalog.sql:44-57`). The join emits one row per performance plus one
 * synthetic `showtime_id IS NULL` row when the key exists but has never resolved
 * non-empty; the no-key case emits no rows at all.
 *
 * Freshness is deliberately NOT in this SQL: the ceiling is a caller-supplied parameter
 * (S15.4), compared in TypeScript by `readCachedSchedule` so the boundary test can hold
 * the clock at the exact-capture-time edge — "range is not a value" (`docs/gates.md`),
 * applied here the same way the fetch-layer tunables are.
 */
export const SCHEDULE_CACHE_READ = define({
  boundary: "B1",
  name: "SCHEDULE_CACHE_READ",
  zeroRowsMeans:
    "no resolved schedule exists for this (provider_id, theatre_id, local_date) — " +
    "the search resolves cold.",
  params: ["provider_id", "theatre_id", "local_date"],
  text: `
    SELECT rk.run_key_id, rk.latest_captured_at, p.showtime_id, p.status,
           p.layout_id, p.format_code, p.auditorium
    FROM run_key rk
    LEFT JOIN performance p
      ON p.provider_id = rk.provider_id
     AND p.theatre_id = rk.theatre_id
     AND p.local_date = rk.local_date
    WHERE rk.provider_id = $1::text
      AND rk.kind = 'SCHEDULE_RESOLUTION'
      AND rk.theatre_id = $2::text
      AND rk.local_date = $3::date
    ORDER BY p.showtime_id`,
});

/**
 * `theatres.movies` range read (S21.4): every SCHEDULE_RESOLUTION `run_key` for
 * `(provider_id, theatre_id)` whose `local_date` lands in the inclusive `[date_from,
 * date_to]` span, LEFT JOINed (exactly like `SCHEDULE_CACHE_READ`) with every
 * `performance` row that key resolved and with the `movie` catalogue on
 * `p.movie_id = m.movie_id` to carry `m.title` (S24). The scan reuses the
 * `run_key_schedule` unique-index prefix (`001_schema.sql:83-84`); the join reuses
 * `performance_by_schedule_key` (`001_schema.sql:230-231`).
 *
 * One statement serves the whole span (a single round trip, never a per-day loop). The
 * LEFT JOIN emits one row per performance, plus one synthetic `showtime_id IS NULL` row
 * per key that exists but has never resolved non-empty, and no rows at all for keys
 * absent from the span. `m.title` is NULL exactly for pre-S24 rows (and for NULL-
 * `movie_id` pre-S14 rows), which the route drops (S21.7) — never fabricated.
 *
 * Freshness is deliberately NOT in this SQL, mirroring `SCHEDULE_CACHE_READ`: the
 * ceiling is a caller-supplied parameter compared in TypeScript per day, so the test
 * can hold the clock at the exact-capture-time edge ("range is not a value",
 * `docs/gates.md`).
 */
export const SCHEDULE_RANGE_READ = define({
  boundary: "B1",
  name: "SCHEDULE_RANGE_READ",
  zeroRowsMeans:
    "no SCHEDULE_RESOLUTION run_key rows exist in [date_from, date_to] for this " +
    "(provider_id, theatre_id) — the whole span is cold.",
  params: ["provider_id", "theatre_id", "date_from", "date_to"],
  text: `
    SELECT rk.local_date::text AS local_date, rk.latest_captured_at,
           p.showtime_id, p.movie_id, p.starts_at, p.status, p.format_code,
           p.auditorium, p.runtime_minutes, p.deep_link_url, p.attributes, p.layout_id,
           m.title
    FROM run_key rk
    LEFT JOIN performance p
      ON p.provider_id = rk.provider_id
     AND p.theatre_id = rk.theatre_id
     AND p.local_date = rk.local_date
    LEFT JOIN movie m
      ON m.movie_id = p.movie_id
    WHERE rk.provider_id = $1::text
      AND rk.kind = 'SCHEDULE_RESOLUTION'
      AND rk.theatre_id = $2::text
      AND rk.local_date >= $3::date
      AND rk.local_date <= $4::date
    ORDER BY rk.local_date, p.showtime_id`,
});

/** Every statement above, in declaration order. Tier 1 prepares all of them. */
export const ALL_STATEMENTS: readonly Statement[] = statements;
