import { describe, expect, it } from "vitest";

import {
  CreateSearchInputSchema,
  CreateSearchResponseSchema,
  IdempotencyKeyConflictSchema,
  RecheckInputSchema,
  RecheckResultSchema,
  createResultContractSchemas,
} from "../src/index.js";

import {
  canonicalJson,
  placement,
  recommendation,
  relaxedRecommendation,
  resultGroup,
  resultWith,
  spec,
  unresolvedGroupShowtime,
} from "./support/contract-fixtures.js";

const contracts = createResultContractSchemas({
  providerHostAllowlists: { amc: ["www.amctheatres.com"] },
});

const goldenSpec = {
  aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
  group: { count: 2, kind: "RUN" },
  groupStrict: false,
  providerId: "amc",
  rank: "SCORE",
  specVersion: 1,
  theatres: { kind: "LIST", refs: [{ id: "amc:theatre:610" }] },
  where: { ids: ["amc:movie:1"], kind: "MOVIE" },
};

const goldenPlacement = {
  count: 2,
  layoutId: "layout_1",
  placementKey: "placement_1",
  row: 0,
  rowSpan: 1,
  seatNames: ["A1", "A2"],
  startCol: 0,
};

const goldenOfferBase = {
  capturedAt: "2026-08-04T20:00:00.000Z",
  deepLinkUrl: "https://www.amctheatres.com/showtimes/1/seats",
  distanceKm: null,
  minPrice: { amount: 18.5, basis: "TICKET_ONLY", currency: "USD" },
  showDateTimeUtc: "2026-08-05T02:30:00.000Z",
  showtimeId: "amc:showtime:1",
  staleAfter: "2026-08-04T20:02:00.000Z",
  status: "OPEN",
  theatreId: "amc:theatre:610",
  timezone: "America/Los_Angeles",
};

const goldenOffer = {
  ...goldenOfferBase,
  nonce: null,
};

const goldenGroupShowtime = {
  ...goldenOfferBase,
  openCount: 2,
  resolved: true,
};

const goldenUnresolvedGroupShowtime = {
  deepLinkUrl: "https://www.amctheatres.com/showtimes/2/seats",
  distanceKm: null,
  minPrice: null,
  openCount: null,
  resolved: false,
  showDateTimeUtc: "2026-08-05T05:30:00.000Z",
  showtimeId: "amc:showtime:2",
  status: "OPEN",
  theatreId: "amc:theatre:610",
  timezone: "America/Los_Angeles",
};

const goldenRecommendation = {
  placement: goldenPlacement,
  reasons: [{ count: 2, kind: "TOGETHER" }],
  relaxed: [],
  showtimes: [goldenOffer],
};

const goldenRelaxedRecommendation = {
  ...goldenRecommendation,
  relaxed: [{ kind: "FEWER_SHOWTIMES" }],
};

const goldenExcluded = {
  byTheatre: {},
  fetchFailed: 0,
  fetchFailedByCause: {},
  notReservedSeating: 0,
  outsideArea: 0,
  outsideRegion: 0,
  outsideWindow: 0,
  overPrice: 0,
  soldOut: 0,
  wrongAttributes: 0,
};

const goldenGroup = {
  attributes: ["DIGITAL"],
  auditorium: "1",
  columns: 2,
  distanceKm: null,
  formatCode: "DIGITAL",
  freeCount: [1, 1],
  freeIn: [[0], [0]],
  groupHits: [{ row: 0, rowSpan: 1, runScore: 0.85, showtimeIndices: [0], startCol: 0 }],
  layoutId: "layout_1",
  regionMask: [1, 1],
  rows: 1,
  seatKinds: [0, 0],
  seatNames: { 0: "A1", 1: "A2" },
  seatScores: [0.9, 0.8],
  showtimes: [goldenGroupShowtime],
  theatreId: "amc:theatre:610",
};

