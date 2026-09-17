import {
  adjacentRunStarts,
  bitmapAnd,
  bitmapNot,
  bitmapOr,
  createBitmap,
  getBit,
  setBit,
} from "./bitmap.js";
import { seatKindFromCode, type AuditoriumLayoutGeometry } from "./layout.js";
import { metricsVersion, type SeatMetrics } from "./metrics.js";
import { SeatRegionSchema, type PresetName, type SeatRegion } from "./search-spec.js";
import { sha256 } from "./sha256.js";

export interface RegionCompileSuccess {
  readonly ok: true;
  readonly mask: Uint8Array;
}

export interface RegionCompileUnsupported {
  readonly ok: false;
  readonly error: {
    readonly code: "UNSUPPORTED_SCORE_REGION";
    readonly region: Extract<SeatRegion, { readonly kind: "SCORE" }>;
  };
}

export type RegionCompileResult = RegionCompileSuccess | RegionCompileUnsupported;

/** Preset trees from the query design; SCORE remains a reserved, unsupported compiler branch. */
export function presetRegion(name: PresetName): SeatRegion {
  switch (name) {
    case "SWEET_SPOT":
      return { kind: "SCORE", min: 0.75 };
    case "CENTER_BLOCK":
      return { kind: "LATERAL", maxOffset: 0.35 };
    case "BACK_CENTER":
      return {
        kind: "AND",
        of: [
          { kind: "DEPTH", from: 0.6, to: 1 },
          { kind: "LATERAL", maxOffset: 0.4 },
        ],
      };
    case "AVOID_FRONT":
      return { kind: "DEPTH", from: 0.25, to: 1 };
    case "LEGROOM":
      return { kind: "AISLE", want: "ADJACENT" };
    case "OUTER_RING":
      return { kind: "NOT", of: { kind: "LATERAL", maxOffset: 0.35 } };
  }
}

function assertMetrics(layout: AuditoriumLayoutGeometry, metrics: SeatMetrics): number {
  const count = layout.rows * layout.columns;
  if (
    metrics.seatIndexInRow.length !== count ||
    metrics.depth.length !== count ||
    metrics.lateral.length !== count ||
    metrics.aisleDistance.length !== count
  ) {
    throw new RangeError("metric lengths do not match layout geometry");
  }
  return count;
}

function allSeatMask(layout: AuditoriumLayoutGeometry, metrics: SeatMetrics): Uint8Array {
  const count = assertMetrics(layout, metrics);
  const mask = createBitmap(count);
  for (let index = 0; index < count; index += 1) {
    if ((metrics.seatIndexInRow[index] ?? -1) >= 0) {
      setBit(mask, index, count);
    }
  }
  return mask;
}

function predicateMask(
  layout: AuditoriumLayoutGeometry,
  metrics: SeatMetrics,
  predicate: (index: number) => boolean,
): Uint8Array {
  const all = allSeatMask(layout, metrics);
  const result = createBitmap(layout.rows * layout.columns);
  for (let index = 0; index < layout.rows * layout.columns; index += 1) {
    if (getBit(all, index, layout.rows * layout.columns) && predicate(index)) {
      setBit(result, index, layout.rows * layout.columns);
    }
  }
  return result;
}

export function compileRegion(
  layout: AuditoriumLayoutGeometry,
  metrics: SeatMetrics,
  regionInput: SeatRegion,
): RegionCompileResult {
  const region = SeatRegionSchema.parse(regionInput);
  const bitLength = assertMetrics(layout, metrics);
  switch (region.kind) {
    case "ALL":
      return { ok: true, mask: allSeatMask(layout, metrics) };
    case "PRESET":
      return compileRegion(layout, metrics, presetRegion(region.name));
    case "DEPTH":
      return {
        ok: true,
        mask: predicateMask(
          layout,
          metrics,
          (index) =>
            (metrics.depth[index] ?? -1) >= region.from &&
            (metrics.depth[index] ?? -1) <= region.to,
        ),
      };
    case "LATERAL":
      return {
        ok: true,
        mask: predicateMask(
          layout,
          metrics,
          (index) => Math.abs(metrics.lateral[index] ?? Number.NaN) <= region.maxOffset,
        ),
      };
    case "AISLE":
      return {
        ok: true,
        mask: predicateMask(layout, metrics, (index) =>
          region.want === "ADJACENT"
            ? metrics.aisleDistance[index] === 0
            : (metrics.aisleDistance[index] ?? -1) > 0,
        ),
      };
    case "SEAT_TYPE": {
      const included = new Set(region.include);
      return {
        ok: true,
        mask: predicateMask(layout, metrics, (index) =>
          included.has(seatKindFromCode(layout.seatKinds[index] ?? -1)),
        ),
      };
    }
    case "SCORE":
      return { ok: false, error: { code: "UNSUPPORTED_SCORE_REGION", region } };
    case "ROWS":
      return {
        ok: true,
        mask: predicateMask(layout, metrics, (index) => {
          const row = Math.floor(index / layout.columns);
          return row >= region.from && row <= region.to;
        }),
      };
    case "AND": {
      const masks: Uint8Array[] = [];
      for (const child of region.of) {
        const compiled = compileRegion(layout, metrics, child);
        if (!compiled.ok) {
          return compiled;
        }
        masks.push(compiled.mask);
      }
      return { ok: true, mask: bitmapAnd(masks, bitLength) };
    }
    case "OR": {
      const masks: Uint8Array[] = [];
      for (const child of region.of) {
        const compiled = compileRegion(layout, metrics, child);
        if (!compiled.ok) {
          return compiled;
        }
        masks.push(compiled.mask);
      }
      return { ok: true, mask: bitmapOr(masks, bitLength) };
    }
    case "NOT": {
      const compiled = compileRegion(layout, metrics, region.of);
      if (!compiled.ok) {
        return compiled;
      }
      return {
        ok: true,
        mask: bitmapAnd(
          [bitmapNot(compiled.mask, bitLength), allSeatMask(layout, metrics)],
          bitLength,
        ),
      };
    }
  }
}

