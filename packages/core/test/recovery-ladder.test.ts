import { describe, expect, it, vi } from "vitest";

import {
  PlacementSchema,
  RecoveryOptionSchema,
  assembleRecoveryLadder,
  assembleRecoveryLevelFour,
  assembleRecoveryLevelOne,
  assembleRecoveryLevelThree,
  assembleRecoveryLevelTwo,
  createResultContractSchemas,
  type GroupShowtime,
  type Placement,
  type ResultGroup,
} from "../src/index.js";

/**
 * S32 verification — the pure recovery-ladder producers. Phase 1 (spec S32.1–S32.9) covers
 * `assembleRecoveryLevelOne`; Phase 3 (spec S32.12–S32.18) covers Levels 2-4
 * (`assembleRecoveryLevelTwo`/`Three`/`Four`, ADR 0026/ADR 0027) and the composed
 * `assembleRecoveryLadder` (S32.17's strict first-success degradation). Every expectation is
 * hand-derived from the fixture's grid or pinned to an accepted document (ADR 0023 for the
 * placementKey hash; `docs/seatfirst-architecture.md` §15/level-1 wording for the distance
 * objective and ±2 window; ADR 0026 for the Level 2-4 search spaces/ranking/dedup; ADR 0027
 * for the Level 4 label and multi-showtime tie-break), never by re-running the
 * implementation's own logic (CONTRIBUTING.md §3). Fixtures hand-build `ResultGroup`s with
 * hand-placed `groupHits` for exact control over the distance and tie-break keys; `rowWeight`
 * is injected as the test double for the undecided `W` (finding F1).
 *
 * The seam (`apps/server/src/routes/showtimes/recovery-seam.ts`) is exercised separately in
 * `apps/server/test/recovery-seam.test.ts`.
 */

const contracts = createResultContractSchemas({
  providerHostAllowlists: { amc: ["www.amctheatres.com"] },
});

const LAYOUT_ID = "amc:layout:1";
const THEATRE_ID = "amc:theatre:1";
const GONE_SHOWTIME_ID = "amc:showtime:1";
const ALT_SHOWTIME_ID = "amc:showtime:2";

type HitInput = {
  readonly row: number;
  readonly startCol: number;
  readonly rowSpan?: number;
  readonly runScore?: number;
  readonly showtimeIndices?: readonly number[];
};

function resolvedShowtime(showtimeId: string): GroupShowtime {
  return {
    showtimeId,
    theatreId: THEATRE_ID,
    distanceKm: null,
    showDateTimeUtc: "2026-08-16T19:00:00Z",
    timezone: "America/New_York",
    minPrice: { amount: 1200, currency: "USD", basis: "TICKET_ONLY" },
    status: "OPEN",
    deepLinkUrl: "https://www.amctheatres.com/showtimes/1",
    resolved: true,
    openCount: 0,
    capturedAt: "2026-08-16T18:00:00Z",
    staleAfter: "2026-08-16T20:00:00Z",
  };
}

/**
 * Hand-builds a schema-valid `ResultGroup`. Every cell is a named STANDARD seat; `groupHits`
 * are injected verbatim for exact control over the distance and tie-break keys. `hits` omitted
 * yields a group with no `groupHits` at all (the S32.8 absent edge).
 */
function makeGroup(input: {
  readonly rows: number;
  readonly columns: number;
  readonly layoutId?: string;
  readonly showtimeIds?: readonly string[];
  readonly hits?: readonly HitInput[];
}): ResultGroup {
  const { rows, columns } = input;
  const layoutId = input.layoutId ?? LAYOUT_ID;
  const showtimeIds = input.showtimeIds ?? [GONE_SHOWTIME_ID];
  const cellCount = rows * columns;

  const seatNames: Record<string, string> = {};
  for (let cell = 0; cell < cellCount; cell += 1) {
    seatNames[String(cell)] = `R${Math.floor(cell / columns)}C${cell % columns}`;
  }

  const showtimes = showtimeIds.map((id) => resolvedShowtime(id));

  const group: ResultGroup = {
    layoutId,
    theatreId: THEATRE_ID,
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: null,
    attributes: [],
    rows,
    columns,
    seatKinds: new Array<number>(cellCount).fill(1),
    seatNames,
    seatScores: new Array<number>(cellCount).fill(0.5),
    showtimes,
    freeCount: new Array<number>(cellCount).fill(showtimes.length),
    freeIn: Array.from({ length: cellCount }, () => showtimes.map((_, index) => index)),
    ...(input.hits === undefined
      ? {}
      : {
          groupHits: input.hits.map((hit) => ({
            row: hit.row,
            startCol: hit.startCol,
            rowSpan: hit.rowSpan ?? 1,
            runScore: hit.runScore ?? 0.5,
            showtimeIndices: [...(hit.showtimeIndices ?? [0])],
          })),
        }),
  };

  // Fixture sanity: every hand-built group must itself satisfy the shipped contract.
  expect(contracts.ResultGroupSchema.safeParse(group).success).toBe(true);
  return group;
}