function goldenResult(
  status: "PENDING_SCHEDULE" | "RUNNING" | "COMPLETE" | "PARTIAL" | "HALTED",
  answer: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    answer,
    capturedAtRange:
      status === "PENDING_SCHEDULE"
        ? null
        : ["2026-08-04T20:00:00.000Z", "2026-08-04T20:00:00.000Z"],
    excluded: goldenExcluded,
    groups: [],
    resolved: status === "PENDING_SCHEDULE" ? 0 : 1,
    searchId: "search_1",
    spec: goldenSpec,
    status,
    total: status === "PENDING_SCHEDULE" ? 0 : 1,
    ...overrides,
  };
}

type Schema = { parse(input: unknown): unknown };

const cases: ReadonlyArray<{
  readonly label: string;
  readonly schema: Schema;
  readonly input: unknown;
  readonly expected: unknown;
}> = [
  {
    label: "create input",
    schema: CreateSearchInputSchema,
    input: { spec, idempotencyKey: "idem_1" },
    expected: { idempotencyKey: "idem_1", spec: goldenSpec },
  },
  {
    label: "create PENDING_SCHEDULE response",
    schema: CreateSearchResponseSchema,
    input: {
      status: "PENDING_SCHEDULE",
      searchId: "search_1",
      showtimeCount: null,
      cachedCount: null,
      estimatedMs: 900,
      groups: [],
      scheduleSkeleton: [],
    },
    expected: {
      cachedCount: null,
      estimatedMs: 900,
      groups: [],
      scheduleSkeleton: [],
      searchId: "search_1",
      showtimeCount: null,
      status: "PENDING_SCHEDULE",
    },
  },
  {
    label: "create RUNNING response",
    schema: CreateSearchResponseSchema,
    input: {
      status: "RUNNING",
      searchId: "search_1",
      showtimeCount: 1,
      cachedCount: 1,
      estimatedMs: 100,
      groups: [
        {
          layoutId: "layout_1",
          theatreId: "amc:theatre:610",
          distanceKm: null,
          formatCode: "DIGITAL",
          auditorium: "1",
          showtimeCount: 1,
        },
      ],
      scheduleSkeleton: [],
    },
    expected: {
      cachedCount: 1,
      estimatedMs: 100,
      groups: [
        {
          auditorium: "1",
          distanceKm: null,
          formatCode: "DIGITAL",
          layoutId: "layout_1",
          showtimeCount: 1,
          theatreId: "amc:theatre:610",
        },
      ],
      scheduleSkeleton: [],
      searchId: "search_1",
      showtimeCount: 1,
      status: "RUNNING",
    },
  },
  {
    label: "create idempotency conflict",
    schema: IdempotencyKeyConflictSchema,
    input: { code: "IDEMPOTENCY_KEY_CONFLICT", searchId: "search_1" },
    expected: { code: "IDEMPOTENCY_KEY_CONFLICT", searchId: "search_1" },
  },
  {
    label: "progress SCHEDULE_RESOLVED",
    schema: contracts.SearchProgressEventSchema,
    input: { type: "schedule_resolved", showtimeCount: 1 },
    expected: { showtimeCount: 1, type: "schedule_resolved" },
  },
  {
    label: "progress PROGRESS",
    schema: contracts.SearchProgressEventSchema,
    input: { type: "progress", resolved: 1, total: 2 },
    expected: { resolved: 1, total: 2, type: "progress" },
  },
  {
    label: "progress GROUP",
    schema: contracts.SearchProgressEventSchema,
    input: { type: "group", group: resultGroup, resolved: 1, total: 2 },
    expected: { group: goldenGroup, resolved: 1, total: 2, type: "group" },
  },
  {
    label: "progress COMPLETE",
    schema: contracts.SearchProgressEventSchema,
    input: { type: "complete", status: "COMPLETE", resolved: 2, total: 2 },
    expected: { resolved: 2, status: "COMPLETE", total: 2, type: "complete" },
  },
  {
    label: "progress PARTIAL",
    schema: contracts.SearchProgressEventSchema,
    input: { type: "partial", status: "PARTIAL", resolved: 1, total: 2 },
    expected: { resolved: 1, status: "PARTIAL", total: 2, type: "partial" },
  },
  {
    label: "progress HALTED",
    schema: contracts.SearchProgressEventSchema,
    input: {
      type: "halted",
      status: "HALTED",
      cause: "UPSTREAM_BLOCKED",
      resolved: 1,
      total: 2,
    },
    expected: {
      cause: "UPSTREAM_BLOCKED",
      resolved: 1,
      status: "HALTED",
      total: 2,
      type: "halted",
    },
  },
  {
    label: "result PENDING_SCHEDULE",
    schema: contracts.SearchResultSchema,
    input: resultWith("PENDING_SCHEDULE", null),
    expected: goldenResult("PENDING_SCHEDULE", null),
  },
  {
    label: "result RUNNING",
    schema: contracts.SearchResultSchema,
    input: resultWith("RUNNING", null, {
      resolved: 1,
      total: 2,
      groups: [
        resultGroup,
        {
          ...resultGroup,
          formatCode: "IMAX",
          showtimes: [unresolvedGroupShowtime],
          freeCount: [0, 0],
          freeIn: [[], []],
          groupHits: [],
        },
      ],
    }),
    expected: goldenResult("RUNNING", null, {
      resolved: 1,
      total: 2,
      groups: [
        goldenGroup,
        {
          ...goldenGroup,
          formatCode: "IMAX",
          showtimes: [goldenUnresolvedGroupShowtime],
          freeCount: [0, 0],
          freeIn: [[], []],
          groupHits: [],
        },
      ],
    }),
  },
  {
    label: "result COMPLETE CONFIDENT",
    schema: contracts.SearchResultSchema,
    input: resultWith("COMPLETE", {
      mode: "CONFIDENT",
      primary: recommendation,
      otherFormats: [{ formatCode: "IMAX", bestRunScore: 0.91 }],
    }),
    expected: goldenResult("COMPLETE", {
      mode: "CONFIDENT",
      otherFormats: [{ bestRunScore: 0.91, formatCode: "IMAX" }],
      primary: goldenRecommendation,
    }),
  },
  {
    label: "result COMPLETE HEDGED",
    schema: contracts.SearchResultSchema,
    input: resultWith("COMPLETE", {
      mode: "HEDGED",
      alternatives: [relaxedRecommendation, relaxedRecommendation],
      otherFormats: [],
    }),
    expected: goldenResult("COMPLETE", {
      alternatives: [goldenRelaxedRecommendation, goldenRelaxedRecommendation],
      mode: "HEDGED",
      otherFormats: [],
    }),
  },
  {
    label: "result COMPLETE EMPTY",
    schema: contracts.SearchResultSchema,
    input: resultWith("COMPLETE", {
      mode: "EMPTY",
      cause: "NO_SHAPE_MATCH",
      suggestions: [{ kind: "WIDEN_WINDOW", direction: "FULL_DAY" }],
    }),
    expected: goldenResult("COMPLETE", {
      cause: "NO_SHAPE_MATCH",
      mode: "EMPTY",
      suggestions: [{ direction: "FULL_DAY", kind: "WIDEN_WINDOW" }],
    }),
  },
  {
    label: "result PARTIAL",
    schema: contracts.SearchResultSchema,
    input: resultWith(
      "PARTIAL",
      {
        mode: "HEDGED",
        alternatives: [relaxedRecommendation, relaxedRecommendation],
        otherFormats: [],
      },
      { resolved: 1, total: 2 },
    ),
    expected: goldenResult(
      "PARTIAL",
      {
        alternatives: [goldenRelaxedRecommendation, goldenRelaxedRecommendation],
        mode: "HEDGED",
        otherFormats: [],
      },
      { resolved: 1, total: 2 },
    ),
  },
  {
    label: "result HALTED",
    schema: contracts.SearchResultSchema,
    input: resultWith(
      "HALTED",
      { mode: "EMPTY", cause: "CAPACITY", suggestions: [] },
      {
        capturedAtRange: null,
        resolved: 0,
        total: 2,
      },
    ),
    expected: goldenResult(
      "HALTED",
      { cause: "CAPACITY", mode: "EMPTY", suggestions: [] },
      {
        capturedAtRange: null,
        resolved: 0,
        total: 2,
      },
    ),
  },
  {
    label: "reveal COMPLETE CONFIDENT",
    schema: contracts.RevealPayloadSchema,
    input: {
      status: "COMPLETE",
      cause: null,
      answer: {
        mode: "CONFIDENT",
        primary: recommendation,
        otherFormats: [{ formatCode: "IMAX", bestRunScore: 0.91 }],
      },
    },
    expected: {
      answer: {
        mode: "CONFIDENT",
        otherFormats: [{ bestRunScore: 0.91, formatCode: "IMAX" }],
        primary: goldenRecommendation,
      },
      cause: null,
      status: "COMPLETE",
    },
  },
  {
    label: "reveal PARTIAL HEDGED",
    schema: contracts.RevealPayloadSchema,
    input: {
      status: "PARTIAL",
      cause: "PARTIAL_SCHEDULE",
      answer: {
        mode: "HEDGED",
        alternatives: [relaxedRecommendation, relaxedRecommendation],
        otherFormats: [],
      },
    },
    expected: {
      answer: {
        alternatives: [goldenRelaxedRecommendation, goldenRelaxedRecommendation],
        mode: "HEDGED",
        otherFormats: [],
      },
      cause: "PARTIAL_SCHEDULE",
      status: "PARTIAL",
    },
  },
  {
    label: "reveal HALTED EMPTY",
    schema: contracts.RevealPayloadSchema,
    input: {
      status: "HALTED",
      cause: "CAPACITY",
      answer: { mode: "EMPTY", cause: "CAPACITY", suggestions: [] },
    },
    expected: {
      answer: { cause: "CAPACITY", mode: "EMPTY", suggestions: [] },
      cause: "CAPACITY",
      status: "HALTED",
    },
  },
  {
    label: "recheck input",
    schema: RecheckInputSchema,
    input: {
      searchId: "search_1",
      showtimeId: "amc:showtime:1",
      placementKey: "placement_1",
      nonce: "nonce_1",
    },
    expected: {
      nonce: "nonce_1",
      placementKey: "placement_1",
      searchId: "search_1",
      showtimeId: "amc:showtime:1",
    },
  },
  {
    label: "recheck AVAILABLE",
    schema: RecheckResultSchema,
    input: {
      status: "AVAILABLE",
      placement,
      checkedAt: "2026-08-04T20:01:00.000Z",
    },
    expected: {
      checkedAt: "2026-08-04T20:01:00.000Z",
      placement: goldenPlacement,
      status: "AVAILABLE",
    },
  },
  {
    label: "recheck GONE",
    schema: RecheckResultSchema,
    input: {
      status: "GONE",
      recovery: [
        {
          level: 1,
          placement,
          showtimeId: "amc:showtime:1",
          relaxed: [],
          requiresConsent: false,
        },
        {
          level: 4,
          placement,
          showtimeId: "amc:showtime:2",
          relaxed: [{ kind: "FEWER_SHOWTIMES" }],
          requiresConsent: true,
        },
      ],
    },
    expected: {
      recovery: [
        {
          level: 1,
          placement: goldenPlacement,
          relaxed: [],
          requiresConsent: false,
          showtimeId: "amc:showtime:1",
        },
        {
          level: 4,
          placement: goldenPlacement,
          relaxed: [{ kind: "FEWER_SHOWTIMES" }],
          requiresConsent: true,
          showtimeId: "amc:showtime:2",
        },
      ],
      status: "GONE",
    },
  },
  {
    label: "recheck UNAVAILABLE",
    schema: RecheckResultSchema,
    input: {
      status: "UNAVAILABLE",
      cause: "TIMEOUT",
      lastKnown: { placement, capturedAt: "2026-08-04T20:00:00.000Z" },
    },
    expected: {
      cause: "TIMEOUT",
      lastKnown: {
        capturedAt: "2026-08-04T20:00:00.000Z",
        placement: goldenPlacement,
      },
      status: "UNAVAILABLE",
    },
  },
];

describe("canonical wire goldens", () => {
  it.each(cases)("byte-compares $label", ({ schema, input, expected }) => {
    const actualBytes = canonicalJson(schema.parse(input));
    const expectedBytes = canonicalJson(expected);

    expect(actualBytes).toBe(expectedBytes);
  });
});
