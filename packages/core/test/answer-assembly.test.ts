import { describe, expect, it } from "vitest";

import {
  SearchSpecSchema,
  assembleAnswerEvidence,
  assembleResultGroup,
  buildAuditoriumLayout,
  compileRegion,
  computeSeatMetrics,
  createBitmap,
  createResultContractSchemas,
  setBit,
  sha256,
  type AssembleResultGroupInput,
  type AuditoriumLayoutGeometry,
  type GroupShowtimeInput,
  type RegionCompileResult,
  type ResolvedGroupShowtimeInput,
  type SearchSpecInput,
  type SearchSpec,
  type SeatMetrics,
  type SparseLayoutCell,
} from "../src/index.js";

/**
 * E7 verification — the pure answer assembler. Every expectation below is hand-derived
 * from the fixture's grid/availability/scores or pinned to an accepted document (ADR 0023
 * for reason formulas and the placementKey hash, ADR 0015 for the sweet-spot depth), never
 * by re-running the implementation's own logic (CONTRIBUTING.md §3). Groups are composed
 * through E5's `assembleResultGroup` where the spec calls for it; tie-break and reason
 * fixtures hand-build `metrics` for exact control over `depth`/`lateral`.
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

function spec(overrides: Partial<SearchSpecInput> = {}): SearchSpec {
  return SearchSpecSchema.parse({
    specVersion: 1,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: THEATRE_ID }] },
    where: { kind: "MOVIE", ids: ["amc:movie:1"] },
    aggregation: { reduce: "COUNT" },
    ...overrides,
  });
}

function makeE5Input(
  layout: AuditoriumLayoutGeometry,
  metrics: SeatMetrics,
  showtimes: readonly GroupShowtimeInput[],
  overrides: {
    seatScores?: Float64Array;
    poolMask?: Uint8Array;
    group?: AssembleResultGroupInput["group"];
    previewRegion?: RegionCompileResult | null;
    layoutId?: string;
  } = {},
): AssembleResultGroupInput {
  return {
    layout,
    metrics,
    seatScores: overrides.seatScores ?? new Float64Array(layout.rows * layout.columns),
    poolMask: overrides.poolMask ?? layout.ordinaryMask,
    previewRegion: overrides.previewRegion ?? null,
    placementRegion: null,
    group: overrides.group,
    groupStrict: false,
    rank: "SCORE",
    showtimes,
    layoutId: overrides.layoutId ?? "lay_test",
    theatreId: THEATRE_ID,
    formatCode: "DIGITAL",
    auditorium: "7",
    attributes: [],
    resultGroupSchema: contracts.ResultGroupSchema,
  };
}

function assembleGroup(
  layout: AuditoriumLayoutGeometry,
  showtimes: readonly GroupShowtimeInput[],
  overrides: Parameters<typeof makeE5Input>[3] = {},
) {
  const metrics = computeSeatMetrics(layout);
  const assembled = assembleResultGroup(makeE5Input(layout, metrics, showtimes, overrides));
  expect(assembled.ok).toBe(true);
  if (!assembled.ok) {
    throw new Error("expected E5 success");
  }
  return { group: assembled.result, layout, metrics };
}

/** `metrics` with per-row `depth` overridden; other fields copied from the real layout. */
function depthMetrics(layout: AuditoriumLayoutGeometry, rowDepth: readonly number[]): SeatMetrics {
  const real = computeSeatMetrics(layout);
  const depth = new Float64Array(real.depth);
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      depth[row * layout.columns + column] = rowDepth[row] ?? 0;
    }
  }
  return {
    seatIndexInRow: real.seatIndexInRow,
    depth,
    lateral: real.lateral,
    aisleDistance: real.aisleDistance,
  };
}

