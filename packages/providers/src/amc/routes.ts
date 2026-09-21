/// <reference lib="dom" />
const AMC_ORIGIN = "https://www.amctheatres.com";

export function buildTheatresUrl(query: string): URL {
  const url = new URL(`${AMC_ORIGIN}/movie-theatres`);
  url.searchParams.set("q", query);
  return url;
}

export function buildMoviesUrl(): URL {
  return new URL(`${AMC_ORIGIN}/movies`);
}

/** Bare theatre-directory index (ADR 0021): market/state link list, not theatre records. */
export function buildTheatresDirectoryUrl(): URL {
  return new URL(`${AMC_ORIGIN}/movie-theatres`);
}

/** Per-market theatre-list page (ADR 0021): holds the actual theatre records for one market. */
export function buildMarketTheatresUrl(marketSlug: string): URL {
  return new URL(`${AMC_ORIGIN}/movie-theatres/${encodeURIComponent(marketSlug)}`);
}

export function buildShowtimesUrl(marketSlug: string, theatreSlug: string, date: string): URL {
  return new URL(
    `${AMC_ORIGIN}/movie-theatres/${encodeURIComponent(marketSlug)}/${encodeURIComponent(theatreSlug)}/showtimes?date=${encodeURIComponent(date)}`,
  );
}

export function buildMovieShowtimesUrl(movieSlug: string, theatreSlug: string, date: string): URL {
  const url = new URL(`${AMC_ORIGIN}/movies/${encodeURIComponent(movieSlug)}/showtimes`);
  url.searchParams.set("date", date);
  url.searchParams.set("theatre", theatreSlug);
  return url;
}

export function buildSeatsUrl(showtimeId: number, seatNames?: readonly string[]): URL {
  const url = new URL(`${AMC_ORIGIN}/showtimes/${encodeURIComponent(showtimeId)}/seats`);
  // ADR 0002 §3.5 Phase 2 (2026-09-05): carry exact pre-selected seat coordinates as a
  // single `seats` query parameter. Omitted or empty keeps the clean baseline path.
  if (seatNames !== undefined && seatNames.length > 0) {
    url.searchParams.set("seats", seatNames.join(","));
  }
  return url;
}

export function isAllowedUrl(url: URL): boolean {
  if (url.origin !== AMC_ORIGIN) {
    return false;
  }
  if (url.username || url.password || url.hash) {
    return false;
  }

  const path = url.pathname + url.search;
  if (path.startsWith("/amc-stubs-wifi/")) return false;
  if (path.startsWith("/associate-resources")) return false;
  if (path.startsWith("/search?")) return false;

  const pathname = url.pathname;
  const params = Array.from(url.searchParams.keys());

  // ADR 0021: bare `/movie-theatres` (the theatre-directory index, zero params) alongside the
  // existing `?q=` single-param theatre-search page. Both are independently valid; neither
  // collapses into the other.
  if (pathname === "/movie-theatres") {
    if (params.length === 0) return true;
    if (params.length === 1 && params[0] === "q") return true;
    return false;
  }
  if (pathname === "/movies") {
    if (params.length !== 0) return false;
    return true;
  }

  // ADR 0021: the per-market theatre-list page — exactly one bare path segment after
  // `/movie-theatres/`, no `/showtimes` suffix, no query params. Structurally disjoint from the
  // showtimes-by-date regex below (two segments plus a `showtimes` suffix): a URL matching one
  // cannot match the other. Guard note (named deliberately, ADR 0021 Consequences): this checks
  // shape only, not real market-slug values — `/movie-theatres/states` (the literal segment
  // "states") also satisfies this pattern even though it is not a market; same-origin,
  // same-guard-rule, no security implication.
  const marketMatch = pathname.match(/^\/movie-theatres\/([^/]+)$/);
  if (marketMatch) {
    const [, marketSlug] = marketMatch;
    if (!marketSlug) return false;
    if (params.length !== 0) return false;
    return true;
  }

  const showtimesMatch = pathname.match(/^\/movie-theatres\/([^/]+)\/([^/]+)\/showtimes$/);
  if (showtimesMatch) {
    const [, marketSlug, theatreSlug] = showtimesMatch;
    if (!marketSlug || !theatreSlug) return false;
    if (params.length !== 1 || params[0] !== "date") return false;
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    return true;
  }

  const movieShowtimesMatch = pathname.match(/^\/movies\/([^/]+)\/showtimes$/);
  if (movieShowtimesMatch) {
    const [, movieSlug] = movieShowtimesMatch;
    if (!movieSlug) return false;
    // S64 (ADR 0104): the movie-first showtimes page carries exactly `date` + `theatre` —
    // any other key, missing key, or duplicated key fails closed.
    if (params.length !== 2 || !params.includes("date") || !params.includes("theatre")) {
      return false;
    }
    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const theatre = url.searchParams.get("theatre");
    if (!theatre || !/^[a-z0-9-]+$/i.test(theatre)) return false;
    return true;
  }

  const seatsMatch = pathname.match(/^\/showtimes\/([^/]+)\/seats$/);
  if (seatsMatch) {
    const [, showtimeId] = seatsMatch;
    if (!showtimeId || !/^\d+$/.test(showtimeId)) return false;
    // ADR 0002 §3.5 Phase 2 (2026-09-05): the seats route allows the baseline
    // unselected map (zero params) or exactly one `seats` param carrying a non-empty
    // comma-separated seat list. Fail closed on any other key, duplicate keys, or
    // unexpected characters.
    if (params.length === 0) return true;
    if (params.length !== 1 || params[0] !== "seats") return false;
    const seats = url.searchParams.get("seats");
    if (!seats || !/^[A-Za-z0-9,]+$/.test(seats)) return false;
    return true;
  }

  return false;
}
