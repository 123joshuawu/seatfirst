import { describe, expect, it } from "vitest";

import {
  CreateResultGroupSchema,
  RecommendationReasonSchema,
  RecoveryOptionSchema,
  RelaxationSchema,
  RecheckResultSchema,
  SuggestedWidenSchema,
  createResultContractSchemas,
} from "../src/index.js";

import {
  excluded,
  offer,
  placement,
  recommendation,
  relaxedRecommendation,
  resultGroup,
  resultWith,
  unresolvedGroupShowtime,
} from "./support/contract-fixtures.js";

const contracts = createResultContractSchemas({
  providerHostAllowlists: { amc: ["www.amctheatres.com"] },
});

const confident = {
  mode: "CONFIDENT",
  primary: recommendation,
  otherFormats: [],
} as const;
const hedged = {
  mode: "HEDGED",
  alternatives: [relaxedRecommendation, relaxedRecommendation],
  otherFormats: [],
} as const;
const empty = (cause: string) => ({ mode: "EMPTY", cause, suggestions: [] });

describe("ranked-answer invalid states", () => {
  it("rejects CONFIDENT without a primary", () => {
    expect(
      contracts.RankedAnswerSchema.safeParse({ mode: "CONFIDENT", otherFormats: [] }).success,
    ).toBe(false);
  });

  it("rejects CONFIDENT with any relaxation", () => {
    expect(
      contracts.RankedAnswerSchema.safeParse({
        ...confident,
        primary: relaxedRecommendation,
      }).success,
    ).toBe(false);
  });

  it("rejects HEDGED when an alternative has no relaxation", () => {
    expect(
      contracts.RankedAnswerSchema.safeParse({
        ...hedged,
        alternatives: [relaxedRecommendation, recommendation],
      }).success,
    ).toBe(false);
  });

  it("rejects HEDGED outside its exact two-or-three alternative cardinality", () => {
    expect(
      contracts.RankedAnswerSchema.safeParse({
        ...hedged,
        alternatives: [relaxedRecommendation],
      }).success,
    ).toBe(false);
    expect(
      contracts.RankedAnswerSchema.safeParse({
        ...hedged,
        alternatives: [
          relaxedRecommendation,
          relaxedRecommendation,
          relaxedRecommendation,
          relaxedRecommendation,
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects EMPTY carrying placement data", () => {
    expect(
      contracts.RankedAnswerSchema.safeParse({
        ...empty("NO_SHAPE_MATCH"),
        placements: [placement],
      }).success,
    ).toBe(false);
  });
});

describe("open enums", () => {
  it.each([
    [
      "RecommendationReason",
      RecommendationReasonSchema,
      { kind: "FUTURE_REASON", label: "New", payload: { nested: [1, { future: true }] } },
    ],
    [
      "Relaxation",
      RelaxationSchema,
      { kind: "FARTHER_THEATRE", label: "Farther", policy: { radius: 25 } },
    ],
    [
      "SuggestedWiden",
      SuggestedWidenSchema,
      { kind: "FUTURE_ACTION", parameters: { modes: ["A", "B"] } },
    ],
  ])("accepts a genuinely unknown %s kind", (_name, schema, value) => {
    const parsed = schema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(value);
    }
  });

  it.each([
    ["RecommendationReason", RecommendationReasonSchema, { kind: "CENTERED" }],
    ["Relaxation", RelaxationSchema, { kind: "DIFFERENT_FORMAT", from: "IMAX" }],
    ["Relaxation", RelaxationSchema, { kind: "UNRESOLVED_SHOWTIMES" }],
    ["Relaxation", RelaxationSchema, { kind: "UNRESOLVED_SHOWTIMES", count: 0 }],
    ["SuggestedWiden", SuggestedWidenSchema, { kind: "NEARBY_THEATRE" }],
  ])(
    "rejects malformed known %s kinds instead of using the unknown arm",
    (_name, schema, value) => {
      expect(schema.safeParse(value).success).toBe(false);
    },
  );

  it("round-trips UNRESOLVED_SHOWTIMES as a known kind (ADR 0033)", () => {
    const value = { kind: "UNRESOLVED_SHOWTIMES", count: 2 };
    const parsed = RelaxationSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(value);
    }
    // Negative counts are malformed too, not unknown kinds.
    expect(RelaxationSchema.safeParse({ kind: "UNRESOLVED_SHOWTIMES", count: -1 }).success).toBe(
      false,
    );
  });
});

describe("wire refinements", () => {
  it("accepts only configured HTTPS provider links", () => {
    expect(contracts.ShowtimeOfferSchema.safeParse(offer).success).toBe(true);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        deepLinkUrl: "https://evil.example/showtimes/1",
      }).success,
    ).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        deepLinkUrl: "http://www.amctheatres.com/showtimes/1",
      }).success,
    ).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({ ...offer, theatreId: "other:theatre:1" }).success,
    ).toBe(false);
  });

  it("rejects offsets, bare local timestamps, and non-IANA timezone labels", () => {
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        showDateTimeUtc: "2026-08-04T19:30:00-07:00",
      }).success,
    ).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        showDateTimeUtc: "2026-08-04T19:30:00",
      }).success,
    ).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({ ...offer, timezone: "Pacific Time" }).success,
    ).toBe(false);
  });

  it("requires money currency and price basis", () => {
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        minPrice: { amount: 18.5, currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        minPrice: { amount: 18.5, currency: "usd", basis: "TICKET_ONLY" },
      }).success,
    ).toBe(false);
  });

  it("requires freshness to move forward", () => {
    expect(
      contracts.ShowtimeOfferSchema.safeParse({
        ...offer,
        staleAfter: "2026-08-04T19:59:59.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires every recommendation to explain itself", () => {
    expect(
      contracts.RecommendationSchema.safeParse({ ...recommendation, reasons: [] }).success,
    ).toBe(false);
  });
  it("requires the recheck nonce on the wire (nullable, never optional)", () => {
    const offerWithoutNonce = Object.fromEntries(
      Object.entries(offer).filter(([key]) => key !== "nonce"),
    );
    expect(contracts.ShowtimeOfferSchema.safeParse(offerWithoutNonce).success).toBe(false);
    expect(
      contracts.ShowtimeOfferSchema.safeParse({ ...offer, nonce: "signed-token" }).success,
    ).toBe(true);
  });
});

describe("recheck invariants", () => {
  it("rejects GONE with an empty recovery list", () => {
    expect(RecheckResultSchema.safeParse({ status: "GONE", recovery: [] }).success).toBe(false);
  });

  it("rejects level-4 recovery without requiresConsent:true", () => {
    const levelFour = {
      level: 4,
      placement,
      showtimeId: "amc:showtime:2",
      relaxed: [{ kind: "FEWER_SHOWTIMES" }],
    };

    expect(RecoveryOptionSchema.safeParse(levelFour).success).toBe(false);
    expect(RecoveryOptionSchema.safeParse({ ...levelFour, requiresConsent: false }).success).toBe(
      false,
    );
    expect(RecoveryOptionSchema.safeParse({ ...levelFour, requiresConsent: true }).success).toBe(
      true,
    );
  });

  it("rejects recovery options that move backward down the fallback ladder", () => {
    const recovery = [
      {
        level: 3,
        placement,
        showtimeId: "amc:showtime:1",
        relaxed: [],
        requiresConsent: false,
      },
      {
        level: 2,
        placement,
        showtimeId: "amc:showtime:2",
        relaxed: [],
        requiresConsent: false,
      },
    ];
    expect(RecheckResultSchema.safeParse({ status: "GONE", recovery }).success).toBe(false);
    expect(
      RecheckResultSchema.safeParse({
        status: "GONE",
        recovery: [...recovery].reverse(),
      }).success,
    ).toBe(true);
  });
});

describe("aggregate integrity", () => {
  it("represents unresolved progressive group skeletons distinctly", () => {
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        showtimes: [unresolvedGroupShowtime],
        freeCount: [0, 0],
        freeIn: [[], []],
        groupHits: [],
      }).success,
    ).toBe(true);
    expect(
      contracts.GroupShowtimeSchema.safeParse({
        ...unresolvedGroupShowtime,
        openCount: 0,
      }).success,
    ).toBe(false);
    expect(
      contracts.GroupShowtimeSchema.safeParse({
        ...unresolvedGroupShowtime,
        capturedAt: "2026-08-04T20:00:00.000Z",
        staleAfter: "2026-08-04T20:02:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      contracts.GroupShowtimeSchema.safeParse({
        ...unresolvedGroupShowtime,
        resolved: true,
        openCount: 0,
      }).success,
    ).toBe(false);
  });

  it("requires an authoritative nonempty format code on every group", () => {
    expect(
      contracts.ResultGroupSchema.safeParse({ ...resultGroup, formatCode: null }).success,
    ).toBe(false);
    expect(contracts.ResultGroupSchema.safeParse({ ...resultGroup, formatCode: "" }).success).toBe(
      false,
    );
    expect(
      CreateResultGroupSchema.safeParse({
        layoutId: "layout_1",
        theatreId: "amc:theatre:610",
        distanceKm: null,
        formatCode: null,
        auditorium: "1",
        showtimeCount: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects containing-group attribution mismatches", () => {
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        showtimes: [{ ...resultGroup.showtimes[0], theatreId: "amc:theatre:999" }],
      }).success,
    ).toBe(false);
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        showtimes: [{ ...resultGroup.showtimes[0], distanceKm: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-grid seat names and group-hit coordinates", () => {
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        seatNames: { ...resultGroup.seatNames, 2: "A3" },
      }).success,
    ).toBe(false);
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        groupHits: [{ ...resultGroup.groupHits[0], row: 1, startCol: 2, showtimeIndices: [0] }],
      }).success,
    ).toBe(false);
  });

  it("rejects freeIn and group-hit indices outside showtimes", () => {
    expect(
      contracts.ResultGroupSchema.safeParse({ ...resultGroup, freeIn: [[1], [0]] }).success,
    ).toBe(false);
    expect(
      contracts.ResultGroupSchema.safeParse({
        ...resultGroup,
        groupHits: [{ ...resultGroup.groupHits[0], showtimeIndices: [1] }],
      }).success,
    ).toBe(false);
  });

  it("enforces SearchSpec provider namespaces through groups, offers, and top runs", () => {
    const answerWithWrongProvider = {
      ...confident,
      primary: {
        ...recommendation,
        showtimes: [{ ...offer, showtimeId: "other:showtime:1", theatreId: "other:theatre:1" }],
      },
    };
    expect(
      contracts.SearchResultSchema.safeParse(resultWith("COMPLETE", answerWithWrongProvider))
        .success,
    ).toBe(false);
    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("RUNNING", null, {
          groups: [{ ...resultGroup, theatreId: "other:theatre:1" }],
          resolved: 1,
          total: 2,
        }),
      ).success,
    ).toBe(false);
    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("COMPLETE", confident, {
          topRuns: [
            {
              layoutId: "layout_1",
              row: 0,
              startCol: 0,
              rowSpan: 1,
              runScore: 1,
              showtimeIds: ["other:showtime:1"],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("enforces SearchSpec provider namespaces on theatre and nested movie inputs", () => {
    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("RUNNING", null, {
          spec: {
            ...resultWith("RUNNING", null).spec,
            theatres: { kind: "LIST", refs: [{ id: "other:theatre:610" }] },
          },
          resolved: 0,
          total: 1,
        }),
      ).success,
    ).toBe(false);

    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("RUNNING", null, {
          spec: {
            ...resultWith("RUNNING", null).spec,
            where: {
              kind: "AND",
              of: [
                { kind: "MOVIE", ids: ["amc:movie:1"] },
                { kind: "NOT", of: { kind: "MOVIE", ids: ["other:movie:2"] } },
              ],
            },
          },
          resolved: 0,
          total: 1,
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects captured offers outside the declared capture range", () => {
    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("COMPLETE", confident, {
          capturedAtRange: ["2026-08-04T20:01:00.000Z", "2026-08-04T20:02:00.000Z"],
        }),
      ).success,
    ).toBe(false);
  });

  it.each(["progress", "group", "complete", "partial", "halted"] as const)(
    "rejects %s events whose resolved count exceeds total",
    (type) => {
      const payload =
        type === "group"
          ? { type, group: resultGroup, resolved: 2, total: 1 }
          : type === "complete"
            ? { type, status: "COMPLETE", resolved: 2, total: 1 }
            : type === "partial"
              ? { type, status: "PARTIAL", resolved: 2, total: 1 }
              : type === "halted"
                ? {
                    type,
                    status: "HALTED",
                    cause: "UPSTREAM_BLOCKED",
                    resolved: 2,
                    total: 1,
                  }
                : { type, resolved: 2, total: 1 };
      expect(contracts.SearchProgressEventSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("enforces progress counts through the individually exported event schemas", () => {
    expect(
      contracts.ProgressEventSchema.safeParse({
        type: "progress",
        resolved: 2,
        total: 1,
      }).success,
    ).toBe(false);
  });

  it("does not terminalize a PAUSED rate limit as HALTED", () => {
    expect(
      contracts.HaltedEventSchema.safeParse({
        type: "halted",
        status: "HALTED",
        cause: "RATE_LIMITED",
        resolved: 0,
        total: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ADR 0003 A1–A14 result matrix", () => {
  const cases = [
    ["A1", resultWith("PENDING_SCHEDULE", null, { resolved: 0, total: 0 })],
    ["A2", resultWith("RUNNING", null, { resolved: 1, total: 2 })],
    ["A3", resultWith("COMPLETE", confident)],
    ["A4", resultWith("COMPLETE", hedged)],
    ["A5", resultWith("COMPLETE", empty("NO_SHAPE_MATCH"))],
    ["A6", resultWith("COMPLETE", empty("SOLD_OUT"))],
    ["A7", resultWith("COMPLETE", empty("TOO_FEW_SHOWTIMES"), { resolved: 0, total: 0 })],
    ["A8-HEDGED", resultWith("PARTIAL", hedged, { resolved: 1, total: 2 })],
    ["A8-EMPTY", resultWith("PARTIAL", empty("NO_SHAPE_MATCH"), { resolved: 1, total: 2 })],
    ["A9", resultWith("PARTIAL", empty("HALTED"), { resolved: 0, total: 1 })],
    [
      "A10",
      resultWith("HALTED", empty("HALTED"), {
        resolved: 0,
        total: 0,
        capturedAtRange: null,
      }),
    ],
    ["A11", resultWith("HALTED", empty("HALTED"), { resolved: 1, total: 2 })],
    ["A12", resultWith("HALTED", empty("HALTED"), { resolved: 0, total: 2 })],
    ["A13", resultWith("HALTED", empty("CAPACITY"), { resolved: 0, total: 2 })],
    [
      "A14-HEDGED",
      resultWith("PARTIAL", hedged, {
        resolved: 1,
        total: 2,
        excluded: {
          ...excluded,
          fetchFailed: 1,
          fetchFailedByCause: { UPSTREAM_UNAVAILABLE: 1 },
        },
      }),
    ],
    [
      "A14-EMPTY",
      resultWith("PARTIAL", empty("PARTIAL_SCHEDULE"), {
        resolved: 0,
        total: 2,
        excluded: {
          ...excluded,
          fetchFailed: 1,
          fetchFailedByCause: { UPSTREAM_UNAVAILABLE: 1 },
        },
      }),
    ],
  ] as const;

  it.each(cases)("accepts %s with its exact answer constraint", (_id, payload) => {
    expect(contracts.SearchResultSchema.safeParse(payload).success).toBe(true);
  });

  it("pins A10's absent capture range", () => {
    const parsed = contracts.SearchResultSchema.parse(cases.find(([id]) => id === "A10")?.[1]);
    expect(parsed.capturedAtRange).toBeNull();
  });

  it.each(["COMPLETE", "PARTIAL", "HALTED"] as const)(
    "rejects terminal %s with answer:null",
    (status) => {
      expect(contracts.SearchResultSchema.safeParse(resultWith(status, null)).success).toBe(false);
    },
  );

  it("forbids every status/answer pairing outside the matrix", () => {
    const forbidden = [
      resultWith("PENDING_SCHEDULE", confident),
      resultWith("RUNNING", empty("HALTED")),
      resultWith("COMPLETE", null),
      // COMPLETE + EMPTY:HALTED is IN the matrix since ADR 0009: every showtime
      // policy-skipped derives EMPTY:HALTED for a COMPLETE search
      // (`docs/adr/0009-p5-5-schedule-status-evidence-policy.md:68-89`) — asserted as
      // accepted below, next to the A15 row of `tier3.lifecycle.test.ts`.
      resultWith("COMPLETE", empty("CAPACITY")),
      resultWith("COMPLETE", empty("PARTIAL_SCHEDULE")),
      resultWith("PARTIAL", confident),
      resultWith("PARTIAL", empty("SOLD_OUT")),
      resultWith("PARTIAL", empty("TOO_FEW_SHOWTIMES")),
      resultWith("PARTIAL", empty("CAPACITY")),
      resultWith("HALTED", null),
      resultWith("HALTED", confident),
      resultWith("HALTED", hedged),
      resultWith("HALTED", empty("SOLD_OUT")),
      resultWith("HALTED", empty("NO_SHAPE_MATCH")),
      resultWith("HALTED", empty("TOO_FEW_SHOWTIMES")),
      resultWith("HALTED", empty("PARTIAL_SCHEDULE")),
    ];

    expect(forbidden).toHaveLength(16);
    for (const payload of forbidden) {
      expect(contracts.SearchResultSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("accepts the ADR 0009 row: COMPLETE with EMPTY:HALTED (A15, all performances policy-skipped)", () => {
    expect(
      contracts.SearchResultSchema.safeParse(resultWith("COMPLETE", empty("HALTED"))).success,
    ).toBe(true);
  });

  it("never lets A14 report TOO_FEW_SHOWTIMES", () => {
    expect(
      contracts.SearchResultSchema.safeParse(
        resultWith("PARTIAL", empty("TOO_FEW_SHOWTIMES"), {
          resolved: 0,
          total: 2,
          excluded: {
            ...excluded,
            fetchFailed: 1,
            fetchFailedByCause: { UPSTREAM_UNAVAILABLE: 1 },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("RevealPayloadSchema (S6U3.0)", () => {
  const reveal = (status: string, cause: string | null, answer: unknown) => ({
    status,
    cause,
    answer,
  });

  it("accepts the three answer modes at their terminal statuses", () => {
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("COMPLETE", null, confident)).success,
    ).toBe(true);
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("PARTIAL", "PARTIAL_SCHEDULE", hedged))
        .success,
    ).toBe(true);
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("HALTED", "CAPACITY", empty("CAPACITY")))
        .success,
    ).toBe(true);
  });

  it("rejects PARTIAL with a CONFIDENT answer (A8)", () => {
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("PARTIAL", null, confident)).success,
    ).toBe(false);
  });

  it("rejects HALTED with a HEDGED answer", () => {
    expect(contracts.RevealPayloadSchema.safeParse(reveal("HALTED", null, hedged)).success).toBe(
      false,
    );
  });

  it("rejects an unknown cause (the reveal uses the durability TerminalCause vocabulary)", () => {
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("HALTED", "UPSTREAM_BLOCKED", empty("HALTED")))
        .success,
    ).toBe(false);
  });

  it("admits COMPLETE with EMPTY:HALTED — ADR 0009's policy-skipped row", () => {
    expect(
      contracts.RevealPayloadSchema.safeParse(reveal("COMPLETE", null, empty("HALTED"))).success,
    ).toBe(true);
  });

  it("rejects a missing answer (the S6U3.1 hard-require's wire shape)", () => {
    expect(
      contracts.RevealPayloadSchema.safeParse({ status: "COMPLETE", cause: null }).success,
    ).toBe(false);
  });
});

describe("S52 strict rate-limit and bootstrap fields", () => {
  it("RateLimitErrorSchema accepts suggest_place_per_minute and retains previous variants", async () => {
    const { RateLimitErrorSchema } = await import("../src/result-contracts.js");
    const variants = [
      "searches_per_hour",
      "fetches_per_hour",
      "concurrent_searches",
      "recheck_calls_per_minute",
      "facet_counts_per_minute",
      "resolve_place_per_minute",
      "suggest_place_per_minute",
    ] as const;
    for (const limit of variants) {
      expect(
        RateLimitErrorSchema.safeParse({ code: "RATE_LIMITED", limit, retryAfterSeconds: 1 })
          .success,
      ).toBe(true);
    }
    expect(
      RateLimitErrorSchema.safeParse({
        code: "RATE_LIMITED",
        limit: "searches_per_hour",
        retryAfterSeconds: null,
      }).success,
    ).toBe(true);
  });
  it("SessionBootstrapResponseSchema requires suggestPlacePerMinute and rejects missing", async () => {
    const { SessionBootstrapResponseSchema } = await import("../src/result-contracts.js");
    const base = {
      sessionId: "test-session",
      limits: {
        searchesPerHour: 1,
        upstreamFetchesPerHour: 1,
        concurrentSearches: 1,
        recheckCallsPerMinute: 1,
        facetCountsPerMinute: 1,
        resolvePlacePerMinute: 1,
        suggestPlacePerMinute: 1,
      },
    };
    expect(SessionBootstrapResponseSchema.safeParse(base).success).toBe(true);
    const { suggestPlacePerMinute: _omit, ...restLimits } = base.limits;
    void _omit;
    expect(
      SessionBootstrapResponseSchema.safeParse({ sessionId: base.sessionId, limits: restLimits })
        .success,
    ).toBe(false);
  });
});
