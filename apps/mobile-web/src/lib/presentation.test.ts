import { describe, expect, it } from "vitest";
import {
  devShowtimeId,
  makeConfidentAnswer,
  makeHedgedAnswer,
  makeHitGroup,
  makePlacement,
} from "@/fixtures/contracts";
import {
  formatCodeLabel,
  formatSeatRange,
  handoffHonestyLabel,
  resolveActivePlacementCard,
  resolveHandoffTarget,
  runtimeLabel,
  searchErrorDetailLabel,
} from "./presentation";

describe("runtimeLabel", () => {
  it("formats hours and remainder as '2h 46m'", () => {
    expect(runtimeLabel(166)).toBe("2h 46m");
  });

  it("formats an exact hour as '2h'", () => {
    expect(runtimeLabel(120)).toBe("2h");
  });

  it("formats a sub-hour runtime as '46m'", () => {
    expect(runtimeLabel(46)).toBe("46m");
  });

  it("returns null for null, zero, or negative input", () => {
    expect(runtimeLabel(null)).toBeNull();
    expect(runtimeLabel(0)).toBeNull();
    expect(runtimeLabel(-90)).toBeNull();
  });
});

describe("formatCodeLabel", () => {
  it("labels real AMC provider codes, not the raw code", () => {
    // Regression: these are the real lower-case codes AMC's provider returns
    // (docs/adr/0008 canonical vocabulary, buildSearchSpec.ts formatCodeToPref) — a raw
    // code like "dolbycinemaatamcprime" must never reach the UI.
    expect(formatCodeLabel("dolbycinemaatamcprime")).toBe("Dolby Cinema");
    expect(formatCodeLabel("imax")).toBe("IMAX");
    expect(formatCodeLabel("imax70mm")).toBe("IMAX");
    expect(formatCodeLabel("imaxlaseratamc")).toBe("IMAX");
  });

  it("labels the dev-seed STANDARD sentinel and unknown codes as Standard", () => {
    expect(formatCodeLabel("STANDARD")).toBe("Standard");
    expect(formatCodeLabel("some_unrecognized_code")).toBe("Standard");
  });
});

describe("formatSeatRange", () => {
  it("shows ascending numbers when seatNames are already in ascending order", () => {
    expect(formatSeatRange(["D4", "D5", "D6", "D7"])).toBe("Row D, Seats 4–7");
  });

  it("always shows the lower number first, even when seatNames run in descending order", () => {
    // House-left numbering can decrease left-to-right, so the API can hand back seatNames
    // in reverse order. "Row D, Seats 7–4" must never reach the UI.
    expect(formatSeatRange(["D7", "D6", "D5", "D4"])).toBe("Row D, Seats 4–7");
  });

  it("formats a single seat without a range", () => {
    expect(formatSeatRange(["G8"])).toBe("Row G, Seat 8");
  });

  it("falls back to a raw join when a seat name doesn't match the row-letter+number pattern", () => {
    expect(formatSeatRange(["X", "Y"])).toBe("X, Y");
  });
});

describe("resolveHandoffTarget (ADR 0017 amendment)", () => {
  it("resolves a non-primary CONFIDENT hit row to its best-hit placement+nonce", () => {
    // Primary covers s1; the clicked row s9 lives only in a group hit.
    const answer = makeConfidentAnswer();
    const group = makeHitGroup("s9", {
      over: {
        groupHits: [
          {
            row: 5,
            startCol: 5,
            rowSpan: 1,
            runScore: 0,
            showtimeIndices: [0],
            placementKey: "hit-plc-s9",
            showtimeNonces: ["hit-nonce-s9"],
          },
        ],
      },
    });
    const target = resolveHandoffTarget(answer, [group], devShowtimeId("s9"));
    expect(target).toEqual({
      placementKey: "hit-plc-s9",
      showtimeId: devShowtimeId("s9"),
      nonce: "hit-nonce-s9",
    });
  });

  it("resolves the SECOND HEDGED alternative's own placement, not alternatives[0]'s", () => {
    const answer = makeHedgedAnswer();
    const target = resolveHandoffTarget(answer, [], devShowtimeId("s2"));
    expect(target?.placementKey).toBe("dev-placement-2");
    expect(target?.nonce).toBe("dev-nonce-s2");
  });

  it("prefers the first covering hit (the rendered best hit) for overlapping hits", () => {
    const answer = makeConfidentAnswer();
    const group = makeHitGroup("s9", {
      over: {
        groupHits: [
          {
            row: 5,
            startCol: 5,
            rowSpan: 1,
            runScore: 0,
            showtimeIndices: [0],
            placementKey: "hit-plc-first",
            showtimeNonces: ["hit-nonce-first"],
          },
          {
            row: 6,
            startCol: 0,
            rowSpan: 1,
            runScore: 0,
            showtimeIndices: [0],
            placementKey: "hit-plc-second",
            showtimeNonces: [null],
          },
        ],
      },
    });
    const target = resolveHandoffTarget(answer, [group], devShowtimeId("s9"));
    expect(target?.placementKey).toBe("hit-plc-first");
    expect(target?.nonce).toBe("hit-nonce-first");
  });

  it("returns null for a showtimeId in neither the answer nor any hit", () => {
    const answer = makeConfidentAnswer();
    const group = makeHitGroup("s9");
    expect(resolveHandoffTarget(answer, [group], devShowtimeId("nope"))).toBeNull();
  });
});

