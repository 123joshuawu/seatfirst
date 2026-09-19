/**
 * S31.3 — the RUN parse seam. Dispatches on the run key's kind to the settled P5 parsers
 * (`parseSeats` / `parseShowtimes`) and translates their results into the actor's closed
 * `ParseResult` union. Pure: no I/O, no pool/redis — the only persisted state read is the
 * already-fetched `runKey.recheckPlacement` geometry for the RECHECK verdict (S31.4/D1).
 *
 * S31.5 — every thrown error is mapped to `{ ok: false, cause }`, never allowed to leak an
 * untyped throw into the actor: a `ProviderError` with code `UPSTREAM_CHANGED` → the S8.15
 * `PARSER_SCHEMA_INCOMPATIBLE` path; anything else → its message.
 */
import { buildAuditoriumLayout, getBit, parseNamespacedId, popcount } from "@seatfirst/core";
import {
  parseSeats,
  parseShowtimes,
  ProviderError,
  attachUpstreamChangedDiagnostic,
  getUpstreamChangedDiagnostic,
} from "@seatfirst/providers";

import type { ParseResult, ProviderFetchActorDeps } from "./provider-fetch-actor.js";

/** The dense 0-based geometry the recheck verdict locates (D1/S31.4). */
interface RecheckGeometry {
  readonly row: number;
  readonly startCol: number;
  readonly rowSpan: number;
  readonly count: number;
}

/**
 * S31.2/S31.3 — the seat page's numeric AMC showtime id, extracted from the namespaced
 * `showtimeId` with `parseNamespacedId` — the same derivation the provider boundary uses
 * (`packages/providers/src/amc/provider.ts:85-110`). Throws on a null/malformed id; callers
 * map that throw to a parse failure rather than navigating.
 */
export function parseNumericShowtimeId(showtimeId: string | null): number {
  if (showtimeId === null) {
    throw new Error("run key carries no showtime id for a seat route");
  }
  const parsed = parseNamespacedId(showtimeId);
  if (!parsed.ok || parsed.value.kind !== "showtime") {
    throw new Error(`invalid namespaced showtime id: ${showtimeId}`);
  }
  if (!/^\d+$/.test(parsed.value.raw)) {
    throw new Error(`invalid showtime id format: ${showtimeId}`);
  }
  const numericId = parseInt(parsed.value.raw, 10);
  if (!Number.isSafeInteger(numericId)) {
    throw new Error(`invalid showtime id magnitude: ${showtimeId}`);
  }
  return numericId;
}

export const parseObservation: ProviderFetchActorDeps["parseObservation"] = (
  payload,
  runKey,
): Promise<ParseResult> => {
  const observationTime = new Date();
  const requestUrl = `${payload.finalUrl.origin}${payload.finalUrl.pathname}`;
  try {
    switch (runKey.kind) {
      case "SHOWTIME_FETCH": {
        const numericId = parseNumericShowtimeId(runKey.showtimeId);
        const result = parseSeats(payload.documentHtml, observationTime, requestUrl, numericId);
        const built = buildAuditoriumLayout(result.grid);
        return Promise.resolve({
          ok: true,
          kind: "SHOWTIME_FETCH",
          bitmap: built.availability,
          freeCount: popcount(built.availability, built.layout.rows * built.layout.columns),
          layout: built.layout,
          minPrice: result.minPrice,
          priceBasis: result.priceBasis,
        });
      }
      case "SCHEDULE_RESOLUTION": {
        const performances = parseShowtimes(payload.documentHtml, observationTime, requestUrl);
        return Promise.resolve({
          ok: true,
          kind: "SCHEDULE_RESOLUTION",
          performances: performances.map((performance) => ({
            showtimeId: performance.showtimeId,
            startsAt: performance.showDateTimeUtc,
            movieId: performance.movieId,
            movieTitle: performance.movieTitle,
            auditorium: performance.auditorium,
            utcOffset: performance.utcOffset,
            runtimeMinutes: performance.runtimeMinutes,
            status: performance.status,
            attributes: performance.attributes,
            formatCode: performance.formatCode,
            deepLinkUrl: performance.deepLinkUrl,
            providerMeta: performance.providerMeta,
          })),
        });
      }
      case "RECHECK": {
        const numericId = parseNumericShowtimeId(runKey.showtimeId);
        const result = parseSeats(payload.documentHtml, observationTime, requestUrl, numericId);
        const built = buildAuditoriumLayout(result.grid);
        return Promise.resolve({
          ok: true,
          kind: "RECHECK",
          placementAvailable: computePlacementAvailable(
            runKey.recheckPlacement,
            built.layout.rows,
            built.layout.columns,
            built.availability,
          ),
        });
      }
      default: {
        const never: never = runKey.kind;
        throw new Error(`unhandled run kind: ${String(never)}`);
      }
    }
  } catch (error) {
    if (error instanceof ProviderError && error.code === "UPSTREAM_CHANGED") {
      const failure = { ok: false as const, cause: "PARSER_SCHEMA_INCOMPATIBLE" as const };
      // Forward the parse layer's raw capture side channel (non-enumerable `diagnostic`,
      // invisible to existing `toEqual` pins) so the actor's best-effort capture can read it.
      const diagnostic = getUpstreamChangedDiagnostic(error);
      if (diagnostic !== undefined) {
        attachUpstreamChangedDiagnostic(failure, diagnostic);
      }
      return Promise.resolve(failure);
    }
    return Promise.resolve({
      ok: false,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * S31.4 — the RECHECK verdict derives strictly from the freshly parsed grid against the
 * persisted placement geometry. `columnsPerRow = count / rowSpan`; every cell of the block
 * must land inside the grid AND be set in the availability bitmap. No cache fallback (S22.3).
 */
function computePlacementAvailable(
  recheckPlacement: unknown,
  rows: number,
  columns: number,
  availability: Uint8Array,
): boolean {
  const geometry = readRecheckGeometry(recheckPlacement);
  const bitLength = rows * columns;
  const columnsPerRow = geometry.count / geometry.rowSpan;
  for (let r = 0; r < geometry.rowSpan; r += 1) {
    for (let c = 0; c < columnsPerRow; c += 1) {
      const index = (geometry.row + r) * columns + (geometry.startCol + c);
      if (index < 0 || index >= bitLength) {
        return false;
      }
      if (!getBit(availability, index, bitLength)) {
        return false;
      }
    }
  }
  return true;
}

function readRecheckGeometry(value: unknown): RecheckGeometry {
  if (typeof value !== "object" || value === null) {
    throw new Error("recheck_placement is not an object");
  }
  const record = value as Record<string, unknown>;
  const row = readNonNegativeInteger(record, "row");
  const startCol = readNonNegativeInteger(record, "startCol");
  const rowSpan = readPositiveInteger(record, "rowSpan");
  const count = readPositiveInteger(record, "count");
  if (count % rowSpan !== 0) {
    throw new Error("recheck_placement count is not a multiple of rowSpan");
  }
  return { row, startCol, rowSpan, count };
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`recheck_placement.${key} must be a non-negative integer`);
  }
  return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`recheck_placement.${key} must be a positive integer`);
  }
  return value;
}
