import { describe, expect, it } from "vitest";

import {
  PresetNameSchema,
  buildAuditoriumLayout,
  compileRegion,
  computeSeatMetrics,
  createBitmap,
  getBit,
  maskCacheKey,
  metricsVersion,
  midpointMask,
  popcount,
  regionRunStarts,
  setBit,
  type SeatRegion,
  type SparseLayoutCell,
} from "../src/index.js";

function standard(row: number, column: number): SparseLayoutCell {
  return { row, column, kind: "STANDARD", available: true, visible: true };
}

function standardGrid(rows: number, columns: number) {
  return buildAuditoriumLayout({
    rows,
    columns,
    cells: Array.from({ length: rows * columns }, (_, index) =>
      standard(Math.floor(index / columns) + 1, (index % columns) + 1),
    ),
  });
}

function compileMask(region: SeatRegion, rows = 5, columns = 9): Uint8Array {
  const built = standardGrid(rows, columns);
  const compiled = compileRegion(built.layout, computeSeatMetrics(built.layout), region);
  if (!compiled.ok) {
    throw new Error(compiled.error.code);
  }
  return compiled.mask;
}

describe("region compiler", () => {
  it("compiles hand-derived primitive masks", () => {
    const lateral = compileMask({ kind: "LATERAL", maxOffset: 0.25 }, 1, 5);
    expect(Array.from({ length: 5 }, (_, index) => getBit(lateral, index, 5))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    const rows = compileMask({ kind: "ROWS", from: 1, to: 1 }, 3, 2);
    expect(Array.from({ length: 6 }, (_, index) => getBit(rows, index, 6))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it("compiles every supported preset deterministically to a non-empty standard-grid mask", () => {
    const built = standardGrid(5, 9);
    const metrics = computeSeatMetrics(built.layout);
    for (const name of PresetNameSchema.options.filter((name) => name !== "SWEET_SPOT")) {
      const compiled = compileRegion(built.layout, metrics, { kind: "PRESET", name });
      expect(compiled.ok, name).toBe(true);
      expect(compiled.ok && popcount(compiled.mask, 45), name).toBeGreaterThan(0);
      const repeated = compileRegion(built.layout, metrics, { kind: "PRESET", name });
      expect(repeated).toEqual(compiled);
    }
  });

  it("fails SWEET_SPOT closed through the deferred SCORE compiler branch", () => {
    const built = standardGrid(5, 9);
    expect(
      compileRegion(built.layout, computeSeatMetrics(built.layout), {
        kind: "PRESET",
        name: "SWEET_SPOT",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_SCORE_REGION",
        region: { kind: "SCORE", min: 0.75 },
      },
    });
  });

  it("returns a typed unsupported result for SCORE without throwing", () => {
    const built = standardGrid(1, 5);
    expect(
      compileRegion(built.layout, computeSeatMetrics(built.layout), { kind: "SCORE", min: 0.5 }),
    ).toEqual({
      ok: false,
      error: { code: "UNSUPPORTED_SCORE_REGION", region: { kind: "SCORE", min: 0.5 } },
    });
  });
});

describe("region cache keys", () => {
  it("differs for semantically different regions", () => {
    expect(maskCacheKey("layout", metricsVersion, { kind: "ROWS", from: 0, to: 1 })).not.toEqual(
      maskCacheKey("layout", metricsVersion, { kind: "ROWS", from: 0, to: 2 }),
    );
  });

  it("matches for key-order, child-order, duplicate, and equivalent nesting differences", () => {
    const left = {
      kind: "AND" as const,
      of: [
        { kind: "ROWS" as const, from: 0, to: 3 },
        {
          kind: "AND" as const,
          of: [
            { kind: "LATERAL" as const, maxOffset: 0.5 },
            {
              kind: "AND" as const,
              of: [{ kind: "DEPTH" as const, from: 0.2, to: 0.8 }],
            },
          ],
        },
      ],
    };
    const right = {
      of: [
        { maxOffset: 0.5, kind: "LATERAL" as const },
        { to: 0.8, kind: "DEPTH" as const, from: 0.2 },
        { to: 3, from: 0, kind: "ROWS" as const },
        { to: 3, from: 0, kind: "ROWS" as const },
      ],
      kind: "AND" as const,
    };
    expect(maskCacheKey("layout", metricsVersion, left)).toEqual(
      maskCacheKey("layout", metricsVersion, right),
    );
  });

  it("hashes a preset and its expanded geometry semantics identically", () => {
    expect(
      maskCacheKey("layout", metricsVersion, { kind: "PRESET", name: "CENTER_BLOCK" }),
    ).toEqual(maskCacheKey("layout", metricsVersion, { kind: "LATERAL", maxOffset: 0.35 }));
  });
});

describe("region-qualified run starts", () => {
  it("masks strict membership before shifting, with a widened positive control", () => {
    const built = standardGrid(1, 5);
    const narrow = compileMask({ kind: "ROWS", from: 0, to: 0 }, 1, 3);
    const narrowOnFive = createBitmap(5);
    for (let index = 0; index < 3; index += 1) {
      setBit(narrowOnFive, index, 5, getBit(narrow, index, 3));
    }
    expect(
      popcount(
        regionRunStarts(
          built.availability,
          built.layout.ordinaryMask,
          built.layout,
          narrowOnFive,
          4,
          true,
        ),
        5,
      ),
    ).toBe(0);

    setBit(narrowOnFive, 3, 5);
    const widened = regionRunStarts(
      built.availability,
      built.layout.ordinaryMask,
      built.layout,
      narrowOnFive,
      4,
      true,
    );
    expect(getBit(widened, 0, 5)).toBe(true);
    expect(popcount(widened, 5)).toBe(1);
  });

  it("takes the union of both centre positions for an even run", () => {
    const region = createBitmap(8);
    setBit(region, 3, 8);
    const midpointStarts = midpointMask(region, 4, 1, 8);
    expect(Array.from({ length: 8 }, (_, index) => getBit(midpointStarts, index, 8))).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);

    const built = standardGrid(1, 8);
    const starts = regionRunStarts(
      built.availability,
      built.layout.ordinaryMask,
      built.layout,
      region,
      4,
      false,
    );
    expect(getBit(starts, 1, 8)).toBe(true);
    expect(getBit(starts, 2, 8)).toBe(true);
    expect(getBit(starts, 4, 8)).toBe(false);
  });

  it("requires an explicitly parsed groupStrict boolean", () => {
    const built = standardGrid(1, 4);
    const region = compileMask({ kind: "ALL" }, 1, 4);
    expect(() =>
      regionRunStarts(
        built.availability,
        built.layout.ordinaryMask,
        built.layout,
        region,
        2,
        undefined as unknown as boolean,
      ),
    ).toThrowError("groupStrict must be a parsed boolean");
  });
});
