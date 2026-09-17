import { describe, expect, it } from "vitest";

import {
  buildAuditoriumLayout,
  createBitmap,
  layoutFingerprint,
  setBit,
  type AuditoriumLayoutGeometry,
} from "../src/index.js";

function geometry(): AuditoriumLayoutGeometry {
  const ordinaryMask = createBitmap(4);
  const displayMask = createBitmap(4);
  setBit(ordinaryMask, 0, 4);
  setBit(ordinaryMask, 1, 4);
  setBit(displayMask, 0, 4);
  setBit(displayMask, 1, 4);
  return {
    rows: 2,
    columns: 2,
    seatKinds: new Uint8Array([1, 1, 0, 0]),
    tiers: ["A", "A", null, null],
    ordinaryMask,
    accessibleMask: createBitmap(4),
    displayMask,
    seatNames: { 0: "A1", 1: "A2" },
  };
}

describe("layoutFingerprint", () => {
  it("excludes availability", () => {
    const open = buildAuditoriumLayout({
      rows: 1,
      columns: 1,
      cells: [{ row: 1, column: 1, kind: "STANDARD", visible: true, available: true }],
    });
    const closed = buildAuditoriumLayout({
      rows: 1,
      columns: 1,
      cells: [{ row: 1, column: 1, kind: "STANDARD", visible: true, available: false }],
    });
    expect(open.layout.fingerprint).toBe(closed.layout.fingerprint);
  });

  it("changes when rows change", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, rows: 1 })).not.toBe(layoutFingerprint(base));
  });

  it("changes when columns change", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, columns: 4 })).not.toBe(layoutFingerprint(base));
  });

  it("changes when seatKinds change", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, seatKinds: new Uint8Array([1, 4, 0, 0]) })).not.toBe(
      layoutFingerprint(base),
    );
  });

  it("changes when tiers change", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, tiers: ["A", "B", null, null] })).not.toBe(
      layoutFingerprint(base),
    );
  });

  it("changes when displayMask changes", () => {
    const base = geometry();
    const changed = base.displayMask.slice();
    setBit(changed, 2, 4);
    expect(layoutFingerprint({ ...base, displayMask: changed })).not.toBe(layoutFingerprint(base));
  });

  it("changes when normalizedSeatNames change", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, seatNames: { 0: "A1", 1: "A3" } })).not.toBe(
      layoutFingerprint(base),
    );
  });

  it("normalizes Unicode names and numeric key order canonically", () => {
    const base = geometry();
    expect(layoutFingerprint({ ...base, seatNames: { 1: "A2", 0: "A\u0301" } })).toBe(
      layoutFingerprint({ ...base, seatNames: { 0: "Á", 1: "A2" } }),
    );
  });

  it("canonicalizes padding-only display-mask differences", () => {
    const clean = geometry();
    const dirtyDisplayMask = new Uint8Array([0b11110011]);
    expect(layoutFingerprint({ ...clean, displayMask: dirtyDisplayMask })).toBe(
      layoutFingerprint(clean),
    );
  });

  it("rejects a display mask whose byte length does not match the logical layout", () => {
    const base = geometry();
    expect(() => layoutFingerprint({ ...base, displayMask: new Uint8Array(2) })).toThrowError(
      "bitmap byte length does not match bitLength",
    );
  });

  it("pins the canonical serialization with a golden fingerprint", () => {
    // Cache canary: update only for an intentional fingerprint serialization version change.
    expect(layoutFingerprint(geometry())).toBe(
      "75b5083ac36b6b27764890616a7abdbeeede3cb8fbb3324d7a385c80d6d7e091",
    );
  });
});
