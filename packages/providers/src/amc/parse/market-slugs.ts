/**
 * Parser for the bare AMC theatre-directory index page (`/movie-theatres`, no query) —
 * S26.4, the ADR 0022 addendum's finding. This page is NOT Flight-JSON theatre data:
 * `extractShapeFromHtml` (the deep-find `parseTheatres()` uses) does not apply here.
 * The real capture (fifth ADR 0002 §3.4 session, 2026-08-15) is 155 literal
 * server-rendered market anchors, e.g. `<a href="/movie-theatres/atlanta">Atlanta</a>`.
 *
 * The extraction is therefore a plain anchor-`href` scan, not object-shape schema
 * validation. It is deliberately a separate parser from `parseTheatres()`: the two pages
 * are structurally different, and `parseTheatres()` correctly reports `UPSTREAM_CHANGED`
 * against this page (desired behavior if AMC ever serves theatre records there instead).
 */

/**
 * An anchor `href` whose value is exactly `/movie-theatres/{single-segment}`. `[^/"]+`
 * rejects the deeper `/movie-theatres/states/{state}/{city}` pattern (the first `/`
 * after the segment fails the closing `"`), so those 441 city links never yield a slug.
 */
const MARKET_HREF_PATTERN = /href="\/movie-theatres\/([^/"]+)"/g;

/**
 * Extracts the ordered, de-duplicated market slugs from the bare `/movie-theatres`
 * directory page. Order is document order (the page is already alphabetical) and is
 * preserved — the replay fixture golden asserts this exact order.
 *
 * The literal segment `states` satisfies the href shape (`/movie-theatres/states`) but is
 * not a market; it is excluded explicitly (the same guard note as
 * `packages/providers/src/amc/routes.ts:66-69`).
 */
export function parseMarketSlugs(html: string): readonly string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(MARKET_HREF_PATTERN)) {
    const slug = match[1];
    if (slug === undefined || slug === "states" || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}