describe("resolveActivePlacementCard (ADR 0017 amendment)", () => {
  it("shows a hit-fallback showtime's OWN row/seats, not primary's", () => {
    // Regression test: primary covers s1 only; s2 is a resolved hit-fallback row
    // (in `groupHits`, not in `primary.showtimes`). Before this fix, the recheck
    // screen silently reused `primary`'s placement card for every CONFIDENT-mode
    // handoff regardless of which row was actually clicked.
    const answer = makeConfidentAnswer();
    const primaryGroup = makeHitGroup("s1", { row: 5, startCol: 5 });
    const fallbackGroup = makeHitGroup("s2", { row: 4, startCol: 10 });
    const card = resolveActivePlacementCard(
      answer,
      [primaryGroup, fallbackGroup],
      devShowtimeId("s2"),
      4,
    );
    expect(card).not.toBeNull();
    expect(card?.run).toEqual({ row: 4, startCol: 10, count: 4 });
    expect(card?.id).toBe("dev-placement-s2");
  });

  it("still shows primary's card when the clicked showtime is primary's own", () => {
    const answer = makeConfidentAnswer();
    const primaryGroup = makeHitGroup("s1", { row: 5, startCol: 5 });
    const card = resolveActivePlacementCard(answer, [primaryGroup], devShowtimeId("s1"), 4);
    expect(card).not.toBeNull();
    // Live path (`toPlacementCardFromLive`) keys the card off the recommendation's own
    // placement, not a hit — confirms this did NOT fall through to `toPlacementCardFromHit`.
    expect(card?.id).toBe(answer.primary.placement.placementKey);
  });

  it("returns null when the showtimeId is in neither the answer nor any hit", () => {
    const answer = makeConfidentAnswer();
    const group = makeHitGroup("s9");
    expect(resolveActivePlacementCard(answer, [group], devShowtimeId("nope"), 4)).toBeNull();
  });
});

describe("handoffHonestyLabel (P9.6)", () => {
  it("honestly states the seats arrive pre-selected at AMC", () => {
    const label = handoffHonestyLabel(makePlacement());
    expect(label).toContain("AMC");
    expect(label).toContain("pre-selected");
  });

  it("names the placement being handed off", () => {
    const placement = makePlacement({ seatNames: ["J10", "J9", "J8", "J7"] });
    expect(handoffHonestyLabel(placement)).toContain("Row J 7–10");
  });
});

describe("searchErrorDetailLabel (UI31 fix)", () => {
  it("maps CONTINUATION_NOT_DEFERRED to friendly copy without the raw code", () => {
    const label = searchErrorDetailLabel(
      "continuation requires BATCH_DEFERRED terminal cause",
      "CONTINUATION_NOT_DEFERRED",
    );
    expect(label).toContain("still loading");
    expect(label).not.toContain("CONTINUATION_NOT_DEFERRED");
    expect(label).not.toContain("BATCH_DEFERRED");
  });

  it("preserves the message (code) debug format for every other code", () => {
    expect(searchErrorDetailLabel("Internal server error", "INTERNAL_SERVER_ERROR")).toBe(
      "Internal server error (INTERNAL_SERVER_ERROR)",
    );
  });

  it("renders the bare message when code is undefined", () => {
    expect(searchErrorDetailLabel("boom", undefined)).toBe("boom");
  });
});
