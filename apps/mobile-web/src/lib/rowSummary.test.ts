import { describe, expect, it } from "vitest";
import type { ResultGroup } from "@seatfirst/core";
import {
  buildRowDotGrid,
  percentFull,
  summarizePlacement,
  freeAndTotalSeats,
  checkedAgoLabel,
  formatFreshnessInfo,
} from "./rowSummary";

// ---------------------------------------------------------------------------
// Helpers — small synthetic fixtures (no external fixture file)
// ---------------------------------------------------------------------------

function mkGroup(over: {
  rows?: number;
  columns?: number;
  seatKinds?: number[];
  freeIn?: number[][];
  seatNames?: Record<string, string>;
  seatScores?: number[];
  formatCode?: string;
  showtimes?: { showtimeId: string; resolved: boolean; capturedAt?: string }[];
  groupHits?: NonNullable<ResultGroup["groupHits"]>;
}): ResultGroup {
  const rows = over.rows ?? 2;
  const columns = over.columns ?? 5;
  const cellCount = rows * columns;
  const seatKinds = over.seatKinds ?? Array.from({ length: cellCount }, () => 1); // 1 = STANDARD, 0 = NOT_A_SEAT
  const freeIn =
    over.freeIn ??
    Array.from({ length: cellCount }, () => (over.showtimes?.[0]?.resolved ? [0] : []));
  const seatNames = over.seatNames ?? {};
  const seatScores = over.seatScores ?? Array.from({ length: cellCount }, () => 0);
  const showtimes = over.showtimes?.map((s, idx) => ({
    showtimeId: s.showtimeId,
    theatreId: "th_1",
    distanceKm: null,
    showDateTimeUtc: "2026-08-30T19:00:00Z",
    timezone: "America/Los_Angeles",
    minPrice: null,
    status: "OK" as const,
    deepLinkUrl: `https://amc.com/${idx}`,
    capturedAt: s.capturedAt ?? "2026-08-30T18:00:00Z",
    staleAfter: "2026-08-30T20:00:00Z",
    resolved: s.resolved,
    openCount: s.resolved ? 10 : null,
  })) ?? [
    {
      showtimeId: "sh_1",
      theatreId: "th_1",
      distanceKm: null,
      showDateTimeUtc: "2026-08-30T19:00:00Z",
      timezone: "America/Los_Angeles",
      minPrice: null,
      status: "OK" as const,
      deepLinkUrl: "https://amc.com/0",
      capturedAt: "2026-08-30T18:00:00Z",
      staleAfter: "2026-08-30T20:00:00Z",
      resolved: true as const,
      openCount: 10,
    },
  ];

  return {
    layoutId: "lay_1",
    theatreId: "th_1",
    distanceKm: null,
    formatCode: over.formatCode ?? "STANDARD",
    auditorium: "1",
    attributes: [],
    rows,
    columns,
    seatKinds,
    seatNames,
    seatScores,
    showtimes,
    freeCount: Array.from({ length: cellCount }, () => 0),
    freeIn,
    groupHits: over.groupHits,
  } as unknown as ResultGroup;
}

function mkHit(row: number, startCol: number, showtimeIndices: number[] = [0]) {
  return { row, startCol, rowSpan: 1, runScore: 0, showtimeIndices };
}

