import { describe, expect, it } from "vitest";

import {
  buildAuditoriumLayout,
  decodeAuditoriumLayoutGeometry,
  encodeAuditoriumLayoutGeometry,
  getBit,
  seatKindFromCode,
  type LayoutDecodeError,
  type LayoutValidationError,
  type SparseLayoutInput,
} from "../src/index.js";

// Mirrors layout.ts's narrowed host-Buffer shim: the shared tsconfig carries no Node types.
const Buffer: {
  from(input: string, encoding?: string): Uint8Array & { toString(encoding?: string): string };
  from(input: Uint8Array): Uint8Array & { toString(encoding?: string): string };
} = (
  globalThis as unknown as {
    Buffer: {
      from(
        input: string,
        encoding?: string,
      ): Uint8Array & {
        toString(encoding?: string): string;
      };
      from(input: Uint8Array): Uint8Array & { toString(encoding?: string): string };
    };
  }
).Buffer;

function input(availability = true): SparseLayoutInput {
  return {
    rows: 2,
    columns: 3,
    cells: [
      {
        row: 1,
        column: 1,
        kind: "STANDARD",
        tier: "A",
        available: availability,
        name: "A1",
        visible: true,
      },
      {
        row: 1,
        column: 3,
        kind: "UNKNOWN",
        available: false,
        name: "A3",
        visible: true,
      },
      {
        row: 2,
        column: 1,
        kind: "WHEELCHAIR",
        available: true,
        visible: true,
      },
      {
        row: 2,
        column: 2,
        kind: "COMPANION",
        available: true,
        visible: true,
      },
    ],
  };
}

