import * as cheerio from "cheerio";
import {
  formatNamespacedId,
  ShowtimeIdSchema,
  TheatreIdSchema,
  MovieIdSchema,
  toTheatreLocal,
} from "@seatfirst/core";
import { type Performance, PerformanceSchema } from "../../contract.js";
import { extractShapeFromHtml, deepFind, extractFlightJSON } from "../flight.js";
import { ProviderError, attachUpstreamChangedDiagnostic } from "../../errors.js";
import { resolvePostalCodeTimezone } from "../postal-timezone.js";
import { normalizeShowtimeStatus, resolvePooledOffering } from "../normalize.js";
import { buildSeatsUrl } from "../routes.js";

/**
 * Inverted counterpart of `parseShowtimes` (S64, ADR 0104).
 *
 * The theatre-centric parser extracts many movies for one theatre from
 * `/movie-theatres/{market}/{theatre}/showtimes`. This parser extracts many
 * theatres for one movie from `/movies/{movieSlug}/showtimes?date={date}&theatre={slug}`:
 * the anchor theatre's own group plus every nearby cluster theatre rendered on the page.
 * Each emitted `Performance` carries its own showtime's `theatreId`, resolved exactly like
 * the theatre-centric path (postal-code timezone, pooled format/attribute offering, per-record
 * `PerformanceSchema` validation).
 *
 * Association mechanism (same standing rule as `resolveScheduleFromDom` in schedule-dom.ts):
 * an `aria-describedby` IDREF token is never treated as data — every consulted token must
 * resolve to a real element in the rendered document. The only string comparison is an exact
 * whole-value equality check against independently known structured values (the request URL's
 * movie slug + each Flight theatre record's `slug`) — never a decomposition of the token.
 */

interface TheatreRecord {
  [key: string]: unknown;
  theatreId: number;
  name: string;
  slug: string;
  postalCode: string;
  stateCode: string;
  utcOffset: string;
  isSelected?: boolean;
}

interface MovieRecord {
  [key: string]: unknown;
  movieId: number;
  name: string;
  slug: string;
  runTimeMinutes?: number;
}

interface ShowtimeRecord {
  [key: string]: unknown;
  showtimeId: number;
  status: string;
  showDateTimeUtc: string;
  policyCodes?: unknown;
  hasTrailers?: unknown;
}

function isTheatreRecord(v: Record<string, unknown>): v is TheatreRecord {
  return (
    typeof v.theatreId === "number" &&
    typeof v.name === "string" &&
    typeof v.slug === "string" &&
    typeof v.postalCode === "string" &&
    typeof v.stateCode === "string" &&
    typeof v.utcOffset === "string" &&
    (v.isSelected === undefined || typeof v.isSelected === "boolean")
  );
}

function isMovieRecord(v: Record<string, unknown>): v is MovieRecord {
  return typeof v.movieId === "number" && typeof v.name === "string" && typeof v.slug === "string";
}

function isShowtimeRecord(v: Record<string, unknown>): v is ShowtimeRecord {
  return (
    typeof v.showtimeId === "number" &&
    typeof v.status === "string" &&
    typeof v.showDateTimeUtc === "string"
  );
}

// The one namespace every AMC-sourced id is built under (P1.6/P5.8) — never reconstructed
// ad hoc at a call site. Matches parse/showtimes.ts and parse/theatres.ts.
const PROVIDER_ID = "amc";

function upstreamChanged(message: string, requestUrl: string, observationTime: Date): never {
  throw new ProviderError("UPSTREAM_CHANGED", message, {
    providerMeta: { requestUrl, observationTime },
  });
}

/** The movie this page is for, grounded in the request URL — never guessed from page content. */
function resolvePageMovieSlug(requestUrl: string, observationTime: Date): string {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    upstreamChanged(`Request URL is not parseable: "${requestUrl}"`, requestUrl, observationTime);
  }
  const match = pathname!.match(/^\/movies\/([^/]+)\/showtimes$/);
  if (!match?.[1]) {
    upstreamChanged(
      `Request URL path "${pathname!}" is not a movie-showtimes page`,
      requestUrl,
      observationTime,
    );
  }
  return match[1];
}