describe("assembleAnswerEvidence — RUN unit proof (item 1)", () => {
  it("assembles the hand-derived exact evidence and parses as CONFIDENT", () => {
    // 2 rows × 6 columns, no aisle. Row 0 depth 0, row 1 depth 1. The top run is (0,2):
    // depth 0 (front third → no AVOIDS_FRONT/MIDDLE_THIRD), lateral −0.2/+0.2 (mean |lateral|
    // 0.2 > 0.15 → no CENTERED), aisleDistance 2/2 (no AISLE_ADJACENT).
    const built = buildAuditoriumLayout({
      rows: 2,
      columns: 6,
      cells: [...rowCells(1, [1, 2, 3, 4, 5, 6], true), ...rowCells(2, [1, 2, 3, 4, 5, 6], true)],
    });
    const layout = built.layout;
    const seatScores = new Float64Array([0.5, 0.5, 0.75, 0.75, 0.5, 0.5, 0, 0, 0, 0, 0, 0]);
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(12, [2, 3]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(12, [2, 3]), 1),
    ];

    const { group, metrics } = assembleGroup(layout, showtimes, {
      seatScores,
      group: { kind: "RUN", count: 2 },
    });

    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 } }),
    });

    // The only run of 2 is (0,2): cells 2,3, offered by both showtimes.
    expect(evidence.hedged).toBeNull();
    expect(evidence.exact).not.toBeNull();
    const exact = evidence.exact!;
    expect(exact.placement).toEqual({
      layoutId: "lay_test",
      row: 0,
      startCol: 2,
      rowSpan: 1,
      count: 2,
      seatNames: ["R1C3", "R1C4"],
      placementKey: "b9bbe64ca9ef005e",
    });
    expect(exact.reasons).toEqual([
      { kind: "TOGETHER", count: 2 },
      { kind: "MULTI_SHOWTIME", count: 2 },
    ]);
    expect(exact.relaxed).toEqual([]);
    // Two reshaped offers, no `resolved`/`openCount` keys.
    expect(exact.showtimes).toHaveLength(2);
    expect(exact.showtimes[0]).not.toHaveProperty("resolved");
    expect(exact.showtimes[0]).not.toHaveProperty("openCount");
    expect(exact.showtimes.map((offer) => offer.showtimeId)).toEqual([
      "amc:showtime:a",
      "amc:showtime:b",
    ]);

    const confident = contracts.ConfidentAnswerSchema.safeParse({
      mode: "CONFIDENT",
      primary: exact,
      otherFormats: [],
    });
    expect(confident.success).toBe(true);
  });
});

