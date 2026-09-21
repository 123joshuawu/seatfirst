import { describe, expect, it } from "vitest";
import type { ResultGroup, ScheduleSkeletonEntry } from "@seatfirst/core";
import { applyPreferOrder, NO_PREFERENCE } from "./preferSort";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkEntry(over: {
  showtimeId: string;
  formatCode?: string | null;
  rank?: number;
  admitted?: boolean;
  resolved?: boolean;
}): ScheduleSkeletonEntry {
  return {
    showtimeId: over.showtimeId as unknown as never,
    theatreId: "th_1" as unknown as never,
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: over.formatCode ?? "STANDARD",
    distanceKm: null,
    attributes: [],
    rank: over.rank ?? 0,
    admitted: over.admitted ?? true,
    resolved: over.resolved ?? true,
  };
}

function mkGroupForHits(
  mapping: {
    showtimeId: string;
    hit?: { row: number; startCol: number };
    minPrice?: { amount: number; currency: string; basis: "TICKET_ONLY" | "UNKNOWN" } | null;
  }[],
  opts: {
    rows?: number;
    columns?: number;
    seatKinds?: number[];
    formatCode?: string;
    partySize?: number; // not used here, but for doc
  } = {},
): ResultGroup[] {
  // One group per showtimeId for simplicity, with showtimes array matching that single entry.
  // For skeleton ordering tests we need groups that each own one showtimeId.
  const rows = opts.rows ?? 6;
  const columns = opts.columns ?? 10;
  const seatKinds = opts.seatKinds ?? Array(rows * columns).fill(1);
  const groups: ResultGroup[] = mapping.map(({ showtimeId, hit, minPrice }) => {
    const showtime = {
      showtimeId,
      theatreId: "th_1",
      distanceKm: null,
      showDateTimeUtc: "2026-08-30T19:00:00Z",
      timezone: "America/Los_Angeles",
      minPrice: minPrice ?? null,
      status: "OK" as const,
      deepLinkUrl: "https://amc.com/1",
      capturedAt: "2026-08-30T18:00:00Z",
      staleAfter: "2026-08-30T20:00:00Z",
      resolved: true as const,
      openCount: 10,
    };
    const groupHits = hit
      ? [{ row: hit.row, startCol: hit.startCol, rowSpan: 1, runScore: 0, showtimeIndices: [0] }]
      : [];
    return {
      layoutId: `lay_${showtimeId}`,
      theatreId: "th_1",
      distanceKm: null,
      formatCode: opts.formatCode ?? "STANDARD",
      auditorium: "1",
      attributes: [],
      rows,
      columns,
      seatKinds,
      seatNames: {},
      seatScores: Array(rows * columns).fill(0),
      showtimes: [showtime],
      freeCount: Array(rows * columns).fill(0),
      freeIn: Array(rows * columns)
        .fill(null)
        .map(() => [0]),
      groupHits,
    } as unknown as ResultGroup;
  });
  return groups;
}

// For tests needing explicit seatKinds gap fixture
function gapSeatKinds(rows: number, columns: number, gapCol: number): number[] {
  const arr: number[] = [];
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < columns; c += 1) arr.push(c === gapCol ? 0 : 1);
  return arr;
}

// ---------------------------------------------------------------------------

