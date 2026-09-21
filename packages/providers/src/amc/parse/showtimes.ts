import { z } from "zod";
import {
  formatNamespacedId,
  ShowtimeIdSchema,
  TheatreIdSchema,
  MovieIdSchema,
  toTheatreLocal,
  UtcInstantSchema,
} from "@seatfirst/core";
import { type Performance, PerformanceSchema } from "../../contract.js";
import { extractShapeFromHtml } from "../flight.js";
import { resolveScheduleFromDom } from "./schedule-dom.js";
import { ProviderError, attachUpstreamChangedDiagnostic } from "../../errors.js";
import { resolvePostalCodeTimezone } from "../postal-timezone.js";
import { buildSeatsUrl } from "../routes.js";
import {
  normalizeShowtimeStatus,
  normalizeFormatCode,
  normalizeAttributeCode,
  resolvePooledOffering,
} from "../normalize.js";

const PublicShowtimeSchema = z
  .object({
    showtimeId: z.number(),
    policyCodes: z.array(z.string()).optional(),
    hasTrailers: z.boolean().optional(),
    status: z.string(),
    // Validated as a real UTC-Z ISO instant (not `z.string()`) so a malformed upstream
    // timestamp fails loudly here (P5.3) rather than producing `Invalid Date` — or throwing a
    // raw `RangeError` from `.toISOString()` — deep inside the local-time conversion below.
    showDateTimeUtc: UtcInstantSchema,
    display: z
      .object({
        time: z.string(),
        amPm: z.string(),
      })
      .optional(),
    discountMatineeMessage: z.string().nullable().optional(),
    maximumIntendedAttendance: z.number().nullable().optional(),
  })
  .passthrough();