describe("assembleAnswerEvidence — tie-break chain (item 2)", () => {
  // One row of six seats: every candidate shares depth 0.5, isolating runScore/count keys.
  function oneRowGrid() {
    return buildAuditoriumLayout({
      rows: 1,
      columns: 6,
      cells: rowCells(1, [1, 2, 3, 4, 5, 6], true),
    }).layout;
  }

  it("(a) runScore decides", () => {
    const layout = oneRowGrid();
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(6, [1, 3]), 0)],
      {
        seatScores: new Float64Array([0.5, 0.8, 0.5, 0.6, 0.5, 0.5]),
        group: { kind: "RUN", count: 1 },
      },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    // Highest runScore (0.8) wins: startCol 1.
    expect(evidence.exact?.placement.startCol).toBe(1);
  });

  it("(b) equal runScore, showtimeIndices.length decides", () => {
    const layout = oneRowGrid();
    // All scores equal → runScore tied. Cell 0 free in both, cell 2 free in one.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(6, [0, 2]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(6, [0]), 1),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    // Cell 0 offered by 2 showtimes beats cell 2 offered by 1.
    expect(evidence.exact?.placement.startCol).toBe(0);
  });

  it("(c) equal runScore and count, distance to 65% depth decides", () => {
    const built = buildAuditoriumLayout({
      rows: 3,
      columns: 2,
      cells: [
        ...rowCells(1, [1, 2], true),
        ...rowCells(2, [1, 2], true),
        ...rowCells(3, [1, 2], true),
      ],
    });
    const layout = built.layout;
    // Row depths: 0, 0.5, 1. Sweet-spot distances: 0.65, 0.15, 0.35 → row 1 (0.5) is closest.
    const metrics = depthMetrics(layout, [0, 0.5, 1]);
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(6, [0, 2, 4]), 0),
    ];
    const assembled = assembleResultGroup(
      makeE5Input(layout, computeSeatMetrics(layout), showtimes, {
        group: { kind: "RUN", count: 1 },
      }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected E5 success");
    }
    const evidence = assembleAnswerEvidence({
      groups: [{ group: assembled.result, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    expect(evidence.exact?.placement.row).toBe(1);
  });

  it("(d) equidistant from 65% → the shallower depth wins", () => {
    const built = buildAuditoriumLayout({
      rows: 2,
      columns: 2,
      cells: [...rowCells(1, [1, 2], true), ...rowCells(2, [1, 2], true)],
    });
    const layout = built.layout;
    // Row depths 0.4 (front) and 0.9 (back): both exactly 0.25 from 0.65 → shallower (0.4) wins.
    const metrics = depthMetrics(layout, [0.4, 0.9]);
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(4, [0, 2]), 0),
    ];
    const assembled = assembleResultGroup(
      makeE5Input(layout, computeSeatMetrics(layout), showtimes, {
        group: { kind: "RUN", count: 1 },
      }),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected E5 success");
    }
    const evidence = assembleAnswerEvidence({
      groups: [{ group: assembled.result, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    expect(evidence.exact?.placement.row).toBe(0);
  });

  it("(e) equal through depth, lowest startCol wins", () => {
    const layout = oneRowGrid();
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(6, [1, 2, 4, 5]), 0)],
      { group: { kind: "RUN", count: 1 } },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    // Equal runScore (0), equal count (1), equal depth (0.5) → lowest startCol (1) wins.
    expect(evidence.exact?.placement.startCol).toBe(1);
  });

  it("(f) equal through startCol, placementKey lexicographic decides across layouts", () => {
    const layout = oneRowGrid();
    // Two groups with identical geometry but different layoutId → identical hits, different keys.
    const metrics = computeSeatMetrics(layout);
    const assembledA = assembleResultGroup(
      makeE5Input(layout, metrics, [resolvedShowtime("amc:showtime:a", bitmapWith(6, [0]), 0)], {
        group: { kind: "RUN", count: 1 },
        layoutId: "layout_a",
      }),
    );
    const assembledB = assembleResultGroup(
      makeE5Input(layout, metrics, [resolvedShowtime("amc:showtime:a", bitmapWith(6, [0]), 0)], {
        group: { kind: "RUN", count: 1 },
        layoutId: "layout_b",
      }),
    );
    expect(assembledA.ok && assembledB.ok).toBe(true);
    if (!assembledA.ok || !assembledB.ok) {
      throw new Error("expected E5 success");
    }
    const evidence = assembleAnswerEvidence({
      groups: [
        { group: assembledA.result, layout, metrics },
        { group: assembledB.result, layout, metrics },
      ],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    // Equal runScore/count/depth/startCol → placementKey decides. layout_a's key sorts first.
    expect(evidence.exact?.placement.placementKey).toBe("1d62acf1468d00fa");
    expect(evidence.exact?.placement.layoutId).toBe("layout_a");
  });

  it("is deterministic: identical inputs produce byte-identical output", () => {
    const layout = oneRowGrid();
    const input = {
      layout,
      metrics: computeSeatMetrics(layout),
      showtimes: [resolvedShowtime("amc:showtime:a", bitmapWith(6, [0, 2, 4]), 0)],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    };
    const { group } = assembleGroup(layout, input.showtimes, { group: { kind: "RUN", count: 1 } });
    const first = assembleAnswerEvidence({
      groups: [{ group, layout, metrics: input.metrics }],
      spec: input.spec,
    });
    const second = assembleAnswerEvidence({
      groups: [{ group, layout, metrics: input.metrics }],
      spec: input.spec,
    });
    expect(second).toEqual(first);
  });
});

describe("assembleAnswerEvidence — CONFIDENT / A3 (item 3)", () => {
  it("every hit unrelaxed → exact is the top hit by the chain, hedged = null", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 4,
      cells: rowCells(1, [1, 2, 3, 4], true),
    });
    const layout = built.layout;
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(4, [0, 1, 2, 3]), 0)],
      { seatScores: new Float64Array([0.2, 0.9, 0.9, 0.2]), group: { kind: "RUN", count: 2 } },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 } }),
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.relaxed).toEqual([]);
    expect(evidence.exact!.placement.startCol).toBe(1); // runs (0,1) and (0,2) tie at 0.9; lowest startCol
    expect(evidence.hedged).toBeNull();
  });
});

