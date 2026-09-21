import { z } from "zod";
import { extractFlightJSON } from "../flight.js";
import { ProviderError, attachUpstreamChangedDiagnostic } from "../../errors.js";

const PublicMovieSummarySchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    movieId: z.number(),
    detailsPath: z.string(),
    showtimesPath: z.string(),
    mpaaRating: z.string().nullable().optional(),
    runTimeMinutes: z.number().nullable().optional(),
    releaseDate: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    trailer: z.unknown().optional(),
    ratings: z.unknown().optional(),
    runTimeAttributeCodes: z.array(z.string()).optional(),
  })
  .passthrough();

export type PublicMovieSummary = z.infer<typeof PublicMovieSummarySchema>;

type RscProps = Record<string, unknown>;

interface MovieFields {
  name?: string;
  mpaaRating?: string;
  runTimeMinutes?: number;
  releaseDate?: string;
  imageUrl?: string;
}

interface MovieLink {
  slug: string;
  movieId: number;
  isShowtimes: boolean;
}

const MOVIE_HREF = /^\/movies\/([a-z0-9][a-z0-9-]*-(\d+))(\/showtimes)?$/i;
const RUNTIME = /^(?:(\d+)\s*HR(?:S)?\s*)?(?:(\d+)\s*MIN(?:S)?)?$/i;
const MONTHS: Readonly<Record<string, string>> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function isRecord(value: unknown): value is RscProps {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRscElement(value: unknown): value is [string, string, unknown, RscProps] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === "$" &&
    typeof value[1] === "string" &&
    isRecord(value[3])
  );
}

function movieLink(href: unknown): MovieLink | null {
  if (typeof href !== "string") return null;

  const match = MOVIE_HREF.exec(href);
  if (!match) return null;

  const movieId = Number(match[2]);
  if (!Number.isSafeInteger(movieId)) return null;

  return {
    slug: match[1]!,
    movieId,
    isShowtimes: match[3] !== undefined,
  };
}

function titleFromAriaLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+details$/i, "").trim();
  return title.length > 0 && !/^MPAA Rating:/i.test(title) ? title : undefined;
}

