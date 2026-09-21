/**
 * `session.bootstrap`, `theatres.search`, `theatres.movies`, `searches.facetCounts`,
 * `searches.capacityPreview`, `searches.suggestPlace`, and `searches.resolvePlace`.
 *
 * `contracts.ts` covers the result contracts a finished search produces; this module
 * covers the procedures the form calls while you are still filling it in. Same two rules
 * apply: every builder stays inside the real contract type (proved in
 * `apiFixtures.test.ts`), and nothing here encodes a product decision.
 */
import {
  CAPACITY_PREVIEW_UNAVAILABLE,
  DEFAULT_SEARCH_LIMITS,
  MovieIdSchema,
  ShowtimeIdSchema,
  TheatreIdSchema,
  type CapacityPreviewResponse,
  type DateScope,
  type FacetCountsInput,
  type FacetCountsResponse,
  type SessionBootstrapResponse,
  type ResolvePlaceResponse,
  type TheatreMovieGroup,
  type TheatreMoviesResponse,
  type TheatreSearchHit,
  type TheatreSearchResponse,
  type SuggestPlaceResponse,
} from "@seatfirst/core";

import {
  DEV_DEEP_LINK_HOST,
  DEV_PROVIDER_ID,
  DEV_THEATRE_ID,
  DEV_TIMEZONE,
  devDeepLink,
} from "./contracts";
import { localDateString } from "@/lib/dates";
import { resolveWhenPreset } from "@/lib/whenPresets";
import { showtimeMatchesWindow } from "@/lib/buildSearchSpec";

/**
 * Why these dates are computed instead of fixed: the search form seeds its default
 * `selectedDates` from `resolveWhenPreset("This weekend", new Date())` on every launch
 * (`store/searchFormSlice.ts`), so a hardcoded fixture date only matches the form's window
 * on the day it was written and then drifts — the browse window and movie showtimes below
 * must sit inside the same weekend or client-side window matching goes all-zero.
 * Each fixture module resolves independently at load; the resolver is a pure function of
 * the date, so both land on the same day.
 */
function devWeekendAnchor(): string {
  try {
    const resolved = resolveWhenPreset("This weekend", new Date());
    if (resolved) return resolved.from;
  } catch {
    // Fall through to the today fallback below.
  }
  // Defensive fallback so a fixture import never throws (the resolver only returns null
  // for unknown presets, which "This weekend" is not).
  return localDateString(new Date());
}

/** Anchor day (`YYYY-MM-DD`) every fixture date below is built from — resolved once at load. */
const DEV_ANCHOR_DATE = devWeekendAnchor();

