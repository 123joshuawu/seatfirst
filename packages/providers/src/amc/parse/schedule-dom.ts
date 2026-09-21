import * as cheerio from "cheerio";
import { extractShapeFromHtml, deepFind, extractFlightJSON } from "../flight.js";
import { ProviderError, attachUpstreamChangedDiagnostic } from "../../errors.js";

/**
 * Schedule-page DOM/ARIA-association resolver.
 *
 * AMC's schedule page (`/movie-theatres/{market}/{theatre}/showtimes`) no longer serializes a
 * single `PublicTheatreSchedule` object (`selectedDate` + `groups` + `theatre`) into the Flight
 * stream — `showtimes.ts`'s primary extraction throws `UPSTREAM_CHANGED` on every committed
 * fixture. The *entity records* the old shape used to nest together are still present as clean,
 * independently structured JSON in the same Flight stream (a theatre record, a flat movies
 * array, and one flat object per showtime — see the shape guards below); what changed is that
 * the *association* between a showtime and its movie/format group now exists only in the
 * rendered HTML, expressed as `aria-describedby` IDREFs on each showtime's anchor element.
 *
 * This module exists because of the open finding `docs/backlog.md` records under "Two new
 * findings are open" ("Whether to build a resolver that reads the schedule pages'
 * movie/format/theatre association out of DOM/aria structure ... or accept `UPSTREAM_CHANGED`
 * as the shipped behavior for schedule pages indefinitely") — flagged there as needing a
 * decision from Josh Wu before either path was taken. That decision was made this session
 * (build the resolver); it is a distinct, previously-undecided item from both P5.4 (the
 * format/attribute normalization *table*, still open — no canonical code vocabulary is
 * approved) and P5.5 (`performancePolicy` still has no caller — unrelated, still open).
 *
 * Per the standing rule this decision was made under: this resolver never treats an IDREF
 * token's text as data. It only ever uses an IDREF to look up the real element with that `id`
 * and reads *that element's own* content (its `aria-label` or text). The one place an ID string
 * is compared at all is an exact whole-value equality check against an independently known
 * movie `slug` (itself real structured JSON) — never a substring/decomposition of the token.
 * Every invariant violation is `UPSTREAM_CHANGED`, never a silent partial result.
 *
 * Because the rendered HTML never exposes an upstream `code` for a format or attribute — only
 * a human display name — this resolver never populates `format`/`attributes` on the groups it
 * returns (DOM display names must not be promoted into normalized core fields — that is exactly
 * the vocabulary-source decision P5.4 is still blocked on). It surfaces the raw names separately
 * via `rawFormatName`/`rawAttributeNames` so the caller can carry them as `providerMeta`
 * evidence only.
 */

interface TheatreRecord {
  [key: string]: unknown;
  theatreId: number;
  name: string;
  postalCode: string;
  stateCode: string;
  utcOffset: string;
  isSelected: boolean;
  outageDescription?: string | null;
}

