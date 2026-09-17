import { IanaTimezoneSchema, type IanaTimezone } from "@seatfirst/core";
import { POSTAL_TIMEZONE_TABLE } from "./postal-timezone-table.generated.js";

// P5.14 (docs/tasks/P5-amc-parsers-provider/spec.md): AMC's payloads carry a theatre's
// postalCode/stateCode but never an IANA timezone name — `TheatreSchema.timezone` (G1.1) needs
// a real one, and `toTheatreLocal` (E6.2) forbids deriving one from a stored UTC offset (an
// offset alone cannot say whether a zone observes Daylight Saving Time).
//
// This table was built once, offline, from public Census/geo-tz data
// (`scripts/generate-postal-timezone-table.mjs`) — there is no live geocoding call here,
// mirroring G1.6's "no network" rule for parser-adjacent code. Decision recorded in
// `docs/open-questions.md` "Resolved", 2026-08-13 (Josh Wu).
//
// Keyed on the 5-digit ZIP/ZCTA only: a US ZIP code belongs to exactly one state, so
// `stateCode` is not part of the lookup key. It is not validated against `stateCode` here
// either — this function is a pure table lookup, nothing more; a caller that wants a
// postalCode/stateCode consistency check owns that decision separately.

/**
 * Resolve a US postal code (plain ZIP or ZIP+4) to its IANA timezone.
 *
 * Returns `undefined` — never a guess, never a throw — when the code is missing, malformed, or
 * absent from the table. Whether that absence is fatal is the caller's call (P5.3: fail loudly
 * on a missing dimension rather than inventing a value; this function only supplies the data,
 * it does not decide what "missing" means for the parser that calls it).
 */
export function resolvePostalCodeTimezone(postalCode: string): IanaTimezone | undefined {
  const zip = normalizeZip(postalCode);
  if (!zip) return undefined;

  const zone = POSTAL_TIMEZONE_TABLE[zip];
  if (!zone) return undefined;

  const parsed = IanaTimezoneSchema.safeParse(zone);
  return parsed.success ? parsed.data : undefined;
}

// AMC's payload has been observed to carry plain 5-digit ZIPs. ZIP+4 ("94103-1234") is
// tolerated defensively by taking the leading 5 digits — the standard ZCTA key the table is
// built on. Anything that does not start with 5 digits is not a US ZIP and is not looked up.
function normalizeZip(postalCode: string): string | undefined {
  const match = /^(\d{5})/.exec(postalCode.trim());
  return match?.[1];
}