/** Calendar-day arithmetic on `YYYY-MM-DD` strings (UTC-based, so DST never skews the span). */
function addDaysIso(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-");
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DEV_SEEN_AT = `${DEV_ANCHOR_DATE}T18:00:00.000Z`;

/** Browse span the form asks for; echoed back when the request does not carry its own. */
export const DEV_BROWSE_FROM = DEV_ANCHOR_DATE;
export const DEV_BROWSE_TO = addDaysIso(DEV_ANCHOR_DATE, 29);

export function devTheatreId(raw: string): string {
  return `${DEV_PROVIDER_ID}:theatre:${raw}`;
}

export function devMovieId(raw: string): string {
  return `${DEV_PROVIDER_ID}:movie:${raw}`;
}

/**
 * `limits` is all zeros on purpose. No component reads it, and picking plausible
 * rate-limit numbers here would be inventing policy that nobody has written down.
 */
export function makeSessionBootstrap(
  over: Partial<SessionBootstrapResponse> = {},
): SessionBootstrapResponse {
  return {
    sessionId: "dev-mock-session",
    limits: {
      searchesPerHour: 0,
      upstreamFetchesPerHour: 0,
      concurrentSearches: 0,
      recheckCallsPerMinute: 0,
      facetCountsPerMinute: 0,
      resolvePlacePerMinute: 0,
      suggestPlacePerMinute: 0,
    },
    ...over,
  };
}

export function makeTheatreSearchHit(
  raw: string,
  over: Partial<TheatreSearchHit> = {},
): TheatreSearchHit {
  return {
    id: TheatreIdSchema.parse(devTheatreId(raw)),
    providerId: DEV_PROVIDER_ID,
    name: `AMC ${raw}`,
    location: { lat: 37.7847, lng: -122.4039 },
    timezone: DEV_TIMEZONE,
    city: "San Francisco",
    address: "135 Fourth St",
    slugs: null,
    amenities: [],
    firstSeenAt: DEV_SEEN_AT,
    lastSeenAt: DEV_SEEN_AT,
    distanceKm: 2.4,
    ...over,
  };
}

/** The catalogue the theatre autocomplete browses. */
export const DEV_THEATRE_HITS: readonly TheatreSearchHit[] = [
  makeTheatreSearchHit("metreon", { name: "AMC Metreon 16", distanceKm: 2.4 }),
  makeTheatreSearchHit("kabuki", { name: "AMC Kabuki 8", distanceKm: 4.1 }),
  makeTheatreSearchHit("van-ness", { name: "AMC Van Ness 14", distanceKm: 3.3 }),
  makeTheatreSearchHit("bay-street", {
    name: "AMC Bay Street 16",
    city: "Emeryville",
    distanceKm: 14.6,
  }),
];

export function makeTheatreSearchResponse(
  hits: readonly TheatreSearchHit[] = DEV_THEATRE_HITS,
): TheatreSearchResponse {
  return { theatres: [...hits] };
}

export function makeSuggestPlaceCandidates(labels: readonly string[]): SuggestPlaceResponse {
  return { candidates: labels.map((label) => ({ label })) };
}

export function makeResolvePlaceOk(options: {
  query: string;
  radiusKm: number;
  resolvedPlaceName: string;
}): ResolvePlaceResponse {
  return {
    kind: "ok",
    theatres: DEV_THEATRE_HITS.map((hit) => ({
      theatreId: hit.id,
      distanceKm: hit.distanceKm ?? 0,
      name: hit.name,
      city: hit.city ?? null,
    })),
    excluded: { outsideArea: 0, byLimit: 0 },
    label: `${options.query} · ${options.radiusKm} km around ${options.query}`,
    resolvedPlaceName: options.resolvedPlaceName,
  };
}

/**
 * First showtime of the fixture day; later slots step forward two hours from here. A raw
 * UTC instant, deliberately *not* a Pacific-wall conversion like `contracts.ts`'
 * `DEV_SHOWTIME_UTC`: 19:10 UTC is midday Pacific, so all six 2-hour-spaced slots stay on
 * the anchor's Pacific calendar day — the same fixture day the result cards land on.
 * Only the date component tracks the anchor; the 19:10 time-of-day is preserved as-is.
 */
const MOVIE_FIRST_SLOT_UTC_MS = Date.parse(`${DEV_ANCHOR_DATE}T19:10:00.000Z`);
const SLOT_SPACING_MS = 2 * 60 * 60 * 1000;

function makeMovieShowtime(raw: string, slot: number): TheatreMovieGroup["showtimes"][number] {
  return {
    showtimeId: ShowtimeIdSchema.parse(`${DEV_PROVIDER_ID}:showtime:${raw}`),
    // Built by arithmetic, not string padding, so a later slot cannot roll past hour 23.
    showDateTimeUtc: new Date(MOVIE_FIRST_SLOT_UTC_MS + slot * SLOT_SPACING_MS).toISOString(),
    status: "OPEN",
    formatCode: "STANDARD",
    auditorium: "Aud 6",
    runtimeMinutes: 166,
    deepLinkUrl: devDeepLink(raw),
    attributes: [],
  };
}

export function makeTheatreMovieGroup(
  rawMovieId: string,
  title: string,
  showtimeCount = 4,
  over: Partial<Pick<TheatreMovieGroup, "posterPath" | "runtimeMinutes" | "genres">> = {},
): TheatreMovieGroup {
  return {
    movieId: MovieIdSchema.parse(devMovieId(rawMovieId)),
    title,
    posterPath: over.posterPath ?? null,
    runtimeMinutes: over.runtimeMinutes ?? null,
    genres: over.genres ?? [],
    showtimes: Array.from({ length: showtimeCount }, (_, index) =>
      makeMovieShowtime(`${rawMovieId}-${index + 1}`, index),
    ),
  };
}

/** The now-playing set the movie autocomplete lists. `runtimeMinutes`/`genres` are set here
 * so the State-2 confirmation card's runtime/genre line has something to show in the dev
 * seed; `posterPath` stays null (the legitimate "not resolved yet" state — see
 * `TheatreMovieGroupSchema`'s doc comment) since there is no real TMDB-hosted image to point
 * at from a fixture. */
export const DEV_MOVIE_GROUPS: readonly TheatreMovieGroup[] = [
  makeTheatreMovieGroup("dune-part-three", "Dune: Part Three", 6, {
    runtimeMinutes: 166,
    genres: ["Action", "Adventure"],
  }),
  makeTheatreMovieGroup("the-long-walk", "The Long Walk", 4, {
    runtimeMinutes: 108,
    genres: ["Drama", "Thriller"],
  }),
  makeTheatreMovieGroup("a-quiet-place-4", "A Quiet Place: Day Two", 3, {
    runtimeMinutes: 97,
    genres: ["Horror", "Thriller"],
  }),
  makeTheatreMovieGroup("interstellar-rerelease", "Interstellar (Re-release)", 2, {
    runtimeMinutes: 169,
    genres: ["Adventure", "Drama", "Sci-Fi"],
  }),
];

export function makeTheatreMoviesResponse(
  options: {
    theatreId?: string;
    from?: string;
    to?: string;
    movies?: readonly TheatreMovieGroup[];
    isWarm?: boolean;
  } = {},
): TheatreMoviesResponse {
  return {
    theatreId: TheatreIdSchema.parse(options.theatreId ?? DEV_THEATRE_ID),
    timezone: DEV_TIMEZONE,
    from: options.from ?? DEV_BROWSE_FROM,
    to: options.to ?? DEV_BROWSE_TO,
    movies: [...(options.movies ?? DEV_MOVIE_GROUPS)],
    isWarm: options.isWarm ?? true,
  };
}

/**
 * Enumerates every ISO calendar date a normalized ADR 0050 date scope covers (one run, or
 * the union of an `OR`'s runs) — the only way the facet mock below can filter
 * `DEV_MOVIE_GROUPS` by the same date membership `showtimeMatchesWindow` already enforces
 * client-side, instead of inventing a second date predicate.
 */
function isoDatesInScope(scope: DateScope): string[] {
  const ranges = scope.kind === "OR" ? scope.of : [scope];
  const dates: string[] = [];
  for (const range of ranges) {
    for (let cursor = range.from; cursor <= range.to; cursor = addDaysIso(cursor, 1)) {
      dates.push(cursor);
    }
  }
  return dates;
}

const FACET_BAND_LABEL: Record<string, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  late: "Late",
};

