import { describe, expect, it } from "vitest";

import type { SanitizedPayload } from "@seatfirst/browser-runtime";

import { parseObservation } from "../src/dispatch/handlers/parse-observation.js";
import type { RunKeyRow } from "../src/dispatch/queries.js";

function makeHtml(...rows: readonly unknown[]): string {
  const lines = [`0:"$L1"`, ...rows.map((row, index) => `${index + 1}:${JSON.stringify(row)}`)];
  return `<script>self.__next_f.push([1, ${JSON.stringify(`${lines.join("\n")}\n`)}])</script>`;
}

function payload(documentHtml: string, pathname = "/showtimes/100/seats"): SanitizedPayload {
  return {
    finalUrl: {
      origin: "https://www.amctheatres.com",
      pathname,
      queryKeys: ["date"],
    },
    finalStatus: 200,
    headers: {},
    documentHtml,
  };
}

function runKey(
  kind: RunKeyRow["kind"],
  overrides: Omit<Partial<RunKeyRow>, "kind"> = {},
): RunKeyRow {
  const schedule = kind === "SCHEDULE_RESOLUTION";
  return {
    runKeyId: "run-key",
    kind,
    providerId: "amc",
    routeClass: schedule ? "schedule" : "seat",
    showtimeId: schedule ? null : "amc:showtime:100",
    theatreId: schedule ? "amc:theatre:2325" : null,
    localDate: schedule ? "2026-08-12" : null,
    acceptedRevision: "0",
    projectedRevision: "0",
    latestObservationId: null,
    latestCapturedAt: null,
    recheckPlacement: null,
    ...overrides,
  };
}

function seatHtml(seats: readonly unknown[]): string {
  return makeHtml(
    {
      showtimeId: 100,
      showDateTimeUtc: "2026-08-10T12:00:00Z",
      prices: [{ price: 15.99 }],
    },
    {
      seatingLayout: {
        columns: 3,
        rows: 2,
        seats,
      },
    },
  );
}

const RECHECK_SEATS = [
  {
    row: 1,
    column: 1,
    name: "A1",
    type: "CanReserve",
    available: true,
    shouldDisplay: true,
  },
  {
    row: 1,
    column: 2,
    name: "A2",
    type: "CanReserve",
    available: true,
    shouldDisplay: true,
  },
  {
    row: 1,
    column: 3,
    name: "A3",
    type: "CanReserve",
    available: false,
    shouldDisplay: true,
  },
  {
    row: 2,
    column: 1,
    name: "B1",
    type: "CanReserve",
    available: true,
    shouldDisplay: true,
  },
  {
    row: 2,
    column: 2,
    name: "B2",
    type: "CanReserve",
    available: true,
    shouldDisplay: true,
  },
  {
    row: 2,
    column: 3,
    name: "B3",
    type: "CanReserve",
    available: true,
    shouldDisplay: true,
  },
];

