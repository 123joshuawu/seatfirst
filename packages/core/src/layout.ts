import { createBitmap, setBit } from "./bitmap.js";
import { canonicalLayoutFingerprintInput, layoutFingerprint } from "./fingerprint.js";
import { SeatKindSchema, type SeatKind } from "./search-spec.js";

/**
 * The codec speaks in `Buffer`s (ADR 0032 decision 1 stores raw `Buffer` bytes in
 * `auditorium_layout.geometry`), but this package is shared with Hermes and keeps Node's
 * ambient types out of its tsconfig (architecture appendix A). This alias adopts the
 * compiling program's own global `Buffer` whenever Node types are present (server,
 * durability) and falls back to the structural minimum the codec needs otherwise — no
 * global augmentation, so Node projects keep their `Buffer` entirely untouched.
 */
type HostedBuffer = Uint8Array & { toString(encoding?: string): string };

export type Buffer = typeof globalThis extends {
  Buffer: infer Ctor extends abstract new (...args: never[]) => unknown;
}
  ? InstanceType<Ctor>
  : HostedBuffer;

type HostBufferConstructor = {
  from(input: string, encoding?: string): Buffer;
  from(input: Uint8Array): Buffer;
};

/** Runtime handle onto the host's global `Buffer`, narrowed to the construction forms used here. */
const Buffer: HostBufferConstructor = (
  globalThis as unknown as {
    Buffer: HostBufferConstructor;
  }
).Buffer;

export const SEAT_KIND_CODE: Readonly<Record<SeatKind, number>> = Object.freeze({
  NOT_A_SEAT: 0,
  STANDARD: 1,
  WHEELCHAIR: 2,
  COMPANION: 3,
  UNKNOWN: 4,
});

const SEAT_KIND_BY_CODE: readonly SeatKind[] = [
  "NOT_A_SEAT",
  "STANDARD",
  "WHEELCHAIR",
  "COMPANION",
  "UNKNOWN",
];

export interface AuditoriumLayoutGeometry {
  readonly rows: number;
  readonly columns: number;
  readonly seatKinds: Uint8Array;
  readonly tiers: readonly (string | null)[];
  readonly ordinaryMask: Uint8Array;
  readonly accessibleMask: Uint8Array;
  readonly displayMask: Uint8Array;
  readonly seatNames: Readonly<Record<number, string>> | null;
}

export interface AuditoriumLayout extends AuditoriumLayoutGeometry {
  /** Global content address: identical geometry at different theatres shares this identity. */
  readonly layoutId: string;
  readonly fingerprint: string;
}

export interface SparseLayoutCell {
  /** Provider coordinates are 1-based and are converted once by `buildAuditoriumLayout`. */
  readonly row: number;
  readonly column: number;
  readonly kind: SeatKind;
  readonly tier?: string | null;
  readonly available: boolean;
  readonly name?: string;
  readonly visible: boolean;
}

export interface SparseLayoutInput {
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly SparseLayoutCell[];
}

export type LayoutValidationErrorCode =
  "INVALID_DIMENSIONS" | "INVALID_COORDINATE" | "COORDINATE_OUT_OF_BOUNDS" | "DUPLICATE_COORDINATE";

export class LayoutValidationError extends Error {
  public constructor(
    public readonly code: LayoutValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LayoutValidationError";
  }
}

export interface BuiltAuditoriumLayout {
  readonly layout: AuditoriumLayout;
  readonly availability: Uint8Array;
  readonly unknownKindCount: number;
}

export function seatKindFromCode(code: number): SeatKind {
  const kind = SEAT_KIND_BY_CODE[code];
  if (kind === undefined) {
    throw new RangeError(`unknown SeatKind code ${code}`);
  }
  return SeatKindSchema.parse(kind);
}

/**
 * Derives the ordinary/accessible masks from raw seat-kind codes without validating them:
 * codes outside STANDARD/WHEELCHAIR/COMPANION set neither bit, so out-of-range garbage
 * encountered during decode-time reconstruction cannot throw.
 */
export function deriveKindMasks(
  seatKinds: Uint8Array,
  cellCount: number,
): { ordinaryMask: Uint8Array; accessibleMask: Uint8Array } {
  const ordinaryMask = createBitmap(cellCount);
  const accessibleMask = createBitmap(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    const code = seatKinds[index];
    if (code === SEAT_KIND_CODE.STANDARD) {
      setBit(ordinaryMask, index, cellCount);
    } else if (code === SEAT_KIND_CODE.WHEELCHAIR || code === SEAT_KIND_CODE.COMPANION) {
      setBit(accessibleMask, index, cellCount);
    }
  }
  return { ordinaryMask, accessibleMask };
}