/** `base.timeOfDay`/a `TIME_OF_DAY` candidate is lower-case; `showtimeMatchesWindow`'s bands
 * are the capitalized `timeOfDayBounds` labels. `"allTimes"`/undefined/an unrecognized value
 * maps to an empty band list — `showtimeMatchesWindow`'s own "no time filter" reading. */
function facetBands(timeOfDay: string | undefined): string[] {
  const label = timeOfDay ? FACET_BAND_LABEL[timeOfDay] : undefined;
  return label ? [label] : [];
}

/**
 * The one real predicate every movie-scoped facet candidate below is filtered through —
 * exactly `summarizeMovieWindow`'s own date/time/format matching against the same
 * `DEV_MOVIE_GROUPS` catalogue the theatre's movie browse already answers with. This is what
 * keeps the client-side window total (`useSubmitSearchViewModel`'s `windowSummary`, from real
 * showtimes — the "Any format" chip itself now renders the ANY facet entry via ChipRow) and
 * the per-format facet chips (this mock) from ever disagreeing again
 * (`docs/seeded-ui-states-audit.md` §2 — specific formats summing past "Any format").
 */
function countRealShowtimes(
  movieId: string,
  selectedDates: string[] | null,
  bands: string[],
  formatCode?: string,
): number {
  const group = DEV_MOVIE_GROUPS.find((g) => g.movieId === movieId);
  if (!group) return 0;
  return group.showtimes.filter(
    (st) =>
      (formatCode === undefined || st.formatCode === formatCode) &&
      showtimeMatchesWindow(st.showDateTimeUtc, DEV_TIMEZONE, selectedDates, "All times", bands),
  ).length;
}

/**
 * How a facet candidate should read in the UI. `lib/facetCounts` turns the
 * count/coldTheatreCount pair into "12", "12+", "not checked yet", or a dimmed
 * dead-end, so these four modes are the four visual states you can iterate on.
 */
export type FacetMode = "warm" | "partial" | "cold" | "warm-zero";

