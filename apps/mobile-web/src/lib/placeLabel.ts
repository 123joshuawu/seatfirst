/**
 * Display-only US place-label formatting.
 *
 * Visible labels omit a terminal `United States` and abbreviate a terminal
 * full US state name to its postal code:
 *   `San Francisco, California, United States` -> `San Francisco, CA`
 *
 * Raw Mapbox labels are preserved for resolution; this helper is pure display.
 * Unknown strings and non-US labels are returned unchanged.
 */

const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

export function formatUsPlaceLabel(label: string): string {
  if (!label) return label;

  // Split on comma so we can reason about terminal segments. Preserve
  // interior segments verbatim except for trimming surrounding whitespace.
  const parts = label.split(",").map((s) => s.trim());

  // Remove a terminal "United States" (case-insensitive, display-only).
  if (parts.at(-1)?.toLowerCase() === "united states") {
    parts.pop();
    if (parts.length === 0) return "";
  }

  if (parts.length === 0) return "";

  const last = parts.at(-1);
  if (last === undefined) return "";
  const key = last.toLowerCase();
  const abbr = US_STATE_ABBREVIATIONS[key];
  if (abbr) {
    parts[parts.length - 1] = abbr;
  }

  return parts.join(", ");
}