// ---------------------------------------------------------------------------
describe("buildRowDotGrid / freeAndTotalSeats / percentFull", () => {
  it("fully-free grid yields 0% full and free==totalSeats", () => {
    const rows = 2;
    const columns = 4;
    const cellCount = rows * columns;
    const seatKinds = Array.from({ length: cellCount }, () => 1);
    // every cell free for showtime 0
    const freeIn = Array.from({ length: cellCount }, () => null).map(() => [0]);
    const group = mkGroup({ rows, columns, seatKinds, freeIn });
    const grid = buildRowDotGrid(group, 0);
    expect(grid.rows).toBe(rows);
    expect(grid.columns).toBe(columns);
    expect(grid.cells.every((c) => c.isSeat)).toBe(true);
    expect(grid.cells.every((c) => c.free)).toBe(true);
    expect(freeAndTotalSeats(group, 0)).toEqual({ free: 8, totalSeats: 8 });
    expect(percentFull(grid)).toBe(0); // 1 - 8/8 = 0%
  });

  it("fully-taken grid yields 100% full and free==0", () => {
    const rows = 2;
    const columns = 3;
    const cellCount = rows * columns;
    const seatKinds = Array.from({ length: cellCount }, () => 1);
    const freeIn = Array.from({ length: cellCount }, () => null).map(() => []); // no showtime index included => taken
    const group = mkGroup({ rows, columns, seatKinds, freeIn });
    const grid = buildRowDotGrid(group, 0);
    expect(grid.cells.every((c) => c.isSeat)).toBe(true);
    expect(grid.cells.every((c) => !c.free)).toBe(true);
    expect(freeAndTotalSeats(group, 0)).toEqual({ free: 0, totalSeats: 6 });
    expect(percentFull(grid)).toBe(100);
  });

  it("gap column (NOT_A_SEAT) excluded from totalSeats and percent, and isSeat false", () => {
    // 2 rows x 5 cols, column 2 is a NOT_A_SEAT gap (aisle)
    const rows = 2;
    const columns = 5;
    const seatKinds: number[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        seatKinds.push(c === 2 ? 0 : 1); // 0 = NOT_A_SEAT per layout.ts SEAT_KIND_CODE
      }
    }
    // Fully free except gap cells are not seats; they still have freeIn empty but isSeat false
    const freeIn = seatKinds.map((kind) => (kind === 0 ? [] : [0]));
    const group = mkGroup({ rows, columns, seatKinds, freeIn });
    const grid = buildRowDotGrid(group, 0);
    // Gap cells are not seats
    expect(grid.cells.filter((c) => !c.isSeat).length).toBe(2); // 2 rows × 1 gap
    // Total seats should be 8, not 10
    expect(freeAndTotalSeats(group, 0)).toEqual({ free: 8, totalSeats: 8 });
    expect(percentFull(grid)).toBe(0);
    // Taken variant: seats taken but gaps still not counted
    const freeInTaken = seatKinds.map(() => [] as number[]);
    const groupTaken = mkGroup({ rows, columns, seatKinds, freeIn: freeInTaken });
    const gridTaken = buildRowDotGrid(groupTaken, 0);
    expect(freeAndTotalSeats(groupTaken, 0)).toEqual({ free: 0, totalSeats: 8 });
    expect(percentFull(gridTaken)).toBe(100);
    // isSeat check explicitly
    for (let r = 0; r < rows; r += 1) {
      const gapIdx = r * columns + 2;
      expect(grid.cells[gapIdx]!.isSeat).toBe(false);
      expect(grid.cells[r * columns + 1]!.isSeat).toBe(true);
    }
  });

  it("percentFull returns null when there are zero seat cells (never divide by zero)", () => {
    const rows = 2;
    const columns = 3;
    const seatKinds = Array.from({ length: rows * columns }, () => 0); // all NOT_A_SEAT
    const freeIn = Array.from({ length: rows * columns }, () => null).map(() => [] as number[]);
    const group = mkGroup({ rows, columns, seatKinds, freeIn });
    const grid = buildRowDotGrid(group, 0);
    expect(grid.cells.every((c) => !c.isSeat)).toBe(true);
    expect(freeAndTotalSeats(group, 0)).toEqual({ free: 0, totalSeats: 0 });
    expect(percentFull(grid)).toBeNull();
  });

  it("freeAndTotalSeats reads freeIn[cell].includes(showtimeIndex) per cell", () => {
    // 1 row x 4 cols, showtime 0 free at cols 0,1 ; showtime 1 free at cols 2,3
    const rows = 1;
    const columns = 4;
    const seatKinds = [1, 1, 1, 1];
    const freeIn = [[0], [0], [1], [1]];
    const group = mkGroup({
      rows,
      columns,
      seatKinds,
      freeIn,
      showtimes: [
        { showtimeId: "sh_0", resolved: true },
        { showtimeId: "sh_1", resolved: true },
      ],
    });
    expect(buildRowDotGrid(group, 0).cells.map((c) => c.free)).toEqual([true, true, false, false]);
    expect(buildRowDotGrid(group, 1).cells.map((c) => c.free)).toEqual([false, false, true, true]);
    expect(freeAndTotalSeats(group, 0)).toEqual({ free: 2, totalSeats: 4 });
    expect(freeAndTotalSeats(group, 1)).toEqual({ free: 2, totalSeats: 4 });
    expect(percentFull(buildRowDotGrid(group, 0))).toBe(50);
    expect(percentFull(buildRowDotGrid(group, 1))).toBe(50);
  });

  it("partial occupancy percent rounding", () => {
    // 1 row x 3 cols, 2 free out of 3 => 33.333% taken? Actually 1 - 2/3 = 33% full rounded
    const rows = 1;
    const columns = 3;
    const seatKinds = [1, 1, 1];
    const freeIn = [[0], [0], []];
    const group = mkGroup({ rows, columns, seatKinds, freeIn });
    expect(percentFull(buildRowDotGrid(group, 0))).toBe(33);
    // 1 free out of 3 => 67% full
    const freeIn2 = [[0], [], []];
    const group2 = mkGroup({ rows, columns, seatKinds, freeIn: freeIn2 });
    expect(percentFull(buildRowDotGrid(group2, 0))).toBe(67);
  });
});