describe("assembleAnswerEvidence — HEDGED / A4 (item 4)", () => {
  // A one-row grid where every hit is relaxed by an unmet AT_LEAST threshold.
  function relaxedFixture(cellCount: number, free: readonly number[]) {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: cellCount,
      cells: rowCells(
        1,
        Array.from({ length: cellCount }, (_, i) => i + 1),
        true,
      ),
    });
    const layout = built.layout;
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(cellCount, free), 0)],
      { group: { kind: "RUN", count: 1 } },
    );
    return { layout, metrics, group };
  }

  it("all hits relaxed → hedged is the top 2 in chain order, exact = null", () => {
    const { layout, metrics, group } = relaxedFixture(2, [0, 1]);
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "AT_LEAST", n: 2 } },
      }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(2);
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed.length).toBeGreaterThanOrEqual(1);
    }
    const hedged = contracts.HedgedAnswerSchema.safeParse({
      mode: "HEDGED",
      alternatives: evidence.hedged,
      otherFormats: [],
    });
    expect(hedged.success).toBe(true);
  });

  it("three-or-more relaxed candidates → exactly 3 alternatives, never 4", () => {
    const { layout, metrics, group } = relaxedFixture(5, [0, 1, 2, 3, 4]);
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "AT_LEAST", n: 2 } },
      }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(3);
  });

  it("a single relaxed candidate → hedged = null (fewer than 2)", () => {
    const { layout, metrics, group } = relaxedFixture(1, [0]);
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "AT_LEAST", n: 2 } },
      }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toBeNull();
  });
});

describe("assembleAnswerEvidence — empty-evidence edges (item 5)", () => {
  it("groupHits absent → { exact: null, hedged: null }", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2]),
    });
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    // No group shape → E5 emits no groupHits.
    const assembled = assembleResultGroup(
      makeE5Input(layout, metrics, [resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0)]),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected E5 success");
    }
    const evidence = assembleAnswerEvidence({
      groups: [{ group: assembled.result, layout, metrics }],
      spec: spec({}),
    });
    // ADR 0017 amendment — the additive per-hit key map is aligned (one group, no hits).
    expect(evidence).toEqual({ exact: null, hedged: null, hitPlacementKeys: [[]] });
  });

  it("grid whose seatNames is null → every hit excluded, no fabricated names, no throw", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 3,
      cells: rowCells(1, [1, 2, 3]), // no names → layout.seatNames is null
    });
    const layout = built.layout;
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(3, [0, 1, 2]), 0)],
      { group: { kind: "RUN", count: 1 } },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    // ADR 0017 amendment — 1×3 grid, count 1 → three single-cell hits, every
    // candidate excluded for missing names → aligned nulls, selection untouched.
    expect(evidence).toEqual({ exact: null, hedged: null, hitPlacementKeys: [[null, null, null]] });
  });
});