interface MovieRecord {
  [key: string]: unknown;
  movieId: number;
  name: string;
  slug: string;
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
    typeof v.postalCode === "string" &&
    typeof v.stateCode === "string" &&
    typeof v.utcOffset === "string" &&
    typeof v.isSelected === "boolean" &&
    (v.outageDescription === undefined ||
      v.outageDescription === null ||
      typeof v.outageDescription === "string")
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

function upstreamChanged(message: string, requestUrl: string, observationTime: Date): never {
  throw new ProviderError("UPSTREAM_CHANGED", message, {
    providerMeta: { requestUrl, observationTime },
  });
}

/**
 * Reconstructs a `PublicTheatreSchedule`-shaped plain object from the rendered HTML plus the
 * independently structured Flight-stream entity records, or throws `UPSTREAM_CHANGED`. The
 * returned value is intentionally shaped to match `PublicTheatreScheduleSchema` so the existing
 * per-group `parseShowtimes` loop needs no branching to consume it.
 */
function resolveScheduleFromDomImpl(
  html: string,
  requestUrl: string,
  observationTime: Date,
): unknown {
  // The schedule page also renders a "nearby theatres" picker widget, whose entries match the
  // same shape (real AMC other-theatre records, not junk) — every entry in that widget except
  // the schedule's own theatre carries `isSelected: false`. `isSelected` is a genuine field
  // AMC's own client uses to highlight the active theatre, not a heuristic invented here.
  const theatreRecords = extractShapeFromHtml<TheatreRecord>(
    html,
    isTheatreRecord,
    "AmcTheatreRecord",
  );
  const selected = theatreRecords.filter((t) => t.isSelected === true);
  if (selected.length !== 1) {
    upstreamChanged(
      `Expected exactly one theatre record with isSelected=true in the Flight payload, found ${selected.length}`,
      requestUrl,
      observationTime,
    );
  }
  const theatre = selected[0]!;

  // Some other embeds of the same theatre (e.g. a movie-detail preload widget) omit
  // `isSelected` entirely rather than setting it `false`, but still carry the same theatreId —
  // require they agree with the selected record rather than silently ignoring a discrepancy.
  const conflicting = theatreRecords.filter(
    (t) =>
      t.theatreId === theatre.theatreId &&
      (t.postalCode !== theatre.postalCode ||
        t.stateCode !== theatre.stateCode ||
        t.utcOffset !== theatre.utcOffset ||
        t.name !== theatre.name),
  );
  if (conflicting.length > 0) {
    upstreamChanged(
      `Multiple theatre records for theatreId ${theatre.theatreId} disagree on name/postalCode/stateCode/utcOffset`,
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

  // AMC's own page renders a genuine `role="alert"` element with this exact message when a
  // theatre legitimately has no showtimes posted for the requested date — a real, structured
  // signal (ARIA alert role + literal upstream copy), not a heuristic invented here. A
  // temporarily closed theatre instead carries a non-empty `outageDescription` on its theatre
  // record (AMC's own structured closure field) and/or a "temporarily closed" alert. Checked
  // only after collecting real evidence (showtime records, showtime anchors): an empty-state
  // signal next to actual showtime evidence is a contradictory state (e.g. a stale/hidden
  // banner), never silently trusted over real data.
  const noShowtimesAlert = $('[role="alert"]')
    .toArray()
    .some((el) => /no showtimes found|temporarily closed/i.test($(el).text()));
  const hasOutageDescription =
    typeof theatre.outageDescription === "string" && theatre.outageDescription.trim().length > 0;
  const emptyState = noShowtimesAlert || hasOutageDescription;
  const hasEvidence = showtimeRecords.length > 0 || anchors.length > 0;

  if (emptyState && hasEvidence) {
    upstreamChanged(
      "Found an empty-schedule signal (no-showtimes/temporarily-closed alert or outageDescription) alongside real showtime evidence (records or anchors) — contradictory state",
      requestUrl,
      observationTime,
    );
  }
  if (emptyState && !hasEvidence) {
    return {
      theatre: {
        name: theatre.name,
        theatreId: theatre.theatreId,
        postalCode: theatre.postalCode,
        stateCode: theatre.stateCode,
        utcOffset: theatre.utcOffset,
      },
      selectedDate: new URL(requestUrl).searchParams.get("date") ?? "",
      groups: [],
    };
  }
  if (!hasEvidence) {
    upstreamChanged(
      "No showtime records and no showtime anchors found, and no 'no showtimes found' alert present to explain the absence",
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

  const movieRecords = extractShapeFromHtml<MovieRecord>(html, isMovieRecord, "AmcMovieRecord");
  const movieBySlug = new Map<string, MovieRecord>();
  for (const m of movieRecords) {
    movieBySlug.set(m.slug, m);
  }

  interface Group {
    movie: MovieRecord;
    rawFormatName: string | null;
    rawAttributeNames: string[];
    showtimes: ShowtimeRecord[];
  }
  const groups = new Map<string, Group>();
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
        `Showtime anchor ${idAttr} has no aria-describedby to resolve its movie/format association`,
        requestUrl,
        observationTime,
      );
    }
    const tokens = describedBy.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      upstreamChanged(
        `Showtime anchor ${idAttr} has an empty aria-describedby`,
        requestUrl,
        observationTime,
      );
    }

    // The movie is always the first IDREF. Per the standing rule, the token is only trusted
    // once it's confirmed to reference a real element in the rendered document — never
    // compared as bare text. Only then is that element's own `id` (the resolved IDREF target,
    // not the token string) checked for whole-value equality against an independently known
    // movie `slug` from the Flight stream — never a decomposition of its characters.
    const movieToken = tokens[0]!;
    const movieEl = byId.get(movieToken);
    if (!movieEl) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s first aria-describedby token "${movieToken}" has no matching element in the rendered HTML`,
        requestUrl,
        observationTime,
      );
    }
    const movie = movieBySlug.get(movieToken);
    if (!movie) {
      upstreamChanged(
        `Showtime anchor ${idAttr}'s first aria-describedby token "${movieToken}" does not match any known movie slug`,
        requestUrl,
        observationTime,
      );
    }

