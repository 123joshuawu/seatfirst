import { TRPCError } from "@trpc/server";

import {
  MovieIdSchema,
  parseNamespacedId,
  ShowtimeIdSchema,
  ShowtimeStatusSchema,
  TheatreIdSchema,
  TheatreMoviesInputSchema,
  toTheatreLocal,
  type MovieId,
  type ShowtimeId,
  type ShowtimeStatus,
  type TheatreMovieGroup,
  type TheatreMoviesResponse,
} from "@seatfirst/core";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import {
  dispatchTmdbFetch,
  poolClient,
  readMovieById,
  readScheduleRange,
  readTheatreById,
  THEATRE_READ_BY_ID,
  type ScheduleRangeDay,
} from "@seatfirst/durability";
import type { Pool } from "pg";

import { mintSessionId } from "../session/bootstrap.js";
import { t } from "./search.js";
import type { TheatreSearchContext } from "./searchContext.js";

/**
 * `theatres.movies` (S21; `seatfirst-architecture.md:265`) — a synchronous, read-only
 * browse of the cached schedule over an inclusive `[from, to]` date span: confirm the
 * theatre exists, read every cached schedule day covering the span in ONE boundary call
 * (`SCHEDULE_RANGE_READ`), drop hard-cold days per the S63 tiered freshness matrix
 * (ADR 0100), group the surviving performances by movie, and return them with `isWarm`.
 *
 * This route builds on the S20 router's `t` (`TheatreSearchContext { db }`) so the shared
 * router stays context-homogeneous (a mixed-context router would degrade `appRouter`'s
 * type). `TheatreSearchContext` names only what S20's route needed; the runtime
 * `appRouter` context (`SearchCreateContext`, `searches/createContext.ts`) additionally
 * carries the request-scoped logger, read via the cast at the top of the query (the same
 * nested-context coordination the S20 router comment records).
 * Cache-derived ONLY (S21.8): no code path here imports `AmcProvider`, the fetch actor,
 * or any network call — a cold day is absent, never fetched. No rate-limit or ledger
 * interaction (S21.9). S25.4 (ADR 0019 amendment decision 2) adds a read-time poster
 * augmentation on top of this: each group's poster resolves through `MOVIE_READ_BY_ID`'s
 * TMDB LEFT JOIN, and a NULL poster enqueues a fire-and-forget TMDB_FETCH through the
 * local outbox (still no network call — the worker owns the HTTP). The runtime catalogue
 * is empty today (no production caller of `upsertTheatre`), so every request 404s until a
 * catalogue-population task lands — documented truth, not a stub (S21.2).
 */