const PublicShowtimeGroupSchema = z
  .object({
    movie: z
      .object({
        name: z.string(),
        movieId: z.number(),
        runTimeMinutes: z.number().nullable().optional(),
      })
      .passthrough(),
    format: z
      .object({
        code: z.string().optional(),
        name: z.string(),
      })
      .optional(),
    attributes: z
      .array(
        z
          .object({
            code: z.string().optional(),
            name: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    showtimes: z.array(PublicShowtimeSchema),
  })
  .passthrough();

const PublicTheatreScheduleSchema = z
  .object({
    theatre: z
      .object({
        name: z.string(),
        theatreId: z.number(),
        // docs/amc-public-website-api-spec.md:611-624 (approved): the schedule row's own
        // `theatre` object carries `postalCode` directly, alongside `stateCode`/`utcOffset` —
        // it does not need to be cross-referenced from a separate Flight row. P5.14 resolves
        // the IANA zone from this field; never from `utcOffset`, which cannot say whether the
        // zone observes Daylight Saving Time.
        postalCode: z.string(),
        stateCode: z.string(),
        utcOffset: z.string(),
      })
      .passthrough(),
    selectedDate: z.string(),
    groups: z.array(PublicShowtimeGroupSchema),
  })
  .passthrough();

export type PublicTheatreSchedule = z.infer<typeof PublicTheatreScheduleSchema>;

// The one namespace every AMC-sourced id is built under (P1.6/P5.8) — never reconstructed
// ad hoc at a call site. Matches parse/theatres.ts's own constant of the same name/value.
const PROVIDER_ID = "amc";

function parseShowtimesImpl(
  html: string,
  observationTime: Date,
  requestUrl: string,
): Performance[] {
  let raw: unknown;
  try {
    const extracted = extractShapeFromHtml(
      html,
      (val) =>
        typeof val.selectedDate === "string" && Array.isArray(val.groups) && val.theatre != null,
      "PublicTheatreSchedule",
    );
    raw = extracted[0];
  } catch (err) {
    if (!(err instanceof ProviderError) || err.code !== "UPSTREAM_CHANGED") {
      throw err;
    }
    // Schedule DOM/ARIA-association resolver (docs/backlog.md, "Two new findings are open" —
    // decided this session): the old single-object Flight shape is gone from every committed
    // fixture. Fall back to reconstructing the same shape from the rendered HTML plus the
    // still-structured entity records — see schedule-dom.ts. This resolver throws its own
    // UPSTREAM_CHANGED (uncaught here) if it can't establish the invariants either.
    raw = resolveScheduleFromDom(html, requestUrl, observationTime);
  }
  const parsed = PublicTheatreScheduleSchema.safeParse(raw);
  if (!parsed.success) {
    const err = parsed.error.issues[0];
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Showtime schedule validation failed: ${err?.message} at ${err?.path.join(".")}`,
      {
        providerMeta: { requestUrl, observationTime },
      },
    );
  }
  const { theatre, groups } = parsed.data;

  // P5.14: resolve the IANA zone from the theatre's postal code (approved spec, see comment on
  // the schema above) — never from `theatre.utcOffset`, a fixed offset that cannot say whether
  // the zone observes Daylight Saving Time. A postal code AMC actually sent but the vendored
  // table does not recognize is a genuine data problem, not a legitimate per-entry gap.
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

  const performances: Performance[] = [];
  for (const group of groups) {
    const movieId = MovieIdSchema.parse(
      formatNamespacedId({
        providerId: PROVIDER_ID,
        kind: "movie",
        raw: String(group.movie.movieId),
      }),
    );
    // P5.4/ADR 0008 (`docs/adr/0008-p5-4-format-attribute-vocabulary.md`, approved): format/
    // attribute codes go through table-driven normalization, the same mechanism as seat
    // kind/status (normalize.ts). `FORMAT_CODE_MAP`/`ATTRIBUTE_CODE_MAP` (normalize.ts) hold two
    // disjoint domains, used two different ways here:
    //  - The old structured shape's real API `code` fields (`rawAttributes`/`rawFormatCode`
    //    below) go through `normalizeAttributeCode`/`normalizeFormatCode` directly — that
    //    domain is still empty in the maps (no observed alias pair exists for real API codes),
    //    so this stays full passthrough.
    //  - The schedule DOM resolver's raw display-name strings (`rawFormatName`/
    //    `rawAttributeNames` below) go through `resolvePooledOffering` instead, which checks
    //    membership in the same two maps (ADR 0008's approved 34-entry display-name
    //    vocabulary) but pools both fields together first: ADR 0008 established that DOM
    //    position is not a reliable category signal, so `rawFormatName`/`rawAttributeNames`
    //    are pooled per performance before normalizing, never mapped independently by field.
    // The two domains never overlap on the same group in practice (`group.format`/
    // `group.attributes` are absent for DOM-resolved groups, so `rawAttributes`/`rawFormatCode`
    // are already `[]`/`null` for them) but are still merged defensively below rather than
    // branched on "which path produced this group."
    const rawAttributes = (group.attributes ?? []).map((a) => a.code ?? a.name);
    const rawFormatCode = group.format?.code ?? null;
    const legacyAttributes = rawAttributes.map(normalizeAttributeCode);
    const legacyFormatCode = rawFormatCode == null ? null : normalizeFormatCode(rawFormatCode);

    const rawFormatName = typeof group.rawFormatName === "string" ? group.rawFormatName : null;
    const rawAttributeNames = Array.isArray(group.rawAttributeNames)
      ? group.rawAttributeNames.filter((x): x is string => typeof x === "string")
      : [];
    const pooled = [
      ...(rawFormatName != null ? [{ raw: rawFormatName, fromHeading: true }] : []),
      ...rawAttributeNames.map((raw) => ({ raw, fromHeading: false })),
    ];
    const domResolved = resolvePooledOffering(pooled);

    const attributes = [
      ...new Set([
        ...legacyAttributes,
        ...(legacyFormatCode != null ? [legacyFormatCode] : []),
        ...domResolved.attributes,
      ]),
    ];
    const formatCode = legacyFormatCode ?? domResolved.formatCode;
    const runtimeMinutes = group.movie.runTimeMinutes ?? null;

    for (const st of group.showtimes) {
      const showtimeId = ShowtimeIdSchema.parse(
        formatNamespacedId({
          providerId: PROVIDER_ID,
          kind: "showtime",
          raw: String(st.showtimeId),
        }),
      );
      const showDateTimeUtc = new Date(st.showDateTimeUtc);
      const local = toTheatreLocal(st.showDateTimeUtc, timezone);

      const candidate = {
        showtimeId,
        providerId: PROVIDER_ID,
        // P5.4: the raw upstream status/format/attribute strings live in providerMeta, never
        // as named columns — only their normalized forms (below) are the core fields.
        providerMeta: {
          requestUrl,
          observationTime: observationTime.toISOString(),
          rawStatus: st.status,
          rawFormatCode,
          rawAttributes,
          // Schedule DOM resolver evidence only — null/[] for groups sourced from the old
          // structured shape, where a real `code` was (or wasn't) already captured above.
          rawFormatName,
          rawAttributeNames,
        },
        theatreId,
        movieId,
        // S24.4: carry the movie title through the parse seam so the schedule-acceptance
        // write can populate the movie catalogue (S24.5). Source is the same required
        // `group.movie.name` both parse paths read — the structured schema (line 47) and
        // the DOM-resolver path's `MovieRecord` guard alike — so every resolved
        // performance has one.
        movieTitle: group.movie.name,
        // P5.10: auditorium identity may be unrecoverable per showtime — AMC's schedule payload
        // never carries one, so this is always null, never a required/derived value.
        auditorium: null,
        showDateTimeUtc,
        showDateTimeLocal: local.localDateTime,
        utcOffset: local.utcOffset,
        runtimeMinutes,
        // P5.4/P5.5: maps the native status string to `ShowtimeStatus` via the normalization
        // table (P5.4). Deciding what to do with that status (fetch vs. skip seats, C1's
        // `performancePolicy`) is not this parser's job (P5.2: pure, no I/O). See
        // docs/backlog.md P5 for the current state of that orchestration decision.
        status: normalizeShowtimeStatus(st.status),
        attributes,
        formatCode,
        // P5.13: null until the seat fetch resolves — prices are not on the schedule.
        minPrice: null,
        // Real, allowlist-validated deep link (the baseline seats map carries zero params),
        // built from the validated numeric upstream id (`PublicShowtimeSchema.showtimeId`
        // is `z.number()`), mirroring the movie-first parser — never the schedule listing
        // page's own request URL. `getSchedule` (provider.ts) recomputes the same value via
        // `deepLink`, so its enrichment is now idempotent for schedule-resolved rows.
        deepLinkUrl: buildSeatsUrl(st.showtimeId).toString(),
        // The schedule payload carries no seat-layout id — only the seat page does.
        layoutId: null,
      };

      const validated = PerformanceSchema.safeParse(candidate);
      if (!validated.success) {
        throw new ProviderError(
          "UPSTREAM_CHANGED",
          `Performance validation failed: ${validated.error.issues[0]?.message}`,
          { providerMeta: { requestUrl, observationTime, showtimeId: st.showtimeId } },
        );
      }
      performances.push(validated.data);
    }
  }

  return performances;
}

export function parseShowtimes(
  html: string,
  observationTime: Date,
  requestUrl: string,
): Performance[] {
  try {
    return parseShowtimesImpl(html, observationTime, requestUrl);
  } catch (error) {
    // UPSTREAM_CHANGED-only raw capture: no headers exist at this boundary, so only the
    // genuinely in-scope body + URL are attached. Other error codes pass through untouched.
    attachUpstreamChangedDiagnostic(error, { url: requestUrl, body: html });
    throw error;
  }
}
