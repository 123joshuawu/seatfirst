import { describe, expect, it } from "vitest";

import {
  assembleResultGroup,
  buildAuditoriumLayout,
  compileRegion,
  computeSeatMetrics,
  createBitmap,
  createResultContractSchemas,
  presetRegion,
  setBit,
  type AssembleResultGroupInput,
  type GroupShowtimeInput,
  type ResolvedGroupShowtimeInput,
  type SparseLayoutCell,
} from "../src/index.js";

/**
 * E5 verification, the pure-module half: hand-built grids with hand-derived expectations —
 * the authorized engine-prototyping path (`docs/backend-work-plan.md:1209-1213`), never live
 * AMC traffic. Every expected run/block score below is derived by hand from the fixture's
 * per-cell scores, never by re-running the implementation's own logic
 * (CONTRIBUTING.md §3: "Derive the expected value independently").
 */

const contracts = createResultContractSchemas({
  providerHostAllowlists: { amc: ["www.amctheatres.com"] },
});

const THEATRE_ID = "amc:theatre:7";

function seat(
  row: number,
  column: number,
  kind: "STANDARD" | "WHEELCHAIR" | "COMPANION" = "STANDARD",
  name?: string,
): SparseLayoutCell {
  return {
    row,
    column,
    kind,
    available: true,
    visible: true,
    ...(name === undefined ? {} : { name }),
  };
}

/** Standard seats at every listed column (1-based) of a row; unlisted columns are gaps. */
function rowCells(row: number, columns: readonly number[], names?: boolean): SparseLayoutCell[] {
  return columns.map((column, index) =>
    seat(row, column, "STANDARD", names ? `R${row}C${index + 1}` : undefined),
  );
}

function makeInput(
  layout: ReturnType<typeof buildAuditoriumLayout>["layout"],
  showtimes: readonly GroupShowtimeInput[],
  overrides: {
    seatScores?: Float64Array;
    poolMask?: Uint8Array;
    previewRegion?: AssembleResultGroupInput["previewRegion"];
    placementRegion?: AssembleResultGroupInput["placementRegion"];
    group?: AssembleResultGroupInput["group"];
    groupStrict?: boolean;
    rank?: AssembleResultGroupInput["rank"];
    attributes?: readonly string[];
    auditorium?: AssembleResultGroupInput["auditorium"];
  } = {},
): AssembleResultGroupInput {
  return {
    layout,
    metrics: computeSeatMetrics(layout),
    seatScores: overrides.seatScores ?? new Float64Array(layout.rows * layout.columns),
    poolMask: overrides.poolMask ?? layout.ordinaryMask,
    previewRegion: overrides.previewRegion ?? null,
    placementRegion: overrides.placementRegion ?? null,
    group: overrides.group,
    groupStrict: overrides.groupStrict ?? false,
    rank: overrides.rank ?? "SCORE",
    showtimes,
    layoutId: "lay_test",
    theatreId: THEATRE_ID,
    formatCode: "DIGITAL",
    auditorium: overrides.auditorium ?? "7",
    attributes: overrides.attributes ?? [],
    resultGroupSchema: contracts.ResultGroupSchema,
  };
}

function resolvedShowtime(
  showtimeId: string,
  availability: Uint8Array,
  index: number,
): ResolvedGroupShowtimeInput {
  const hour = 19 + index;
  return {
    resolved: true,
    showtimeId,
    theatreId: THEATRE_ID,
    distanceKm: null,
    showDateTimeUtc: `2026-08-20T${String(hour).padStart(2, "0")}:00:00.000Z`,
    timezone: "America/New_York",
    minPrice: null,
    status: "OPEN",
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}`,
    capturedAt: "2026-08-19T12:00:00.000Z",
    staleAfter: "2026-08-19T12:15:00.000Z",
    availability,
  };
}

function unresolvedShowtime(showtimeId: string, index: number): GroupShowtimeInput {
  const hour = 19 + index;
  return {
    resolved: false,
    showtimeId,
    theatreId: THEATRE_ID,
    distanceKm: null,
    showDateTimeUtc: `2026-08-20T${String(hour).padStart(2, "0")}:00:00.000Z`,
    timezone: "America/New_York",
    minPrice: null,
    status: "UNKNOWN",
    deepLinkUrl: `https://www.amctheatres.com/showtimes/${showtimeId}`,
  };
}

