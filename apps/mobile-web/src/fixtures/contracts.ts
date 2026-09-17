/**
 * Contract-valid fixture builders for `@seatfirst/core` result contracts.
 *
 * Dev/test data only. Two rules govern this module:
 *
 * 1. **Shape fidelity.** Every builder returns a value that parses against the real
 *    schema in `packages/core/src/result-contracts.ts` — no `as unknown as` casts.
 *    `contracts.test.ts` proves it by running each builder through
 *    `createResultContractSchemas`, so a contract change breaks these fixtures
 *    instead of silently letting components render impossible data.
 * 2. **No semantics.** These are illustrative values with no product meaning. Nothing
 *    here encodes a ranking rule, a policy threshold, or a default anyone should read
 *    back out (see CLAUDE.md — "if a decision needs a number, surface it"). `seatScores`
 *    is uniformly zero for exactly this reason: the UI never reads it, and inventing a
 *    scoring curve here would look like a decision.
 *
 * Consumed by `scenarios.ts` (dev seeding) and by unit tests that need a real
 * `ResultGroup`/`RankedAnswer` rather than a hand-rolled cast.
 */
import {
  ShowtimeIdSchema,
  TheatreIdSchema,
  type EmptyCause,
  type FormatPointer,
  type GroupShowtime,
  type Money,
  type Placement,
  type RankedAnswer,
  type Recommendation,
  type RecommendationReason,
  type Relaxation,
  type ResultGroup,
  type ScheduleSkeletonEntry,
  type ShowtimeOffer,
  type SuggestedWiden,
} from "@seatfirst/core";
import { localDateString } from "@/lib/dates";
import { resolveWhenPreset } from "@/lib/whenPresets";

/**
 * `showtimeId` and `theatreId` must share a provider prefix, and `deepLinkUrl` must be
 * an HTTPS URL on a host allowlisted for that provider — see the `validateShowtimeIdentity`
 * refinement in `packages/core/src/result-contracts.ts`. These three constants are what
 * keeps every builder below on the right side of it.
 */
export const DEV_PROVIDER_ID = "amc";
export const DEV_DEEP_LINK_HOST = "www.amctheatres.com";
/** The allowlist a validator needs to accept fixtures from this module. */
export const DEV_PROVIDER_HOST_ALLOWLISTS: Record<string, string[]> = {
  [DEV_PROVIDER_ID]: [DEV_DEEP_LINK_HOST],
};

export const DEV_THEATRE_ID = `${DEV_PROVIDER_ID}:theatre:metreon`;
export const DEV_LAYOUT_ID = "lay_metreon_aud6";
export const DEV_TIMEZONE = "America/Los_Angeles";
export const DEV_DISTANCE_KM = 2.4;

/**
 * Why these dates are computed instead of fixed: the search form seeds its default
 * `selectedDates` from `resolveWhenPreset("This weekend", new Date())` on every launch
 * (`store/searchFormSlice.ts`), so a hardcoded fixture date only matches the form's window
 * on the day it was written and then drifts — result cards showing a stale date next to a
 * current-weekend header, and client-side window matching going all-zero. Anchoring to the
 * same resolver keeps the seeded showtimes inside the form's default window permanently.
 * Each fixture module resolves independently at load; the resolver is a pure function of
 * the date, so both land on the same day.
 */
function devWeekendAnchor(): string {
  try {
    const resolved = resolveWhenPreset("This weekend", new Date());
    if (resolved) return resolved.from;
  } catch {
    // Fall through to the today fallback below.
  }
  // Defensive fallback so a fixture import never throws (the resolver only returns null
  // for unknown presets, which "This weekend" is not).
  return localDateString(new Date());
}

/** Anchor day (`YYYY-MM-DD`) every fixture date below is built from — resolved once at load. */
const DEV_ANCHOR_DATE = devWeekendAnchor();

/**
 * Why the UTC date usually rolls a day ahead of the anchor: this is 7:10pm Pacific on the
 * anchor day (`DEV_TIMEZONE`), and Pacific trails UTC — so the instant lands after midnight
 * UTC. The offset comes from `Intl`, not a hardcoded PDT assumption, so the anchor stays a
 * 7:10pm-Pacific showtime year-round.
 */
function pacificWallToUtcIso(datePart: string, timePart: string): string {
  const [year, month, day] = datePart.split("-");
  const [hour, minute] = timePart.split(":");
  const wallAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
  );
  const wallClockOf = (instant: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEV_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(instant));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const normalizedHour = get("hour") === "24" ? "00" : get("hour");
    return Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(normalizedHour),
      Number(get("minute")),
      Number(get("second")),
    );
  };
  // Solve wallClockOf(t) === wallAsUtc by fixed-point iteration; the zone offset is
  // locally constant, so this converges on the first pass away from a DST transition.
  let guess = wallAsUtc;
  for (let step = 0; step < 3; step += 1) guess += wallAsUtc - wallClockOf(guess);
  return new Date(guess).toISOString();
}