describe("summarizePlacement", () => {
  it("rowSeatLabel fallback to startCol+1 when seatNames absent", () => {
    const group = mkGroup({ rows: 5, columns: 10, seatNames: {} });
    const hit = mkHit(1, 2); // row B, startCol 2 => seats 3-4 for partySize 2
    const res = summarizePlacement(group, hit, 2);
    expect(res.rowSeatLabel).toBe("Row B, Seats 3-4");
  });

  it("rowSeatLabel prefers real seatNames values when present (extracting numeric suffix)", () => {
    const rows = 3;
    const columns = 6;
    // seatNames for row 1 (B): cells 1*6+2 and 1*6+3 => B3 and B4
    const seatNames: Record<string, string> = {
      [String(1 * columns + 2)]: "B3",
      [String(1 * columns + 3)]: "B4",
    };
    const group = mkGroup({ rows, columns, seatNames });
    const hit = mkHit(1, 2);
    const res = summarizePlacement(group, hit, 2);
    expect(res.rowSeatLabel).toBe("Row B, Seats 3-4");
  });
  it("rowSeatLabel always shows ascending numbers even when seatNames run in reverse column order", () => {
    const rows = 3;
    const columns = 6;
    // Real house numbering can decrease left-to-right: cell at startCol has the higher
    // seat number, cell at startCol+partySize-1 has the lower one. The displayed range
    // must still read low-high ("Seats 4-7"), never positional ("Seats 7-4").
    const seatNames: Record<string, string> = {
      [String(1 * columns + 2)]: "B7",
      [String(1 * columns + 3)]: "B4",
    };
    const group = mkGroup({ rows, columns, seatNames });
    const hit = mkHit(1, 2);
    const res = summarizePlacement(group, hit, 2);
    expect(res.rowSeatLabel).toBe("Row B, Seats 4-7");
  });

  it("rowSeatLabel uses raw seatNames when they do not match RowLetterNumber pattern", () => {
    const rows = 2;
    const columns = 4;
    const seatNames: Record<string, string> = {
      [String(0 * columns + 1)]: "X",
      [String(0 * columns + 2)]: "Y",
    };
    const group = mkGroup({ rows, columns, seatNames });
    const hit = mkHit(0, 1);
    const res = summarizePlacement(group, hit, 2);
    expect(res.rowSeatLabel).toBe("Row A, Seats X-Y");
  });

  it("centered true when run centre within 2 of columns/2, false otherwise", () => {
    const columns = 10;
    const group = mkGroup({ rows: 4, columns });
    // centre = 5
    // partySize 2, startCol 4 => runCentre 5 => distance 0 => centered true
    const hitCentered = mkHit(2, 4);
    expect(summarizePlacement(group, hitCentered, 2).centered).toBe(true);
    // startCol 4, partySize 4 => runCentre 6 => distance 1 => still centered (<2)
    const hitWideCentered = mkHit(2, 4);
    expect(summarizePlacement(group, hitWideCentered, 4).centered).toBe(true);
    // startCol 0, partySize 2 => runCentre 1 => distance 4 => off-centre
    const hitOff = mkHit(2, 0);
    expect(summarizePlacement(group, hitOff, 2).centered).toBe(false);
    // startCol 8, partySize2 => runCentre 9 => distance 4 => off-centre
    const hitOffRight = mkHit(2, 8);
    expect(summarizePlacement(group, hitOffRight, 2).centered).toBe(false);
    // Edge of threshold: startCol 3, partySize2 => runCentre 4 => distance 1 => centered
    expect(summarizePlacement(mkGroup({ rows: 4, columns: 10 }), mkHit(1, 3), 2).centered).toBe(
      true,
    );
    // startCol 2, partySize2 => runCentre 3 => distance 2 => NOT centered (must be <2, not <=2)
    expect(summarizePlacement(mkGroup({ rows: 4, columns: 10 }), mkHit(1, 2), 2).centered).toBe(
      false,
    );
  });

  it("third bucketing: row 0 front, middle rows, back rows", () => {
    const rows = 9;
    const columns = 6;
    const group = mkGroup({ rows, columns });
    expect(summarizePlacement(group, mkHit(0, 1), 2).third).toBe("front");
    expect(summarizePlacement(group, mkHit(2, 1), 2).third).toBe("front"); // 2 < 3
    expect(summarizePlacement(group, mkHit(3, 1), 2).third).toBe("middle"); // 3 >=3 and <6
    expect(summarizePlacement(group, mkHit(4, 1), 2).third).toBe("middle");
    expect(summarizePlacement(group, mkHit(5, 1), 2).third).toBe("middle");
    expect(summarizePlacement(group, mkHit(6, 1), 2).third).toBe("back"); // 6 >=6
    expect(summarizePlacement(group, mkHit(8, 1), 2).third).toBe("back");
  });

  it("third with small grid divisions", () => {
    // rows=3 => front row0, middle row1, back row2
    const group = mkGroup({ rows: 3, columns: 4 });
    expect(summarizePlacement(group, mkHit(0, 0), 1).third).toBe("front");
    expect(summarizePlacement(group, mkHit(1, 0), 1).third).toBe("middle");
    expect(summarizePlacement(group, mkHit(2, 0), 1).third).toBe("back");
  });

  it("single-seat partySize label", () => {
    const group = mkGroup({ rows: 2, columns: 5, seatNames: {} });
    const hit = mkHit(0, 3);
    const res = summarizePlacement(group, hit, 1);
    // Should be Row A, Seats 4-4 for single seat (partySize 1)
    expect(res.rowSeatLabel).toBe("Row A, Seats 4-4");
  });
});

