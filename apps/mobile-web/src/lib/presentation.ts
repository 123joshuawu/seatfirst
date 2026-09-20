import type {
  EmptyCause,
  FormatPointer,
  Money,
  Placement as CorePlacement,
  RankedAnswer,
  RecheckResult,
  Recommendation,
  RecommendationReason,
  Relaxation,
  ResultGroup,
  ShowtimeOffer,
  SuggestedWiden,
} from "@seatfirst/core";
import type { PlacementCard, PlacementHue, ShowtimeViewItem } from "@/types/placement";
import { summarizePlacement } from "@/lib/rowSummary";
import { formatCodeToPref } from "@/lib/buildSearchSpec";
import { FORMAT_META } from "@/hooks/demoData";

/**
 * Deterministic display derivation from `@seatfirst/core` contract shapes to the strings
 * and grid geometry the result-screen components render. Nothing here invents data the
 * contract doesn't carry — see `docs/adr/0025-ui-v1-implementation-and-integration.md`
 * §3 ("component view models derived from the contract remain allowed") and the resolved
 * open questions this module encodes:
 *   - price: `minPrice` carries a real `Money` value once S59's writer lands
 *     (ADR 0062 amending ADR 0023 decision 6, lifting ADR 0041 decision 1's
 *     `$`-figure prohibition) — null renders as "Price unavailable", never a
 *     fabricated number.
 *   - explanation copy: built from `reasons`/`relaxed` codes via the template below, never
 *     hand-authored per placement.
 */

const FORMAT_PREF_LABELS: Record<string, string> = Object.fromEntries(
  FORMAT_META.map((m) => [m.v, m.label]),
);

/** Human label for a raw provider `formatCode` (e.g. "dolbycinemaatamcprime", "imax70mm")
 * — normalizes through the same `formatCodeToPref` vocabulary buildSearchSpec.ts uses for
 * search-spec construction, so "Row D · dolbycinemaatamcprime" never reaches the UI (the
 * dev-seed "STANDARD"/"IMAX"/"DOLBY" sentinel literals also normalize correctly since
 * formatCodeToPref treats anything outside the imax family or dolby as standard). */
export function formatCodeLabel(formatCode: string): string {
  return FORMAT_PREF_LABELS[formatCodeToPref(formatCode)] ?? formatCode;
}

/** Matches the existing demo convention: premium formats read "indigo", Standard reads "amber". */
export function hueForFormat(formatCode: string): PlacementHue {
  return formatCode === "STANDARD" ? "amber" : "indigo";
}

/**
 * Client-side TMDB image URL construction per ADR 0019 decision 6
 * (docs/adr/0019-tmdb-movie-metadata-integration.md:21): "The client app will construct
 * the image URL natively (`https://image.tmdb.org/t/p/{size}/{poster_path}`)". The API
 * carries only the bare relative `poster_path` (`TheatreMovieGroupSchema`,
 * packages/core/src/result-contracts.ts:440-448), so this joins the base here and nowhere
 * else. Size `w185` is the small-thumbnail TMDB size matching the UX spec's "poster
 * thumbnail (small — confirmation, not hero)" treatment
 * (docs/ux-spec-search-initial-experience.md:56). Null in → null out: a null poster is
 * legitimate (cache miss / no TMDB match) and is never fabricated into a URL.
 */
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";
export function tmdbPosterUrl(posterPath: string | null): string | null {
  return posterPath === null ? null : `${TMDB_IMAGE_BASE}w185/${posterPath.replace(/^\//, "")}`;
}

/**
 * Shared km→mi distance label (UI25): identical logic to ShowtimeRow's former
 * private copy — one decimal, `null`/non-finite input → `null`.
 */
export function distanceLabel(distanceKm: number | null): string | null {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return null;
  return `${(distanceKm * 0.621371).toFixed(1)} mi`;
}

/**
 * Shared runtime label (UI25 follow-up): "2h 46m" when both parts are non-zero,
 * "2h" on the hour, "46m" under an hour. `null`/non-positive/non-finite input →
 * `null` — the caller omits the line rather than rendering a placeholder.
 */
