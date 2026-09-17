import type { SeatKind, ShowtimeStatus } from "@seatfirst/core";

export const SHOWTIME_STATUS_MAP: Record<string, ShowtimeStatus> = {
  Sellable: "OPEN",
  AlmostFull: "LOW_AVAILABILITY",
  Soldout: "SOLD_OUT",
  Canceled: "CANCELED", // Fallback for safety, though mostly we see Soldout/Sellable
};

export const SEAT_KIND_MAP: Record<string, SeatKind> = {
  CanReserve: "STANDARD",
  Wheelchair: "WHEELCHAIR",
  Companion: "COMPANION",
  NotASeat: "NOT_A_SEAT",
};

/**
 * Ensures unknown statuses fallback to UNKNOWN while returning a typed core status.
 */
export function normalizeShowtimeStatus(status: string): ShowtimeStatus {
  return SHOWTIME_STATUS_MAP[status] ?? "UNKNOWN";
}

/**
 * Ensures unknown types fallback to UNKNOWN while returning a typed core kind.
 */
export function normalizeSeatKind(type: string): SeatKind {
  return SEAT_KIND_MAP[type] ?? "UNKNOWN";
}

/**
 * P5.4/ADR 0008 (`docs/adr/0008-p5-4-format-attribute-vocabulary.md`, approved 2026-08-14):
 * table-driven canonicalization for native format-code/name variants, mirroring the mechanism
 * used for seat kind/status (`normalizeShowtimeStatus`/`normalizeSeatKind` above) — a `Record`
 * lookup, not an `if`-chain. Two disjoint domains share this one map, distinguished by key
 * shape, never colliding in practice:
 *  - Real upstream API `code` values from the old structured schedule shape
 *    (`group.format.code`, e.g. `docs/amc-public-website-api-spec.md:783-784`'s
 *    `{"code": "imax70mm", ...}`) — already lowercase/slug-shaped. None are present yet: that
 *    shape has not been observed in any committed fixture since the RSC change (ADR 0007).
 *  - The schedule DOM resolver's raw Title-Case display-name strings
 *    (`providerMeta.rawFormatName`), keyed exactly as extracted — ADR 0008's approved 12-entry
 *    presentation-format vocabulary, added below. 10 reuse the real `value` slug from AMC's own
 *    `<select name="premiumOffering">` filter (9 exact text matches, 1 near-miss reuse —
 *    `"PRIME 3D"` for the select's `"PRIME 3D at AMC"`); 2 (`Laser at AMC`,
 *    `IMAX with Laser at AMC`) have no select linkage and use an invented code following AMC's
 *    own observed slug convention. See the ADR's table for full per-entry sourcing.
 * A raw string with no entry here (either domain) passes through unchanged via
 * `normalizeFormatCode`, never guessed — `resolvePooledOffering` below applies a stricter,
 * ADR-0008-specific "drop, don't pass through" rule for the display-name domain specifically.
 */
export const FORMAT_CODE_MAP: Record<string, string> = {
  "4DX at AMC": "4dx",
  "70mm": "70mm",
  "PRIME at AMC": "amcprime",
  "Dolby Cinema at AMC": "dolbycinemaatamcprime",
  "IMAX at AMC": "imax",
  "IMAX 70MM": "imax70mm",
  "PRIME 3D": "prime3d",
  "RealD 3D": "reald3d",
  "SCREENX at AMC": "screenx",
  "XL at AMC": "xl",
  "Laser at AMC": "laseratamc",
  "IMAX with Laser at AMC": "imaxlaseratamc",
};

/**
 * Canonicalizes a known native format alias to one spelling; an unrecognized code or raw
 * display-name string passes through unchanged rather than collapsing to a sentinel (P5.4).
 * `resolvePooledOffering` below is the caller for the ADR 0008 display-name domain and applies
 * a *stricter* drop-if-unmapped rule specific to that pooling design — this passthrough
 * function is unaffected and keeps its original P5.4 contract for direct callers.
 */
export function normalizeFormatCode(code: string): string {
  return FORMAT_CODE_MAP[code] ?? code;
}

/**
 * P5.4/ADR 0008: same table-driven mechanism, same two-disjoint-domains-one-map design, and
 * same "no unevidenced entries" rule as `FORMAT_CODE_MAP` above, for native attribute-code/name
 * variants. The real-API-code domain is still empty (no evidence yet); the 22 non-format rows
 * of ADR 0008's approved vocabulary (accessibility/amenity, language/dub track, content
 * programming/series, eligibility/policy — see the ADR for the category breakdown and per-entry
 * sourcing) are populated below.
 */