describe("checkedAgoLabel", () => {
  it("just now for <60s", () => {
    const now = new Date("2026-08-30T19:00:00Z");
    expect(checkedAgoLabel("2026-08-30T19:00:00Z", now)).toBe("just now");
    expect(checkedAgoLabel("2026-08-30T18:59:30Z", now)).toBe("just now");
    expect(checkedAgoLabel("2026-08-30T18:59:01Z", now)).toBe("just now");
  });

  it("minutes ago (singular vs plural)", () => {
    const now = new Date("2026-08-30T19:00:00Z");
    expect(checkedAgoLabel("2026-08-30T18:59:00Z", now)).toBe("1 minute ago");
    expect(checkedAgoLabel("2026-08-30T18:58:00Z", now)).toBe("2 minutes ago");
    expect(checkedAgoLabel("2026-08-30T18:56:00Z", now)).toBe("4 minutes ago");
  });

  it("hours ago", () => {
    const now = new Date("2026-08-30T19:00:00Z");
    expect(checkedAgoLabel("2026-08-30T18:00:00Z", now)).toBe("1 hour ago");
    expect(checkedAgoLabel("2026-08-30T17:00:00Z", now)).toBe("2 hours ago");
    expect(checkedAgoLabel("2026-08-30T16:00:00Z", now)).toBe("3 hours ago");
  });

  it("days fallback for >24h", () => {
    const now = new Date("2026-08-31T19:00:00Z");
    expect(checkedAgoLabel("2026-08-30T19:00:00Z", now)).toBe("1 day ago");
    expect(checkedAgoLabel("2026-08-29T19:00:00Z", now)).toBe("2 days ago");
  });

  it("future capturedAt yields just now", () => {
    const now = new Date("2026-08-30T19:00:00Z");
    expect(checkedAgoLabel("2026-08-30T20:00:00Z", now)).toBe("just now");
  });

  it("defaults now to current time when not provided", () => {
    // Should not throw and should return a string matching the expected pattern
    const label = checkedAgoLabel(new Date().toISOString());
    expect(
      ["just now", "1 minute ago", "2 minutes ago"].some(
        (v) => label.includes(v) || label === "just now",
      ),
    ).toBe(true);
    // For a recent instant, it must be just now
    expect(checkedAgoLabel(new Date(Date.now() - 2000).toISOString())).toBe("just now");
  });
});

describe("formatFreshnessInfo", () => {
  const now = new Date("2026-08-30T19:00:00Z");
  const ago = (ageMs: number): string => new Date(now.getTime() - ageMs).toISOString();

  it("29s is fresh", () => {
    const info = formatFreshnessInfo(ago(29_000), now);
    expect(info?.tier).toBe("fresh");
    expect(info?.ageMs).toBe(29_000);
    expect(info?.label).toBe("Available · checked just now");
  });

  it("exactly 30s is cached (lower boundary)", () => {
    expect(formatFreshnessInfo(ago(30_000), now)?.tier).toBe("cached");
  });

  it("exactly 120s is still cached (upper boundary)", () => {
    expect(formatFreshnessInfo(ago(120_000), now)?.tier).toBe("cached");
  });

  it("121s is stale", () => {
    const info = formatFreshnessInfo(ago(121_000), now);
    expect(info?.tier).toBe("stale");
    expect(info?.ageMs).toBe(121_000);
  });

  it("future capturedAt clamps ageMs to 0 and reads fresh", () => {
    const info = formatFreshnessInfo(new Date(now.getTime() + 60_000).toISOString(), now);
    expect(info?.ageMs).toBe(0);
    expect(info?.tier).toBe("fresh");
  });

  it("null/undefined/empty capturedAt returns null", () => {
    expect(formatFreshnessInfo(null, now)).toBeNull();
    expect(formatFreshnessInfo(undefined, now)).toBeNull();
    expect(formatFreshnessInfo("", now)).toBeNull();
  });

  it("unparseable capturedAt returns null", () => {
    expect(formatFreshnessInfo("not-a-date", now)).toBeNull();
  });
});
