import { describe, expect, it } from "vitest";

import type { ResultGroup } from "@seatfirst/core";

import { RECHECK_NONCE_TTL_MS, verifyRecheckNonce } from "../src/session/nonce.js";
import type { RecheckNonceIssuance } from "../src/session/nonce-issuance.js";
import { issueHitNonces, issueRecheckNonces } from "../src/session/nonce-issuance.js";

/**
 * ADR 0017 amendment (2026-09-03) — best-hit-per-showtime issuance. Pure unit suite
 * (no containers): hand-built groups, positive control through the same
 * `verifyRecheckNonce` primitive the recheck route consumes.
 */

const SECRET = "test-nonce-secret";
const NOW = 1_786_000_000_000;

function issuance(over: Partial<RecheckNonceIssuance> = {}): RecheckNonceIssuance {
  let minted = 0;
  return {
    sessionId: "sess_hit_1",
    searchId: "srch_hit_1",
    resultVersion: 7,
    nonceSecret: SECRET,
    mintId: () => `mint-${(minted += 1)}`,
    now: () => NOW,
    ...over,
  };
}

function resolvedShowtime(showtimeId: string) {
  return {
    showtimeId,
    theatreId: "amc:theatre:t1",
    distanceKm: null,
    showDateTimeUtc: "2026-08-20T19:00:00.000Z",
    timezone: "America/New_York",
    minPrice: null,
    status: "OPEN",
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}`,
    capturedAt: "2026-08-19T12:00:00.000Z",
    staleAfter: "2026-08-19T12:15:00.000Z",
    resolved: true as const,
    openCount: 4,
  };
}

function makeGroup(
  showtimeIds: readonly string[],
  hits: readonly {
    row: number;
    startCol: number;
    showtimeIndices: readonly number[];
    placementKey?: string | null;
  }[],
): ResultGroup {
  return {
    layoutId: "lay_hit_1",
    theatreId: "amc:theatre:t1",
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: "Aud 6",
    attributes: [],
    rows: 4,
    columns: 8,
    seatKinds: [],
    seatNames: {},
    seatScores: [],
    showtimes: showtimeIds.map((showtimeId) => resolvedShowtime(showtimeId)),
    freeCount: [],
    freeIn: [],
    groupHits: hits.map((hit) => ({
      row: hit.row,
      startCol: hit.startCol,
      rowSpan: 1,
      runScore: 0,
      showtimeIndices: [...hit.showtimeIndices],
      ...(hit.placementKey === undefined
        ? {}
        : { placementKey: hit.placementKey, showtimeNonces: hit.showtimeIndices.map(() => null) }),
    })),
  } as unknown as ResultGroup;
}

describe("issueHitNonces — ADR 0017 amendment", () => {
  it("issues one nonce per showtime bound to the best hit's placementKey", () => {
    const groups = [
      makeGroup(
        ["amc:showtime:a", "amc:showtime:b"],
        [
          // Two overlapping hits cover showtime 0: hits[0] is best.
          { row: 1, startCol: 2, showtimeIndices: [0, 1], placementKey: "plc_best" },
          { row: 2, startCol: 0, showtimeIndices: [0], placementKey: "plc_other" },
        ],
      ),
    ];
    const issued = issueHitNonces(groups, issuance());
    const hits = issued[0]?.groupHits;
    expect(hits?.length).toBe(2);

    const bestSlot = hits?.[0]?.showtimeNonces?.[0];
    expect(typeof bestSlot).toBe("string");
    const payload = verifyRecheckNonce(bestSlot!, SECRET);
    expect(payload).toMatchObject({
      sessionId: "sess_hit_1",
      searchId: "srch_hit_1",
      resultVersion: 7,
      showtimeId: "amc:showtime:a",
      placementKey: "plc_best",
      expiry: NOW + RECHECK_NONCE_TTL_MS,
    });

    // Same best hit covers showtime 1 at position 1.
    const secondSlot = hits?.[0]?.showtimeNonces?.[1];
    expect(verifyRecheckNonce(secondSlot!, SECRET)?.showtimeId).toBe("amc:showtime:b");

    // The non-best overlapping hit keeps its null placeholder.
    expect(hits?.[1]?.showtimeNonces).toEqual([null]);
  });

  it("skips key-less hits and selects the first keyed covering hit", () => {
    const groups = [
      makeGroup(
        ["amc:showtime:a"],
        [
          { row: 0, startCol: 0, showtimeIndices: [0] },
          { row: 1, startCol: 1, showtimeIndices: [0], placementKey: "plc_second" },
        ],
      ),
    ];
    const issued = issueHitNonces(groups, issuance());
    const hits = issued[0]?.groupHits;
    // No placementKey on hits[0] and no placeholders there — nothing to sign into.
    expect(hits?.[0]?.showtimeNonces).toBeUndefined();
    const secondHitNonce = hits?.[1]?.showtimeNonces?.[0];
    expect(secondHitNonce).toBeDefined();
    const payload = verifyRecheckNonce(secondHitNonce!, SECRET);
    expect(payload?.placementKey).toBe("plc_second");
  });

  it("leaves groups without hits referentially unchanged", () => {
    const bare = makeGroup(["amc:showtime:a"], []);
    const withNoHits = { ...bare, groupHits: undefined };
    const issued = issueHitNonces([withNoHits], issuance());
    expect(issued[0]).toBe(withNoHits);
  });

  it("answer issuance is untouched: primary/alternatives selection still only fills offer nonces", () => {
    const answer = {
      mode: "CONFIDENT",
      primary: {
        placement: {
          layoutId: "lay_hit_1",
          row: 1,
          startCol: 2,
          rowSpan: 1,
          count: 2,
          seatNames: ["B3", "B4"],
          placementKey: "plc_best",
        },
        reasons: [{ kind: "TOGETHER", count: 2 }],
        relaxed: [],
        showtimes: [
          {
            showtimeId: "amc:showtime:a",
            theatreId: "amc:theatre:t1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-20T19:00:00.000Z",
            timezone: "America/New_York",
            minPrice: null,
            status: "OPEN",
            deepLinkUrl: "https://www.amctheatres.com/showtimes/amc:showtime:a",
            capturedAt: "2026-08-19T12:00:00.000Z",
            staleAfter: "2026-08-19T12:15:00.000Z",
            nonce: null,
          },
        ],
      },
      otherFormats: [],
    } as const;
    const issued = issueRecheckNonces(answer as never, issuance());
    expect(issued.mode).toBe("CONFIDENT");
    if (issued.mode !== "CONFIDENT") throw new Error("unreachable");
    expect(verifyRecheckNonce(issued.primary.showtimes[0]!.nonce!, SECRET)).toMatchObject({
      showtimeId: "amc:showtime:a",
      placementKey: "plc_best",
    });
  });
});