function parseRuntime(value: string): number | undefined {
  const match = RUNTIME.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function parseReleaseDate(value: string): string | undefined {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return undefined;

  const month = MONTHS[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return undefined;

  return `${match[3]}-${month}-${String(day).padStart(2, "0")}`;
}

function collectCardFields(node: unknown): MovieFields {
  const fields: MovieFields = {};
  const text: string[] = [];
  const seen = new Set<unknown>();

  function walk(value: unknown) {
    if (typeof value === "string") {
      text.push(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (isRscElement(value)) {
      const props = value[3];
      const ariaLabel = props["aria-label"];
      const title = titleFromAriaLabel(ariaLabel);
      if (
        !fields.name &&
        title &&
        (props.role === "group" || /\s+details$/i.test(String(ariaLabel)))
      ) {
        fields.name = title;
      }
      if (!fields.mpaaRating && typeof ariaLabel === "string") {
        const rating = /^MPAA Rating:\s*(.+)$/i.exec(ariaLabel);
        if (rating?.[1]) fields.mpaaRating = rating[1].trim();
      }
      if (!fields.name && typeof props.alt === "string" && props.alt.trim()) {
        fields.name = props.alt.trim();
      }
      if (!fields.imageUrl && typeof props.alt === "string") {
        const imageUrl =
          typeof props.src === "string"
            ? props.src
            : typeof props.fallbackSrc === "string"
              ? props.fallbackSrc
              : undefined;
        if (imageUrl) fields.imageUrl = imageUrl;
      }
      walk(props.children);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    for (const child of Object.values(value)) walk(child);
  }

  walk(node);

  for (const value of text) {
    if (fields.runTimeMinutes === undefined) {
      const runtime = parseRuntime(value);
      if (runtime !== undefined) fields.runTimeMinutes = runtime;
    }
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    if (
      fields.releaseDate === undefined &&
      /^(Released|Opening)\s*$/i.test(text[index]!) &&
      typeof text[index + 1] === "string"
    ) {
      const releaseDate = parseReleaseDate(text[index + 1]!);
      if (releaseDate) fields.releaseDate = releaseDate;
    }
  }

  return fields;
}

function mergeMovieFields(target: MovieFields, source: MovieFields): void {
  if (target.name === undefined && source.name !== undefined) target.name = source.name;
  if (target.mpaaRating === undefined && source.mpaaRating !== undefined) {
    target.mpaaRating = source.mpaaRating;
  }
  if (target.runTimeMinutes === undefined && source.runTimeMinutes !== undefined) {
    target.runTimeMinutes = source.runTimeMinutes;
  }
  if (target.releaseDate === undefined && source.releaseDate !== undefined) {
    target.releaseDate = source.releaseDate;
  }
  if (target.imageUrl === undefined && source.imageUrl !== undefined) {
    target.imageUrl = source.imageUrl;
  }
}

/**
 * Scrape AMC's national `/movies` catalogue page (an RSC/flight-stream page) to seed the
 * local `amc_movie_catalogue` table (the 'Now Playing (general release)' default slate).
 *
 * Default behavior is featured-only: only AMC's own curated 'Featured' movies are captured.
 * The full 'All Movies' grid is intentionally excluded because it is too broad/noisy for a
 * default slate. The DOM/RSC signal distinguishing the two is the card root tag: catalogue
 * grid tiles are cards rooted at list items (`<li>`), while a featured movie uses an
 * equivalent aside card (`<aside>`). Traversal threads an `excluded` flag so that once it
 * enters a subtree rooted at an `<li>` element, every movie discovered anywhere within that
 * subtree is skipped. Movies under an `<aside>` root and bare/standalone movie-detail
 * anchors not nested inside any `<li>` continue to be captured exactly as before.
 */
function parseMoviesImpl(
  html: string,
  observationTime: Date,
  requestUrl: string,
): PublicMovieSummary[] {
  const movieById = new Map<number, { slug: string; fields: MovieFields }>();
  const seen = new Set<unknown>();

  function capture(link: MovieLink, fields: MovieFields): void {
    const existing = movieById.get(link.movieId);
    if (existing) {
      mergeMovieFields(existing.fields, fields);
      return;
    }
    movieById.set(link.movieId, { slug: link.slug, fields: { ...fields } });
  }

  function linksIn(node: unknown): MovieLink[] {
    const links = new Map<number, MovieLink>();
    const cardSeen = new Set<unknown>();

    function search(value: unknown): void {
      if (!value || typeof value !== "object" || cardSeen.has(value)) return;
      cardSeen.add(value);

      if (isRscElement(value)) {
        const link = movieLink(value[3].href);
        if (link) links.set(link.movieId, link);
        search(value[3].children);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) search(item);
        return;
      }
      for (const child of Object.values(value)) search(child);
    }

    search(node);
    return [...links.values()];
  }

  function search(node: unknown, excluded = false): void {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (isRscElement(node)) {
      const props = node[3];
      // Once inside an `<li>`-rooted grid tile, exclusion sticks for the whole subtree:
      // a nested `<aside>` must not clear it (defensive; real AMC markup is unlikely to
      // nest them, but an aside inside an li is still part of the excluded grid tile).
      const childExcluded = excluded || node[1] === "li";
      const link = movieLink(props.href);
      if (link && !excluded) capture(link, collectCardFields(node));

      // AMC's catalogue tiles are cards rooted at list items [`<li>`, the full grid]. A
      // featured movie uses an equivalent aside card [`<aside>`]. Their metadata lives
      // beside, not inside, the detail link. Only `<aside>` (featured) cards get the
      // merge-fields pass — `<li>` (full-grid) subtrees are excluded entirely.
      if (node[1] === "aside" && !excluded) {
        const fields = collectCardFields(node);
        for (const cardLink of linksIn(node)) capture(cardLink, fields);
      }
      search(props.children, childExcluded);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) search(item, excluded);
      return;
    }
    for (const child of Object.values(node)) search(child, excluded);
  }

  search(extractFlightJSON(html));

  const movieArray = [...movieById.entries()].flatMap(([movieId, { slug, fields }]) =>
    fields.name
      ? [
          {
            name: fields.name,
            slug,
            movieId,
            detailsPath: `/movies/${slug}`,
            showtimesPath: `/movies/${slug}/showtimes`,
            mpaaRating: fields.mpaaRating,
            runTimeMinutes: fields.runTimeMinutes,
            releaseDate: fields.releaseDate,
            imageUrl: fields.imageUrl,
          },
        ]
      : [],
  );

  if (movieArray.length === 0) {
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      "Movie validation failed: could not locate movie cards",
      { providerMeta: { requestUrl, observationTime } },
    );
  }

  const parsed = z.array(PublicMovieSummarySchema).safeParse(movieArray);
  if (!parsed.success) {
    const err = parsed.error.issues[0];
    throw new ProviderError("UPSTREAM_CHANGED", `Movie validation failed: ${err?.message}`, {
      providerMeta: { requestUrl, observationTime },
    });
  }

  return parsed.data.map((raw) => ({
    ...raw,
    providerMeta: {
      requestUrl,
      observationTime: observationTime.toISOString(),
    },
  }));
}

export function parseMovies(
  html: string,
  observationTime: Date,
  requestUrl: string,
): PublicMovieSummary[] {
  try {
    return parseMoviesImpl(html, observationTime, requestUrl);
  } catch (error) {
    // UPSTREAM_CHANGED-only raw capture: no headers exist at this boundary, so only the
    // genuinely in-scope body + URL are attached. Other error codes pass through untouched.
    attachUpstreamChangedDiagnostic(error, { url: requestUrl, body: html });
    throw error;
  }
}
