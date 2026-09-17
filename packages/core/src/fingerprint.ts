import { sha256 } from "./sha256.js";
import { canonicalizeBitmap } from "./bitmap.js";

import type { AuditoriumLayoutGeometry } from "./layout.js";

/**
 * Fingerprint serialization v1 is UTF-8 JSON of this fixed-order tuple:
 * `[1, rows, columns, seatKindBytes, tiers, displayMaskBytes, normalizedSeatNames]`.
 * Byte arrays are decimal arrays. Tiers retain per-cell nulls. Seat-name entries are sorted by
 * numeric flat index, names are Unicode NFC, and absence is `[]`. Availability and derived masks
 * are excluded. Any change to these bytes intentionally creates a new global layout identity.
 */
export function canonicalLayoutFingerprintInput(layout: AuditoriumLayoutGeometry): string {
  const bitLength = layout.rows * layout.columns;
  const normalizedSeatNames = Object.entries(layout.seatNames ?? {})
    .map(([index, name]) => [Number(index), name.normalize("NFC")] as const)
    .sort(([left], [right]) => left - right);
  return JSON.stringify([
    1,
    layout.rows,
    layout.columns,
    Array.from(layout.seatKinds),
    layout.tiers,
    Array.from(canonicalizeBitmap(layout.displayMask, bitLength)),
    normalizedSeatNames,
  ]);
}

export function layoutFingerprint(layout: AuditoriumLayoutGeometry): string {
  return sha256(canonicalLayoutFingerprintInput(layout));
}