function parseMovieShowtimesImpl(
  html: string,
  observationTime: Date,
  requestUrl: string,
): Performance[] {
  const movieSlug = resolvePageMovieSlug(requestUrl, observationTime);

  // Theatre membership is sourced from structured Flight records only. The rendered
  // "NEARBY THEATRES" container / `<select name="theatre">` widget is corroborating markup —
  // its option text is never parsed for ids (standing rule). `isSelected`, when present,
  // marks the anchor theatre the same way it does on the theatre-centric schedule page;
  // records without it (widget embeds) still participate, keyed by theatreId.
  const theatreRecords = extractShapeFromHtml<TheatreRecord>(
    html,
    isTheatreRecord,
    "AmcTheatreRecord",
  );
  const theatreById = new Map<number, TheatreRecord>();
  for (const t of theatreRecords) {
    const known = theatreById.get(t.theatreId);
    if (
      known &&
      (known.slug !== t.slug || known.postalCode !== t.postalCode || known.name !== t.name)
    ) {
      upstreamChanged(
        `Multiple theatre records for theatreId ${t.theatreId} disagree on slug/name/postalCode`,
        requestUrl,
        observationTime,
      );
    }
    theatreById.set(t.theatreId, t);
  }
  const theatreBySectionToken = new Map<string, TheatreRecord>();
  for (const t of theatreById.values()) {
    theatreBySectionToken.set(`${movieSlug}-${t.slug}`, t);
  }

  const movieRecords = extractShapeFromHtml<MovieRecord>(html, isMovieRecord, "AmcMovieRecord");
  const movie = movieRecords.find((m) => m.slug === movieSlug);
  if (!movie) {
    upstreamChanged(
      `No movie record with slug "${movieSlug}" in the Flight payload`,
      requestUrl,
      observationTime,
    );
  }

  const $ = cheerio.load(html);

  // Collected via `deepFind` directly (not `extractShapeFromHtml`, which throws on an empty
  // result) so a genuinely empty schedule can be told apart from a real shape mismatch below.
  const showtimeRecords = deepFind<ShowtimeRecord>(extractFlightJSON(html), isShowtimeRecord);
  const showtimeById = new Map<number, ShowtimeRecord>();
  for (const st of showtimeRecords) {
    showtimeById.set(st.showtimeId, st);
  }

  const byId = new Map<string, ReturnType<typeof $>>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (id != null && !byId.has(id)) {
      byId.set(id, $(el));
    }
  });

  const anchors = $('a[href^="/showtimes/"]').filter((_, el) => {
    const id = $(el).attr("id");
    return id != null && /^\d+$/.test(id);
  });

  // AMC's own page renders a genuine `role="alert"` element when a movie legitimately has no
  // showtimes for the requested date/theatre cluster — either the shared "no showtimes found"
  // copy or the cluster-specific "please select a nearby theatre" prompt. A real, structured
  // signal (ARIA alert role + literal upstream copy), not a heuristic invented here. Checked
  // only after collecting real evidence: an alert next to actual showtime evidence is a
  // contradictory state, never silently trusted over real data.
  const noShowtimesAlert = $('[role="alert"]')
    .toArray()
    .some((el) =>
      /no showtimes found|please select a nearby theatre|temporarily closed/i.test($(el).text()),
    );
  const hasEvidence = showtimeRecords.length > 0 || anchors.length > 0;

  if (noShowtimesAlert && hasEvidence) {
    upstreamChanged(
      "Found a 'no showtimes' alert alongside real showtime evidence (records or anchors) — contradictory state",
      requestUrl,
      observationTime,
    );
  }
  if (noShowtimesAlert && !hasEvidence) {
    return [];
  }
  if (!hasEvidence) {
    upstreamChanged(
      "No showtime records and no showtime anchors found, and no 'no showtimes' alert present to explain the absence",
      requestUrl,
      observationTime,
    );
  }
  if (showtimeRecords.length === 0) {
    upstreamChanged(
      "Showtime anchors are present in the rendered HTML but no showtime records were found in the Flight payload",
      requestUrl,
      observationTime,
    );
  }
  if (anchors.length === 0) {
    upstreamChanged(
      "Showtime records are present in the Flight payload but no showtime anchor elements were found in the rendered HTML",
      requestUrl,
      observationTime,
    );
  }

  const movieId = MovieIdSchema.parse(
    formatNamespacedId({
      providerId: PROVIDER_ID,
      kind: "movie",
      raw: String(movie.movieId),
    }),
  );
  const runtimeMinutes =
    typeof movie.runTimeMinutes === "number" &&
    Number.isInteger(movie.runTimeMinutes) &&
    movie.runTimeMinutes > 0
      ? movie.runTimeMinutes
      : null;

  const performances: Performance[] = [];
  const seenShowtimeIds = new Set<number>();

  anchors.each((_, el) => {
    const $el = $(el);
    const idAttr = $el.attr("id")!;
    const showtimeId = Number(idAttr);
    const href = $el.attr("href");
    if (href !== `/showtimes/${idAttr}`) {
      upstreamChanged(
        `Showtime anchor id ${idAttr} does not match its own href ${href ?? "<missing>"}`,
        requestUrl,
        observationTime,
      );
    }

    const describedBy = $el.attr("aria-describedby");
    if (!describedBy) {
      upstreamChanged(
        `Showtime anchor ${idAttr} has no aria-describedby to resolve its theatre/format association`,
        requestUrl,
        observationTime,
      );
    }
    const tokens = describedBy.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      upstreamChanged(
        `Showtime anchor ${idAttr} has ${tokens.length} aria-describedby token(s), expected at least the movie and theatre-section references`,
        requestUrl,
        observationTime,
      );
    }

    // First IDREF: the movie. Only trusted once confirmed to reference a real element, then
    // checked for whole-value equality against the URL-grounded slug — never decomposed.
    const movieToken = tokens[0]!;
    if (!byId.has(movieToken)) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s first aria-describedby token "${movieToken}" has no matching element in the rendered HTML`,
        requestUrl,
        observationTime,
      );
    }
    if (movieToken !== movieSlug) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s first aria-describedby token "${movieToken}" does not match this page's movie slug "${movieSlug}"`,
        requestUrl,
        observationTime,
      );
    }

    // Second IDREF: the theatre section (`{movie-slug}-{theatre-slug}`). Must both resolve
    // to a real element (the theatre's section in the document) and whole-match exactly one
    // known theatre's section token — the token text itself is never split for data.
    const theatreToken = tokens[1]!;
    if (!byId.has(theatreToken)) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s theatre aria-describedby token "${theatreToken}" has no matching element in the rendered HTML`,
        requestUrl,
        observationTime,
      );
    }
    const theatre = theatreBySectionToken.get(theatreToken);
    if (!theatre) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s theatre aria-describedby token "${theatreToken}" does not match any known theatre section for movie "${movieSlug}"`,
        requestUrl,
        observationTime,
      );
    }

    // P5.14: resolve the IANA zone from this showtime's own theatre's postal code — never
    // from `utcOffset`, a fixed offset that cannot say whether the zone observes Daylight
    // Saving Time. Each nearby theatre converts in its own zone, not the anchor's.
    const timezone = resolvePostalCodeTimezone(theatre.postalCode);
    if (timezone == null) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Postal code "${theatre.postalCode}" is not in the timezone table`,
        {
          providerMeta: {
            requestUrl,
            observationTime,
            theatreId: theatre.theatreId,
            postalCode: theatre.postalCode,
          },
        },
      );
    }
    const theatreId = TheatreIdSchema.parse(
      formatNamespacedId({
        providerId: PROVIDER_ID,
        kind: "theatre",
        raw: String(theatre.theatreId),
      }),
    );

    // The attributes list, if present, is always the last IDREF and is only trusted once the
    // referenced element is confirmed to actually be a list container — never assumed from
    // the token text. With only the movie + theatre tokens present there is no attributes
    // list to resolve (the theatre section itself is never a list).
    const lastToken = tokens[tokens.length - 1]!;
    const lastEl = tokens.length > 2 ? byId.get(lastToken) : undefined;
    const hasAttributesList = lastEl != null && lastEl.is("ul, ol");
    const rawAttributeNames: string[] = hasAttributesList
      ? lastEl
          .find("li")
          .toArray()
          .map((li) => $(li).text().trim())
          .filter((t) => t.length > 0)
      : [];

    // Remaining middle tokens (after the movie + theatre references, excluding the resolved
    // attributes list) are candidate format-group references. Same known-good pattern as the
    // theatre-centric resolver: the real format name is the first non-`sr-only` `<span>`
    // descendant with no element children of its own (a promo tagline wrapping a "More Info"
    // `<button>` is excluded by structure, not by text). Only the deepest middle token is
    // ever consulted; a deepest token resolving to no element is a structural anomaly, never
    // silently skipped in favor of a shallower token.
    const middleTokens = tokens.slice(2, hasAttributesList ? -1 : tokens.length);
    let rawFormatName: string | null = null;
    if (middleTokens.length > 0) {
      const deepestToken = middleTokens[middleTokens.length - 1]!;
      const target = byId.get(deepestToken);
      if (!target) {
        upstreamChanged(
          `Showtime anchor ${idAttr}'s deepest format aria-describedby token "${deepestToken}" has no matching element in the rendered HTML`,
          requestUrl,
          observationTime,
        );
      }
      const leafSpans = target
        .find("span")
        .filter((_, s) => !$(s).hasClass("sr-only") && $(s).children().length === 0);
      if (leafSpans.length === 1) {
        const text = leafSpans.first().text().trim();
        rawFormatName = text.length > 0 ? text : null;
      }
    }

    const showtimeRecord = showtimeById.get(showtimeId);
    if (!showtimeRecord) {
      upstreamChanged(
        `Showtime anchor ${idAttr} has no matching showtime record in the Flight payload`,
        requestUrl,
        observationTime,
      );
    }

    if (seenShowtimeIds.has(showtimeId)) {
      upstreamChanged(
        `Showtime ${showtimeId} appears under more than one showtime anchor`,
        requestUrl,
        observationTime,
      );
    }
    seenShowtimeIds.add(showtimeId);

    // P5.4/ADR 0008: the rendered page exposes no upstream `code` for a format or attribute —
    // only human display names — so both DOM positions are pooled before normalizing (DOM
    // position is not a reliable category signal). Unmapped strings are dropped, never passed
    // through.
    const pooled = [
      ...(rawFormatName != null ? [{ raw: rawFormatName, fromHeading: true }] : []),
      ...rawAttributeNames.map((raw) => ({ raw, fromHeading: false })),
    ];
    const { formatCode, attributes } = resolvePooledOffering(pooled);

    const namespacedShowtimeId = ShowtimeIdSchema.parse(
      formatNamespacedId({
        providerId: PROVIDER_ID,
        kind: "showtime",
        raw: String(showtimeRecord.showtimeId),
      }),
    );
    const showDateTimeUtc = new Date(showtimeRecord.showDateTimeUtc);
    const local = toTheatreLocal(showtimeRecord.showDateTimeUtc, timezone);

    const candidate = {
      showtimeId: namespacedShowtimeId,
      providerId: PROVIDER_ID,
      // P5.4: the raw upstream status/format/attribute strings live in providerMeta, never
      // as named columns — only their normalized forms (below) are the core fields.
      providerMeta: {
        requestUrl,
        observationTime: observationTime.toISOString(),
        rawStatus: showtimeRecord.status,
        rawFormatName,
        rawAttributeNames,
      },
      theatreId,
      movieId,
      // S24.4: carry the movie title through the parse seam so the schedule-acceptance
      // write can populate the movie catalogue (S24.5).
      movieTitle: movie.name,
      // P5.10: auditorium identity may be unrecoverable per showtime — AMC's schedule payload
      // never carries one, so this is always null, never a required/derived value.
      auditorium: null,
      showDateTimeUtc,
      showDateTimeLocal: local.localDateTime,
      utcOffset: local.utcOffset,
      runtimeMinutes,
      // P5.5: maps the native status string to `ShowtimeStatus` via the normalization table.
      // Deciding what to do with that status is not this parser's job (P5.2: pure, no I/O).
      status: normalizeShowtimeStatus(showtimeRecord.status),
      attributes,
      formatCode,
      // P5.13: null until the seat fetch resolves — prices are not on the schedule.
      minPrice: null,
      // Real, allowlist-validated deep link (the baseline seats map carries zero params):
      // never fabricated from a numeric id outside the corridor, never a placeholder.
      deepLinkUrl: buildSeatsUrl(showtimeRecord.showtimeId).toString(),
      // The schedule payload carries no seat-layout id — only the seat page does.
      layoutId: null,
    };

    const validated = PerformanceSchema.safeParse(candidate);
    if (!validated.success) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Performance validation failed: ${validated.error.issues[0]?.message}`,
        { providerMeta: { requestUrl, observationTime, showtimeId: showtimeRecord.showtimeId } },
      );
    }
    performances.push(validated.data);
  });

  // Counts round-trip: every showtime record the Flight stream carries must have been claimed
  // by exactly one anchor, and vice versa (already enforced above). A mismatch means some
  // showtimes are unreachable from the rendered HTML — a real structural change, not a
  // legitimate empty result.
  if (seenShowtimeIds.size !== showtimeById.size) {
    upstreamChanged(
      `${showtimeById.size} showtime records in the Flight payload but only ${seenShowtimeIds.size} were reachable from a showtime anchor`,
      requestUrl,
      observationTime,
    );
  }

  return performances;
}

export function parseMovieShowtimes(
  html: string,
  observationTime: Date,
  requestUrl: string,
): Performance[] {
  try {
    return parseMovieShowtimesImpl(html, observationTime, requestUrl);
  } catch (error) {
    // UPSTREAM_CHANGED-only raw capture: no headers exist at this boundary, so only the
    // genuinely in-scope body + URL are attached. Other error codes pass through untouched.
    attachUpstreamChangedDiagnostic(error, { url: requestUrl, body: html });
    throw error;
  }
}
