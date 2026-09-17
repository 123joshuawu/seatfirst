// Postal abbreviations for every US state, the District of Columbia, and the territories AMC's
// theatre catalogue can plausibly list. Keys are the full names AMC emits on the
// `/movie-theatres/{marketSlug}` page (e.g. "Georgia"), values are the 2-letter codes (e.g. "GA").
// Ordered alphabetically by full name; this is a small vendored table in the same spirit as
// postal-timezone-table.generated.ts, not a live/remote lookup.
//
// Source of the confirmed raw shape: docs/amc-catalogue-plan.md §6.3 — the {marketSlug} theatre
// page puts `state` (a full state name) flat on the theatre record, unlike the `?q=`
// search-result shape's nested `address.stateCode`.
export const US_STATE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  Alabama: "AL",
  Alaska: "AK",
  "American Samoa": "AS",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Guam: "GU",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  "Northern Mariana Islands": "MP",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Puerto Rico": "PR",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  "US Virgin Islands": "VI",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
};

// Case-insensitive lookup index, built once at module load. Keys are lowercase full names
// (→ code) and lowercase codes (→ code, their own identity). Codes are folded in directly
// rather than special-cased in `normalizeStateCode`, so a single lookup covers both spellings.
const STATE_CODE_LOOKUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [name, code] of Object.entries(US_STATE_ABBREVIATIONS)) {
    map.set(name.toLowerCase(), code);
    map.set(code.toLowerCase(), code);
  }
  return map;
})();

/**
 * Normalize AMC's full state name ("Georgia") to its 2-letter postal code ("GA"), for display.
 *
 * Lookup is case-insensitive and tolerates surrounding whitespace. An input that is already a
 * valid 2-letter code is its own identity (case-normalized to upper); anything else passes
 * through unchanged rather than throwing.
 *
 * Why passthrough instead of fail-loudly: this value only ever feeds `Theatre.address`
 * (packages/core/src/theatre.ts:21), a free-text nullable display string with no format contract
 * and no downstream identity or timezone use — `resolvePostalCodeTimezone`
 * (packages/providers/src/amc/postal-timezone.ts) resolves timezone from `postalCode` alone,
 * never from `state`/`stateCode`. Throwing here would abort an entire theatre-list parse over a
 * cosmetic mismatch, unlike the postal-code-to-timezone lookup which DOES throw
 * `UPSTREAM_CHANGED` because a missing zone is correctness-relevant.
 */
export function normalizeStateCode(raw: string): string {
  return STATE_CODE_LOOKUP.get(raw.trim().toLowerCase()) ?? raw;
}