function customShowtime(id: string, showDateTimeUtc: string): GroupShowtime {
  return { ...resolvedShowtime(id), showDateTimeUtc };
}

/**
 * Like `makeGroup`, but for Level 2/3/4 fixtures that need explicit per-showtime
 * `showDateTimeUtc` (the ADR 0027 Part 2 tie-break) and explicit `showtimeIndices` per hit.
 */
function makeGroupWithShowtimes(input: {
  readonly rows: number;
  readonly columns: number;
  readonly layoutId?: string;
  readonly showtimes: readonly { readonly id: string; readonly showDateTimeUtc: string }[];
  readonly hits: readonly {
    readonly row: number;
    readonly startCol: number;
    readonly rowSpan?: number;
    readonly runScore?: number;
    readonly showtimeIndices: readonly number[];
  }[];
}): ResultGroup {
  const { rows, columns } = input;
  const layoutId = input.layoutId ?? LAYOUT_ID;
  const cellCount = rows * columns;

  const seatNames: Record<string, string> = {};
  for (let cell = 0; cell < cellCount; cell += 1) {
    seatNames[String(cell)] = `R${Math.floor(cell / columns)}C${cell % columns}`;
  }

  const showtimes = input.showtimes.map((showtime) =>
    customShowtime(showtime.id, showtime.showDateTimeUtc),
  );

  const group: ResultGroup = {
    layoutId,
    theatreId: THEATRE_ID,
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: null,
    attributes: [],
    rows,
    columns,
    seatKinds: new Array<number>(cellCount).fill(1),
    seatNames,
    seatScores: new Array<number>(cellCount).fill(0.5),
    showtimes,
    freeCount: new Array<number>(cellCount).fill(showtimes.length),
    freeIn: Array.from({ length: cellCount }, () => showtimes.map((_, index) => index)),
    groupHits: input.hits.map((hit) => ({
      row: hit.row,
      startCol: hit.startCol,
      rowSpan: hit.rowSpan ?? 1,
      runScore: hit.runScore ?? 0.5,
      showtimeIndices: [...hit.showtimeIndices],
    })),
  };

  expect(contracts.ResultGroupSchema.safeParse(group).success).toBe(true);
  return group;
}

function gonePlacement(overrides: Partial<Placement> = {}): Placement {
  return {
    layoutId: LAYOUT_ID,
    row: 3,
    startCol: 4,
    rowSpan: 1,
    count: 4,
    seatNames: ["R3C4", "R3C5", "R3C6", "R3C7"],
    placementKey: "gone-placement-key",
    ...overrides,
  };
}