    // The attributes list, if present, is always the last IDREF and is only trusted once the
    // referenced element is confirmed to actually be a list container — never assumed from the
    // token text.
    const lastToken = tokens[tokens.length - 1]!;
    const lastEl = byId.get(lastToken);
    const hasAttributesList = lastEl != null && lastEl.is("ul, ol");
    const rawAttributeNames: string[] = hasAttributesList
      ? lastEl
          .find("li")
          .toArray()
          .map((li) => $(li).text().trim())
          .filter((t) => t.length > 0)
      : [];

    // Remaining middle tokens (excluding the movie and, if resolved, the attributes list) are
    // candidate format-group references. AMC's real markup for a format heading (verified
    // against a real capture) nests three sibling `<span>`s under the target: the plain name
    // (`<span>Dolby Cinema at AMC</span>`), an `sr-only` separator, and a promotional tagline
    // that itself wraps an interactive "More Info" `<button>`
    // (`<span class="...">COMPLETELY CAPTIVATING<button aria-label="More Info" ...></span>`).
    // Naively taking the target's full text (or its first child's full text) concatenates the
    // tagline into the name. The real name is the first non-`sr-only` `<span>` descendant that
    // has no element children of its own — the tagline span is excluded because it contains
    // the button element, not by guessing at its text content.
    // Never falls back to the target's raw container text: if no single qualifying leaf span
    // is found, the structure doesn't match the known-good pattern and the name is left `null`
    // rather than risking silently blessing ambiguous/marketing container text as evidence (or
    // as part of the group key below).
    // Middle tokens can include non-format references too. AMC's real markup (verified against
    // every committed schedule fixture) lists them deepest-last: a theatre-name reference, then
    // a non-rendered "group key" token that is never an actual element's `id` anywhere in the
    // document (present in the token list but not the DOM — this is the normal, universal shape
    // of AMC's own markup, not an anomaly), then the format heading's real, uniquely-suffixed
    // id as the deepest (last) middle token. Only that deepest middle token is ever consulted:
    // shallower middle tokens (the theatre-name reference, the non-rendered group key) are
    // never inspected, so whether they happen to resolve to an element is irrelevant. If the
    // deepest middle token itself does not resolve to a real element, that is a genuine
    // structural anomaly (not the expected shape) and the resolver throws rather than silently
    // falling through to a shallower, unrelated token (e.g. the theatre name).
    const middleTokens = tokens.slice(1, hasAttributesList ? -1 : tokens.length);
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

    // Groups are keyed by (movie, format, attribute set) — the same granularity the old
    // structured `groups[]` shape used. Two showtimes with the same movie+format but a
    // different attribute set are genuinely different groups, not a merge.
    const groupKey = `${movie.movieId}::${rawFormatName ?? ""}::${[...rawAttributeNames].sort().join("|")}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { movie, rawFormatName, rawAttributeNames, showtimes: [] };
      groups.set(groupKey, group);
    }
    group.showtimes.push(showtimeRecord);
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

  return {
    theatre: {
      name: theatre.name,
      theatreId: theatre.theatreId,
      postalCode: theatre.postalCode,
      stateCode: theatre.stateCode,
      utcOffset: theatre.utcOffset,
    },
    selectedDate: new URL(requestUrl).searchParams.get("date") ?? "",
    groups: Array.from(groups.values()).map((g) => ({
      movie: { name: g.movie.name, movieId: g.movie.movieId },
      // Never `format`/`attributes` here — no upstream `code` is available from the DOM, only
      // a human display name, and this schema's `format.name`/`attributes[].name` are meant
      // for genuine upstream records. The raw names are carried separately below for
      // `parseShowtimes` to place directly into `providerMeta`.
      rawFormatName: g.rawFormatName,
      rawAttributeNames: g.rawAttributeNames,
      showtimes: g.showtimes,
    })),
  };
}

export function resolveScheduleFromDom(
  html: string,
  requestUrl: string,
  observationTime: Date,
): unknown {
  try {
    return resolveScheduleFromDomImpl(html, requestUrl, observationTime);
  } catch (error) {
    // UPSTREAM_CHANGED-only raw capture: no headers exist at this boundary, so only the
    // genuinely in-scope body + URL are attached. Other error codes pass through untouched.
    attachUpstreamChangedDiagnostic(error, { url: requestUrl, body: html });
    throw error;
  }
}