/** Capture instants ride the anchor day; `staleAfter` stays exactly 5 minutes past capture. */
export const DEV_CAPTURED_AT = `${DEV_ANCHOR_DATE}T18:00:00.000Z`;
export const DEV_STALE_AFTER = new Date(Date.parse(DEV_CAPTURED_AT) + 5 * 60 * 1000).toISOString();
export const DEV_SHOWTIME_UTC = pacificWallToUtcIso(DEV_ANCHOR_DATE, "19:10");

/** Grid the fixture auditorium uses. Columns 4 and 9 are aisles (`NOT_A_SEAT`). */
export const DEV_GRID_ROWS = 8;
export const DEV_GRID_COLUMNS = 14;
const DEV_AISLE_COLUMNS: readonly number[] = [4, 9];

/** `SEAT_KIND_CODE` from `packages/core/src/layout.ts`. */
const SEAT_KIND_NOT_A_SEAT = 0;
const SEAT_KIND_STANDARD = 1;

export function devShowtimeId(raw: string): string {
  return `${DEV_PROVIDER_ID}:showtime:${raw}`;
}

export function devDeepLink(raw: string): string {
  return `https://${DEV_DEEP_LINK_HOST}/showtimes/${raw}`;
}

export function makeMoney(over: Partial<Money> = {}): Money {
  return { amount: 21.5, currency: "USD", basis: "TICKET_ONLY", ...over };
}

