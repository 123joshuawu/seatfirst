import { describe, expect, it } from "vitest";

import {
  adjacentRunStarts,
  bitmapAnd,
  bitmapOr,
  createBitmap,
  getBit,
  openCount,
  perPositionPopcount,
  popcount,
  setBit,
} from "../src/index.js";

function bitmap(bitLength: number, indices: readonly number[]): Uint8Array {
  const result = createBitmap(bitLength);
  for (const index of indices) {
    setBit(result, index, bitLength);
  }
  return result;
}

describe("bitmap convention and folds", () => {
  it("pins flat indices to LSB-first byte positions", () => {
    const bits = bitmap(10, [0, 3, 8]);
    expect(Array.from(bits)).toEqual([0b00001001, 0b00000001]);
    expect(getBit(bits, 3, 10)).toBe(true);
    expect(getBit(bits, 4, 10)).toBe(false);
  });

  it("computes hand-counted union, intersection, and open count", () => {
    const first = bitmap(10, [0, 1, 4, 9]);
    const second = bitmap(10, [1, 2, 4, 8]);
    expect(Array.from(bitmapOr([first, second], 10))).toEqual([0b00010111, 0b00000011]);
    expect(Array.from(bitmapAnd([first, second], 10))).toEqual([0b00010010, 0]);
    expect(popcount(first, 10)).toBe(4);
    expect(openCount(first, bitmap(10, [0, 4, 5]), 10)).toBe(2);
  });

  it("computes the per-position heatmap from a hand-counted stack", () => {
    expect(
      Array.from(
        perPositionPopcount([bitmap(5, [0, 1, 4]), bitmap(5, [1, 2, 4]), bitmap(5, [1, 3])], 5),
      ),
    ).toEqual([1, 3, 1, 1, 2]);
  });
});

describe("adjacentRunStarts", () => {
  it("finds exact four-seat starts on each side of a NOT_A_SEAT aisle", () => {
    // One 10-wide row: columns 0..3 and 5..9 are ordinary; column 4 is the aisle.
    const ordinary = bitmap(10, [0, 1, 2, 3, 5, 6, 7, 8, 9]);
    const available = bitmap(10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const starts = adjacentRunStarts(available, ordinary, 1, 10, 4);
    expect(Array.from({ length: 10 }, (_, index) => getBit(starts, index, 10))).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("does not allow a run to wrap between rows", () => {
    const ordinary = bitmap(8, [2, 3, 4, 5]);
    expect(popcount(adjacentRunStarts(ordinary, ordinary, 2, 4, 4), 8)).toBe(0);
  });

  it("enforces logical length and canonicalizes dirty padding at fold/count boundaries", () => {
    const dirty = new Uint8Array([0b00000001, 0b11111100]);
    expect(() => getBit(dirty, 0, 10)).toThrowError("bitmap padding bits must be zero");
    expect(() => getBit(new Uint8Array(2), 10, 10)).toThrowError("out of bounds");
    expect(() => setBit(new Uint8Array(2), 10, 10)).toThrowError("out of bounds");
    expect(popcount(dirty, 10)).toBe(1);
    expect(Array.from(bitmapOr([dirty], 10))).toEqual([1, 0]);
    expect(Array.from(bitmapAnd([dirty, new Uint8Array([0xff, 0xff])], 10))).toEqual([1, 0]);
    const normalizedByWrite = dirty.slice();
    setBit(normalizedByWrite, 1, 10);
    expect(Array.from(normalizedByWrite)).toEqual([3, 0]);
  });
});
