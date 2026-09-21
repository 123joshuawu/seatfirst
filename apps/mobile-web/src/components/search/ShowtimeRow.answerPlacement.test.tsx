import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ShowtimeRow } from "./ShowtimeRow";
import type {
  Placement,
  RecommendationReason,
  ResultGroup,
  ScheduleSkeletonEntry,
} from "@seatfirst/core";

function mkEntry(
  over: { showtimeId: string } & Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>,
): ScheduleSkeletonEntry {
  return {
    theatreId: "th_amc_metreon",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: true,
    resolved: true,
    ...over,
  } as unknown as ScheduleSkeletonEntry;
}

function mkGroupWithLayout(params: {
  showtimeId: string;
  rows: number;
  columns: number;
  layoutId?: string;
  groupHits?: NonNullable<ResultGroup["groupHits"]>;
}): ResultGroup {
  const total = params.rows * params.columns;
  return {
    theatreId: "th_amc_metreon",
    layoutId: params.layoutId ?? "lay_1",
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: "Auditorium 1",
    attributes: [],
    rows: params.rows,
    columns: params.columns,
    seatKinds: Array.from({ length: total }, () => 1),
    seatNames: {},
    seatScores: Array.from({ length: total }, () => 0),
    showtimes: [
      {
        showtimeId: params.showtimeId as unknown as never,
        theatreId: "th_amc_metreon" as unknown as never,
        distanceKm: null,
        showDateTimeUtc: "2026-08-30T19:00:00Z",
        timezone: "America/Los_Angeles",
        minPrice: null,
        status: "AVAILABLE" as unknown as never,
        deepLinkUrl: "https://www.amctheatres.com/showtimes/123",
        capturedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        staleAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        resolved: true as const,
        openCount: 5,
      },
    ],
    freeCount: [],
    freeIn: Array.from({ length: total }, () => [0]),
    groupHits: params.groupHits,
  };
}

function mkAnswerPlacement(
  showtimeId: string,
  placement: Placement,
  reasons: RecommendationReason[] = [{ kind: "MIDDLE_THIRD" }],
): Record<string, { placement: Placement; reasons: RecommendationReason[] }> {
  return { [showtimeId]: { placement, reasons } };
}

function renderRow(props: Parameters<typeof ShowtimeRow>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ShowtimeRow, props));
  });
  return renderer;
}

/**
 * Client display consistency fix: for any showtime covered by the ranked answer,
 * the row's displayed seat/row text and dot-grid highlight must come from the
 * answer's own canonical `Recommendation.placement` — the exact placement bound
 * to the real nonce/recheck/deep-link — never from the (possibly stale,
 * ADR 0064-retained) group's own top `groupHits[0]` pick.
 */
describe("ShowtimeRow canonical answer placement display (this fix)", () => {
  it("renders the answerPlacements seat/row text, not the group's own groupHits[0] pick", () => {
    const showtimeId = "sh_canonical";
    // The group's own top hit claims row B, seats 1-2 …
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 4,
      groupHits: [{ row: 1, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    // … but the canonical answer placement claims row A, seats 3-4.
    const canonical: Placement = {
      layoutId: "lay_1",
      row: 0,
      startCol: 2,
      rowSpan: 1,
      count: 2,
      seatNames: ["A3", "A4"],
      placementKey: "pk-canonical",
    };
    const renderer = renderRow({
      entry: mkEntry({ showtimeId }),
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
      answerPlacements: mkAnswerPlacement(showtimeId, canonical),
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Row A, Seats 3-4");
    expect(str).not.toContain("Row B, Seats 1-2");
    // Same auditorium geometry, so the grid still renders (highlighted canonically).
    expect(str).toContain("seat-dot-grid");
  });

  it("falls back to the groupHits-derived text when this showtime has no answerPlacements entry", () => {
    const showtimeId = "sh_fallback";
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 4,
      groupHits: [{ row: 1, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    const canonical: Placement = {
      layoutId: "lay_1",
      row: 0,
      startCol: 2,
      rowSpan: 1,
      count: 2,
      seatNames: ["A3", "A4"],
      placementKey: "pk-canonical",
    };
    // Entry present for some *other* showtime — this row must behave exactly as before.
    const renderer = renderRow({
      entry: mkEntry({ showtimeId }),
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
      answerPlacements: mkAnswerPlacement("sh_other", canonical),
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Row B, Seats 1-2");
    expect(str).not.toContain("Row A, Seats 3-4");
    expect(str).toContain("seat-dot-grid");
  });

  it("renders no dot grid when the found group's layout does not match the canonical placement", () => {
    const showtimeId = "sh_layout_mismatch";
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 4,
      groupHits: [{ row: 1, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    // Canonical placement lives in another auditorium — highlighting its seats on
    // this group's map would depict the right seats on the wrong map.
    const canonical: Placement = {
      layoutId: "lay_other_auditorium",
      row: 0,
      startCol: 2,
      rowSpan: 1,
      count: 2,
      seatNames: ["A3", "A4"],
      placementKey: "pk-canonical",
    };
    const renderer = renderRow({
      entry: mkEntry({ showtimeId }),
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
      answerPlacements: mkAnswerPlacement(showtimeId, canonical),
    });
    const str = JSON.stringify(renderer.toJSON());
    // Text is still canonical (it never depended on the layout)…
    expect(str).toContain("Row A, Seats 3-4");
    expect(str).not.toContain("Row B, Seats 1-2");
    // …but no mismatched grid renders.
    expect(str).not.toContain("seat-dot-grid");
  });
});