export function runtimeLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const wholeMinutes = Math.floor(minutes);
  const hours = Math.floor(wholeMinutes / 60);
  const remainder = wholeMinutes % 60;
  if (hours > 0 && remainder > 0) return `${hours}h ${remainder}m`;
  if (hours > 0) return `${hours}h`;
  return `${wholeMinutes}m`;
}

export function auditoriumLabel(auditorium: string | number | null): string {
  if (auditorium === null) return "Auditorium unknown";
  return `Auditorium ${auditorium}`;
}

const SEAT_NAME_PATTERN = /^([A-Za-z]+)(\d+)$/;

/** "Row J, Seats 12–15" derived from `seatNames`, never hardcoded. Falls back to a plain
 * list when a seat name doesn't follow the row-letter+number convention, rather than
 * guessing at a row it can't parse out of the data. Real seat numbering can run in either
 * direction across columns (e.g. house-left numbering that decreases left-to-right), so
 * this always displays the lower number first (min–max), matching the
 * formatPlacementLabel/rowSummary.ts convention — "Seats 7–4" must never reach the UI. */
export function formatSeatRange(seatNames: readonly string[]): string {
  const first = seatNames[0];
  const match = first === undefined ? null : SEAT_NAME_PATTERN.exec(first);
  if (match === null) {
    return seatNames.join(", ");
  }
  const [, rowLetter] = match;
  const numbers = seatNames.map((name) => {
    const m = SEAT_NAME_PATTERN.exec(name);
    return m ? Number(m[2]) : null;
  });
  const parsed = numbers.filter((n): n is number => n !== null);
  if (parsed.length !== numbers.length || parsed.length === 0) {
    return seatNames.join(", ");
  }
  const first_ = Math.min(...parsed);
  const last = Math.max(...parsed);
  return first_ === last
    ? `Row ${rowLetter}, Seat ${first_}`
    : `Row ${rowLetter}, Seats ${first_}–${last}`;
}

/** "Price unavailable" whenever `minPrice` is null — unresolved showtimes or
 * performances without price data (ADR 0062 §5). Formats a real amount when
 * present. */
export function priceLabel(money: Money | null): string {
  if (money === null) return "Price unavailable";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
  }).format(money.amount);
  return money.basis === "TICKET_ONLY" ? formatted : `${formatted} (estimated)`;
}

export function formatShowtimeLocal(showDateTimeUtc: string, timezone: string): string {
  const date = new Date(showDateTimeUtc);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  // Intl inserts "at" between date and time (e.g. "Fri, Jul 31 at 7:20 PM"); the mockup's
  // "·" separator reads better here, so swap it post-format rather than hand-building the string.
  return formatted.replace(", at ", " · ").replace(" at ", " · ");
}

export function showtimeViewItem(offer: ShowtimeOffer): ShowtimeViewItem {
  return {
    time: formatShowtimeLocal(offer.showDateTimeUtc, offer.timezone),
    price: priceLabel(offer.minPrice),
    showtimeId: offer.showtimeId,
    theatreId: offer.theatreId,
    deepLinkUrl: offer.deepLinkUrl,
    nonce: offer.nonce,
    timezone: offer.timezone,
    showDateTimeUtc: offer.showDateTimeUtc,
  };
}

/**
 * `RecommendationReason`/`Relaxation`/`SuggestedWiden` are each `knownSchema.or(unknownSchema)`
 * in `result-contracts.ts`, and the unknown branch is a `z.looseObject` — which carries a
 * `[key: string]: unknown` catchall. That catchall "answers" every property access on the
 * union (rather than erroring "does not exist"), so after narrowing by `kind` the accessed
 * property's type collapses to `unknown` instead of the known member's real type. `Extract`
 * against the literal `kind` sidesteps it by picking only the known member out of the union,
 * without merging in the loose member's index signature.
 */
type ReasonOf<K extends RecommendationReason["kind"]> = Extract<RecommendationReason, { kind: K }>;
type RelaxationOf<K extends Relaxation["kind"]> = Extract<Relaxation, { kind: K }>;