describe("buildAuditoriumLayout", () => {
  it("converts 1-based sparse coordinates exactly once", () => {
    const built = buildAuditoriumLayout(input());
    expect(seatKindFromCode(built.layout.seatKinds[0] ?? -1)).toBe("STANDARD");
    expect(built.layout.seatKinds[1]).toBe(0);
    expect(built.layout.seatNames?.[0]).toBe("A1");
    expect(getBit(built.layout.ordinaryMask, 0, 6)).toBe(true);
    expect(getBit(built.layout.displayMask, 1, 6)).toBe(false);
    expect(getBit(built.layout.accessibleMask, 3, 6)).toBe(true);
    expect(getBit(built.layout.accessibleMask, 4, 6)).toBe(true);
  });

  it("keeps visibility, availability, and kind orthogonal", () => {
    const built = buildAuditoriumLayout({
      rows: 1,
      columns: 2,
      cells: [
        { row: 1, column: 1, kind: "STANDARD", available: false, visible: true },
        { row: 1, column: 2, kind: "STANDARD", available: true, visible: false },
      ],
    });
    expect(getBit(built.layout.ordinaryMask, 0, 2)).toBe(true);
    expect(getBit(built.availability, 0, 2)).toBe(false);
    expect(getBit(built.layout.displayMask, 0, 2)).toBe(true);
    expect(getBit(built.layout.ordinaryMask, 1, 2)).toBe(true);
    expect(getBit(built.availability, 1, 2)).toBe(true);
    expect(getBit(built.layout.displayMask, 1, 2)).toBe(false);
  });

  it("retains unknown kinds as visible, non-recommendable telemetry", () => {
    const built = buildAuditoriumLayout(input());
    expect(built.unknownKindCount).toBe(1);
    expect(seatKindFromCode(built.layout.seatKinds[2] ?? -1)).toBe("UNKNOWN");
    expect(getBit(built.layout.displayMask, 2, 6)).toBe(true);
    expect(getBit(built.layout.ordinaryMask, 2, 6)).toBe(false);
  });

  it("rejects duplicate 1-based coordinates with a typed error", () => {
    expect(() =>
      buildAuditoriumLayout({
        rows: 1,
        columns: 1,
        cells: [
          { row: 1, column: 1, kind: "STANDARD", available: true, visible: true },
          { row: 1, column: 1, kind: "STANDARD", available: false, visible: true },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<LayoutValidationError>>({ code: "DUPLICATE_COORDINATE" }),
    );
  });

  it("rejects non-positive and out-of-bounds coordinates", () => {
    expect(() =>
      buildAuditoriumLayout({
        rows: 1,
        columns: 1,
        cells: [{ row: 0, column: 1, kind: "STANDARD", available: true, visible: true }],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_COORDINATE" }));
    expect(() =>
      buildAuditoriumLayout({
        rows: 1,
        columns: 1,
        cells: [{ row: 1, column: 2, kind: "STANDARD", available: true, visible: true }],
      }),
    ).toThrowError(expect.objectContaining({ code: "COORDINATE_OUT_OF_BOUNDS" }));
  });
});

describe("auditoriumLayoutGeometry codec", () => {
  function expectedFor(built: ReturnType<typeof buildAuditoriumLayout>) {
    return {
      layoutId: built.layout.layoutId,
      rows: built.layout.rows,
      columns: built.layout.columns,
    };
  }

  it("round-trips a multi-kind layout byte-for-byte", () => {
    const built = buildAuditoriumLayout(input());
    const decoded = decodeAuditoriumLayoutGeometry(
      encodeAuditoriumLayoutGeometry(built.layout),
      expectedFor(built),
    );
    expect(decoded.rows).toBe(built.layout.rows);
    expect(decoded.columns).toBe(built.layout.columns);
    expect(decoded.seatKinds).toEqual(built.layout.seatKinds);
    expect(decoded.tiers).toEqual(built.layout.tiers);
    expect(decoded.ordinaryMask).toEqual(built.layout.ordinaryMask);
    expect(decoded.accessibleMask).toEqual(built.layout.accessibleMask);
    expect(decoded.displayMask).toEqual(built.layout.displayMask);
    expect(decoded.seatNames).toEqual(built.layout.seatNames);
  });

  it("rejects tampered seat-kind bytes with FINGERPRINT_MISMATCH", () => {
    const built = buildAuditoriumLayout(input());
    const tuple = JSON.parse(
      Buffer.from(encodeAuditoriumLayoutGeometry(built.layout)).toString("utf8"),
    ) as [number, number, number, number[], ...unknown[]];
    tuple[3][1] = 9; // flip one NOT_A_SEAT code inside seatKindBytes
    const tampered = Buffer.from(JSON.stringify(tuple), "utf8");
    expect(() => decodeAuditoriumLayoutGeometry(tampered, expectedFor(built))).toThrowError(
      expect.objectContaining<Partial<LayoutDecodeError>>({ code: "FINGERPRINT_MISMATCH" }),
    );
  });

  it("rejects mismatched expected dimensions with DIMENSION_MISMATCH", () => {
    const built = buildAuditoriumLayout(input());
    expect(() =>
      decodeAuditoriumLayoutGeometry(encodeAuditoriumLayoutGeometry(built.layout), {
        ...expectedFor(built),
        rows: built.layout.rows + 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<LayoutDecodeError>>({ code: "DIMENSION_MISMATCH" }),
    );
  });

  it("rejects rewritten versions with UNSUPPORTED_VERSION", () => {
    const built = buildAuditoriumLayout(input());
    const tuple = JSON.parse(
      Buffer.from(encodeAuditoriumLayoutGeometry(built.layout)).toString("utf8"),
    ) as [number, ...unknown[]];
    tuple[0] = 2;
    const tampered = Buffer.from(JSON.stringify(tuple), "utf8");
    expect(() => decodeAuditoriumLayoutGeometry(tampered, expectedFor(built))).toThrowError(
      expect.objectContaining<Partial<LayoutDecodeError>>({ code: "UNSUPPORTED_VERSION" }),
    );
  });

  it("rejects a wrong-length tuple with a clear malformed-encoding error", () => {
    const built = buildAuditoriumLayout(input());
    const malformed = Buffer.from(JSON.stringify([1, built.layout.rows]), "utf8");
    expect(() => decodeAuditoriumLayoutGeometry(malformed, expectedFor(built))).toThrowError(
      /malformed layout geometry encoding: expected a 7-element tuple, got 2/,
    );
  });
});