export const movies = t.procedure
  .input(TheatreMoviesInputSchema)
  .query(async ({ input, ctx }): Promise<TheatreMoviesResponse> => {
    // S21.1 — the runtime context (SearchCreateContext via appRouter) carries the pool
    // beyond the S20-narrow `TheatreSearchContext`. S63 no longer reads the injected
    // flat freshness ceiling here: per-day tiering comes from
    // `evaluateScheduleDayFreshness` (ADR 0100). The `freshnessMs` context field itself
    // stays plumbed (facetCounts/capacityPreview still read it) — this route just
    // stops consuming it.
    const { db } = ctx as TheatreSearchContext & {
      readonly logger: SeatfirstLogger;
    };
    // O11.6 — the runtime appRouter context (`SearchCreateContext`) carries the
    // request-scoped Fastify logger (`req.log`, requestId included) as `logger`; this
    // route logs through it like every other route, so its lines carry request
    // identity and ride the OTel log bridge. The per-request ad hoc `createLogger`
    // fallback this route used to build is gone — that construction path carried
    // neither a requestId nor the OTel log bridge.
    const logger = (ctx as TheatreSearchContext & { logger: SeatfirstLogger }).logger;
    // S21.2 — theatre existence check first. Zero rows maps to NOT_FOUND with the
    // boundary's own zeroRowsMeans text; the row's timezone is what the response echoes.
    const theatreRows = await readTheatreById(poolClient(db), input.theatreId);
    const theatre = theatreRows[0];
    if (theatre === undefined) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: THEATRE_READ_BY_ID.zeroRowsMeans,
      });
    }

    // S21.3 — provider is DERIVED from the namespaced id prefix, never a request field.
    // `TheatreMoviesInputSchema` already rejected unnamespaced or foreign-kind ids, so
    // this parse is guaranteed to succeed; we still handle the impossible case loudly.
    const parsed = parseNamespacedId(input.theatreId);
    if (!parsed.ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "theatre id did not parse as a namespaced id",
      });
    }

    // S21.4 — one boundary call serves the whole span (no per-day loop). `from`/`to`
    // are `z.iso.date()` wire strings (`YYYY-MM-DD`), passed through verbatim.
    const range = await readScheduleRange(poolClient(db), {
      providerId: parsed.value.providerId,
      theatreId: input.theatreId,
      dateFrom: input.from,
      dateTo: input.to,
    });

    // S63.1/S63.2 — per-day tiered freshness gate (ADR 0100), then group the
    // surviving performances by movie (drop pre-S14/pre-S24 rows, order deterministically).
    // A day contributes iff it is served (`isFresh || isStaleWhileRevalidate`, i.e. not
    // hard-cold and not absent). `isWarm` is true iff EVERY requested day in the range
    // is soft-fresh (`isFresh`) — false when ANY day is SWR, hard-cold, or absent.
    const now = new Date();
    const moviesOut = buildMovieGroups(range.days, now, theatre.timezone);
    const dayByDate = new Map(range.days.map((day) => [day.localDate, day]));
    const isWarm = enumerateRequestedDates(input.from, input.to).every((date) => {
      const day = dayByDate.get(date);
      return day !== undefined && evaluateScheduleDayFreshness(day, now, theatre.timezone).isFresh;
    });

    // S25.4 (ADR 0019 amendment decision 2) — resolve each group's poster through the
    // batched MOVIE_READ_BY_ID LEFT JOIN. The boundary is per-id, so "batched" is one
    // concurrent read per distinct movieId (never a sequential loop); a group whose
    // read loses (0 rows) resolves to null. This is the first production caller of
    // `readMovieById` — confirmed absent from SCHEDULE_RESOLUTION in the amendment.
    // S55 — the same rows also carry runtimeMinutes/genres (readMovieById already
    // coalesces the LEFT JOIN's null genres to []): no second read, no second trigger.
    const distinctMovieIds = [...new Set(moviesOut.map((group) => group.movieId))];
    const movieRows = await Promise.all(
      distinctMovieIds.map((movieId) => readMovieById(poolClient(db), movieId)),
    );
    const detailsByMovieId = new Map<
      string,
      { posterPath: string | null; runtimeMinutes: number | null; genres: readonly string[] }
    >();
    distinctMovieIds.forEach((movieId, index) => {
      const row = movieRows[index]?.[0];
      detailsByMovieId.set(movieId, {
        posterPath: row?.poster_path ?? null,
        runtimeMinutes: row?.runtime_minutes ?? null,
        genres: row?.genres ?? [],
      });
    });

    const movies: TheatreMovieGroup[] = moviesOut.map((group) => ({
      ...group,
      posterPath: detailsByMovieId.get(group.movieId)?.posterPath ?? null,
      runtimeMinutes: detailsByMovieId.get(group.movieId)?.runtimeMinutes ?? null,
      genres: [...(detailsByMovieId.get(group.movieId)?.genres ?? [])],
    }));

    await dispatchPosterBackfills(db, movies, logger);

    // S21.6 — the response echoes the namespaced theatre id (branded), the theatre row's
    // timezone, and the requested date span in wire date form. Every movie/showtime field
    // was validated against the boundary schema above; `TheatreIdSchema.parse` re-brands
    // the id at the wire boundary (the create.ts pattern). S63.2 adds `isWarm` (ADR 0100).
    return {
      theatreId: TheatreIdSchema.parse(input.theatreId),
      timezone: theatre.timezone,
      from: input.from,
      to: input.to,
      movies,
      isWarm,
    };
  });

/**
 * S25.4 cache-miss dispatch (extracted for test seam, O6.5): a null poster enqueues a
 * TMDB_FETCH through the outbox (the worker does the actual TMDB HTTP search later).
 * The response is unaffected — it still returns posterPath null on a first miss. The
 * dispatch awaits only the local outbox insert (never a network call) and is swallowed
 * on failure so a poster backfill problem can never fail the browse request; a repeat
 * miss while a fetch is still PENDING is deduped by one_live_tmdb_fetch_per_title.
 */