function describeReason(reason: RecommendationReason): string | null {
  switch (reason.kind) {
    case "CENTERED": {
      const r = reason as ReasonOf<"CENTERED">;
      return r.lateralPct === 0 ? "centered" : "near-centered";
    }
    case "MIDDLE_THIRD":
      return "ideal viewing distance";
    case "TOGETHER": {
      const r = reason as ReasonOf<"TOGETHER">;
      return `${r.count} seats together`;
    }
    case "AISLE_ADJACENT":
      return "aisle-adjacent";
    case "MULTI_SHOWTIME": {
      const r = reason as ReasonOf<"MULTI_SHOWTIME">;
      return `available across ${r.count} showtimes`;
    }
    case "AVOIDS_FRONT":
      return "avoids the front rows";
    case "ACCESSIBLE_REQUESTED":
      return "meets your accessibility request";
    default:
      // Open-enum fallback (RecommendationReasonSchema's unknown branch): surface the
      // provided label rather than silently dropping a reason the client doesn't know yet.
      return "label" in reason && typeof reason.label === "string" ? reason.label : null;
  }
}

function describeRelaxation(relaxation: Relaxation): string | null {
  switch (relaxation.kind) {
    case "OUTSIDE_REGION":
      return "outside your preferred seat location";
    case "EARLIER_THAN_PREFERRED":
      return "earlier than your preferred window";
    case "LATER_THAN_PREFERRED":
      return "later than your preferred window";
    case "DIFFERENT_FORMAT": {
      const r = relaxation as RelaxationOf<"DIFFERENT_FORMAT">;
      return `${formatCodeLabel(r.to)} instead of ${formatCodeLabel(r.from)}`;
    }
    case "FEWER_SHOWTIMES":
      return "fewer matching showtimes than other options";
    case "UNRESOLVED_SHOWTIMES": {
      const r = relaxation as RelaxationOf<"UNRESOLVED_SHOWTIMES">;
      return `${r.count} showtime${r.count === 1 ? "" : "s"} not yet checked`;
    }
    default:
      return "label" in relaxation && typeof relaxation.label === "string"
        ? relaxation.label
        : null;
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function buildExplanation(
  reasons: RecommendationReason[],
  relaxed: Relaxation[],
): PlacementCard["explanation"] {
  const reasonClauses = reasons.map(describeReason).filter((c): c is string => c !== null);
  const relaxedClauses = relaxed.map(describeRelaxation).filter((c): c is string => c !== null);

  const concise =
    reasonClauses.length > 0 ? `${capitalize(reasonClauses[0]!)}.` : "Matches your search.";
  const balanced =
    reasonClauses.length > 0
      ? `${capitalize(reasonClauses.join(" · "))}.`
      : "Matches your search criteria.";
  const detailedParts = [balanced];
  if (relaxedClauses.length > 0) {
    detailedParts.push(`This option is ${relaxedClauses.join(" and ")}.`);
  }
  const detailed = detailedParts.join(" ");

  return { concise, balanced, detailed };
}

/** Label for an `EmptyAnswer.suggestions` entry (`SuggestedWiden`) — drives the "No valid
 * placement" screen's action list directly off the contract's widen-suggestion vocabulary
 * instead of a hand-authored action list. */
type SuggestionOf<K extends SuggestedWiden["kind"]> = Extract<SuggestedWiden, { kind: K }>;

export function suggestionLabel(suggestion: SuggestedWiden): string {
  switch (suggestion.kind) {
    case "WIDEN_WINDOW": {
      const s = suggestion as SuggestionOf<"WIDEN_WINDOW">;
      return s.direction === "FULL_DAY"
        ? "Widen to the full day"
        : `Widen the time window (${s.direction.toLowerCase()})`;
    }
    case "NEARBY_THEATRE": {
      const s = suggestion as SuggestionOf<"NEARBY_THEATRE">;
      return `Check a nearby theatre (${s.distanceKm.toFixed(1)} km)`;
    }
    case "OTHER_FORMAT": {
      const s = suggestion as SuggestionOf<"OTHER_FORMAT">;
      return `Try ${formatCodeLabel(s.formatCode)}`;
    }
    case "SPLIT_PARTY": {
      const s = suggestion as SuggestionOf<"SPLIT_PARTY">;
      return `Split into groups of ${s.groups.join(" and ")}`;
    }
    default:
      return "label" in suggestion && typeof suggestion.label === "string"
        ? suggestion.label
        : "See other options";
  }
}

// ---------------------------------------------------------------------------
// Live contract derivation (UI4.2) — deterministic, no invention.
// ---------------------------------------------------------------------------

/**
 * Derive a `PlacementCard` from a live `Recommendation` and its owning `ResultGroup`.
 * `formatCode` and `auditorium` live only on the group (result-contracts.ts:806-834),
 * not on the recommendation; `placement.seatNames` etc. live on the recommendation's
 * placement. This is the live counterpart to the demo `toPlacementCard`.
 */
export function toPlacementCardFromLive(
  recommendation: Recommendation,
  group: ResultGroup,
): PlacementCard {
  const { placement, reasons, relaxed, showtimes } = recommendation;
  const id = placement.placementKey;
  return {
    id,
    format: formatCodeLabel(group.formatCode),
    auditorium: auditoriumLabel(group.auditorium),
    seats: formatSeatRange(placement.seatNames),
    seatDesc: capitalize(
      [...reasons.map(describeReason), ...relaxed.map(describeRelaxation)]
        .filter((c): c is string => c !== null)
        .join(" · "),
    ),
    altDesc: capitalize(
      reasons
        .map(describeReason)
        .filter((c): c is string => c !== null)
        .slice(0, 2)
        .join(" · "),
    ),
    hue: hueForFormat(group.formatCode),
    run: { row: placement.row, startCol: placement.startCol, count: placement.count },
    showtimes: showtimes.map(showtimeViewItem),
    explanation: buildExplanation(reasons, relaxed),
  };
}

/**
 * Find the owning group for a recommendation by `placement.layoutId`.
 * Returns `undefined` if no group matches — the caller must handle the missing-group
 * case without fabricating data (UI4.8 never-invent guard).
 */
export function findGroupForRecommendation(
  recommendation: Recommendation,
  groups: readonly ResultGroup[],
): ResultGroup | undefined {
  const layoutId = recommendation.placement.layoutId;
  return groups.find((g) => g.layoutId === layoutId);
}

/**
 * Presentational-only pointer for `otherFormats` (UI4.3). Returns a de-emphasized label
 * like "Also available in IMAX →" via `formatCodeLabel`, or `null` if empty. Never
 * exposes `bestRunScore` and never returns a control — the caller must render this as
 * plain text (see `OtherFormatsPointer` component contract).
 */
export function otherFormatsLabel(otherFormats: readonly FormatPointer[]): string | null {
  if (otherFormats.length === 0) return null;
  const first = otherFormats[0];
  if (first === undefined) return null;
  return `Also available in ${formatCodeLabel(first.formatCode)} →`;
}

/**
 * Single textual pointer for `otherFormats` derived from a `RankedAnswer`'s `otherFormats`.
 * Convenience that extracts `otherFormats` from either CONFIDENT or HEDGED; EMPTY has no
 * `otherFormats`. Returns `null` for EMPTY or empty array.
 */
export function otherFormatsLabelForAnswer(answer: RankedAnswer | null): string | null {
  if (answer === null) return null;
  if (answer.mode === "EMPTY") return null;
  return otherFormatsLabel(answer.otherFormats);
}

/** Human-readable heading for an `EmptyCause` (UI4.7). Exhaustive — type error if a new cause is added. */
export function emptyCauseLabel(cause: EmptyCause): string {
  switch (cause) {
    case "SOLD_OUT":
      return "No seats remain for this window";
    case "TOO_FEW_SHOWTIMES":
      return "Too few showtimes match your window";
    case "NO_SHAPE_MATCH":
      return "No placement matches your seat preferences";
    case "HALTED":
      return "Search halted before completion";
    case "CAPACITY":
      return "No capacity — search halted";
    case "PARTIAL_SCHEDULE":
      return "Partial schedule — some showtimes unavailable";
    default: {
      // Exhaustiveness guard: if EmptyCause gains a variant, this branch becomes unreachable at type level,
      // but at runtime we fall back to the unknown label if present.
      const unknown = cause as { label?: unknown };
      if (typeof unknown.label === "string") return unknown.label;
      return "No valid placement";
    }
  }
}

/** Distinct copy for PARTIAL terminal banner (UI4.4). Driven by resolved/total counts. */
export function partialBannerLabel(resolved: number, total: number): string {
  return `We checked ${resolved} of ${total} showtimes — partial results`;
}

/** Distinct copy for HALTED terminal state (UI4.4). */
export function haltedBannerLabel(cause: EmptyCause): string {
  if (cause === "CAPACITY") return "Search halted — capacity limit reached";
  return "Search halted — try again";
}

/**
 * Admission-rejected (429) label for submission-time notice (UI4.5).
 * Must read the server-provided `retryAfterSeconds`, not fabricate.
 */
export function admissionRejectedLabel(retryAfterSeconds: number): string {
  return `No capacity — try again. Retry in ${retryAfterSeconds} seconds`;
}
/**
 * Submission-time error detail for the result screen's retry card (UI31 fix).
 * A residual CONTINUATION_NOT_DEFERRED race (terminalCause flipped between the
 * startSearch gate read and request dispatch, or multi-tab) must never surface
 * the raw backend code verbatim — map that single code to friendly copy and
 * preserve the existing `message (code)` debug format for everything else.
 */
export function searchErrorDetailLabel(message: string, code: string | undefined): string {
  if (code === "CONTINUATION_NOT_DEFERRED") {
    return "Your search updated while results were still loading — please try again.";
  }
  return code !== undefined && code.length > 0 ? `${message} (${code})` : message;
}
// ---------------------------------------------------------------------------
// Recheck presentation helpers (UI6)
// ---------------------------------------------------------------------------

/**
 * Format a Placement as "Row G 8–11" from row/startCol/count.
 * Uses seatNames when available for precise labeling; falls back to
 * row letter + seat-number range derived from startCol/count.
 */
export function formatPlacementLabel(placement: CorePlacement): string {
  if (placement.seatNames.length > 0) {
    // Prefer seatNames for fidelity — formatSeatRange already handles multi-row nuances
    // but UI6's spec copy wants "Row G 8–11" compact form. Derive row letter from first seat.
    const first = placement.seatNames[0] ?? "";
    const match = /^([A-Za-z]+)(\d+)$/.exec(first);
    if (match) {
      const rowLetters = match[1]!;
      const nums = placement.seatNames
        .map((name) => {
          const m = /^([A-Za-z]+)(\d+)$/.exec(name);
          return m ? Number(m[2]) : null;
        })
        .filter((n): n is number => n !== null);
      if (nums.length > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        if (nums.length === 1) return `Row ${rowLetters} ${min}`;
        // When seatNames are contiguous, show range; otherwise list
        const isContiguous = nums.length === max - min + 1;
        if (isContiguous) return `Row ${rowLetters} ${min}–${max}`;
        return `Row ${rowLetters} ${nums.join(", ")}`;
      }
    }
  }
  // Fallback: derive from row/startCol/count — row 0 => A
  const rowLetter = String.fromCharCode(65 + (placement.row % 26));
  const start = placement.startCol + 1;
  const end = placement.startCol + placement.count;
  if (placement.count === 1) return `Row ${rowLetter} ${start}`;
  return `Row ${rowLetter} ${start}–${end}`;
}

/** Handoff honesty copy per docs/seatfirst-architecture.md:397 — never "held"/"reserved".
 * ADR 0002 §3.5 Phase 2 (2026-09-05) verified seat pre-selection carry-through, so the copy
 * honestly states the seats arrive pre-selected in AMC's seat map. */
export function handoffHonestyLabel(placement: CorePlacement): string {
  return `We'll take you to AMC with your seats pre-selected: ${formatPlacementLabel(placement)}`;
}

/** Human-readable label for a UNAVAILABLE cause (UI6.2). Exhaustive. */
export function unavailableCauseLabel(
  cause: Extract<RecheckResult, { status: "UNAVAILABLE" }>["cause"],
): string {
  switch (cause) {
    case "RATE_LIMITED":
      return "Too many checks — try again shortly";
    case "UPSTREAM_BLOCKED":
      return "Theatre site is temporarily blocked — try again";
    case "CHALLENGE_REQUIRED":
      return "Verification required on the theatre site — try again";
    case "UPSTREAM_QUEUED":
      return "Theatre site is busy — try again shortly";
    case "UPSTREAM_CHANGED":
      return "Theatre layout changed — pick again from results";
    case "TIMEOUT":
      return "No seats have been reserved or charged. Please try again.";
    case "UPSTREAM_UNAVAILABLE":
      return "Theatre site unavailable — try again";
    default: {
      const _never: never = cause;
      return _never;
    }
  }
}

/** Label for recheck error codes that are not UNAVAILABLE causes (UNAUTHORIZED/CONFLICT/network). */
export function recheckErrorLabel(code: string | null, fallback: string | null): string {
  if (fallback !== null && fallback.length > 0) return fallback;
  switch (code) {
    case "UNAUTHORIZED":
      return "This selection expired — pick the seats again from the answer";
    case "CONFLICT":
      return "Already checked — pick again";
    case "NETWORK_ERROR":
      return "Couldn't re-verify — check your connection and try again";
    case "NONCE_MISSING":
      return "Not ready — return to results";
    case "TIMEOUT":
      return "No seats have been reserved or charged. Please try again.";
    case "TOO_MANY_REQUESTS":
      return "Too many requests — try again shortly";
    case null:
      return fallback ?? "Couldn't re-verify — try again";
    default:
      return "Couldn't re-verify — try again";
  }
}

/** Describe a Relaxation for display in the recovery ladder. */
export function relaxationLabel(relaxation: Relaxation): string | null {
  return describeRelaxation(relaxation);
}

/**
 * ADR 0017 amendment (2026-09-03) — generic handoff target for a clicked showtimeId.
 *
 * Resolution order: `primary`/`alternatives` first (unchanged priority and shape —
 * this also fixes the pre-existing bug where a non-first HEDGED alternative silently
 * resolved to `alternatives[0]`'s data), then the per-hit fallback: the best hit
 * covering the showtime (first hit in stored `groupHits` order with a placement key —
 * the same `hits[0]` pick `ShowtimeRow` renders, skipping key-less hits exactly as
 * the server's issuance does). Returns the target with a `null` nonce when the data
 * is not yet issued rather than no target, so the caller surfaces NONCE_MISSING
 * instead of silently no-op-ing. `null` only when the showtimeId is in neither the
 * answer nor any hit.
 */
export interface HandoffTarget {
  readonly placementKey: string;
  readonly showtimeId: string;
  readonly nonce: string | null;
}

/**
 * Locate the best (first placement-keyed) `groupHits` entry covering `showtimeId`,
 * mirroring the server's issuance order (`hits[0]` — the same hit `ShowtimeRow`
 * renders and the only one ever issued a nonce, per the ADR 0017 amendment).
 * Shared by `resolveHandoffTarget` (API target) and `toPlacementCardFromHit`
 * (display card) so both agree on exactly which hit "the best hit" means.
 */
function findBestHitForShowtime(
  groups: readonly ResultGroup[],
  showtimeId: string,
): {
  group: ResultGroup;
  hit: NonNullable<ResultGroup["groupHits"]>[number];
  showtimeIndex: number;
} | null {
  for (const group of groups) {
    const showtimeIndex = group.showtimes.findIndex((s) => s.showtimeId === showtimeId);
    if (showtimeIndex < 0) {
      continue;
    }
    for (const hit of group.groupHits ?? []) {
      if (!hit.showtimeIndices.includes(showtimeIndex)) {
        continue;
      }
      if (hit.placementKey === null || hit.placementKey === undefined) {
        continue;
      }
      return { group, hit, showtimeIndex };
    }
  }
  return null;
}

export function resolveHandoffTarget(
  answer: RankedAnswer,
  groups: readonly ResultGroup[],
  showtimeId: string,
): HandoffTarget | null {
  if (answer.mode === "CONFIDENT") {
    const offer = answer.primary.showtimes.find((o) => o.showtimeId === showtimeId);
    if (offer !== undefined) {
      return {
        placementKey: answer.primary.placement.placementKey,
        showtimeId,
        nonce: offer.nonce,
      };
    }
  } else if (answer.mode === "HEDGED") {
    for (const alternative of answer.alternatives) {
      const offer = alternative.showtimes.find((o) => o.showtimeId === showtimeId);
      if (offer !== undefined) {
        return {
          placementKey: alternative.placement.placementKey,
          showtimeId,
          nonce: offer.nonce,
        };
      }
    }
  } else {
    return null;
  }
  const found = findBestHitForShowtime(groups, showtimeId);
  if (found === null) {
    return null;
  }
  const position = found.hit.showtimeIndices.indexOf(found.showtimeIndex);
  return {
    placementKey: found.hit.placementKey!,
    showtimeId,
    nonce: found.hit.showtimeNonces?.[position] ?? null,
  };
}

/**
 * `PlacementCard` for a hit-fallback showtime — one covered only by `groupHits`, not by
 * `primary`/`alternatives` (ADR 0017 amendment: every resolved hit now gets a nonce, so
 * these rows' "Hold seats" must display the *correct* seat/row card too, not just send
 * the correct recheck request). Built the same way `ShowtimeRow`'s own row summary is
 * (`summarizePlacement`) — never fabricated. `seatDesc`/`altDesc`/`explanation`/`showtimes`
 * carry no per-hit `reasons`/`relaxed`/offer data (those exist only on `Recommendation`
 * entries), so they're populated with the real derived centered/third facts where
 * available and left empty otherwise; today's only consumer (`LeftPanel`) reads just
 * `format`, `seats`, and `run`/`hue` (via `buildGrid`).
 */
export function toPlacementCardFromHit(
  group: ResultGroup,
  hit: NonNullable<ResultGroup["groupHits"]>[number],
  partySize: number,
): PlacementCard {
  const summary = summarizePlacement(group, hit, partySize);
  const seatDesc = capitalize(
    `${summary.centered ? "centered" : "off-centre"} · ${summary.third} third`,
  );
  return {
    id: hit.placementKey ?? `${group.layoutId}-${hit.row}-${hit.startCol}`,
    format: formatCodeLabel(group.formatCode),
    auditorium: auditoriumLabel(group.auditorium),
    seats: summary.rowSeatLabel,
    seatDesc,
    altDesc: seatDesc,
    hue: hueForFormat(group.formatCode),
    run: { row: hit.row, startCol: hit.startCol, count: partySize },
    showtimes: [],
    explanation: { concise: seatDesc, balanced: seatDesc, detailed: seatDesc },
  };
}

/**
 * Full generic resolution for the recheck-screen display card: `primary`/`alternatives`
 * first (unchanged shape, via `toPlacementCardFromLive`), then the hit-fallback via
 * `toPlacementCardFromHit` — the display counterpart to `resolveHandoffTarget`'s API
 * target resolution, so a held hit-fallback showtime shows its own row/seats instead of
 * silently reusing `primary`'s.
 */
export function resolveActivePlacementCard(
  answer: RankedAnswer,
  groups: readonly ResultGroup[],
  showtimeId: string | null,
  partySize: number,
): PlacementCard | null {
  if (answer.mode === "CONFIDENT") {
    if (showtimeId === null || answer.primary.showtimes.some((o) => o.showtimeId === showtimeId)) {
      const group = findGroupForRecommendation(answer.primary, groups);
      return group === undefined ? null : toPlacementCardFromLive(answer.primary, group);
    }
  } else if (answer.mode === "HEDGED") {
    const target =
      showtimeId !== null
        ? (answer.alternatives.find((alt) =>
            alt.showtimes.some((o) => o.showtimeId === showtimeId),
          ) ?? null)
        : (answer.alternatives[0] ?? null);
    if (target !== null) {
      const group = findGroupForRecommendation(target, groups);
      return group === undefined ? null : toPlacementCardFromLive(target, group);
    }
  } else {
    return null;
  }
  if (showtimeId === null) {
    return null;
  }
  const found = findBestHitForShowtime(groups, showtimeId);
  return found === null ? null : toPlacementCardFromHit(found.group, found.hit, partySize);
}
