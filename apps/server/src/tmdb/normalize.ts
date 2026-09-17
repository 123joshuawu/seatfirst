/**
 * TMDB title normalization (S25.2/S25.5) — the exact transformation that makes the
 * `MOVIE_READ_BY_ID` LEFT JOIN (`lower(movie.title) = tmdb_movie.normalized_title`) resolve.
 *
 * Both write paths feed this key:
 * - the pre-warm (S25.3) normalizes TMDB's own upstream title, and
 * - the fetch worker (S25.5) normalizes the AMC `movie.title` it searched by (NOT the TMDB
 *   result title), so the join resolves for the exact AMC title even when TMDB's own title
 *   differs in case, spacing, or punctuation.
 *
 * The transform is `trim().toLowerCase()` — nothing more. `movie.title` is stored verbatim
 * from the AMC parser, so anything fancier (collapsing internal whitespace, diacritic
 * folding) would have to be applied to BOTH sides of the join and is out of scope.
 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}