export async function dispatchPosterBackfills(
  db: Pool,
  movies: readonly TheatreMovieGroup[],
  logger: SeatfirstLogger,
): Promise<void> {
  for (const movie of movies) {
    if (movie.posterPath !== null) continue;
    try {
      await dispatchTmdbFetch(poolClient(db), {
        tmdbFetchId: mintSessionId(),
        movieTitle: movie.title,
      });
    } catch (error) {
      logger.warn({ movie_title: movie.title, error }, "TMDB_FETCH dispatch failed (best-effort)");
    }
  }
}

/** The showtime wire shape, narrowed from the boundary row for grouping (S21.6). */
export interface Showtime {
  showtimeId: ShowtimeId;
  showDateTimeUtc: string;
  status: ShowtimeStatus;
  formatCode: string | null;
  auditorium: string | null;
  runtimeMinutes: number | null;
  deepLinkUrl: string;
  attributes: string[];
}

/** One grouped movie in the response (S21.6/S21.7). */
export interface MovieGroup {
  readonly movieId: MovieId;
  readonly title: string;
  readonly showtimes: Showtime[];
}

/**
 * S40.5 — replaces the former unchecked deepLinkUrl string cast on provider-derived data:
 * the wire field is a non-null URL string, so a drifted value fails loudly at this
 * boundary instead of reaching clients unvalidated. Well-formed rows are untouched.
 */
function requireWireDeepLinkUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `performance.deepLinkUrl: expected string, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * S63.1 — tiered schedule freshness evaluator (ADR 0100 "Implementation Mechanics",
 * "Precedence Hierarchy & Freshness Matrix"). Pure: no DB, no clock, no network.
 *
 * | Tier (evaluated in order)                  | Condition                    | Soft TTL | Hard TTL |
 * | ------------------------------------------ | ---------------------------- | -------- | -------- |
 * | 1. Empty schedules (negative cache, wins)  | `performances.length === 0`  | 2 hours  | 4 hours  |
 * | 2. Populated today (D+0)                   | `isToday && !isEmpty`        | 2 hours  | 6 hours  |
 * | 3. Populated future (D+1..D+6)             | `!isToday && !isEmpty`       | 12 hours | 36 hours |
 *
 * `isFresh` (age <= soft TTL) means servable with no revalidation. `isStaleWhileRevalidate`
 * (soft TTL < age <= hard TTL) means still servable, but the caller must stage a
 * background `SCHEDULE_RESOLUTION` (search admission only — never browse, S21.8). A day
 * that is neither (age past the hard TTL, or `capturedAt === null`) is hard-cold: the
 * caller must not serve it as-is. `isToday` compares the day's `localDate` against
 * `now` rendered in the theatre's timezone (a malformed timezone falls back to the UTC
 * calendar date, the create.ts representative-`today` precedent). The empty tier is
 * evaluated FIRST so a transiently empty D+0 crawl never lingers for 6 hours.
 *
 * NOTE: `ScheduleRangeDay` carries `localDate` (not `date`): the ADR/spec sketches spell
 * the field `day.date`, but this repo's durable shape is `localDate` (repository.ts).
 * NOTE: unlike the spec sketch (whose `isFresh: ageMs <= hardTtlMs` overlaps SWR), the
 * two flags here are disjoint: `isFresh` means strictly within the soft TTL, so
 * "servable as-is" is `isFresh || isStaleWhileRevalidate` and "needs no staging" is
 * exactly `isFresh`.
 */
export interface ScheduleDayFreshness {
  readonly isFresh: boolean;
  readonly isStaleWhileRevalidate: boolean;
}

export function evaluateScheduleDayFreshness(
  day: ScheduleRangeDay,
  now: Date,
  theatreTimezone: string,
): ScheduleDayFreshness {
  if (day.capturedAt === null) {
    return { isFresh: false, isStaleWhileRevalidate: false };
  }
  const ageMs = now.getTime() - day.capturedAt.getTime();
  let localToday: string;
  try {
    localToday = toTheatreLocal(now.toISOString(), theatreTimezone).localDate;
  } catch {
    localToday = now.toISOString().slice(0, 10);
  }
  const isToday = day.localDate === localToday;
  const isEmpty = day.performances.length === 0;

  // Precedence: negative cache (isEmpty) takes precedence over isToday so that
  // a transiently empty or unposted schedule for today does not linger for 6 hours.
  const { softTtlMs, hardTtlMs } = isEmpty
    ? { softTtlMs: 2 * 3600_000, hardTtlMs: 4 * 3600_000 }
    : isToday
      ? { softTtlMs: 2 * 3600_000, hardTtlMs: 6 * 3600_000 }
      : { softTtlMs: 12 * 3600_000, hardTtlMs: 36 * 3600_000 };

  return {
    isFresh: ageMs <= softTtlMs,
    isStaleWhileRevalidate: ageMs > softTtlMs && ageMs <= hardTtlMs,
  };
}

/**
 * S63.2 — enumerate every wire date (`YYYY-MM-DD`) in the inclusive `[from, to]` span.
 * The span refine on the input schema bounds this (≤ 30 days), so the loop is small.
 */
export function enumerateRequestedDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * S21.5 + S21.7 (S63 tiering) — the route's cache-derived grouping core, extracted as a
 * pure function so the exact tier edges are provable with a deterministic clock
 * (mirroring how `readCachedSchedule` accepts an injected `now`). A day serves iff
 * `evaluateScheduleDayFreshness` says `isFresh || isStaleWhileRevalidate` — a capture
 * exactly AT the hard TTL is served, one past is not (S15 verification item 6's
 * off-by-one discipline). Hard-cold days, NULL-capture days, and no-key days
 * contribute nothing. Grouping drops NULL-`movie_id` rows (pre-S14) and rows whose
 * movieId has no movie catalogue row (`title` NULL, pre-S24 — S24.8), never fabricating a
 * title. Movies order by `movieId`, showtimes by `showDateTimeUtc` (deterministic,
 * `docs/open-questions.md:10`). `status` is carried verbatim (a NULL only ever means a
 * pre-S14 row, which is already dropped; map fail-open to UNKNOWN per the
 * readCachedSchedule precedent); `performancePolicy` is NOT applied.
 */
export function buildMovieGroups(
  days: readonly ScheduleRangeDay[],
  now: Date,
  theatreTimezone: string,
): MovieGroup[] {
  const freshDays = days.filter((day) => {
    const freshness = evaluateScheduleDayFreshness(day, now, theatreTimezone);
    return freshness.isFresh || freshness.isStaleWhileRevalidate;
  });

  const byMovie = new Map<string, { movieId: MovieId; title: string; showtimes: Showtime[] }>();
  for (const day of freshDays) {
    for (const performance of day.performances) {
      if (performance.movieId === null || performance.title === null) continue;
      // The DB CHECK already enforces the namespaced shape, but the wire contract brands
      // the ids (MovieIdSchema/ShowtimeIdSchema) — validated here at the boundary (Zod at
      // every boundary, the create.ts pattern).
      const movieId = MovieIdSchema.parse(performance.movieId);
      let group = byMovie.get(movieId);
      if (group === undefined) {
        group = { movieId, title: performance.title, showtimes: [] };
        byMovie.set(movieId, group);
      }
      group.showtimes.push({
        showtimeId: ShowtimeIdSchema.parse(performance.showtimeId),
        showDateTimeUtc: performance.startsAt.toISOString(),
        status: ShowtimeStatusSchema.parse(performance.status ?? "UNKNOWN"),
        formatCode: performance.formatCode,
        auditorium: performance.auditorium,
        runtimeMinutes: performance.runtimeMinutes,
        // A surviving row has `movie_id` set, and the S14 product write that sets it
        // always writes `deep_link_url` from the parser (non-null per the Performance
        // contract); a NULL here would only mean a pre-product row, which the movie_id-NULL
        // drop above already excluded. The former `as string` trust is now a guarded
        // read: a residual null/non-string fails loudly here instead of reaching clients.
        deepLinkUrl: requireWireDeepLinkUrl(performance.deepLinkUrl),
        // Spread to a mutable `string[]` (the wire shape); the boundary carries `readonly`.
        attributes: [...performance.attributes],
      });
    }
  }

  return [...byMovie.values()]
    .sort((a, b) => a.movieId.localeCompare(b.movieId))
    .map((group) => ({
      movieId: group.movieId,
      title: group.title,
      showtimes: [...group.showtimes].sort((a, b) =>
        a.showDateTimeUtc.localeCompare(b.showDateTimeUtc),
      ),
    }));
}