describe("parseObservation (S31.3–S31.5)", () => {
  it("maps a seat-page fixture to its dense availability bitmap and free count", async () => {
    const result = await parseObservation(
      payload(
        seatHtml([
          {
            row: 1,
            column: 1,
            name: "A1",
            type: "CanReserve",
            available: true,
            shouldDisplay: true,
          },
          {
            row: 1,
            column: 2,
            name: "A2",
            type: "Wheelchair",
            available: false,
            shouldDisplay: true,
          },
          {
            row: 2,
            column: 1,
            name: "",
            type: "NotASeat",
            available: false,
            shouldDisplay: false,
          },
        ]),
      ),
      runKey("SHOWTIME_FETCH"),
    );

    if (!result.ok || result.kind !== "SHOWTIME_FETCH") {
      throw new Error(`expected SHOWTIME_FETCH result, got ${JSON.stringify(result)}`);
    }
    expect(Array.from(result.bitmap)).toEqual([1]);
    expect(result.freeCount).toBe(1);
  });

  it("forwards minPrice and priceBasis from parseSeats on SHOWTIME_FETCH (S59)", async () => {
    const result = await parseObservation(
      payload(
        seatHtml([
          {
            row: 1,
            column: 1,
            name: "A1",
            type: "CanReserve",
            available: true,
            shouldDisplay: true,
          },
        ]),
      ),
      runKey("SHOWTIME_FETCH"),
    );

    if (!result.ok || result.kind !== "SHOWTIME_FETCH") {
      throw new Error(`expected SHOWTIME_FETCH result, got ${JSON.stringify(result)}`);
    }
    // seatHtml prices the showtime at 15.99 and A1 is a visible STANDARD seat, so
    // parseSeats resolves minPrice 15.99 / TICKET_ONLY — delete the two forwarding
    // lines and both assertions below fail (undefined, not the parsed values).
    expect(result.minPrice).toBe(15.99);
    expect(result.priceBasis).toBe("TICKET_ONLY");
  });

  it("forwards a null minPrice with UNKNOWN basis when no standard seat is visible", async () => {
    const result = await parseObservation(
      payload(
        seatHtml([
          {
            row: 1,
            column: 2,
            name: "A2",
            type: "Wheelchair",
            available: false,
            shouldDisplay: true,
          },
        ]),
      ),
      runKey("SHOWTIME_FETCH"),
    );

    if (!result.ok || result.kind !== "SHOWTIME_FETCH") {
      throw new Error(`expected SHOWTIME_FETCH result, got ${JSON.stringify(result)}`);
    }
    expect(result.minPrice).toBeNull();
    expect(result.priceBasis).toBe("UNKNOWN");
  });

  it("maps every persisted SCHEDULE_RESOLUTION performance field", async () => {
    const result = await parseObservation(
      payload(
        makeHtml({
          theatre: {
            theatreId: 2325,
            name: "AMC Metreon 16",
            postalCode: "94103",
            stateCode: "CA",
            utcOffset: "-07:00",
          },
          selectedDate: "2026-08-12",
          groups: [
            {
              movie: { movieId: 987, name: "Dune Part 3", runTimeMinutes: 155 },
              format: { code: "IMAX", name: "IMAX" },
              attributes: [{ code: "REC", name: "Reclining Seats" }],
              showtimes: [
                {
                  showtimeId: 144239197,
                  status: "Sellable",
                  showDateTimeUtc: "2026-08-13T05:00:00.000Z",
                },
              ],
            },
          ],
        }),
        "/movie-theatres/san-francisco/amc-metreon-16/showtimes",
      ),
      runKey("SCHEDULE_RESOLUTION"),
    );

    if (!result.ok || result.kind !== "SCHEDULE_RESOLUTION") {
      throw new Error(`expected SCHEDULE_RESOLUTION result, got ${JSON.stringify(result)}`);
    }
    expect(result.performances).toHaveLength(1);
    expect(result.performances[0]).toMatchObject({
      showtimeId: "amc:showtime:144239197",
      startsAt: new Date("2026-08-13T05:00:00.000Z"),
      movieId: "amc:movie:987",
      movieTitle: "Dune Part 3",
      auditorium: null,
      utcOffset: "-07:00",
      runtimeMinutes: 155,
      status: "OPEN",
      attributes: ["REC", "IMAX"],
      formatCode: "IMAX",
      deepLinkUrl:
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
      providerMeta: { rawStatus: "Sellable" },
    });
  });

  it("computes a RECHECK verdict from the persisted geometry and fresh bitmap only", async () => {
    const html = seatHtml(RECHECK_SEATS);
    const available = await parseObservation(
      payload(html),
      runKey("RECHECK", {
        recheckPlacement: { placementKey: "p", row: 0, startCol: 0, rowSpan: 2, count: 4 },
      }),
    );
    const unavailableMember = await parseObservation(
      payload(html),
      runKey("RECHECK", {
        recheckPlacement: { placementKey: "p", row: 0, startCol: 1, rowSpan: 1, count: 2 },
      }),
    );
    const driftedOutOfBounds = await parseObservation(
      payload(html),
      runKey("RECHECK", {
        recheckPlacement: { placementKey: "p", row: 1, startCol: 2, rowSpan: 1, count: 2 },
      }),
    );

    expect(available).toEqual({ ok: true, kind: "RECHECK", placementAvailable: true });
    expect(unavailableMember).toEqual({ ok: true, kind: "RECHECK", placementAvailable: false });
    expect(driftedOutOfBounds).toEqual({ ok: true, kind: "RECHECK", placementAvailable: false });
  });

  it("maps P5 schema drift to PARSER_SCHEMA_INCOMPATIBLE", async () => {
    const result = await parseObservation(
      payload(makeHtml({ notLayout: true })),
      runKey("SHOWTIME_FETCH"),
    );
    expect(result).toEqual({
      ok: false,
      cause: "PARSER_SCHEMA_INCOMPATIBLE",
      parserError: {
        code: "UPSTREAM_CHANGED",
        message: "Could not locate PublicSeatMap shape in Flight payload",
      },
    });
  });

  it("returns the message for errors outside P5 schema drift", async () => {
    const result = await parseObservation(
      payload(seatHtml(RECHECK_SEATS)),
      runKey("SHOWTIME_FETCH", { showtimeId: "not-a-namespaced-showtime" }),
    );
    expect(result).toEqual({
      ok: false,
      cause: "invalid namespaced showtime id: not-a-namespaced-showtime",
    });
  });
});