function bitmapWith(bitLength: number, set: readonly number[]): Uint8Array {
  const bitmap = createBitmap(bitLength);
  for (const index of set) {
    setBit(bitmap, index, bitLength);
  }
  return bitmap;
}

/** 2 rows × 8 columns, column 4 (flat index 3) an aisle — the RUN fixture grid. */
function runFixtureLayout() {
  return buildAuditoriumLayout({
    rows: 2,
    columns: 8,
    cells: [
      ...rowCells(1, [1, 2, 3, 5, 6, 7, 8], true),
      ...rowCells(2, [1, 2, 3, 5, 6, 7, 8], true),
    ],
  });
}

describe("assembleResultGroup — RUN (E5 verification items 4, 6, 10)", () => {
  it("assembles the exact hand-derived group: hits, means, showtimeIndices, freeCount/freeIn (items 4, 6)", () => {
    const built = runFixtureLayout();
    const layout = built.layout;
    // Snapshot A: row 0 free at cols 0-2 (run start 0) and 4-6 (run start 4); row 1 cols 0-1.
    // Snapshot B: row 0 cols 1-2; row 1 cols 0-2 (run start 0).
    const availabilityA = bitmapWith(16, [0, 1, 2, 4, 5, 6, 8, 9]);
    const availabilityB = bitmapWith(16, [1, 2, 8, 9, 10]);
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", availabilityA, 0),
      unresolvedShowtime("amc:showtime:u", 1),
      resolvedShowtime("amc:showtime:b", availabilityB, 2),
    ];
    // Per-cell scores (all dyadic so the means are exact): runs (0,0), (0,4), (1,0) carry
    // 0.25, 0.5, 0.75 respectively — means 0.25, 0.5, 0.75.
    const seatScores = new Float64Array([
      0.25, 0.25, 0.25, 0, 0.5, 0.5, 0.5, 0, 0.75, 0.75, 0.75, 0, 0, 0, 0, 0,
    ]);

    const assembled = assembleResultGroup(
      makeInput(layout, showtimes, { seatScores, group: { kind: "RUN", count: 3 } }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected success");
    }
    const group = assembled.result;

    // Rank SCORE (default): descending runScore → (1,0) 0.75, (0,4) 0.5, (0,0) 0.25.
    expect(group.groupHits).toEqual([
      { row: 1, startCol: 0, rowSpan: 1, runScore: 0.75, showtimeIndices: [2] },
      { row: 0, startCol: 4, rowSpan: 1, runScore: 0.5, showtimeIndices: [0] },
      { row: 0, startCol: 0, rowSpan: 1, runScore: 0.25, showtimeIndices: [0] },
    ]);

    // E5.4 passthrough: values verbatim, length rows × columns, every element finite.
    expect(group.seatScores).toEqual(Array.from(seatScores));
    expect(group.seatScores).toHaveLength(16);

    // E5.5: freeCount is NOT pool-filtered and counts every resolved snapshot's bit.
    // Cell 0 is A-only (B frees cols 1-2), cells 1-2 are both, 8-9 both, 10 B-only.
    expect(group.freeCount).toEqual([1, 2, 2, 0, 1, 1, 1, 0, 2, 2, 1, 0, 0, 0, 0, 0]);
    // freeIn indexes into the final showtimes array — B sits at index 2 because the
    // unresolved showtime keeps its slot.
    expect(group.freeIn).toEqual([
      [0],
      [0, 2],
      [0, 2],
      [],
      [0],
      [0],
      [0],
      [],
      [0, 2],
      [0, 2],
      [2],
      [],
      [],
      [],
      [],
      [],
    ]);

    // Item 6: the gap-cell contract — every per-cell array spans rows × columns.
    expect(group.seatKinds).toHaveLength(16);
    expect(group.freeIn).toHaveLength(16);
    expect(group.seatNames).toEqual({
      "0": "R1C1",
      "1": "R1C2",
      "2": "R1C3",
      "4": "R1C4",
      "5": "R1C5",
      "6": "R1C6",
      "7": "R1C7",
      "8": "R2C1",
      "9": "R2C2",
      "10": "R2C3",
      "12": "R2C4",
      "13": "R2C5",
      "14": "R2C6",
      "15": "R2C7",
    });

    // E5.10: the unresolved showtime passes through, contributes nothing.
    expect(group.showtimes).toHaveLength(3);
    expect(group.showtimes[1]).toEqual({
      showtimeId: "amc:showtime:u",
      theatreId: THEATRE_ID,
      distanceKm: null,
      showDateTimeUtc: "2026-08-20T20:00:00.000Z",
      timezone: "America/New_York",
      minPrice: null,
      status: "UNKNOWN",
      deepLinkUrl: "https://www.amctheatres.com/showtimes/amc:showtime:u",
      resolved: false,
      openCount: null,
    });
    // openCount is ordinary-seats-only (E5.10/F4): 8 and 5 ordinary bits free.
    expect(group.showtimes[0]).toMatchObject({ resolved: true, openCount: 8 });
    expect(group.showtimes[2]).toMatchObject({ resolved: true, openCount: 5 });

    // The whole group is contract-valid (item 4).
    expect(contracts.ResultGroupSchema.safeParse(group).success).toBe(true);
  });

  it("throws RangeError on contract violations instead of repairing them (E5.4)", () => {
    const layout = runFixtureLayout().layout;
    expect(() =>
      assembleResultGroup(makeInput(layout, [], { seatScores: new Float64Array(15) })),
    ).toThrowError(/rows × columns/);
    const nonFinite = new Float64Array(16);
    nonFinite[7] = Number.NaN;
    expect(() =>
      assembleResultGroup(makeInput(layout, [], { seatScores: nonFinite })),
    ).toThrowError(/must be finite/);
  });

  it("emits every run — no hidden top-N truncation (item 10)", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 10,
      cells: rowCells(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    const layout = built.layout;
    const availability = bitmapWith(10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const assembled = assembleResultGroup(
      makeInput(layout, [resolvedShowtime("amc:showtime:a", availability, 0)], {
        group: { kind: "RUN", count: 2 },
      }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected success");
    }
    // All scores equal → rank order is row-major, i.e. startCol ascending: nine starts.
    expect(assembled.result.groupHits?.map((hit) => hit.startCol)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(assembled.result.groupHits).toHaveLength(9);
  });
});

describe("assembleResultGroup — accessibility pool-filter (item 5)", () => {
  const built = buildAuditoriumLayout({
    rows: 2,
    columns: 6,
    cells: [
      ...rowCells(1, [1, 2, 3, 4, 5, 6]),
      seat(2, 1, "WHEELCHAIR"),
      seat(2, 2, "WHEELCHAIR"),
      seat(2, 3, "COMPANION"),
      seat(2, 4, "COMPANION"),
      seat(2, 5, "STANDARD"),
      seat(2, 6, "STANDARD"),
    ],
  });
  const layout = built.layout;
  // Ordinary row scores 1/0.75 → run means 0.875; accessible row scores 0.25 → means 0.25:
  // the best ordinary run out-scores every accessible run.
  const seatScores = new Float64Array([1, 0.75, 1, 0.75, 1, 0.75, 0.25, 0.25, 0.25, 0.25, 0, 0]);
  const availability = bitmapWith(12, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const showtimes = [
    resolvedShowtime("amc:showtime:a", availability, 0),
    resolvedShowtime("amc:showtime:b", availability, 1),
  ];

  it("swaps the entire pipeline's mask — the only difference is the pool", () => {
    const ordinary = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        poolMask: layout.ordinaryMask,
        group: { kind: "RUN", count: 2 },
      }),
    );
    const accessible = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        poolMask: layout.accessibleMask,
        group: { kind: "RUN", count: 2 },
      }),
    );
    expect(ordinary.ok).toBe(true);
    expect(accessible.ok).toBe(true);
    if (!ordinary.ok || !accessible.ok) {
      throw new Error("expected success");
    }
    // Ordinary pool: five row-0 runs plus the row-1 STANDARD pair at cols 4-5 — every
    // ordinary seat participates; accessible seats (row 1, cols 0-3) are absent from hits.
    expect(ordinary.result.groupHits).toEqual([
      { row: 0, startCol: 0, rowSpan: 1, runScore: 0.875, showtimeIndices: [0, 1] },
      { row: 0, startCol: 1, rowSpan: 1, runScore: 0.875, showtimeIndices: [0, 1] },
      { row: 0, startCol: 2, rowSpan: 1, runScore: 0.875, showtimeIndices: [0, 1] },
      { row: 0, startCol: 3, rowSpan: 1, runScore: 0.875, showtimeIndices: [0, 1] },
      { row: 0, startCol: 4, rowSpan: 1, runScore: 0.875, showtimeIndices: [0, 1] },
      { row: 1, startCol: 4, rowSpan: 1, runScore: 0, showtimeIndices: [0, 1] },
    ]);
    // Accessible pool: three row-1 runs (cols 0-3), all offered by both snapshots (the
    // positive control — the same runs exist in both snapshots); ordinary seats absent.
    expect(accessible.result.groupHits).toEqual(
      [0, 1, 2].map((startCol) => ({
        row: 1,
        startCol,
        rowSpan: 1,
        runScore: 0.25,
        showtimeIndices: [0, 1],
      })),
    );

    // E5.5: accessible seats stay truthfully present in freeCount either way — everything
    // except groupHits is pool-independent, exactly as ADR 0011's single pipeline demands.
    expect(accessible.result.freeCount).toEqual(ordinary.result.freeCount);
    expect(accessible.result.freeIn).toEqual(ordinary.result.freeIn);
    expect(accessible.result.seatScores).toEqual(ordinary.result.seatScores);
    expect(accessible.result.showtimes).toEqual(ordinary.result.showtimes);
    expect(ordinary.result.freeCount.slice(6, 10)).toEqual([2, 2, 2, 2]);
  });
});