/** Builds a dense row-major geometry from a sparse, 1-based provider boundary. */
export function buildAuditoriumLayout(input: SparseLayoutInput): BuiltAuditoriumLayout {
  if (
    !Number.isInteger(input.rows) ||
    input.rows <= 0 ||
    !Number.isInteger(input.columns) ||
    input.columns <= 0
  ) {
    throw new LayoutValidationError("INVALID_DIMENSIONS", "rows and columns must be positive");
  }

  const cellCount = input.rows * input.columns;
  const seatKinds = new Uint8Array(cellCount);
  const tiers: (string | null)[] = Array.from({ length: cellCount }, () => null);
  const displayMask = createBitmap(cellCount);
  const availability = createBitmap(cellCount);
  const seatNames: Record<number, string> = {};
  const occupied = new Set<number>();
  let unknownKindCount = 0;

  for (const cell of input.cells) {
    if (
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      cell.row <= 0 ||
      cell.column <= 0
    ) {
      throw new LayoutValidationError(
        "INVALID_COORDINATE",
        `coordinates must be positive integers: (${cell.row}, ${cell.column})`,
      );
    }
    if (cell.row > input.rows || cell.column > input.columns) {
      throw new LayoutValidationError(
        "COORDINATE_OUT_OF_BOUNDS",
        `coordinate exceeds layout bounds: (${cell.row}, ${cell.column})`,
      );
    }

    const flatIndex = (cell.row - 1) * input.columns + (cell.column - 1);
    if (occupied.has(flatIndex)) {
      throw new LayoutValidationError(
        "DUPLICATE_COORDINATE",
        `duplicate coordinate: (${cell.row}, ${cell.column})`,
      );
    }
    occupied.add(flatIndex);

    seatKinds[flatIndex] = SEAT_KIND_CODE[cell.kind];
    tiers[flatIndex] = cell.tier ?? null;
    if (cell.kind === "UNKNOWN") {
      unknownKindCount += 1;
    }
    if (cell.visible) {
      setBit(displayMask, flatIndex, cellCount);
    }
    if (cell.available) {
      setBit(availability, flatIndex, cellCount);
    }
    if (cell.name !== undefined) {
      seatNames[flatIndex] = cell.name.normalize("NFC");
    }
  }

  const { ordinaryMask, accessibleMask } = deriveKindMasks(seatKinds, cellCount);

  const geometry: AuditoriumLayoutGeometry = {
    rows: input.rows,
    columns: input.columns,
    seatKinds,
    tiers,
    ordinaryMask,
    accessibleMask,
    displayMask,
    seatNames: Object.keys(seatNames).length === 0 ? null : seatNames,
  };
  const fingerprint = layoutFingerprint(geometry);
  return {
    layout: { ...geometry, fingerprint, layoutId: fingerprint },
    availability,
    unknownKindCount,
  };
}

/** Encodes a geometry into its canonical fingerprint bytes for durable storage or transport. */
export function encodeAuditoriumLayoutGeometry(layout: AuditoriumLayoutGeometry): Buffer {
  return Buffer.from(canonicalLayoutFingerprintInput(layout), "utf8");
}

export type LayoutDecodeErrorCode =
  "UNSUPPORTED_VERSION" | "DIMENSION_MISMATCH" | "FINGERPRINT_MISMATCH";

export class LayoutDecodeError extends Error {
  public constructor(
    public readonly code: LayoutDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LayoutDecodeError";
  }
}

/** Reconstructs a geometry from canonical fingerprint bytes, verifying it against expectations. */
export function decodeAuditoriumLayoutGeometry(
  bytes: Uint8Array,
  expected: { layoutId: string; rows: number; columns: number },
): AuditoriumLayoutGeometry {
  // Malformed bytes are not one of the three semantic codes: the raw SyntaxError surfaces as-is.
  const tuple = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown[];
  if (!Array.isArray(tuple) || tuple.length !== 7) {
    throw new Error(
      `malformed layout geometry encoding: expected a 7-element tuple, got ${Array.isArray(tuple) ? tuple.length : typeof tuple}`,
    );
  }
  const [version, rows, columns, seatKindBytes, tiers, displayMaskBytes, normalizedSeatNames] =
    tuple as [number, number, number, number[], (string | null)[], number[], [number, string][]];
  if (version !== 1) {
    throw new LayoutDecodeError(
      "UNSUPPORTED_VERSION",
      `unsupported layout geometry encoding version: ${version}`,
    );
  }
  if (rows !== expected.rows || columns !== expected.columns) {
    throw new LayoutDecodeError(
      "DIMENSION_MISMATCH",
      `layout dimensions do not match expectation: (${rows}, ${columns})`,
    );
  }

  const seatKinds = Uint8Array.from(seatKindBytes);
  const displayMask = Uint8Array.from(displayMaskBytes);
  const decodedSeatNames: Record<number, string> = {};
  for (const [index, name] of normalizedSeatNames) {
    decodedSeatNames[index] = name;
  }
  const { ordinaryMask, accessibleMask } = deriveKindMasks(seatKinds, rows * columns);
  const decoded: AuditoriumLayoutGeometry = {
    rows,
    columns,
    seatKinds,
    tiers,
    ordinaryMask,
    accessibleMask,
    displayMask,
    seatNames: Object.keys(decodedSeatNames).length === 0 ? null : decodedSeatNames,
  };
  if (layoutFingerprint(decoded) !== expected.layoutId) {
    throw new LayoutDecodeError(
      "FINGERPRINT_MISMATCH",
      `decoded layout fingerprint does not match expected layoutId: ${expected.layoutId}`,
    );
  }
  return decoded;
}
