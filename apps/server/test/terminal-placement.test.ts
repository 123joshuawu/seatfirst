import { describe, expect, it } from "vitest";

import { findTerminalPlacement } from "../src/routes/showtimes/terminal-placement.js";

/**
 * This fix — the `groups[].groupHits[]` fallback in `findTerminalPlacement`.
 * Pure unit suite (no containers): hand-built terminal payloads. A nonce minted by
 * `issueHitNonces` (ADR 0017 amendment) exists for every resolved hit, not just the
 * ones selected into `answer.primary`/`alternatives`, so a placementKey/showtimeId
 * pair living only in a group's hits must still resolve instead of failing recheck
 * with "terminal answer has no matching placement".
 */

const PLACEMENT_KEY = "b9bbe64ca9ef005e";
const OTHER_KEY = "aaaaaaaaaaaaaaaa";
const SHOWTIME_ID = "amc:showtime:a";
const OTHER_SHOWTIME = "amc:showtime:b";

function placement(key: string = PLACEMENT_KEY) {
  return {
    layoutId: "lay_test",
    row: 0,
    startCol: 2,
    rowSpan: 1,
    count: 2,
    seatNames: ["R1C3", "R1C4"],
    placementKey: key,
  };
}

function answerOffer(showtimeId: string, capturedAt: string) {
  return {
    showtimeId,
    theatreId: "amc:theatre:t1",
    distanceKm: null,
    showDateTimeUtc: "2026-08-20T19:00:00.000Z",
    timezone: "America/New_York",
    minPrice: null,
    status: "OPEN",
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}`,
    capturedAt,
    staleAfter: "2026-08-19T12:15:00.000Z",
    nonce: null,
  };
}

function confidentAnswer(key: string, showtimeId: string, capturedAt: string) {
  return {
    mode: "CONFIDENT",
    primary: {
      placement: placement(key),
      reasons: [{ kind: "TOGETHER", count: 2 }],
      relaxed: [],
      showtimes: [answerOffer(showtimeId, capturedAt)],
    },
    otherFormats: [],
  };
}

function groupShowtime(showtimeId: string, capturedAt: string, resolved = true) {
  return {
    showtimeId,
    theatreId: "amc:theatre:t1",
    distanceKm: null,
    showDateTimeUtc: "2026-08-20T19:00:00.000Z",
    timezone: "America/New_York",
    minPrice: null,
    status: "OPEN",
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}`,
    ...(resolved
      ? {
          capturedAt,
          staleAfter: "2026-08-19T12:15:00.000Z",
          resolved: true as const,
          openCount: 4,
        }
      : { resolved: false as const, openCount: null }),
  };
}

function groupWithHit(options: {
  key?: string | null;
  withPlacement?: boolean;
  showtimeIndices?: readonly number[];
  showtimeId?: string;
  capturedAt?: string;
  resolved?: boolean;
}) {
  const {
    key = PLACEMENT_KEY,
    withPlacement = true,
    showtimeIndices = [0],
    showtimeId = SHOWTIME_ID,
    capturedAt = "2026-08-19T12:00:00.000Z",
    resolved = true,
  } = options;
  return {
    layoutId: "lay_test",
    theatreId: "amc:theatre:t1",
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: "Aud 6",
    attributes: [],
    rows: 1,
    columns: 6,
    seatKinds: [0, 0, 0, 0, 0, 0],
    seatNames: { "0": "R1C1", "1": "R1C2", "2": "R1C3", "3": "R1C4", "4": "R1C5", "5": "R1C6" },
    seatScores: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    showtimes: [groupShowtime(showtimeId, capturedAt, resolved)],
    freeCount: [1, 1, 1, 1, 1, 1],
    freeIn: [[0], [1], [2], [3], [4], [5]],
    groupHits: [
      {
        row: 0,
        startCol: 2,
        rowSpan: 1,
        runScore: 0.75,
        showtimeIndices: [...showtimeIndices],
        placementKey: key,
        ...(withPlacement ? { placement: placement(key ?? OTHER_KEY) } : {}),
        showtimeNonces: [null],
      },
    ],
  };
}

const EMPTY_ANSWER = { mode: "EMPTY", cause: "HALTED", suggestions: [] };

describe("findTerminalPlacement — ranked-answer path (unchanged)", () => {
  it("resolves a CONFIDENT primary match with the offer's capturedAt", () => {
    const payload = {
      answer: confidentAnswer(PLACEMENT_KEY, SHOWTIME_ID, "2026-08-19T12:00:00.000Z"),
      groups: [],
    };
    expect(findTerminalPlacement(payload, PLACEMENT_KEY, SHOWTIME_ID)).toEqual({
      placement: placement(),
      capturedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("returns null for an unknown placementKey", () => {
    const payload = {
      answer: confidentAnswer(PLACEMENT_KEY, SHOWTIME_ID, "2026-08-19T12:00:00.000Z"),
      groups: [],
    };
    expect(findTerminalPlacement(payload, OTHER_KEY, SHOWTIME_ID)).toBeNull();
  });
});

describe("findTerminalPlacement — groups fallback (this fix)", () => {
  it("resolves a placementKey/showtimeId pair living only in groups[].groupHits[]", () => {
    // The ranked answer carries no placement at all (EMPTY), so the answer walk
    // cannot match — the hit's persisted full placement must resolve instead.
    const payload = {
      answer: EMPTY_ANSWER,
      groups: [groupWithHit({})],
    };
    expect(findTerminalPlacement(payload, PLACEMENT_KEY, SHOWTIME_ID)).toEqual({
      placement: placement(),
      capturedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("returns null when the key matches a hit but the showtime is not covered by it", () => {
    const payload = {
      answer: EMPTY_ANSWER,
      groups: [groupWithHit({})],
    };
    expect(findTerminalPlacement(payload, PLACEMENT_KEY, OTHER_SHOWTIME)).toBeNull();
  });

  it("returns null when the hit carries the key but no persisted placement", () => {
    // Pre-fix persisted rows have `placementKey` without `placement`: without the
    // full placement there is nothing booking-ready to return.
    const payload = {
      answer: EMPTY_ANSWER,
      groups: [groupWithHit({ withPlacement: false })],
    };
    expect(findTerminalPlacement(payload, PLACEMENT_KEY, SHOWTIME_ID)).toBeNull();
  });

  it("returns null when the covered showtime is unresolved (no capturedAt)", () => {
    const payload = {
      answer: EMPTY_ANSWER,
      groups: [groupWithHit({ resolved: false })],
    };
    expect(findTerminalPlacement(payload, PLACEMENT_KEY, SHOWTIME_ID)).toBeNull();
  });
});