export const ATTRIBUTE_CODE_MAP: Record<string, string> = {
  "Closed Caption": "closedcaption",
  "Audio Description": "descriptivevideo",
  "Heated AMC Signature Recliners": "heatedseats",
  "Open Caption (On-screen Subtitles)": "opencaption",
  "AMC Signature Recliners": "reclinerseating",
  "Reserved Seating": "reservedseating",
  "English Language Dubbed with No Subtitles": "englishdubbed",
  "Japanese Spoken with English Subtitles": "japaneseenglishsubtitle",
  "Korean Spoken with English Subtitles": "koreanenglishsubtitle",
  "Korean Spoken with No Subtitles": "koreanspoken",
  "Tamil Spoken with English Subtitles": "tamilenglishsubtitle",
  "Telugu Spoken with English Subtitles": "teluguenglishsubtitle",
  "Vietnamese Spoken with English Subtitles": "vietnameseenglishsubtitle",
  "AMC Artisan Films": "amcartisanfilms",
  "AMC Club Rockers": "amcclubrockers",
  "International Films": "intfilms",
  "Thrills & Chills": "thrlschls",
  "ID Required": "idrequired",
  "Excluded from A-List": "excludedfromalist",
  "No Passes": "nopasses",
  "Alternative Content": "alternativecontent",
  "No Trailers": "notrailers",
};

/**
 * Canonicalizes a known native attribute alias to one spelling; an unrecognized code or raw
 * display-name string passes through unchanged rather than collapsing to a sentinel (P5.4).
 * Same relationship to `resolvePooledOffering` as `normalizeFormatCode` above.
 */
export function normalizeAttributeCode(code: string): string {
  return ATTRIBUTE_CODE_MAP[code] ?? code;
}

/**
 * ADR 0008's pooling rule: collects every raw display-name string observed for one performance
 * from both DOM positions (the format heading and the attribute badge list) into one input,
 * because the same raw string is observed in either position depending on the fixture/theatre —
 * DOM position is not a reliable category signal, only the string's own meaning is. Membership
 * in `FORMAT_CODE_MAP` (not a separate flag) is what makes a pooled raw string a format
 * candidate; membership in `ATTRIBUTE_CODE_MAP` makes it a plain attribute. `fromHeading`
 * records which raw strings came from the dedicated format-heading position, used only as a
 * tie-break, never as the category decision itself.
 *
 * - `attributes`: the normalized code for every pooled raw string found in either map, deduped —
 *   including format codes, which are tagged in `attributes` too, not excluded from it.
 * - `formatCode`: the normalized code of whichever pooled raw string is a `FORMAT_CODE_MAP`
 *   member, preferring one that came from the heading position when more than one qualifies
 *   (observed in the corpus, e.g. a heading of `"IMAX 70MM"` alongside badges `"IMAX at AMC"`
 *   and `"70mm"` — ADR 0008's explicit tie-break). `null` when no pooled raw string is a
 *   `FORMAT_CODE_MAP` member (ADR 0008, explicit).
 *
 *   UNRESOLVED, not covered by ADR 0008: more than one qualifies and none came from the
 *   heading. Not observed in the corpus. Rather than silently picking one (an invented,
 *   unapproved precedence) this throws a plain `Error`, matching this codebase's convention of
 *   surfacing unhandled shapes loudly (`parseShowtimes`'s caller maps any thrown error to the
 *   `UPSTREAM_CHANGED` provider outcome — see `packages/providers/src/amc/provider.ts`) rather
 *   than emitting a guessed value as if it were decided product output. Needs an explicit
 *   decision (a new ADR note or amendment) before this case can return a value.
 * - A pooled raw string absent from both maps is dropped — unlike `normalizeFormatCode`/
 *   `normalizeAttributeCode`'s passthrough-if-unmapped contract, pooling never passes through:
 *   it contributes to neither `attributes` nor `formatCode`, and is never invented ad hoc at
 *   parse time (ADR 0008). A new raw string requires a table update reviewed the same way as
 *   the ADR's table.
 */
export function resolvePooledOffering(pooled: Array<{ raw: string; fromHeading: boolean }>): {
  formatCode: string | null;
  attributes: string[];
} {
  const attributes: string[] = [];
  const formatCandidates: Array<{ code: string; fromHeading: boolean }> = [];
  for (const { raw, fromHeading } of pooled) {
    if (raw in FORMAT_CODE_MAP) {
      const code = FORMAT_CODE_MAP[raw]!;
      if (!attributes.includes(code)) attributes.push(code);
      formatCandidates.push({ code, fromHeading });
      continue;
    }
    if (raw in ATTRIBUTE_CODE_MAP) {
      const code = ATTRIBUTE_CODE_MAP[raw]!;
      if (!attributes.includes(code)) attributes.push(code);
    }
  }
  const headingCandidate = formatCandidates.find((c) => c.fromHeading);
  let winner: { code: string; fromHeading: boolean } | undefined;
  if (headingCandidate) {
    winner = headingCandidate;
  } else if (formatCandidates.length === 1) {
    winner = formatCandidates[0];
  } else if (formatCandidates.length > 1) {
    throw new Error(
      "resolvePooledOffering: ADR 0008 does not specify a tie-break for multiple format-" +
        "tagged raw strings pooled with none from the heading position (candidates: " +
        `${formatCandidates.map((c) => c.code).join(", ")}). Not observed in the corpus this ` +
        "ADR was approved against; needs an explicit decision, not an invented default.",
    );
  }
  return { formatCode: winner?.code ?? null, attributes };
}
