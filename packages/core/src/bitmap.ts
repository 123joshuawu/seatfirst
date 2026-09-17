/**
 * Core bitmaps are LSB-first within each byte: flat index `i` is bit `(i & 7)` of byte
 * `(i >>> 3)`. Increasing a row-major column therefore increases the bit index, and a logical
 * right shift moves a later seat onto an earlier candidate start for adjacency intersection.
 */

function requiredByteLength(bitLength: number): number {
  if (!Number.isInteger(bitLength) || bitLength < 0) {
    throw new RangeError("bitLength must be a non-negative integer");
  }
  return Math.ceil(bitLength / 8);
}

function assertBitmapLength(bitmap: Uint8Array, bitLength: number): void {
  if (bitmap.length !== requiredByteLength(bitLength)) {
    throw new RangeError("bitmap byte length does not match bitLength");
  }
}

function tailMask(bitLength: number): number {
  const usedBits = bitLength % 8;
  return usedBits === 0 ? 0xff : (1 << usedBits) - 1;
}

function hasDirtyTail(bitmap: Uint8Array, bitLength: number): boolean {
  if (bitmap.length === 0 || bitLength % 8 === 0) {
    return false;
  }
  return ((bitmap[bitmap.length - 1] ?? 0) & ~tailMask(bitLength)) !== 0;
}

/** Returns an exact-length copy whose padding bits are canonical zeroes. */
export function canonicalizeBitmap(bitmap: Uint8Array, bitLength: number): Uint8Array {
  assertBitmapLength(bitmap, bitLength);
  const result = bitmap.slice();
  if (result.length > 0) {
    const lastIndex = result.length - 1;
    result[lastIndex] = (result[lastIndex] ?? 0) & tailMask(bitLength);
  }
  return result;
}

export function createBitmap(bitLength: number): Uint8Array {
  return new Uint8Array(requiredByteLength(bitLength));
}

export function getBit(bitmap: Uint8Array, index: number, bitLength: number): boolean {
  assertBitmapLength(bitmap, bitLength);
  if (hasDirtyTail(bitmap, bitLength)) {
    throw new RangeError("bitmap padding bits must be zero");
  }
  if (!Number.isInteger(index) || index < 0 || index >= bitLength) {
    throw new RangeError("bitmap index is out of bounds");
  }
  return ((bitmap[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

export function setBit(bitmap: Uint8Array, index: number, bitLength: number, value = true): void {
  assertBitmapLength(bitmap, bitLength);
  if (!Number.isInteger(index) || index < 0 || index >= bitLength) {
    throw new RangeError("bitmap index is out of bounds");
  }
  if (bitmap.length > 0) {
    const lastIndex = bitmap.length - 1;
    bitmap[lastIndex] = (bitmap[lastIndex] ?? 0) & tailMask(bitLength);
  }
  const byteIndex = index >>> 3;
  const bit = 1 << (index & 7);
  bitmap[byteIndex] = value ? (bitmap[byteIndex] ?? 0) | bit : (bitmap[byteIndex] ?? 0) & ~bit;
}

export function bitmapOr(bitmaps: readonly Uint8Array[], bitLength: number): Uint8Array {
  const result = createBitmap(bitLength);
  for (const bitmap of bitmaps) {
    assertBitmapLength(bitmap, bitLength);
    for (let byteIndex = 0; byteIndex < result.length; byteIndex += 1) {
      result[byteIndex] = (result[byteIndex] ?? 0) | (bitmap[byteIndex] ?? 0);
    }
  }
  return canonicalizeBitmap(result, bitLength);
}

export function bitmapAnd(bitmaps: readonly Uint8Array[], bitLength: number): Uint8Array {
  if (bitmaps.length === 0) {
    throw new RangeError("bitmapAnd requires at least one bitmap");
  }
  const first = bitmaps[0];
  if (first === undefined) {
    throw new RangeError("bitmapAnd requires at least one bitmap");
  }
  assertBitmapLength(first, bitLength);
  const result = first.slice();
  for (const bitmap of bitmaps.slice(1)) {
    assertBitmapLength(bitmap, bitLength);
    for (let byteIndex = 0; byteIndex < result.length; byteIndex += 1) {
      result[byteIndex] = (result[byteIndex] ?? 0) & (bitmap[byteIndex] ?? 0);
    }
  }
  return canonicalizeBitmap(result, bitLength);
}

export function bitmapNot(bitmap: Uint8Array, bitLength: number): Uint8Array {
  assertBitmapLength(bitmap, bitLength);
  return canonicalizeBitmap(
    bitmap.map((byte) => ~byte),
    bitLength,
  );
}

export function popcount(bitmap: Uint8Array, bitLength: number): number {
  const canonical = canonicalizeBitmap(bitmap, bitLength);
  let count = 0;
  for (const byte of canonical) {
    let value = byte;
    while (value !== 0) {
      value &= value - 1;
      count += 1;
    }
  }
  return count;
}

export function openCount(availability: Uint8Array, mask: Uint8Array, bitLength: number): number {
  return popcount(bitmapAnd([availability, mask], bitLength), bitLength);
}

export function perPositionPopcount(
  bitmaps: readonly Uint8Array[],
  bitLength: number,
): Uint32Array {
  const canonical = bitmaps.map((bitmap) => canonicalizeBitmap(bitmap, bitLength));
  const counts = new Uint32Array(bitLength);
  for (let index = 0; index < bitLength; index += 1) {
    for (const bitmap of canonical) {
      if (getBit(bitmap, index, bitLength)) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function shiftRight(bitmap: Uint8Array, amount: number, bitLength: number): Uint8Array {
  const result = createBitmap(bitLength);
  for (let index = 0; index + amount < bitLength; index += 1) {
    if (getBit(bitmap, index + amount, bitLength)) {
      setBit(result, index, bitLength);
    }
  }
  return result;
}

/** Remaining set bits are the row-major start positions of `count` adjacent ordinary seats. */
export function adjacentRunStarts(
  availability: Uint8Array,
  ordinaryMask: Uint8Array,
  rows: number,
  columns: number,
  count: number,
): Uint8Array {
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(columns) || columns <= 0) {
    throw new RangeError("rows and columns must be positive integers");
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError("count must be a positive integer");
  }
  const bitLength = rows * columns;
  let runs = bitmapAnd([availability, ordinaryMask], bitLength);
  for (let offset = 1; offset < count; offset += 1) {
    runs = bitmapAnd([runs, shiftRight(runs, 1, bitLength)], bitLength);
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (column + count > columns) {
        setBit(runs, row * columns + column, bitLength, false);
      }
    }
  }
  return runs;
}
