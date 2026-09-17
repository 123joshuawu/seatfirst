import { z } from "zod";
import {
  type SeatPageResult,
  type RawGridCell,
  type RawGrid,
  SeatPageResultSchema,
} from "../../contract.js";
import { extractShapeFromHtml } from "../flight.js";
import { ProviderError } from "../../errors.js";
import { normalizeSeatKind } from "../normalize.js";

const PublicSeatSchema = z
  .object({
    available: z.boolean(),
    column: z.number().int().positive(),
    row: z.number().int().positive(),
    name: z.string().optional(),
    type: z.string(),
    seatTier: z.string().optional(),
    shouldDisplay: z.boolean(),
  })
  .passthrough();

const PublicSeatingLayoutSchema = z
  .object({
    columns: z.number().int().positive({ message: "Missing columns" }),
    rows: z.number().int().positive({ message: "Missing rows" }),
    seats: z.array(PublicSeatSchema),
  })
  .passthrough();

/**
 * The real 2026 seat page carries its model data across two separate Flight rows:
 *
 * - the showtime row (`PublicShowtimeSchema` below) holds `showtimeId`, `prices`, and
 *   `performanceNumber` — the row that previously lived, in the old payload shape, inside a
 *   `showtime` key of the seat-map row;
 * - the seat-map row (`PublicSeatMapSchema`) holds `seatingLayout` plus display/amenity
 *   siblings this parser does not consume (`attributes`, `display`,
 *   `showtimeHeaderInfoAttributes`, `movie`, `theatre`, `hasTrailers`).
 *
 * Verified against all 10 promoted seat fixtures (fixtures/redacted/seats-*.json).
 */
const PublicShowtimeSchema = z
  .object({
    showtimeId: z.number().int().positive(),
    showDateTimeUtc: z.string().datetime(),
    performanceNumber: z.number().optional(),
    prices: z
      .array(
        z
          .object({
            price: z.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const PublicSeatMapSchema = z
  .object({
    seatingLayout: PublicSeatingLayoutSchema,
  })
  .passthrough();

export type PublicShowtime = z.infer<typeof PublicShowtimeSchema>;
export type PublicSeatMap = z.infer<typeof PublicSeatMapSchema>;

export function parseSeats(
  html: string,
  observationTime: Date,
  requestUrl: string,
  expectedShowtimeId: number,
): SeatPageResult {
  const seatMaps = extractShapeFromHtml<PublicSeatMap>(
    html,
    (val) => val.seatingLayout != null && typeof val.seatingLayout === "object",
    "PublicSeatMap",
  );
  const seatMapParsed = PublicSeatMapSchema.safeParse(seatMaps[0]);
  if (!seatMapParsed.success) {
    const err = seatMapParsed.error.issues[0];
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Seat page validation failed: ${err?.message} at ${err?.path.join(".")}`,
      {
        providerMeta: { requestUrl, observationTime },
      },
    );
  }
  const { seatingLayout } = seatMapParsed.data;

  const showtimeRows = extractShapeFromHtml<PublicShowtime>(
    html,
    (val) => typeof val.showtimeId === "number",
    "PublicShowtime",
  );
  const showtimeParsed = PublicShowtimeSchema.safeParse(showtimeRows[0]);
  if (!showtimeParsed.success) {
    const err = showtimeParsed.error.issues[0];
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Seat page validation failed: ${err?.message} at ${err?.path.join(".")}`,
      {
        providerMeta: { requestUrl, observationTime },
      },
    );
  }
  const showtime = showtimeParsed.data;

  if (showtime.showtimeId !== expectedShowtimeId) {
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Showtime ID mismatch: expected ${expectedShowtimeId}, got ${showtime.showtimeId}`,
      {
        providerMeta: { requestUrl, observationTime },
      },
    );
  }

  // Grid reconstruction (P5.9):
  // "Allocate rows × columns, treat observed coordinates as 1-based, place each entry at [row - 1][column - 1]"
  // Wait! The RawGrid format in @seatfirst/core just has a flat `cells: RawGridCell[]` array.
  // We do not need a 2D array, we just map `seats` to `RawGridCell`.

  const seenCoords = new Set<string>();
  for (const s of seatingLayout.seats) {
    if (s.row > seatingLayout.rows || s.column > seatingLayout.columns) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Seat coordinate out of bounds: row ${s.row}, column ${s.column} exceeds declared grid ${seatingLayout.rows}x${seatingLayout.columns}`,
        { providerMeta: { requestUrl, observationTime } },
      );
    }
    const key = `${s.row},${s.column}`;
    if (seenCoords.has(key)) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Duplicate seat coordinate: row ${s.row}, column ${s.column}`,
        { providerMeta: { requestUrl, observationTime } },
      );
    }
    seenCoords.add(key);
  }

  const cells: RawGridCell[] = seatingLayout.seats.map((s) => {
    return {
      row: s.row,
      column: s.column,
      kind: normalizeSeatKind(s.type),
      rawType: s.type,
      tier: s.seatTier ?? null,
      available: s.available,
      ...(s.name != null && s.name.trim() !== "" ? { name: s.name.trim() } : {}),
      visible: s.shouldDisplay,
    };
  });

  const grid: RawGrid = {
    rows: seatingLayout.rows,
    columns: seatingLayout.columns,
    cells,
  };

  let minPrice: number | null = null;
  const hasVisibleStandard = cells.some((c) => c.visible && c.kind === "STANDARD");
  if (showtime.prices && showtime.prices.length > 0) {
    const negativePrice = showtime.prices.find((p) => p.price < 0);
    if (negativePrice) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        `Negative ticket price in upstream data: ${negativePrice.price}`,
        { providerMeta: { requestUrl, observationTime } },
      );
    }
  }
  if (hasVisibleStandard && showtime.prices && showtime.prices.length > 0) {
    minPrice = Math.min(...showtime.prices.map((p) => p.price));
  }

  const resultCandidate = {
    grid,
    minPrice,
    priceBasis: minPrice !== null ? "TICKET_ONLY" : ("UNKNOWN" as const),
    providerMeta: {
      requestUrl,
      observationTime: observationTime.toISOString(),
      performanceNumber: showtime.performanceNumber,
    },
  };

  const validatedResult = SeatPageResultSchema.safeParse(resultCandidate);
  if (!validatedResult.success) {
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Seat page validation failed: ${validatedResult.error.issues[0]?.message}`,
      { providerMeta: { requestUrl, observationTime } },
    );
  }

  return validatedResult.data;
}