describe("assembleResultGroup — BLOCK (item 7)", () => {
  // 3 rows × 5 columns with column 3 (flat 2) an aisle.
  const built = buildAuditoriumLayout({
    rows: 3,
    columns: 5,
    cells: [
      ...rowCells(1, [1, 2, 4, 5]),
      ...rowCells(2, [1, 2, 4, 5]),
      ...rowCells(3, [1, 2, 4, 5]),
    ],
  });
  const layout = built.layout;
  const availability = bitmapWith(15, [0, 1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14]);
  // Hand-set member cells (gaps score 0); each block's mean derived below.
  const seatScores = new Float64Array([
    0, 0.25, 0, 0.25, 0.5, 0.5, 0.75, 0, 0.75, 1, 0, 0.25, 0, 0.25, 0.5,
  ]);
  const showtimes = [resolvedShowtime("amc:showtime:a", availability, 0)];

  it("reports 2×2 blocks with rowSpan 2 and mean-of-four runScore; aisle straddles excluded", () => {
    const assembled = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        group: { kind: "BLOCK", rows: 2, cols: 2 },
      }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected success");
    }
    // Blocks (0,0): cells 0,1,5,6 → (0 + 0.25 + 0.5 + 0.75)/4 = 0.375
    //        (0,3): cells 3,4,8,9 → (0.25 + 0.5 + 0.75 + 1)/4 = 0.625
    //        (1,0): cells 5,6,10,11 → (0.5 + 0.75 + 0 + 0.25)/4 = 0.375
    //        (1,3): cells 8,9,13,14 → (0.75 + 1 + 0.25 + 0.5)/4 = 0.625
    // No block starts at column 1 or 2: column 2 is the aisle gap (excluded by the pool),
    // and column 1 would straddle it. Ranked by score, then row-major.
    expect(assembled.result.groupHits).toEqual([
      { row: 0, startCol: 3, rowSpan: 2, runScore: 0.625, showtimeIndices: [0] },
      { row: 1, startCol: 3, rowSpan: 2, runScore: 0.625, showtimeIndices: [0] },
      { row: 0, startCol: 0, rowSpan: 2, runScore: 0.375, showtimeIndices: [0] },
      { row: 1, startCol: 0, rowSpan: 2, runScore: 0.375, showtimeIndices: [0] },
    ]);
    expect(contracts.ResultGroupSchema.safeParse(assembled.result).success).toBe(true);
  });

  it("BLOCK rows: 1 degenerates to RUN-equivalent hits", () => {
    const block = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        group: { kind: "BLOCK", rows: 1, cols: 2 },
      }),
    );
    const run = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        group: { kind: "RUN", count: 2 },
      }),
    );
    expect(block.ok).toBe(true);
    expect(run.ok).toBe(true);
    if (!block.ok || !run.ok) {
      throw new Error("expected success");
    }
    expect(block.result.groupHits).toEqual(run.result.groupHits);
    expect(block.result.groupHits?.map((hit) => hit.rowSpan)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("assembleResultGroup — regions (item 8)", () => {
  it("spec.region surfaces regionMask, 0/1, rows × columns; groupRegion filters placements (item 8, F5)", () => {
    // E3's exact proof grid — one row of five seats, no aisle — so a 4-run's edges are
    // unambiguous (E3.5: narrow region excludes, one-seat-wider region includes).
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 5,
      cells: rowCells(1, [1, 2, 3, 4, 5]),
    });
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    const availability = bitmapWith(5, [0, 1, 2, 3, 4]);
    const preview = compileRegion(layout, metrics, { kind: "ROWS", from: 0, to: 0 });

    // Narrow placement region (cols 0-2), groupStrict: a 4-run at column 0 would straddle
    // the region edge → excluded.
    const narrowMask = bitmapWith(5, [0, 1, 2]);
    const strict = assembleResultGroup(
      makeInput(layout, [resolvedShowtime("amc:showtime:a", availability, 0)], {
        previewRegion: preview,
        placementRegion: { ok: true, mask: narrowMask },
        group: { kind: "RUN", count: 4 },
        groupStrict: true,
      }),
    );
    expect(strict.ok).toBe(true);
    if (!strict.ok) {
      throw new Error("expected success");
    }
    expect(strict.result.regionMask).toEqual([1, 1, 1, 1, 1]);
    expect(strict.result.regionMask?.every((value) => value === 0 || value === 1)).toBe(true);
    expect(strict.result.groupHits).toEqual([]);

    // Widening the region by one seat reports the run — E3's own proof through E5's assembly.
    const widenedMask = bitmapWith(5, [0, 1, 2, 3]);
    const widened = assembleResultGroup(
      makeInput(layout, [resolvedShowtime("amc:showtime:a", availability, 0)], {
        previewRegion: preview,
        placementRegion: { ok: true, mask: widenedMask },
        group: { kind: "RUN", count: 4 },
        groupStrict: true,
      }),
    );
    expect(widened.ok).toBe(true);
    if (!widened.ok) {
      throw new Error("expected success");
    }
    expect(widened.result.groupHits?.map((hit) => hit.startCol)).toEqual([0]);

    // Negative-with-positive control: the same narrow region with groupStrict: false does
    // report runs — both starts, because start 1's centre (col 2) sits inside the region.
    // The exclusion above is strict-specific (query design midpoint semantics).
    const nonStrict = assembleResultGroup(
      makeInput(layout, [resolvedShowtime("amc:showtime:a", availability, 0)], {
        placementRegion: { ok: true, mask: narrowMask },
        group: { kind: "RUN", count: 4 },
        groupStrict: false,
      }),
    );
    expect(nonStrict.ok).toBe(true);
    if (!nonStrict.ok) {
      throw new Error("expected success");
    }
    expect(nonStrict.result.groupHits?.map((hit) => hit.startCol)).toEqual([0, 1]);
    expect(nonStrict.result.regionMask).toBeUndefined();
  });

  it("typed unsupported, never a throw: SCORE region (SWEET_SPOT), SPLIT shape, DEPTH rank (E5.8, E5.9, F1, F6)", () => {
    const built = runFixtureLayout();
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    const sweetSpot = compileRegion(layout, metrics, presetRegion("SWEET_SPOT"));
    expect(sweetSpot.ok).toBe(false);

    const scorable = assembleResultGroup(makeInput(layout, [], { previewRegion: sweetSpot }));
    expect(scorable).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_SCORE_REGION",
        region: { kind: "SCORE", min: 0.75 },
      },
    });

    const split = assembleResultGroup(
      makeInput(layout, [], {
        group: { kind: "SPLIT", count: 4, maxGroups: 2, sameRow: true },
      }),
    );
    expect(split).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_SPLIT_GROUP",
        group: { kind: "SPLIT", count: 4, maxGroups: 2, sameRow: true },
      },
    });

    const depth = assembleResultGroup(
      makeInput(layout, [], {
        group: { kind: "RUN", count: 3 },
        rank: "DEPTH",
      }),
    );
    expect(depth).toEqual({
      ok: false,
      error: { code: "UNSUPPORTED_DEPTH_RANK", rank: "DEPTH" },
    });
  });
});