describe("assembleAnswerEvidence — OUTSIDE_REGION (item 6)", () => {
  it("regionMask 0 inside the run's cells → OUTSIDE_REGION with the region identifier", () => {
    const built = buildAuditoriumLayout({
      rows: 2,
      columns: 4,
      cells: [...rowCells(1, [1, 2, 3, 4], true), ...rowCells(2, [1, 2, 3, 4], true)],
    });
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    const preview = compileRegion(layout, metrics, { kind: "ROWS", from: 0, to: 0 });
    expect(preview.ok).toBe(true);
    // Row 1 free (flat 4-7) → 3 runs of 2, all outside the ROWS[0,0] region.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(8, [4, 5, 6, 7]), 0),
    ];
    const { group } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 2 },
      previewRegion: preview.ok ? preview : null,
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 }, region: { kind: "ROWS", from: 0, to: 0 } }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).not.toBeNull();
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toContainEqual({ kind: "OUTSIDE_REGION", region: "ROWS" });
    }
  });

  it("fully-inside sibling does not fire OUTSIDE_REGION", () => {
    const built = buildAuditoriumLayout({
      rows: 2,
      columns: 4,
      cells: [...rowCells(1, [1, 2, 3, 4], true), ...rowCells(2, [1, 2, 3, 4], true)],
    });
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    const preview = compileRegion(layout, metrics, { kind: "ROWS", from: 0, to: 0 });
    expect(preview.ok).toBe(true);
    // Row 0 free (flat 0-3) → runs inside the region → no OUTSIDE_REGION.
    const { group } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(8, [0, 1, 2, 3]), 0)],
      { group: { kind: "RUN", count: 2 }, previewRegion: preview.ok ? preview : null },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 }, region: { kind: "ROWS", from: 0, to: 0 } }),
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.relaxed).toEqual([]);
  });

  it("PRESET region label uses the preset name (ADR 0023 decision 5)", () => {
    const built = buildAuditoriumLayout({
      rows: 2,
      columns: 4,
      cells: [...rowCells(1, [1, 2, 3, 4], true), ...rowCells(2, [1, 2, 3, 4], true)],
    });
    const layout = built.layout;
    const metrics = computeSeatMetrics(layout);
    // AVOID_FRONT compiles to DEPTH[0.25, 1]: row 0 (depth 0) is outside → regionMask 0 there.
    const preview = compileRegion(layout, metrics, { kind: "PRESET", name: "AVOID_FRONT" });
    expect(preview.ok).toBe(true);
    const { group } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(8, [0, 1, 2, 3]), 0)],
      { group: { kind: "RUN", count: 2 }, previewRegion: preview.ok ? preview : null },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 2 },
        region: { kind: "PRESET", name: "AVOID_FRONT" },
      }),
    });
    expect(evidence.exact).toBeNull();
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toContainEqual({ kind: "OUTSIDE_REGION", region: "AVOID_FRONT" });
    }
  });
});

describe("assembleAnswerEvidence — FEWER_SHOWTIMES (item 7)", () => {
  it("AT_LEAST 3 unmet by a 2-showtime hit → FEWER_SHOWTIMES", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [0, 1]), 1),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "AT_LEAST", n: 3 } },
      }),
    });
    // Both hits are offered by 2 showtimes < 3 → relaxed; no unrelaxed candidate → exact null.
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(2);
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toContainEqual({ kind: "FEWER_SHOWTIMES" });
    }
  });

  it("NONE threshold → never FEWER_SHOWTIMES", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(2, [0]), 0)],
      { group: { kind: "RUN", count: 1 } },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }), // threshold defaults to NONE
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.relaxed).toEqual([]);
  });

  it("FRACTION boundary at exactly min → met, no FEWER_SHOWTIMES", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    // 4 resolved showtimes; each hit is free in 2 → 2/4 = 0.5 exactly meets min 0.5.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [0]), 1),
      resolvedShowtime("amc:showtime:c", bitmapWith(2, [1]), 2),
      resolvedShowtime("amc:showtime:d", bitmapWith(2, [1]), 3),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "FRACTION", min: 0.5 } },
      }),
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.relaxed).toEqual([]);
  });

  it("FRACTION denominator is resolved showtimes only (unresolved excluded)", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    // 2 resolved + 1 unresolved. Each hit is free in exactly 1 resolved showtime → 1/2 = 0.5
    // meets min 0.5. If the unresolved showtime were counted, the denominator would be 3 and
    // 1/3 < 0.5 would wrongly relax the hit. The hits still relax via UNRESOLVED_SHOWTIMES
    // (ADR 0033) — but never via FEWER_SHOWTIMES, proving the denominator excludes unresolved.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [1]), 1),
      unresolvedShowtime("amc:showtime:u", 2),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({
        group: { kind: "RUN", count: 1 },
        aggregation: { reduce: "COUNT", threshold: { kind: "FRACTION", min: 0.5 } },
      }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(2);
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toContainEqual({ kind: "UNRESOLVED_SHOWTIMES", count: 1 });
      expect(alternative.relaxed).not.toContainEqual({ kind: "FEWER_SHOWTIMES" });
    }
  });
});