/** Row letter + 1-based seat number, e.g. cell 0 of an 8x14 grid is `A1`. */
function seatName(index: number, columns: number): string {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

function isAisle(index: number, columns: number): boolean {
  return DEV_AISLE_COLUMNS.includes(index % columns);
}

// ---------------------------------------------------------------------------
// Showtimes
// ---------------------------------------------------------------------------

/**
 * A `ShowtimeOffer` — the showtime shape carried *inside a `RankedAnswer`*, which is
 * the only place a recheck `nonce` lives. `raw` is the provider-local id; the
 * namespaced id and deep link are derived from it so they cannot drift apart.
 */
export function makeShowtimeOffer(raw: string, over: Partial<ShowtimeOffer> = {}): ShowtimeOffer {
  return {
    showtimeId: devShowtimeId(raw),
    theatreId: DEV_THEATRE_ID,
    distanceKm: DEV_DISTANCE_KM,
    showDateTimeUtc: DEV_SHOWTIME_UTC,
    timezone: DEV_TIMEZONE,
    minPrice: makeMoney(),
    status: "OPEN",
    deepLinkUrl: devDeepLink(raw),
    capturedAt: DEV_CAPTURED_AT,
    staleAfter: DEV_STALE_AFTER,
    nonce: `dev-nonce-${raw}`,
    ...over,
  };
}

type ResolvedGroupShowtime = Extract<GroupShowtime, { resolved: true }>;
type UnresolvedGroupShowtime = Extract<GroupShowtime, { resolved: false }>;

/** A group showtime whose seat map came back — carries freshness and an open count. */
export function makeResolvedGroupShowtime(
  raw: string,
  over: Partial<ResolvedGroupShowtime> = {},
): ResolvedGroupShowtime {
  return {
    showtimeId: devShowtimeId(raw),
    theatreId: DEV_THEATRE_ID,
    distanceKm: DEV_DISTANCE_KM,
    showDateTimeUtc: DEV_SHOWTIME_UTC,
    timezone: DEV_TIMEZONE,
    minPrice: makeMoney(),
    status: "OPEN",
    deepLinkUrl: devDeepLink(raw),
    capturedAt: DEV_CAPTURED_AT,
    staleAfter: DEV_STALE_AFTER,
    resolved: true,
    openCount: 42,
    ...over,
  };
}

/**
 * A group showtime that was never fetched. The unresolved variant is a *different*
 * strict object — it has no `capturedAt`/`staleAfter` at all, and `minPrice`/`openCount`
 * are pinned to `null`.
 */
export function makeUnresolvedGroupShowtime(
  raw: string,
  over: Partial<UnresolvedGroupShowtime> = {},
): UnresolvedGroupShowtime {
  return {
    showtimeId: devShowtimeId(raw),
    theatreId: DEV_THEATRE_ID,
    distanceKm: DEV_DISTANCE_KM,
    showDateTimeUtc: DEV_SHOWTIME_UTC,
    timezone: DEV_TIMEZONE,
    status: "UNKNOWN",
    deepLinkUrl: devDeepLink(raw),
    minPrice: null,
    resolved: false,
    openCount: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Result groups
// ---------------------------------------------------------------------------

export interface ResultGroupOptions {
  rows?: number;
  columns?: number;
  showtimes?: GroupShowtime[];
  /**
   * Flattened, row-major cell indices that are free in *every* showtime of this group.
   * Defaults to the whole back half of the auditorium, which is enough for a run to land.
   */
  freeIndices?: readonly number[];
  /**
   * Escape hatch, spread last. Overriding `theatreId` or `distanceKm` here without
   * matching the group's showtimes will fail the contract's group/showtime consistency
   * refinement — pass matching `showtimes` too.
   */
  over?: Partial<ResultGroup>;
}

function defaultFreeIndices(rows: number, columns: number): number[] {
  const indices: number[] = [];
  for (let index = Math.floor((rows * columns) / 2); index < rows * columns; index += 1) {
    if (!isAisle(index, columns)) indices.push(index);
  }
  return indices;
}

export function makeResultGroup(options: ResultGroupOptions = {}): ResultGroup {
  const rows = options.rows ?? DEV_GRID_ROWS;
  const columns = options.columns ?? DEV_GRID_COLUMNS;
  const cellCount = rows * columns;
  const showtimes = options.showtimes ?? [makeResolvedGroupShowtime("s1")];
  const free = new Set(options.freeIndices ?? defaultFreeIndices(rows, columns));
  const everyShowtimeIndex = showtimes.map((_, index) => index);

  const seatNames: Record<string, string> = {};
  for (let index = 0; index < cellCount; index += 1) {
    if (!isAisle(index, columns)) seatNames[String(index)] = seatName(index, columns);
  }

  return {
    layoutId: DEV_LAYOUT_ID,
    theatreId: DEV_THEATRE_ID,
    distanceKm: DEV_DISTANCE_KM,
    formatCode: "STANDARD",
    auditorium: "Aud 6",
    attributes: [],
    rows,
    columns,
    seatKinds: Array.from({ length: cellCount }, (_, index) =>
      isAisle(index, columns) ? SEAT_KIND_NOT_A_SEAT : SEAT_KIND_STANDARD,
    ),
    seatNames,
    // Deliberately uniform — see the "no semantics" note at the top of this file.
    seatScores: Array.from({ length: cellCount }, () => 0),
    showtimes,
    freeCount: Array.from({ length: cellCount }, (_, index) =>
      free.has(index) ? showtimes.length : 0,
    ),
    freeIn: Array.from({ length: cellCount }, (_, index) =>
      free.has(index) ? [...everyShowtimeIndex] : [],
    ),
    ...options.over,
  };
}

/**
 * A group carrying one contiguous run, which is what makes a row render as a *hit*
 * rather than a miss. `row`/`startCol` must stay inside the grid and clear of the aisle
 * columns. The run carries no seat count of its own — `rowSpan` is always 1 for RUN
 * groups and the width comes from `partySize` at render time (see `lib/rowSummary.ts`).
 */
export function makeHitGroup(
  raw: string,
  options: { row?: number; startCol?: number; over?: Partial<ResultGroup> } = {},
): ResultGroup {
  const row = options.row ?? 5;
  const startCol = options.startCol ?? 5;
  const base = makeResultGroup({ showtimes: [makeResolvedGroupShowtime(raw)] });
  return {
    ...base,
    // ADR 0017 amendment (2026-09-03) — every resolved hit carries a placementKey and
    // (for the best/first hit) a recheck nonce in production, so `resolveHandoffTarget`'s
    // hit-fallback branch has something to resolve. Without these two fields a dev
    // "Hold seats" click on a hit-fallback row (one not in `primary`/`alternatives`)
    // would silently no-op, same as the pre-amendment bug this fixture must exercise.
    groupHits: [
      {
        row,
        startCol,
        rowSpan: 1,
        runScore: 0,
        showtimeIndices: [0],
        placementKey: `dev-placement-${raw}`,
        showtimeNonces: [`dev-nonce-${raw}`],
      },
    ],
    ...options.over,
  };
}

// ---------------------------------------------------------------------------
// Schedule skeleton
// ---------------------------------------------------------------------------

/**
 * `ScheduleSkeletonEntry` ids are branded (`ShowtimeIdSchema`/`TheatreIdSchema`), so they
 * are parsed rather than cast — which also validates the namespaced-id format for free.
 */
export function makeScheduleSkeletonEntry(
  raw: string,
  over: Partial<Omit<ScheduleSkeletonEntry, "showtimeId" | "theatreId">> = {},
): ScheduleSkeletonEntry {
  return {
    showtimeId: ShowtimeIdSchema.parse(devShowtimeId(raw)),
    theatreId: TheatreIdSchema.parse(DEV_THEATRE_ID),
    // Local wall time on the anchor day — same fixture day as `DEV_SHOWTIME_UTC`.
    showDateTimeLocal: `${DEV_ANCHOR_DATE}T19:10`,
    formatCode: "STANDARD",
    distanceKm: DEV_DISTANCE_KM,
    rank: 0,
    admitted: true,
    resolved: true,
    ...over,
  };
}

/** A ranked skeleton of `count` entries, the first `resolvedCount` of them resolved. */
export function makeScheduleSkeleton(
  count: number,
  resolvedCount: number = count,
  admittedCount: number = count,
): ScheduleSkeletonEntry[] {
  return Array.from({ length: count }, (_, index) =>
    makeScheduleSkeletonEntry(`s${index + 1}`, {
      rank: index,
      resolved: index < resolvedCount,
      admitted: index < admittedCount,
      showDateTimeLocal: `${DEV_ANCHOR_DATE}T${String(17 + index).padStart(2, "0")}:10`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * `seatNames` is derived from the effective row/startCol/count rather than hard-coded, so
 * overriding `row` moves the seat labels with it instead of leaving a placement that
 * claims row 3 and names seats in row F. An explicit `seatNames` override still wins.
 */
export function makePlacement(over: Partial<Placement> = {}): Placement {
  const row = over.row ?? 5;
  const startCol = over.startCol ?? 5;
  const count = over.count ?? 4;
  return {
    layoutId: DEV_LAYOUT_ID,
    row,
    startCol,
    rowSpan: 1,
    count,
    seatNames: Array.from({ length: count }, (_, offset) =>
      seatName(row * DEV_GRID_COLUMNS + startCol + offset, DEV_GRID_COLUMNS),
    ),
    placementKey: "dev-placement-1",
    ...over,
  };
}

export function makeRecommendation(
  raw: string,
  over: Partial<Recommendation> = {},
): Recommendation {
  const reasons: RecommendationReason[] = [
    { kind: "MIDDLE_THIRD" },
    { kind: "TOGETHER", count: 4 },
  ];
  return {
    placement: makePlacement(),
    reasons,
    relaxed: [],
    showtimes: [makeShowtimeOffer(raw)],
    ...over,
  };
}

export function makeConfidentAnswer(
  options: { primary?: Recommendation; otherFormats?: FormatPointer[] } = {},
): Extract<RankedAnswer, { mode: "CONFIDENT" }> {
  const primary = options.primary ?? makeRecommendation("s1");
  return {
    mode: "CONFIDENT",
    // CONFIDENT pins `relaxed` to the empty tuple — nothing was given up to reach it.
    primary: { ...primary, relaxed: [] },
    // Lower-case `imax`: the ADR 0008 canonical code. Upper-case `"IMAX"` matches no known
    // code in `formatCodeToPref`, so it silently reads as Standard and the "Also available
    // in …" pointer names the format already on screen.
    otherFormats: options.otherFormats ?? [{ formatCode: "imax", bestRunScore: 0 }],
  };
}

/**
 * HEDGED requires two or three alternatives, each of which must have relaxed at least
 * one constraint (an alternative that gave nothing up would be CONFIDENT).
 */
export function makeHedgedAnswer(
  options: { alternatives?: Recommendation[]; otherFormats?: FormatPointer[] } = {},
): Extract<RankedAnswer, { mode: "HEDGED" }> {
  const laterRelaxation: Relaxation[] = [{ kind: "LATER_THAN_PREFERRED" }];
  const formatRelaxation: Relaxation[] = [
    { kind: "DIFFERENT_FORMAT", from: "IMAX", to: "STANDARD" },
  ];
  const alternatives = options.alternatives ?? [
    makeRecommendation("s1", { relaxed: laterRelaxation }),
    makeRecommendation("s2", {
      relaxed: formatRelaxation,
      placement: makePlacement({ placementKey: "dev-placement-2", row: 4 }),
      showtimes: [makeShowtimeOffer("s2")],
    }),
  ];
  const [first, second, third] = alternatives;
  if (first === undefined || second === undefined) {
    throw new Error("makeHedgedAnswer requires at least two alternatives");
  }
  return {
    mode: "HEDGED",
    alternatives: third === undefined ? [first, second] : [first, second, third],
    otherFormats: options.otherFormats ?? [],
  };
}

export function makeEmptyAnswer(
  cause: EmptyCause,
  suggestions: SuggestedWiden[] = [
    { kind: "WIDEN_WINDOW", direction: "FULL_DAY" },
    { kind: "OTHER_FORMAT", formatCode: "STANDARD" },
  ],
): Extract<RankedAnswer, { mode: "EMPTY" }> {
  return { mode: "EMPTY", cause, suggestions };
}