describe("assembleRecoveryLevelOne", () => {
  it("S32.4 — minimizes |Δrow|·W + |Δcol| and follows the injected W", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 2, startCol: 4 }, // Δrow=1, Δcol=0
        { row: 3, startCol: 7 }, // Δrow=0, Δcol=3
      ],
    });
    const gone = gonePlacement(); // row=3, startCol=4

    // W=10 → (2,4)=10·1+0=10, (3,7)=10·0+3=3 → (3,7) wins.
    const withTen = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(withTen?.placement.row).toBe(3);
    expect(withTen?.placement.startCol).toBe(7);

    // W=2 → (2,4)=2·1+0=2, (3,7)=2·0+3=3 → (2,4) wins.
    const withTwo = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 2,
    });
    expect(withTwo?.placement.row).toBe(2);
    expect(withTwo?.placement.startCol).toBe(4);
  });

  it("S32.3(c) — excludes hits beyond the ±2-row window", () => {
    const group = makeGroup({
      rows: 8,
      columns: 10,
      hits: [
        { row: 6, startCol: 4 }, // Δrow=3 → out of window
        { row: 4, startCol: 4 }, // Δrow=1 → in window
      ],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(4);
    expect(result?.placement.startCol).toBe(4);
  });

  it("S32.3(b) — the gone placement is not its own alternative", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 3, startCol: 4 }], // the gone seat itself
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.3(a) — only same-showtime hits are candidates", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 2, startCol: 4, showtimeIndices: [1] }], // ALT only, not the gone showtime
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.5 — ties break on runScore desc first", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 2, startCol: 4, runScore: 0.6 },
        { row: 4, startCol: 4, runScore: 0.8 },
      ],
    });
    const gone = gonePlacement();
    // Both Δrow=1, Δcol=0 → distance equal. Higher runScore (0.8, row 4) wins.
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(4);
  });

  it("S32.5 — ties break on showtimeIndices.length desc next", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [
        { row: 2, startCol: 4, runScore: 0.5, showtimeIndices: [0, 1] },
        { row: 4, startCol: 4, runScore: 0.5, showtimeIndices: [0] },
      ],
    });
    const gone = gonePlacement();
    // Equal distance, equal runScore → more showtimes (row 2) wins.
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(2);
  });

  it("S32.5 — ties break on lowest startCol next", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 3, startCol: 6, runScore: 0.5 },
        { row: 3, startCol: 2, runScore: 0.5 },
      ],
    });
    const gone = gonePlacement();
    // Both Δrow=0, Δcol=2 → distance equal; equal runScore and showtime count → lowest startCol (2).
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(3);
    expect(result?.placement.startCol).toBe(2);
  });

  it("S32.5 — final tie falls to placementKey lexicographic (determinism)", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 2, startCol: 4, runScore: 0.5 },
        { row: 4, startCol: 4, runScore: 0.5 },
      ],
    });
    const gone = gonePlacement();
    // Equal distance (Δrow=1, Δcol=0), runScore, showtime count, and startCol.
    // placementKey: sha256("amc:layout:1|4|4|1|4")[:16] = 980c39db6940f705
    //               sha256("amc:layout:1|2|4|1|4")[:16] = b0372019528b06d1
    // 980c… < b037… → row 4 wins.
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(4);
  });

  it("is deterministic for identical inputs", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 2, startCol: 4 },
        { row: 4, startCol: 4 },
        { row: 3, startCol: 6 },
      ],
    });
    const gone = gonePlacement();
    const run = () =>
      assembleRecoveryLevelOne({
        gonePlacement: gone,
        goneShowtimeId: GONE_SHOWTIME_ID,
        group,
        rowWeight: 10,
      });
    expect(run()).toEqual(run());
  });

  it("S32.7 — output satisfies the shipped RecoveryOption/Placement contracts", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 2, startCol: 4 }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(RecoveryOptionSchema.safeParse(result).success).toBe(true);
    expect(PlacementSchema.safeParse(result!.placement).success).toBe(true);
    expect(result!.level).toBe(1);
    expect(result!.relaxed).toEqual([]);
    expect(result!.requiresConsent).toBe(false);
    expect(result!.showtimeId).toBe(GONE_SHOWTIME_ID);
  });

  it("S32.7 — validates the returned option through RecoveryOptionSchema before returning", () => {
    const parseSpy = vi.spyOn(RecoveryOptionSchema, "parse");
    try {
      const group = makeGroup({
        rows: 6,
        columns: 10,
        hits: [{ row: 2, startCol: 4 }],
      });
      const gone = gonePlacement();
      const result = assembleRecoveryLevelOne({
        gonePlacement: gone,
        goneShowtimeId: GONE_SHOWTIME_ID,
        group,
        rowWeight: 10,
      });
      expect(result).not.toBeNull();
      // The internal boundary validation fired exactly once — not just the test's own
      // `safeParse` above (spec S32.7 "validate … before returning it").
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("S32.6 — placementKey is the ADR 0023 decision-1 hash, seatNames are member cells", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 2, startCol: 4 }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement).toEqual({
      layoutId: LAYOUT_ID,
      row: 2,
      startCol: 4,
      rowSpan: 1,
      count: 4,
      seatNames: ["R2C4", "R2C5", "R2C6", "R2C7"],
      placementKey: "b0372019528b06d1",
    });
  });

  it("S32.6 — BLOCK shape derives member columns from count/rowSpan", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 1, startCol: 4, rowSpan: 2 }],
    });
    const gone = gonePlacement({
      row: 2,
      startCol: 4,
      rowSpan: 2,
      count: 6,
      seatNames: ["R2C4", "R2C5", "R2C6", "R3C4", "R3C5", "R3C6"],
    });
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.rowSpan).toBe(2);
    expect(result?.placement.count).toBe(6);
    expect(result?.placement.seatNames).toEqual(["R1C4", "R1C5", "R1C6", "R2C4", "R2C5", "R2C6"]);
  });

  it("E7.3 — excludes a hit whose member cell has no seat name (never fabricates)", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 2, startCol: 4 },
        { row: 4, startCol: 4 },
      ],
    });
    // Remove the name of the (2,4) candidate's first member cell (cell 2·10 + 4 = 24).
    delete group.seatNames["24"];
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(4);
  });

  it("S32.8 — returns null when groupHits is absent", () => {
    const group = makeGroup({ rows: 6, columns: 10 });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.8 — returns null when the gone showtime is absent from the group", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [ALT_SHOWTIME_ID],
      hits: [{ row: 2, startCol: 4 }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.3 — returns null when the group layoutId differs from the gone placement's", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      layoutId: "amc:layout:2",
      hits: [{ row: 2, startCol: 4 }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.8 — returns null when no candidate survives the filter", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [
        { row: 3, startCol: 4 }, // the gone seat itself
        { row: 0, startCol: 4 }, // Δrow=3 → out of window
      ],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelOne({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });
});

describe("assembleRecoveryLevelTwo", () => {
  it("S32.13 — returns the gone placement at the lowest non-gone showtimeIndex", () => {
    const group = makeGroupWithShowtimes({
      rows: 6,
      columns: 10,
      showtimes: [
        { id: GONE_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T19:00:00Z" },
        { id: "amc:showtime:3", showDateTimeUtc: "2026-08-16T20:00:00Z" },
        { id: ALT_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T21:00:00Z" },
      ],
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0, 2, 1] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelTwo({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(2);
    expect(result?.placement).toEqual(gone);
    expect(result?.showtimeId).toBe("amc:showtime:3"); // index 1 — lowest non-gone
    expect(result?.relaxed).toEqual([]);
    expect(result?.requiresConsent).toBe(false);
    expect(RecoveryOptionSchema.safeParse(result).success).toBe(true);
  });

  it("S32.12 — yields none when the gone placement is offered only at the gone showtime", () => {
    const group = makeGroupWithShowtimes({
      rows: 6,
      columns: 10,
      showtimes: [{ id: GONE_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T19:00:00Z" }],
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelTwo({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.12 — returns null when no hit matches the gone placement's (row, startCol, rowSpan)", () => {
    const group = makeGroupWithShowtimes({
      rows: 6,
      columns: 10,
      showtimes: [
        { id: GONE_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T19:00:00Z" },
        { id: ALT_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T20:00:00Z" },
      ],
      hits: [{ row: 2, startCol: 4, showtimeIndices: [0, 1] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelTwo({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });
});

describe("assembleRecoveryLevelThree", () => {
  it("S32.14 — excludes hits within the ±2-row window (Level 1/2 territory)", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      hits: [
        { row: 5, startCol: 4 }, // Δrow=2 → within window, not a Level 3 candidate
        { row: 7, startCol: 4 }, // Δrow=4 → outside window, the only Level 3 candidate
      ],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(3);
    expect(result?.placement.row).toBe(7);
    expect(result?.showtimeId).toBe(GONE_SHOWTIME_ID);
    expect(result?.relaxed).toEqual([]);
    expect(result?.requiresConsent).toBe(false);
    expect(RecoveryOptionSchema.safeParse(result).success).toBe(true);
  });

  it("S32.14 — ranks by runScore desc first", () => {
    const group = makeGroup({
      rows: 12,
      columns: 10,
      hits: [
        { row: 0, startCol: 4, runScore: 0.6 }, // Δrow=3
        { row: 8, startCol: 4, runScore: 0.9 }, // Δrow=5
      ],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(8);
  });

  it("S32.14 — ties break on showtimeIndices.length desc next", () => {
    const group = makeGroup({
      rows: 12,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [
        { row: 0, startCol: 4, runScore: 0.5, showtimeIndices: [0, 1] },
        { row: 8, startCol: 4, runScore: 0.5, showtimeIndices: [0] },
      ],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(0);
  });

  it("S32.14 — ties break on lowest startCol next", () => {
    const group = makeGroup({
      rows: 12,
      columns: 10,
      hits: [
        { row: 0, startCol: 6, runScore: 0.5 },
        { row: 0, startCol: 2, runScore: 0.5 },
      ],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.startCol).toBe(2);
  });

  it("S32.14 — final tie falls to placementKey lexicographic (determinism)", () => {
    const group = makeGroup({
      rows: 12,
      columns: 10,
      hits: [
        { row: 0, startCol: 4, runScore: 0.5 },
        { row: 8, startCol: 4, runScore: 0.5 },
      ],
    });
    const gone = gonePlacement({ row: 3 });
    // placementKey: sha256("amc:layout:1|0|4|1|4")[:16] = a963a784ff09e8ed
    //               sha256("amc:layout:1|8|4|1|4")[:16] = f0389bb9026ddb5b
    // a963… < f038… → row 0 wins.
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.placement.row).toBe(0);
  });

  it("S32.14 — returns null when the only out-of-window hit is at a different showtime", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 8, startCol: 4, showtimeIndices: [1] }],
    });
    const gone = gonePlacement({ row: 3 });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });
});

describe("assembleRecoveryLevelFour", () => {
  it("S32.15/S32.16 — ranks by the same chain and sets requiresConsent + relaxed", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [
        { row: 3, startCol: 6, runScore: 0.4, showtimeIndices: [1] },
        { row: 3, startCol: 8, runScore: 0.9, showtimeIndices: [1] },
      ],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(4);
    expect(result?.placement.startCol).toBe(8); // higher runScore wins
    expect(result?.showtimeId).toBe(ALT_SHOWTIME_ID);
    expect(result?.requiresConsent).toBe(true);
    expect(result?.relaxed).toEqual([
      { kind: "S32_LEVEL_4_RELAXED", label: "Different showtime and seat" },
    ]);
    expect(RecoveryOptionSchema.safeParse(result).success).toBe(true);
  });

  it("S32.15 — pair-level dedup: the gone-showtime pairing is excluded, the other-showtime pairing survives", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 6, showtimeIndices: [0, 1] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.placement.startCol).toBe(6);
    expect(result?.showtimeId).toBe(ALT_SHOWTIME_ID);
  });

  it("S32.15 — the gone placement's own hit at the gone showtime is never a Level 4 candidate", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0] }], // the gone seat itself
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("S32.15 — the gone placement's own hit at another showtime is Level-2 territory, not Level 4", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0, 1] }], // gone placement's own coords
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("ADR 0027 Part 2 — equidistant showtimes resolve earlier-first", () => {
    const group = makeGroupWithShowtimes({
      rows: 6,
      columns: 10,
      showtimes: [
        { id: GONE_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T19:00:00Z" },
        { id: "amc:showtime:earlier", showDateTimeUtc: "2026-08-16T17:00:00Z" }, // 2h before
        { id: "amc:showtime:later", showDateTimeUtc: "2026-08-16T21:00:00Z" }, // 2h after
        { id: "amc:showtime:far", showDateTimeUtc: "2026-08-17T19:00:00Z" }, // 24h after
      ],
      hits: [{ row: 3, startCol: 6, showtimeIndices: [1, 2, 3] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    // Indices 1 and 2 are equidistant (2h) from the gone showtime; earlier-first picks index 1.
    expect(result?.showtimeId).toBe("amc:showtime:earlier");
  });

  it("ADR 0027 Part 2 — exact-timestamp ties fall to showtimeIndex ascending", () => {
    const group = makeGroupWithShowtimes({
      rows: 6,
      columns: 10,
      showtimes: [
        { id: GONE_SHOWTIME_ID, showDateTimeUtc: "2026-08-16T19:00:00Z" },
        { id: "amc:showtime:a", showDateTimeUtc: "2026-08-16T21:00:00Z" },
        { id: "amc:showtime:b", showDateTimeUtc: "2026-08-16T21:00:00Z" },
      ],
      hits: [{ row: 3, startCol: 6, showtimeIndices: [2, 1] }],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLevelFour({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.showtimeId).toBe("amc:showtime:a"); // index 1, lower than index 2
  });
});

describe("assembleRecoveryLadder", () => {
  it("S32.17 — strict first success: the Level 1 winner wins even when Level 2/3 candidates exist", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [
        { row: 2, startCol: 4 }, // Level 1 candidate (Δrow=1, within window, gone showtime)
        { row: 3, startCol: 4, showtimeIndices: [1] }, // Level 2 candidate (gone's own hit, other showtime)
        { row: 8, startCol: 4 }, // Level 3 candidate (outside window, gone showtime)
      ],
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLadder({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(1);
    expect(result?.placement.row).toBe(2);
  });

  it("S32.17 — falls through to Level 2 when Level 1 has no candidate", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0, 1] }], // gone's own hit, offered elsewhere
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLadder({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(2);
    expect(result?.showtimeId).toBe(ALT_SHOWTIME_ID);
  });

  it("S32.17 — falls through to Level 3 when Levels 1-2 have no candidate", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      hits: [{ row: 8, startCol: 4 }], // outside ±2 window, the only (gone) showtime
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLadder({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(3);
    expect(result?.placement.row).toBe(8);
  });

  it("S32.17 — falls through to Level 4 when Levels 1-3 have no candidate", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 6, showtimeIndices: [1] }], // only offered at the other showtime
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLadder({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result?.level).toBe(4);
    expect(result?.requiresConsent).toBe(true);
  });

  it("S32.17/F5 — returns null when all four rungs fail (never a fabricated option)", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 3, startCol: 4 }], // the gone seat itself, its only showtime
    });
    const gone = gonePlacement();
    const result = assembleRecoveryLadder({
      gonePlacement: gone,
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).toBeNull();
  });

  it("is deterministic for identical inputs", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [
        { row: 3, startCol: 4, showtimeIndices: [1] },
        { row: 8, startCol: 4 },
      ],
    });
    const gone = gonePlacement();
    const run = () =>
      assembleRecoveryLadder({
        gonePlacement: gone,
        goneShowtimeId: GONE_SHOWTIME_ID,
        group,
        rowWeight: 10,
      });
    expect(run()).toEqual(run());
  });
});

describe("recovery options carry seatNames for seat-level deep links (P9.5)", () => {
  it("Level 1 carries the winning alternative placement's specific seat names", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      hits: [{ row: 2, startCol: 4 }],
    });
    const result = assembleRecoveryLevelOne({
      gonePlacement: gonePlacement(),
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.placement.seatNames).toEqual(["R2C4", "R2C5", "R2C6", "R2C7"]);
  });

  it("Level 2 carries the gone placement's own seat names at the other showtime", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 4, showtimeIndices: [0, 1] }],
    });
    const result = assembleRecoveryLevelTwo({
      gonePlacement: gonePlacement(),
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.showtimeId).toBe(ALT_SHOWTIME_ID);
    expect(result?.placement.seatNames).toEqual(["R3C4", "R3C5", "R3C6", "R3C7"]);
  });

  it("Level 3 carries the outside-window alternative's specific seat names", () => {
    const group = makeGroup({
      rows: 10,
      columns: 10,
      hits: [{ row: 8, startCol: 4 }],
    });
    const result = assembleRecoveryLevelThree({
      gonePlacement: gonePlacement(),
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.placement.seatNames).toEqual(["R8C4", "R8C5", "R8C6", "R8C7"]);
  });

  it("Level 4 carries the any-showtime alternative's specific seat names", () => {
    const group = makeGroup({
      rows: 6,
      columns: 10,
      showtimeIds: [GONE_SHOWTIME_ID, ALT_SHOWTIME_ID],
      hits: [{ row: 3, startCol: 6, showtimeIndices: [1] }],
    });
    const result = assembleRecoveryLevelFour({
      gonePlacement: gonePlacement(),
      goneShowtimeId: GONE_SHOWTIME_ID,
      group,
      rowWeight: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.showtimeId).toBe(ALT_SHOWTIME_ID);
    expect(result?.placement.seatNames).toEqual(["R3C6", "R3C7", "R3C8", "R3C9"]);
  });
});