describe("assembleAnswerEvidence — UNRESOLVED_SHOWTIMES (item 11)", () => {
  it("relaxes an otherwise-perfect hit by its unresolved showtime count (ADR 0033)", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    // One resolved showtime every hit is free in, plus two never-resolved ones. Threshold
    // NONE is met and the region matches, so without the new relaxation these hits would
    // carry relaxed: [] and be treated as exact despite the incomplete coverage.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0),
      unresolvedShowtime("amc:showtime:u", 1),
      unresolvedShowtime("amc:showtime:v", 2),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(2);
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toEqual([{ kind: "UNRESOLVED_SHOWTIMES", count: 2 }]);
    }
  });

  it("mixed resolved/unresolved group reaches HEDGED via UNRESOLVED_SHOWTIMES, not FEWER_SHOWTIMES", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    // Two resolved showtimes cover both hits; the third is never resolved. Threshold NONE
    // holds (no FEWER_SHOWTIMES), yet each candidate carries the unresolved-count relaxation.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [0, 1]), 1),
      unresolvedShowtime("amc:showtime:u", 2),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    expect(evidence.exact).toBeNull();
    expect(evidence.hedged).toHaveLength(2);
    for (const alternative of evidence.hedged!) {
      expect(alternative.relaxed).toContainEqual({ kind: "UNRESOLVED_SHOWTIMES", count: 1 });
      expect(alternative.relaxed).not.toContainEqual({ kind: "FEWER_SHOWTIMES" });
    }
  });

  it("all-resolved group is unaffected: exact populates with no UNRESOLVED_SHOWTIMES", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [1]), 1),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }), // threshold defaults to NONE
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.relaxed).toEqual([]);
  });
});

