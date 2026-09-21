import { z } from "zod";
import { formatNamespacedId, TheatreIdSchema, TheatreSchema, type Theatre, type TheatreAmenity } from "@seatfirst/core";
import { extractShapeFromHtml } from "../flight.js";
import { ProviderError, attachUpstreamChangedDiagnostic } from "../../errors.js";
import { resolvePostalCodeTimezone } from "../postal-timezone.js";
import { normalizeStateCode } from "../us-states.js";

const PublicTheatreSummarySchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    theatreId: z.number(),
    marketSlug: z.string(),
    address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        stateCode: z.string().optional(),
        postalCode: z.string().optional(),
      })
      .optional(),
    addressLine1: z.string().nullable().optional(),
    addressLine2: z.string().nullable().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    utcOffset: z.string().optional(),
    marketName: z.string().optional(),
    attributes: z
      .object({
        edges: z
          .array(
            z.object({
              node: z.object({
                code: z.string(),
                name: z.string(),
                details: z
                  .object({
                    sort: z.number().int().optional(),
                  })
                  .optional(),
              }),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type PublicTheatreSummary = z.infer<typeof PublicTheatreSummarySchema>;

// The one namespace every AMC-sourced id is built under (P1.6/P5.8) — never reconstructed
// ad hoc at a call site.
const PROVIDER_ID = "amc";

function parseTheatresImpl(html: string, observationTime: Date, requestUrl: string): Theatre[] {
  const extracted = extractShapeFromHtml<PublicTheatreSummary>(
    html,
    (val) => typeof val.theatreId === "number" && typeof val.marketSlug === "string",
    "PublicTheatreSummary",
  );

  const theatres: Theatre[] = [];

  for (const raw of extracted) {
    const parsed = PublicTheatreSummarySchema.safeParse(raw);
    if (!parsed.success) {
      const err = parsed.error.issues[0];
      throw new ProviderError("UPSTREAM_CHANGED", `Theatre validation failed: ${err?.message}`, {
        providerMeta: { requestUrl, observationTime },
      });
    }

    const t = parsed.data;

    // Missing lat/lng is a legitimate per-entry gap (some AMC theatre records carry it, some
    // don't) — skip only this entry, no Null Island fallback.
    if (t.latitude == null || t.longitude == null) {
      continue;
    }

    // Missing postalCode is the same kind of legitimate per-entry gap — the theatre-discovery
    // page's `address` block is itself optional (docs/amc-public-website-api-spec.md:414-419),
    // and some entries carry a partial address. Skip; do not invent a postal code.
    const postalCode = t.address?.postalCode ?? t.postalCode;
    if (postalCode == null) {
      continue;
    }

    // P5.14 (docs/tasks/P5-amc-parsers-provider/spec.md): resolve the theatre's IANA zone from
    // its postal code via the vendored, offline-built table — never from AMC's own UtcOffset,
    // which is only a snapshot and cannot say whether a zone observes Daylight Saving Time. A
    // postal code AMC actually sent but that the table does not recognize is a genuine data
    // problem (an unmapped/foreign code, or a stale table), not a legitimate per-entry gap —
    // fail loudly (P5.3) rather than silently drop the theatre or guess from the offset.
    const timezone = resolvePostalCodeTimezone(postalCode);
    if (timezone == null) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Postal code "${postalCode}" is not in the timezone table`,
        { providerMeta: { requestUrl, observationTime, theatreId: t.theatreId, postalCode } },
      );
    }

    const id = TheatreIdSchema.parse(
      formatNamespacedId({ providerId: PROVIDER_ID, kind: "theatre", raw: String(t.theatreId) }),
    );

    theatres.push(
      TheatreSchema.parse({
        id,
        providerId: PROVIDER_ID,
        name: t.name,
        location: { lat: t.latitude, lng: t.longitude },
        timezone,
        city: extractCity(t),
        address: formatAddress(t),
        // Keyed by marketSlug: AMC's own route shape is
        // /movie-theatres/{marketSlug}/{theatreSlug}/showtimes
        // (docs/amc-public-website-api-spec.md:551), so any single entry is enough to
        // reconstruct a working deep link. Not an established contract elsewhere in the
        // codebase (`TheatreRefSchema.slugs` at packages/core/src/search-spec.ts:46 leaves the
        // key open) — this is the engineering decision, made and documented here.
        slugs: { [t.marketSlug]: t.slug },
        amenities: extractAmenities(t),
        // No persistence/merge happens in this pure parser (that is S2's job): both timestamps
        // are "as observed in this single parse," not a claim about when the theatre was first
        // seen across all history. A caller that already has a stored `firstSeenAt` keeps it;
        // this parser only ever reports the truth of this one payload.
        firstSeenAt: observationTime,
        lastSeenAt: observationTime,
      }),
    );
  }

  return theatres;
}

export function parseTheatres(html: string, observationTime: Date, requestUrl: string): Theatre[] {
  try {
    return parseTheatresImpl(html, observationTime, requestUrl);
  } catch (error) {
    // UPSTREAM_CHANGED-only raw capture: no headers exist at this boundary, so only the
    // genuinely in-scope body + URL are attached. Other error codes pass through untouched.
    attachUpstreamChangedDiagnostic(error, { url: requestUrl, body: html });
    throw error;
  }
}

export function extractAmenities(t: PublicTheatreSummary): TheatreAmenity[] {
  const amenities: TheatreAmenity[] = [];
  for (const edge of t.attributes?.edges ?? []) {
    const amenity: TheatreAmenity = { code: edge.node.code, name: edge.node.name };
    if (typeof edge.node.details?.sort === "number") {
      amenity.sort = edge.node.details.sort;
    }
    amenities.push(amenity);
  }
  amenities.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));
  return amenities;
}

function extractCity(t: PublicTheatreSummary): string | null {
  // ADR 0029 §7 (a): `city` column populated from the address data the crawler already
  // captures. Two shapes: nested `?q=` search-result (`address.city`) and flat
  // `/movie-theatres/{marketSlug}` (`city` top-level, docs/amc-catalogue-plan.md §6.3).
  // Reuses the same flat-address-shape handling ADR 0021's Consequences reference
  // (`packages/core/src/theatre.ts:21`, `postal-timezone.ts`), not a second competing parser.
  const raw = t.address?.city ?? t.city ?? null;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatAddress(t: PublicTheatreSummary): string | null {
  // Nested `?q=` search-result shape: keep the exact original behaviour.
  if (t.address != null) {
    const parts = [
      t.address.street,
      t.address.city,
      t.address.stateCode,
      t.address.postalCode,
    ].filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join(", ") : null;
  }

  // Flat `/movie-theatres/{marketSlug}` shape (docs/amc-catalogue-plan.md §6.3): address fields
  // sit directly on the theatre record, and `state` is a full name that must be normalized.
  const parts = [
    t.addressLine1,
    t.city,
    t.state != null ? normalizeStateCode(t.state) : undefined,
    t.postalCode,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(", ") : null;
}