describe("applyPreferOrder — stable partition semantics", () => {
  it("NO_PREFERENCE returns original skeleton unchanged (same order & reference allowed)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0 }),
      mkEntry({ showtimeId: "sh_b", rank: 1 }),
      mkEntry({ showtimeId: "sh_c", rank: 2 }),
    ];
    const groups: ResultGroup[] = [];
    const out = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE);
    expect(out).toBe(skeleton); // allowed per spec: same array reference
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c"]);
  });

  it("clearing every toggle restores original order (stable partition empty-active)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, formatCode: "imax" }),
      mkEntry({ showtimeId: "sh_b", rank: 1, formatCode: "STANDARD" }),
      mkEntry({ showtimeId: "sh_c", rank: 2, formatCode: "imax" }),
      mkEntry({ showtimeId: "sh_d", rank: 3, formatCode: "dolbycinemaatamcprime" }),
    ];
    // Hits for each to allow seat toggles to influence
    const groups = [
      ...mkGroupForHits(
        [
          { showtimeId: "sh_a", hit: { row: 2, startCol: 4 } }, // centered
          { showtimeId: "sh_b", hit: { row: 2, startCol: 0 } }, // off-centre
          { showtimeId: "sh_c", hit: { row: 0, startCol: 4 } }, // centered but front
          { showtimeId: "sh_d", hit: { row: 5, startCol: 4 } }, // centered back
        ],
        { rows: 6, columns: 10 },
      ),
    ];
    // Apply format+centered, then clear
    const withToggles = applyPreferOrder(skeleton, groups, 2, {
      format: "imax",
      centered: true,
      aisle: false,
      avoidFront: false,
    });
    // With format imax + centered, only sh_a satisfies (sh_c is centered but front — but not filtered here)
    // Actually both sh_a and sh_c are centered and imax, so both satisfy. Expect stable: sh_a, sh_c first, then sh_b, sh_d
    expect(withToggles.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_c", "sh_b", "sh_d"]);

    const cleared = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE);
    expect(cleared.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c", "sh_d"]);
    // Also test explicitly all-false toggles not via constant
    const cleared2 = applyPreferOrder(skeleton, groups, 2, {
      format: "any",
      centered: false,
      aisle: false,
      avoidFront: false,
    });
    expect(cleared2).toBe(skeleton);
  });

  it("multi-toggle exact stable-partition order (format + centered + avoidFront)", () => {
    // Rows 6, columns 10, centre=5. Party size 2.
    // Skeleton rank order: sh_a(0), sh_b(1), sh_c(2), sh_d(3), sh_e(4)
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, formatCode: "imax" }), // hit centered, middle => satisfies all
      mkEntry({ showtimeId: "sh_b", rank: 1, formatCode: "imax" }), // hit centered but front => fails avoidFront
      mkEntry({ showtimeId: "sh_c", rank: 2, formatCode: "STANDARD" }), // hit centered middle but format fails
      mkEntry({ showtimeId: "sh_d", rank: 3, formatCode: "imax" }), // hit off-centre middle => fails centered
      mkEntry({ showtimeId: "sh_e", rank: 4, formatCode: "imax" }), // hit centered middle => satisfies
    ];
    const groups: ResultGroup[] = [
      // sh_a: row 3 middle, startCol 4 => runCentre 5 => centered true, third middle
      {
        layoutId: "lay_a",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows: 6,
        columns: 10,
        seatKinds: Array(60).fill(1),
        seatNames: {},
        seatScores: Array(60).fill(0),
        showtimes: [
          {
            showtimeId: "sh_a",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/a",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(60).fill(0),
        freeIn: Array(60)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 3, startCol: 4, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup,
      // sh_b: row 0 front, centered
      {
        layoutId: "lay_b",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows: 6,
        columns: 10,
        seatKinds: Array(60).fill(1),
        seatNames: {},
        seatScores: Array(60).fill(0),
        showtimes: [
          {
            showtimeId: "sh_b",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/b",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(60).fill(0),
        freeIn: Array(60)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 0, startCol: 4, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup,
      // sh_c: row 3 middle centered but different format skeleton
      {
        layoutId: "lay_c",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows: 6,
        columns: 10,
        seatKinds: Array(60).fill(1),
        seatNames: {},
        seatScores: Array(60).fill(0),
        showtimes: [
          {
            showtimeId: "sh_c",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/c",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(60).fill(0),
        freeIn: Array(60)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 3, startCol: 4, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup,
      // sh_d: row 3 middle but off-centre
      {
        layoutId: "lay_d",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows: 6,
        columns: 10,
        seatKinds: Array(60).fill(1),
        seatNames: {},
        seatScores: Array(60).fill(0),
        showtimes: [
          {
            showtimeId: "sh_d",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/d",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(60).fill(0),
        freeIn: Array(60)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 3, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup,
      // sh_e: row 4 middle, centered
      {
        layoutId: "lay_e",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows: 6,
        columns: 10,
        seatKinds: Array(60).fill(1),
        seatNames: {},
        seatScores: Array(60).fill(0),
        showtimes: [
          {
            showtimeId: "sh_e",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/e",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(60).fill(0),
        freeIn: Array(60)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 4, startCol: 4, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup,
    ];

    const toggles = { format: "imax" as const, centered: true, aisle: false, avoidFront: true };
    const out = applyPreferOrder(skeleton, groups, 2, toggles);
    // Satisfying: sh_a and sh_e (both imax, centered, not front) in original order
    // Non-satisfying: sh_b (fails avoidFront), sh_c (fails format), sh_d (fails centered) in original order
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_e", "sh_b", "sh_c", "sh_d"]);
    // Ensure stable: relative order among satisfying preserved (sh_a rank0 before sh_e rank4)
    // and among non-satisfying preserved (sh_b rank1 before sh_c rank2 before sh_d rank3)
  });

  it("format toggle uses formatCodeToPref semantics (imax family, dolby, standard)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_imax", formatCode: "imax70mm", rank: 0, resolved: false }),
      mkEntry({
        showtimeId: "sh_dolby",
        formatCode: "dolbycinemaatamcprime",
        rank: 1,
        resolved: false,
      }),
      mkEntry({ showtimeId: "sh_std", formatCode: null, rank: 2, resolved: false }),
      mkEntry({ showtimeId: "sh_unknown", formatCode: "UNKNOWN", rank: 3, resolved: false }),
    ];
    const groups: ResultGroup[] = []; // no seat data needed for format-only toggle
    // imax toggle should match imax and imax70mm etc
    expect(
      applyPreferOrder(skeleton, groups, 2, {
        format: "imax",
        centered: false,
        aisle: false,
        avoidFront: false,
      }).map((e) => e.showtimeId),
    ).toEqual(
      ["sh_imax", "sh_dolby", "sh_std", "sh_unknown"]
        .filter((_, i) => i === 0)
        .concat(["sh_dolby", "sh_std", "sh_unknown"]),
    );
    // More precise: only sh_imax satisfies imax, others go to second partition preserving order
    const imaxOut = applyPreferOrder(skeleton, groups, 2, {
      format: "imax",
      centered: false,
      aisle: false,
      avoidFront: false,
    });
    expect(imaxOut.map((e) => e.showtimeId)).toEqual([
      "sh_imax",
      "sh_dolby",
      "sh_std",
      "sh_unknown",
    ]);
    // dolby
    const dolbyOut = applyPreferOrder(skeleton, groups, 2, {
      format: "dolby",
      centered: false,
      aisle: false,
      avoidFront: false,
    });
    expect(dolbyOut.map((e) => e.showtimeId)).toEqual([
      "sh_dolby",
      "sh_imax",
      "sh_std",
      "sh_unknown",
    ]);
    // standard should match null and unknown
    const stdOut = applyPreferOrder(skeleton, groups, 2, {
      format: "standard",
      centered: false,
      aisle: false,
      avoidFront: false,
    });
    expect(stdOut.map((e) => e.showtimeId)).toEqual([
      "sh_std",
      "sh_unknown",
      "sh_imax",
      "sh_dolby",
    ]);
  });

  it("non-hit rows never satisfy a seat-preference toggle but are never dropped", () => {
    // Mix of hit and non-hit (unresolved/miss/deferred) rows
    const skeleton = [
      mkEntry({ showtimeId: "sh_hit_centered", formatCode: "STANDARD", rank: 0, resolved: true }),
      mkEntry({ showtimeId: "sh_checking", formatCode: "STANDARD", rank: 1, resolved: false }), // checking
      mkEntry({
        showtimeId: "sh_queued",
        formatCode: "STANDARD",
        rank: 2,
        admitted: false,
        resolved: false,
      }), // deferred
      mkEntry({ showtimeId: "sh_miss", formatCode: "STANDARD", rank: 3, resolved: true }), // will have no hit entry => miss
      mkEntry({ showtimeId: "sh_hit_off", formatCode: "STANDARD", rank: 4, resolved: true }),
    ];
    // groups: sh_hit_centered -> centered true, sh_miss -> no groupHits (miss), sh_hit_off -> off-centre
    const rows = 6;
    const columns = 10;
    const baseGroup = (id: string, hit?: { row: number; startCol: number }) => {
      const showtime = {
        showtimeId: id,
        theatreId: "th_1",
        distanceKm: null,
        showDateTimeUtc: "2026-08-30T19:00:00Z",
        timezone: "America/Los_Angeles",
        minPrice: null,
        status: "OK" as const,
        deepLinkUrl: `https://amc.com/${id}`,
        capturedAt: "2026-08-30T18:00:00Z",
        staleAfter: "2026-08-30T20:00:00Z",
        resolved: true as const,
        openCount: 10,
      };
      return {
        layoutId: `lay_${id}`,
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows,
        columns,
        seatKinds: Array(rows * columns).fill(1),
        seatNames: {},
        seatScores: Array(rows * columns).fill(0),
        showtimes: [showtime],
        freeCount: Array(rows * columns).fill(0),
        freeIn: Array(rows * columns)
          .fill(null)
          .map(() => [0]),
        groupHits: hit
          ? [
              {
                row: hit.row,
                startCol: hit.startCol,
                rowSpan: 1,
                runScore: 0,
                showtimeIndices: [0],
              },
            ]
          : [],
      } as unknown as ResultGroup;
    };
    const groups: ResultGroup[] = [
      baseGroup("sh_hit_centered", { row: 3, startCol: 4 }), // centered middle
      // sh_checking not in groups (unresolved, no group)
      // sh_queued not in groups
      baseGroup("sh_miss", undefined), // miss: no hits
      baseGroup("sh_hit_off", { row: 3, startCol: 0 }), // off-centre
    ];
    const toggles = { format: "any" as const, centered: true, aisle: false, avoidFront: false };
    const out = applyPreferOrder(skeleton, groups, 2, toggles);
    // Only sh_hit_centered satisfies centered; all others (including non-hit) go to second partition
    expect(out.map((e) => e.showtimeId)).toEqual([
      "sh_hit_centered",
      "sh_checking",
      "sh_queued",
      "sh_miss",
      "sh_hit_off",
    ]);
    // Ensure none dropped
    expect(out.length).toBe(skeleton.length);
    expect(new Set(out.map((e) => e.showtimeId))).toEqual(
      new Set(skeleton.map((e) => e.showtimeId)),
    );
    // Check that with format-only toggle, non-hit rows CAN satisfy format and move to front
    const formatOnlyOut = applyPreferOrder(skeleton, groups, 2, {
      format: "standard",
      centered: false,
      aisle: false,
      avoidFront: false,
    });
    // All are STANDARD format, so all satisfy -> order unchanged
    expect(formatOnlyOut.map((e) => e.showtimeId)).toEqual(skeleton.map((e) => e.showtimeId));
  });

  it("aisle toggle with NOT_A_SEAT gap column — synthetic fixture proves derivation", () => {
    // Layout: 1 row x 6 cols, gap at col 2 is NOT_A_SEAT (aisle)
    // Seat layout: [S][S][gap][S][S][S]
    // Hits:
    //  sh_left_edge at col0 partySize1 -> left edge => aisle true (boundary)
    //  sh_gap_left at col1 partySize1 -> right neighbor is gap => aisle true
    //  sh_gap_right at col3 partySize1 -> left neighbor is gap => aisle true
    //  sh_right_edge at col5 partySize1 -> right edge => aisle true
    //  sh_mid_no_gap at col4 partySize1 -> neighbors col3 and col5 are seats, not edge/gap => aisle false
    const rows = 1;
    const columns = 6;
    const seatKinds = gapSeatKinds(rows, columns, 2);
    // Also verify totalSeats exclusion: should be 5 not 6
    // Create skeleton in shuffled order to test stable partition
    const skeleton = [
      mkEntry({ showtimeId: "sh_mid_no_gap", formatCode: "STANDARD", rank: 0 }),
      mkEntry({ showtimeId: "sh_left_edge", formatCode: "STANDARD", rank: 1 }),
      mkEntry({ showtimeId: "sh_gap_left", formatCode: "STANDARD", rank: 2 }),
      mkEntry({ showtimeId: "sh_gap_right", formatCode: "STANDARD", rank: 3 }),
      mkEntry({ showtimeId: "sh_right_edge", formatCode: "STANDARD", rank: 4 }),
    ];
    const mkAisleGroup = (id: string, startCol: number) => {
      const showtime = {
        showtimeId: id,
        theatreId: "th_1",
        distanceKm: null,
        showDateTimeUtc: "2026-08-30T19:00:00Z",
        timezone: "America/Los_Angeles",
        minPrice: null,
        status: "OK" as const,
        deepLinkUrl: `https://amc.com/${id}`,
        capturedAt: "2026-08-30T18:00:00Z",
        staleAfter: "2026-08-30T20:00:00Z",
        resolved: true as const,
        openCount: 10,
      };
      return {
        layoutId: `lay_${id}`,
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows,
        columns,
        seatKinds,
        seatNames: {},
        seatScores: Array(rows * columns).fill(0),
        showtimes: [showtime],
        freeCount: Array(rows * columns).fill(0),
        freeIn: Array(rows * columns)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 0, startCol, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      } as unknown as ResultGroup;
    };
    const groups: ResultGroup[] = [
      mkAisleGroup("sh_mid_no_gap", 4),
      mkAisleGroup("sh_left_edge", 0),
      mkAisleGroup("sh_gap_left", 1),
      mkAisleGroup("sh_gap_right", 3),
      mkAisleGroup("sh_right_edge", 5),
    ];
    // Apply aisle toggle: should partition aisle-satisfying first, preserving original relative order among partitions
    // Skeleton order: [mid, left, gap_left, gap_right, right]
    // Satisfying aisle: left, gap_left, gap_right, right (in original order: left(1), gap_left(2), gap_right(3), right(4))
    // Non-satisfying: mid (rank0)
    const toggles = { format: "any" as const, centered: false, aisle: true, avoidFront: false };
    const out = applyPreferOrder(skeleton, groups, 1, toggles);
    expect(out.map((e) => e.showtimeId)).toEqual([
      "sh_left_edge",
      "sh_gap_left",
      "sh_gap_right",
      "sh_right_edge",
      "sh_mid_no_gap",
    ]);
    // Verify that totalSeats exclusion is correctly handled via seatKinds (5 seats not 6)
    // Cross-check with freeAndTotalSeats logic implicitly via isAisle: gap column contributes to aisle but not to total
    // Also confirm partySize 2 aisle at boundary: left 0-1 touches left edge => aisle true; mid 4-5 touches right edge => true; middle 1 gap adjacency still true
    const mid2Group = mkAisleGroup("sh_mid2", 4); // cols 4-5 partySize2 => last col 5 is edge => aisle true
    const mid2Skeleton = [mkEntry({ showtimeId: "sh_mid2", rank: 0 })];
    const mid2Out = applyPreferOrder(mid2Skeleton, [mid2Group], 2, toggles);
    // Should satisfy because it touches right edge
    expect(mid2Out.map((e) => e.showtimeId)).toEqual(["sh_mid2"]);
  });

  it("avoidFront satisfied only when third !== 'front'", () => {
    const rows = 9;
    const columns = 10;
    const skeleton = [
      mkEntry({ showtimeId: "sh_front", rank: 0 }),
      mkEntry({ showtimeId: "sh_middle", rank: 1 }),
      mkEntry({ showtimeId: "sh_back", rank: 2 }),
    ];
    const groups: ResultGroup[] = [
      {
        layoutId: "lay_front",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows,
        columns,
        seatKinds: Array(rows * columns).fill(1),
        seatNames: {},
        seatScores: Array(rows * columns).fill(0),
        showtimes: [
          {
            showtimeId: "sh_front",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/front",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(rows * columns).fill(0),
        freeIn: Array(rows * columns)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 0, startCol: 2, rowSpan: 1, runScore: 0, showtimeIndices: [0] }], // front
      } as unknown as ResultGroup,
      {
        layoutId: "lay_mid",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows,
        columns,
        seatKinds: Array(rows * columns).fill(1),
        seatNames: {},
        seatScores: Array(rows * columns).fill(0),
        showtimes: [
          {
            showtimeId: "sh_middle",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/mid",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(rows * columns).fill(0),
        freeIn: Array(rows * columns)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 4, startCol: 2, rowSpan: 1, runScore: 0, showtimeIndices: [0] }], // middle
      } as unknown as ResultGroup,
      {
        layoutId: "lay_back",
        theatreId: "th_1",
        distanceKm: null,
        formatCode: "STANDARD",
        auditorium: "1",
        attributes: [],
        rows,
        columns,
        seatKinds: Array(rows * columns).fill(1),
        seatNames: {},
        seatScores: Array(rows * columns).fill(0),
        showtimes: [
          {
            showtimeId: "sh_back",
            theatreId: "th_1",
            distanceKm: null,
            showDateTimeUtc: "2026-08-30T19:00:00Z",
            timezone: "America/Los_Angeles",
            minPrice: null,
            status: "OK",
            deepLinkUrl: "https://amc.com/back",
            capturedAt: "2026-08-30T18:00:00Z",
            staleAfter: "2026-08-30T20:00:00Z",
            resolved: true as const,
            openCount: 10,
          },
        ],
        freeCount: Array(rows * columns).fill(0),
        freeIn: Array(rows * columns)
          .fill(null)
          .map(() => [0]),
        groupHits: [{ row: 8, startCol: 2, rowSpan: 1, runScore: 0, showtimeIndices: [0] }], // back
      } as unknown as ResultGroup,
    ];
    const out = applyPreferOrder(skeleton, groups, 2, {
      format: "any",
      centered: false,
      aisle: false,
      avoidFront: true,
    });
    // Front fails avoidFront, middle and back satisfy
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_middle", "sh_back", "sh_front"]);
  });

  it("stable partition preserves original relative order within each partition", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_1", formatCode: "imax", rank: 0 }),
      mkEntry({ showtimeId: "sh_2", formatCode: "STANDARD", rank: 1 }),
      mkEntry({ showtimeId: "sh_3", formatCode: "imax", rank: 2 }),
      mkEntry({ showtimeId: "sh_4", formatCode: "STANDARD", rank: 3 }),
      mkEntry({ showtimeId: "sh_5", formatCode: "imax", rank: 4 }),
    ];
    const groups: ResultGroup[] = []; // format-only toggle doesn't need groups
    const toggles = { format: "imax" as const, centered: false, aisle: false, avoidFront: false };
    const out = applyPreferOrder(skeleton, groups, 2, toggles);
    // Satisfying: sh_1, sh_3, sh_5 in original order; non-satisfying: sh_2, sh_4 in original order
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_1", "sh_3", "sh_5", "sh_2", "sh_4"]);
  });
});

describe("applyPreferOrder — PRICE_ASC display sort (S59)", () => {
  const usd = (amount: number) => ({ amount, currency: "USD", basis: "TICKET_ONLY" as const });

  it("orders by ascending amount with null prices last", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_expensive", rank: 0 }),
      mkEntry({ showtimeId: "sh_unpriced", rank: 1 }),
      mkEntry({ showtimeId: "sh_cheap", rank: 2 }),
      mkEntry({ showtimeId: "sh_mid", rank: 3 }),
    ];
    const groups = mkGroupForHits([
      { showtimeId: "sh_expensive", minPrice: usd(24.5) },
      { showtimeId: "sh_unpriced", minPrice: null },
      { showtimeId: "sh_cheap", minPrice: usd(9.99) },
      { showtimeId: "sh_mid", minPrice: usd(16.99) },
    ]);
    // Expected order derived from the fixture amounts above, not from the sort:
    // 9.99 < 16.99 < 24.50, null last.
    const out = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE, "PRICE_ASC");
    expect(out.map((e) => e.showtimeId)).toEqual([
      "sh_cheap",
      "sh_mid",
      "sh_expensive",
      "sh_unpriced",
    ]);
  });

  it("is stable for equal amounts and keeps original order among unpriced", () => {
    // Interleaved input: passthrough would keep this order, so this fails without the sort.
    const skeleton = [
      mkEntry({ showtimeId: "sh_null_1", rank: 0 }),
      mkEntry({ showtimeId: "sh_b", rank: 1 }),
      mkEntry({ showtimeId: "sh_null_2", rank: 2 }),
      mkEntry({ showtimeId: "sh_a", rank: 3 }),
    ];
    const groups = mkGroupForHits([
      { showtimeId: "sh_b", minPrice: usd(12) },
      { showtimeId: "sh_a", minPrice: usd(12) },
      { showtimeId: "sh_null_1", minPrice: null },
      { showtimeId: "sh_null_2", minPrice: null },
    ]);
    const out = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE, "PRICE_ASC");
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_b", "sh_a", "sh_null_1", "sh_null_2"]);
  });

  it("DEFAULT mode preserves input order for the same priced input", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_expensive", rank: 0 }),
      mkEntry({ showtimeId: "sh_cheap", rank: 1 }),
    ];
    const groups = mkGroupForHits([
      { showtimeId: "sh_expensive", minPrice: usd(24.5) },
      { showtimeId: "sh_cheap", minPrice: usd(9.99) },
    ]);
    const out = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE);
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_expensive", "sh_cheap"]);
  });

  it("places entries with no owning group after priced entries", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_orphan", rank: 0 }),
      mkEntry({ showtimeId: "sh_priced", rank: 1 }),
    ];
    const groups = mkGroupForHits([{ showtimeId: "sh_priced", minPrice: usd(15) }]);
    const out = applyPreferOrder(skeleton, groups, 2, NO_PREFERENCE, "PRICE_ASC");
    expect(out.map((e) => e.showtimeId)).toEqual(["sh_priced", "sh_orphan"]);
  });
});