describe("assembleAnswerEvidence — offer reshape (item 8)", () => {
  it("reshapes resolved showtimes, preserves freshness fields, drops resolved/openCount", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    // One resolved showtime (hit free in it), one resolved showtime the hit is NOT free in.
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0]), 0),
      resolvedShowtime("amc:showtime:b", bitmapWith(2, [1]), 1),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 1 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 1 } }),
    });
    const offer = evidence.exact!.showtimes[0]!;
    expect(offer).toEqual({
      showtimeId: "amc:showtime:a",
      theatreId: THEATRE_ID,
      distanceKm: null,
      showDateTimeUtc: "2026-08-20T19:00:00.000Z",
      timezone: "America/New_York",
      minPrice: null,
      status: "OPEN",
      // P9.4 — the offer resolves the candidate placement's seat-level deep link
      // (cell 0 is named R1C1 in this fixture), not the general schedule URL.
      deepLinkUrl: "https://www.amctheatres.com/showtimes/amc:showtime:a?seats=R1C1",
      capturedAt: "2026-08-19T12:00:00.000Z",
      staleAfter: "2026-08-19T12:15:00.000Z",
      nonce: null,
    });
    // The showtime the hit is not free in never appears.
    expect(evidence.exact!.showtimes.map((o) => o.showtimeId)).toEqual(["amc:showtime:a"]);
  });

  it("P9.4: a multi-seat placement resolves a comma-joined ?seats= deep link per offer", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    const showtimes: GroupShowtimeInput[] = [
      resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0),
    ];
    const { group, metrics } = assembleGroup(layout, showtimes, {
      group: { kind: "RUN", count: 2 },
    });
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 } }),
    });
    expect(evidence.exact).not.toBeNull();
    expect(evidence.exact!.placement.seatNames).toEqual(["R1C1", "R1C2"]);
    expect(evidence.exact!.showtimes).toHaveLength(1);
    expect(evidence.exact!.showtimes[0]!.deepLinkUrl).toBe(
      "https://www.amctheatres.com/showtimes/amc:showtime:a?seats=R1C1%2CR1C2",
    );
  });
});
describe("assembleAnswerEvidence — placementKey golden (item 9)", () => {
  it("pins the SHA-256 first-16-hex placementKey for fixed tuples", () => {
    // layoutId|row|startCol|rowSpan|count → 16-hex prefix. Expected values computed with
    // node:crypto, byte-identical to the package's pure sha256 (ADR 0023 decision 1).
    expect(sha256("lay_test|0|2|1|2").slice(0, 16)).toBe("b9bbe64ca9ef005e");
    expect(sha256("layout_a|0|0|1|2").slice(0, 16)).toBe("c8e45dbd7b5c35f5");
    expect(sha256("layout_a|1|3|1|4").slice(0, 16)).toBe("e5d4c2ab378c5bb1");
    expect(sha256("layout_a|0|0|2|6").slice(0, 16)).toBe("ad2cfb56fdadd3e5");
  });

  it("the assembled placementKey matches the pinned hash, not a re-derivation", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: rowCells(1, [1, 2], true),
    });
    const layout = built.layout;
    const { group, metrics } = assembleGroup(
      layout,
      [resolvedShowtime("amc:showtime:a", bitmapWith(2, [0, 1]), 0)],
      { group: { kind: "RUN", count: 2 }, layoutId: "layout_a" },
    );
    const evidence = assembleAnswerEvidence({
      groups: [{ group, layout, metrics }],
      spec: spec({ group: { kind: "RUN", count: 2 } }),
    });
    expect(evidence.exact?.placement.placementKey).toBe("c8e45dbd7b5c35f5");
  });
});

describe("assembleAnswerEvidence — accessibility negative control (item 10)", () => {
  it("runs the identical code over the accessible pool; no ACCESSIBLE_REQUESTED reason", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 6,
      cells: [
        seat(1, 1, "WHEELCHAIR", "A1"),
        seat(1, 2, "WHEELCHAIR", "A2"),
        seat(1, 3, "COMPANION", "A3"),
        seat(1, 4, "COMPANION", "A4"),
        seat(1, 5, "STANDARD", "A5"),
        seat(1, 6, "STANDARD", "A6"),
      ],
    });
    const layout = built.layout;
    // The ADR 0011 pool mask (accessibleMask) selects only wheelchair/companion seats.
    const assembled = assembleResultGroup(
      makeE5Input(
        layout,
        computeSeatMetrics(layout),
        [resolvedShowtime("amc:showtime:a", bitmapWith(6, [0, 1, 2, 3, 4, 5]), 0)],
        { group: { kind: "RUN", count: 2 }, poolMask: layout.accessibleMask },
      ),
    );
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) {
      throw new Error("expected E5 success");
    }
    const evidence = assembleAnswerEvidence({
      groups: [{ group: assembled.result, layout, metrics: computeSeatMetrics(layout) }],
      spec: spec({ group: { kind: "RUN", count: 2 } }),
    });
    // The same pipeline ran; no accessibility branch and no ACCESSIBLE_REQUESTED emission.
    expect(evidence.exact).not.toBeNull();
    for (const reason of evidence.exact!.reasons) {
      expect(reason.kind).not.toBe("ACCESSIBLE_REQUESTED");
    }
  });
});