type CanonicalValue =
  null | boolean | number | string | readonly CanonicalValue[] | CanonicalObject;
type CanonicalObject = { readonly [key: string]: CanonicalValue | undefined };

function isCanonicalArray(value: CanonicalValue): value is readonly CanonicalValue[] {
  return Array.isArray(value);
}

function compareLexicographically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (isCanonicalArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter((entry) => entry[1] !== undefined && entry[1] !== null)
    .sort(([left], [right]) => compareLexicographically(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item as CanonicalValue)}`)
    .join(",")}}`;
}

function canonicalRegionValue(regionInput: SeatRegion): CanonicalValue {
  const region =
    regionInput.kind === "PRESET"
      ? SeatRegionSchema.parse(presetRegion(regionInput.name))
      : regionInput;
  if (region.kind === "AND" || region.kind === "OR") {
    const flattened: CanonicalValue[] = [];
    for (const child of region.of) {
      const normalized = canonicalRegionValue(child);
      if (
        typeof normalized === "object" &&
        normalized !== null &&
        !isCanonicalArray(normalized) &&
        normalized.kind === region.kind &&
        normalized.of !== undefined &&
        isCanonicalArray(normalized.of)
      ) {
        flattened.push(...normalized.of);
      } else {
        flattened.push(normalized);
      }
    }
    const unique = new Map<string, CanonicalValue>();
    for (const normalized of flattened) {
      unique.set(canonicalJson(normalized), normalized);
    }
    const children = Array.from(unique.entries())
      .sort(([left], [right]) => compareLexicographically(left, right))
      .map((entry) => entry[1]);
    return children.length === 1
      ? (children[0] as CanonicalValue)
      : { kind: region.kind, of: children };
  }
  if (region.kind === "NOT") {
    return { kind: "NOT", of: canonicalRegionValue(region.of) };
  }
  if (region.kind === "SEAT_TYPE") {
    return { kind: "SEAT_TYPE", include: Array.from(new Set(region.include)).sort() };
  }
  return region;
}

/** Canonical semantic bytes used by the load-bearing region component of mask cache keys. */
export function canonicalizeRegion(regionInput: SeatRegion): string {
  const region = SeatRegionSchema.parse(regionInput);
  return canonicalJson(canonicalRegionValue(region));
}

export function regionHash(region: SeatRegion): string {
  return sha256(canonicalizeRegion(region));
}

/**
 * The region hash is load-bearing: omitting it lets searches with different preferences reuse the
 * wrong mask. The version is E2's geometry `metricsVersion`, not a scoring-version reservation.
 */
export function maskCacheKey(
  layoutId: string,
  version: typeof metricsVersion,
  region: SeatRegion,
): readonly [string, typeof metricsVersion, string] {
  if (layoutId.length === 0) {
    throw new RangeError("layoutId must not be empty");
  }
  if (version !== metricsVersion) {
    throw new RangeError("mask cache key version does not match current metricsVersion");
  }
  return [layoutId, version, regionHash(region)];
}

/**
 * Converts qualifying centre seats into candidate run starts. For an even party both centre
 * positions qualify the run; neither is rounded away.
 */
export function midpointMask(
  regionMask: Uint8Array,
  count: number,
  rows: number,
  columns: number,
): Uint8Array {
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError("count must be a positive integer");
  }
  const bitLength = rows * columns;
  if (regionMask.length !== Math.ceil(bitLength / 8)) {
    throw new RangeError("region mask length does not match layout dimensions");
  }
  const result = createBitmap(bitLength);
  const centerOffsets = count % 2 === 0 ? [count / 2 - 1, count / 2] : [Math.floor(count / 2)];
  for (let row = 0; row < rows; row += 1) {
    for (let startColumn = 0; startColumn + count <= columns; startColumn += 1) {
      if (
        centerOffsets.some((offset) =>
          getBit(regionMask, row * columns + startColumn + offset, bitLength),
        )
      ) {
        setBit(result, row * columns + startColumn, bitLength);
      }
    }
  }
  return result;
}

/**
 * Applies strict region masks before adjacency; non-strict regions qualify either midpoint.
 *
 * The candidate pool is a caller-supplied mask, not a hardcoded `layout.ordinaryMask`: ADR
 * 0011's accessibility pool-filter swaps it for `layout.accessibleMask` and runs the exact
 * same single pipeline — one function whose pool varies, never two
 * (`docs/adr/0011-accessibility-ranking-policy.md:42-52`; E5.2).
 */
export function regionRunStarts(
  availability: Uint8Array,
  poolMask: Uint8Array,
  layout: AuditoriumLayoutGeometry,
  regionMask: Uint8Array,
  count: number,
  groupStrict: boolean,
): Uint8Array {
  if (typeof groupStrict !== "boolean") {
    throw new TypeError("groupStrict must be a parsed boolean");
  }
  const bitLength = layout.rows * layout.columns;
  const base = groupStrict
    ? bitmapAnd([availability, poolMask, regionMask], bitLength)
    : bitmapAnd([availability, poolMask], bitLength);
  const starts = adjacentRunStarts(base, poolMask, layout.rows, layout.columns, count);
  return groupStrict
    ? starts
    : bitmapAnd([starts, midpointMask(regionMask, count, layout.rows, layout.columns)], bitLength);
}