describe("assembleResultGroup — ranking (item 9)", () => {
  // 1 row × 6 columns, RUN count 2. Snapshots: X free 0-3; Y free 0,1,4,5; Z free 2-5.
  const built = buildAuditoriumLayout({
    rows: 1,
    columns: 6,
    cells: rowCells(1, [1, 2, 3, 4, 5, 6]),
  });
  const layout = built.layout;
  const seatScores = new Float64Array([0.25, 0.25, 0.75, 0.75, 0.25, 0.75]);
  const showtimes = [
    resolvedShowtime("amc:showtime:x", bitmapWith(6, [0, 1, 2, 3]), 0),
    resolvedShowtime("amc:showtime:y", bitmapWith(6, [0, 1, 4, 5]), 1),
    resolvedShowtime("amc:showtime:z", bitmapWith(6, [2, 3, 4, 5]), 2),
  ];
  // Run starts and hand-derived means:
  //   (0,0): X,Y → scores 0.25+0.25 → 0.25, offered by [0,1]
  //   (0,1): X   → scores 0.25+0.75 → 0.5,  offered by [0]
  //   (0,2): X,Z → scores 0.75+0.75 → 0.75, offered by [0,2]
  //   (0,3): Z   → scores 0.75+0.25 → 0.5,  offered by [2]
  //   (0,4): Y,Z → scores 0.25+0.75 → 0.5,  offered by [1,2]

  it("rank SCORE descends by runScore; ties break row-major deterministically", () => {
    const first = assembleResultGroup(
      makeInput(layout, showtimes, { seatScores, group: { kind: "RUN", count: 2 } }),
    );
    const second = assembleResultGroup(
      makeInput(layout, showtimes, { seatScores, group: { kind: "RUN", count: 2 } }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected success");
    }
    expect(first.result.groupHits).toEqual([
      { row: 0, startCol: 2, rowSpan: 1, runScore: 0.75, showtimeIndices: [0, 2] },
      { row: 0, startCol: 1, rowSpan: 1, runScore: 0.5, showtimeIndices: [0] },
      { row: 0, startCol: 3, rowSpan: 1, runScore: 0.5, showtimeIndices: [2] },
      { row: 0, startCol: 4, rowSpan: 1, runScore: 0.5, showtimeIndices: [1, 2] },
      { row: 0, startCol: 0, rowSpan: 1, runScore: 0.25, showtimeIndices: [0, 1] },
    ]);
    // Two identical calls produce identical output arrays.
    expect(second).toEqual(first);
  });

  it("rank AVAILABILITY descends by how many showtimes offer the placement", () => {
    const assembled = assembleResultGroup(
      makeInput(layout, showtimes, {
        seatScores,
        group: { kind: "RUN", count: 2 },
        rank: "AVAILABILITY",
      }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected success");
    }
    expect(assembled.result.groupHits).toEqual([
      { row: 0, startCol: 0, rowSpan: 1, runScore: 0.25, showtimeIndices: [0, 1] },
      { row: 0, startCol: 2, rowSpan: 1, runScore: 0.75, showtimeIndices: [0, 2] },
      { row: 0, startCol: 4, rowSpan: 1, runScore: 0.5, showtimeIndices: [1, 2] },
      { row: 0, startCol: 1, rowSpan: 1, runScore: 0.5, showtimeIndices: [0] },
      { row: 0, startCol: 3, rowSpan: 1, runScore: 0.5, showtimeIndices: [2] },
    ]);
  });
});