/**
 * Answers whatever axes the caller actually asked for, so counts line up with the
 * candidates on screen rather than a hard-coded list. `MOVIE`/`FORMAT`/`DATE`/`TIME_OF_DAY` —
 * the only axes the real app ever sends — derive their count from the exact same
 * `DEV_MOVIE_GROUPS` showtimes `summarizeMovieWindow` filters client-side
 * (`countRealShowtimes` above), scaled by the requested theatre count (every mock theatre
 * answers with an identical catalogue, mirroring how `theatreMovieSet` merges one identical
 * entry per selected theatre). `WEEKDAY`/`HORIZON`/`DATE_SCOPE` are dead wire axes no client
 * builds today (ADR 0052 dropped weekday state; ADR 0051 §A never authorized `DATE_SCOPE`
 * rendering) — kept schema-valid with the previous synthetic sequence since no seeded
 * predicate exists for them to derive a real count from.
 */
export function makeFacetCountsResponse(
  input: FacetCountsInput,
  mode: FacetMode = "warm",
): FacetCountsResponse {
  const theatreCount = input.theatreIds.length;
  const baseDates = input.base.dateScope ? isoDatesInScope(input.base.dateScope) : null;
  const baseBands = facetBands(input.base.timeOfDay);

  return {
    counts: input.axes.flatMap((axis) =>
      axis.candidates.map((rawCandidate, index) => {
        const candidate =
          axis.kind === "DATE_SCOPE"
            ? (rawCandidate as { key: string }).key
            : (rawCandidate as string);

        // Without a movie context there is no meaningful theatre×format/date/time count, so
        // a missing `base.movieId` (no movie chosen yet, still loading, or failed to load)
        // yields an all-zero entry for every movie-scoped axis, in every mode. `MOVIE` never
        // carries `base.movieId` (its own candidates are the movies) and is unaffected.
        if (axis.kind !== "MOVIE" && input.base.movieId == null) {
          return { kind: axis.kind, candidate, count: 0, coldTheatreCount: 0 };
        }

        const displayCount = ((): number => {
          switch (axis.kind) {
            case "MOVIE":
              return countRealShowtimes(candidate, baseDates, baseBands) * theatreCount;
            case "FORMAT":
              // Reserved "ANY" candidate (ADR 0036 amendment, 2026-09-21): like
              // the server, skip format filtering so every showtime counts.
              return (
                countRealShowtimes(
                  input.base.movieId as string,
                  baseDates,
                  baseBands,
                  candidate === "ANY" ? undefined : candidate,
                ) * theatreCount
              );
            case "DATE":
              return (
                countRealShowtimes(input.base.movieId as string, [candidate], baseBands) *
                theatreCount
              );
            case "TIME_OF_DAY":
              return (
                countRealShowtimes(input.base.movieId as string, baseDates, facetBands(candidate)) *
                theatreCount
              );
            case "WEEKDAY":
            case "HORIZON":
            case "DATE_SCOPE":
              // Dead wire axes no client builds today — see doc comment above.
              return 4 + index * 3;
          }
        })();

        switch (mode) {
          case "cold":
            return { kind: axis.kind, candidate, count: 0, coldTheatreCount: theatreCount };
          case "partial":
            return {
              kind: axis.kind,
              candidate,
              count: displayCount,
              coldTheatreCount: Math.max(1, theatreCount - 1),
            };
          case "warm-zero":
            return { kind: axis.kind, candidate, count: 0, coldTheatreCount: 0 };
          case "warm":
            return { kind: axis.kind, candidate, count: displayCount, coldTheatreCount: 0 };
        }
      }),
    ),
  };
}

export function makeCapacityPreviewOk(matchedCount = 18): CapacityPreviewResponse {
  return { kind: "ok", matchedCount, ceilingExceeded: false };
}

/**
 * `ceilingExceeded` is derived from the same constant the admission gate enforces, so the
 * fixture cannot drift from the limit the UI quotes back in its blocked copy.
 */
export function makeCapacityPreviewExceeded(): CapacityPreviewResponse {
  return {
    kind: "ok",
    matchedCount: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes + 137,
    ceilingExceeded: true,
  };
}

export function makeCapacityPreviewUnavailable(): CapacityPreviewResponse {
  return { kind: CAPACITY_PREVIEW_UNAVAILABLE };
}

export { DEV_DEEP_LINK_HOST };
