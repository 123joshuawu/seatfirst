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

/**
 * Cleans an AMC catalogue title for TMDB search queries.
 *
 * AMC frequently appends anniversary labels, event labels, or re-release tags
 * (e.g. "The Transformers: The Movie 40th Anniversary", "Ghost in the Shell 30th Anniversary",
 * "Cars: 20th Anniversary", "The Passion of the Christ (2026 Event)") that prevent TMDB's
 * search API from matching the canonical movie title.
 *
 * This cleaner strips these common suffixes so TMDB search can find the base movie.
 * Note: `normalizeTitle` is STILL applied to the verbatim AMC title for the database join!
 */
export function cleanTitleForSearch(title: string): string {
  return title
    .replace(/\s*:\s*\d+(?:st|nd|rd|th)\s+Anniversary.*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+Anniversary.*$/i, "")
    .replace(/\s*\(\d{4}\s+Event\).*$/i, "")
    .replace(/\s*\(\d{4}\s+Re-?release\).*$/i, "")
    .replace(/\s+Re-?release.*$/i, "")
    .replace(/\s*-\s*Fan\s+Event.*$/i, "")
    .trim();
}
