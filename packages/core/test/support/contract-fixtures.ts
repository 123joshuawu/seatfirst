import type { SearchSpecInput } from "../../src/index.js";

export const spec: SearchSpecInput = {
  specVersion: 1,
  providerId: "amc",
  theatres: { kind: "LIST", refs: [{ id: "amc:theatre:610" }] },
  where: { kind: "MOVIE", ids: ["amc:movie:1"] },
  aggregation: { reduce: "COUNT" },
  group: { kind: "RUN", count: 2 },
};

export const placement = {
  layoutId: "layout_1",
  row: 0,
  startCol: 0,
  rowSpan: 1,
  count: 2,
  seatNames: ["A1", "A2"],
  placementKey: "placement_1",
} as const;

// Shared schedule + freshness shape: a `ShowtimeOffer` and a resolved `GroupShowtime` differ only
// by the offer's `nonce` (S34) vs. the group's `resolved`/`openCount`. Kept separate so the group
// showtime never inherits a nonce (GroupShowtimeSchema has no `nonce` field).
const offerBase = {
  showtimeId: "amc:showtime:1",
  theatreId: "amc:theatre:610",
  distanceKm: null,
  showDateTimeUtc: "2026-08-05T02:30:00.000Z",
  timezone: "America/Los_Angeles",
  minPrice: { amount: 18.5, currency: "USD", basis: "TICKET_ONLY" },
  status: "OPEN",
  capturedAt: "2026-08-04T20:00:00.000Z",
  staleAfter: "2026-08-04T20:02:00.000Z",
  deepLinkUrl: "https://www.amctheatres.com/showtimes/1/seats",
} as const;

export const offer = {
  ...offerBase,
  nonce: null,
} as const;

export const resolvedGroupShowtime = {
  ...offerBase,
  resolved: true,
  openCount: 2,
} as const;

export const unresolvedGroupShowtime = {
  showtimeId: "amc:showtime:2",
  theatreId: "amc:theatre:610",
  distanceKm: null,
  showDateTimeUtc: "2026-08-05T05:30:00.000Z",
  timezone: "America/Los_Angeles",
  minPrice: null,
  status: "OPEN",
  deepLinkUrl: "https://www.amctheatres.com/showtimes/2/seats",
  resolved: false,
  openCount: null,
} as const;

export const recommendation = {
  placement,
  reasons: [{ kind: "TOGETHER", count: 2 }],
  relaxed: [],
  showtimes: [offer],
} as const;

export const relaxedRecommendation = {
  ...recommendation,
  relaxed: [{ kind: "FEWER_SHOWTIMES" }],
} as const;

export const excluded = {
  soldOut: 0,
  outsideWindow: 0,
  outsideRegion: 0,
  outsideArea: 0,
  wrongAttributes: 0,
  overPrice: 0,
  notReservedSeating: 0,
  fetchFailed: 0,
  fetchFailedByCause: {},
  byTheatre: {},
} as const;

export const resultGroup = {
  layoutId: "layout_1",
  theatreId: "amc:theatre:610",
  distanceKm: null,
  formatCode: "DIGITAL",
  auditorium: "1",
  attributes: ["DIGITAL"],
  rows: 1,
  columns: 2,
  seatKinds: [0, 0],
  seatNames: { 0: "A1", 1: "A2" },
  seatScores: [0.9, 0.8],
  regionMask: [1, 1],
  showtimes: [resolvedGroupShowtime],
  freeCount: [1, 1],
  freeIn: [[0], [0]],
  groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0.85, showtimeIndices: [0] }],
} as const;

export function resultWith(
  status: "PENDING_SCHEDULE" | "RUNNING" | "COMPLETE" | "PARTIAL" | "HALTED",
  answer: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    searchId: "search_1",
    spec,
    status,
    resolved: status === "PENDING_SCHEDULE" ? 0 : 1,
    total: status === "PENDING_SCHEDULE" ? 0 : 1,
    capturedAtRange:
      status === "PENDING_SCHEDULE"
        ? null
        : ["2026-08-04T20:00:00.000Z", "2026-08-04T20:00:00.000Z"],
    groups: [],
    excluded,
    answer,
    ...overrides,
  };
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Independent test-only serializer for byte-stable wire goldens. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const object = value as Record<string, Json>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
