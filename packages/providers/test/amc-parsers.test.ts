import { describe, it, expect, vi } from "vitest";
import { parseTheatres } from "../src/amc/parse/theatres.js";
import { parseMovies } from "../src/amc/parse/movies.js";
import { parseShowtimes } from "../src/amc/parse/showtimes.js";
import { parseSeats } from "../src/amc/parse/seats.js";
import { parseMarketSlugs } from "../src/amc/parse/market-slugs.js";
import { AmcProvider } from "../src/amc/provider.js";
import type { AmcFetcher } from "../src/amc/fetcher.js";
import type { ShowtimeId } from "@seatfirst/core";

function makeHtml(...jsonRows: string[]): string {
  const lines = [`0:"$L1"`, ...jsonRows.map((row, i) => `${i + 1}:${row}`)];
  return `<script>self.__next_f.push([1, ${JSON.stringify(`${lines.join("\n")}\n`)}])</script>`;
}

describe("AMC Parsers (P5)", () => {
  const observationTime = new Date("2026-08-10T12:00:00Z");

  describe("Theatres", () => {
    it("skips theatre entries with missing lat/lng (no Null Island fallback)", () => {
      const html = makeHtml(
        `[{"theatreId":123,"name":"AMC Metreon","slug":"amc-metreon","marketSlug":"san-francisco","address":{"stateCode":"CA"}}]`,
      );
      expect(parseTheatres(html, observationTime, "http://test")).toEqual([]);
    });

    it("skips theatre entries with lat/lng but no postal code (same per-entry-gap rule)", () => {
      const html = makeHtml(
        `[{"theatreId":456,"name":"AMC Empire","slug":"amc-empire","marketSlug":"new-york","latitude":40.756,"longitude":-73.988,"utcOffset":"-05:00","address":{"stateCode":"NY"}}]`,
      );
      expect(parseTheatres(html, observationTime, "http://test")).toEqual([]);
    });

    it("fails loudly (P5.3/P5.14) when a postal code AMC sent is not in the timezone table", () => {
      const html = makeHtml(
        `[{"theatreId":789,"name":"AMC Nowhere","slug":"amc-nowhere","marketSlug":"nowhere","latitude":1,"longitude":1,"address":{"stateCode":"ZZ","postalCode":"00000"}}]`,
      );
      expect(() => parseTheatres(html, observationTime, "http://test")).toThrowError(
        /Postal code "00000" is not in the timezone table/,
      );
    });

    it("builds a real Theatre, resolving a real captured theatre's postal code to its real IANA zone", () => {
      // theatreId 2325, slug, marketSlug, and postalCode 94103 are AMC Metreon 16's real
      // captured values (apps/server/fixtures/CAPTURE-LOG.md, 2026-08-13 P7 session).
      // Coordinates are the theatre's approximate public location, not upstream-observed.
      const html = makeHtml(
        `[{"theatreId":2325,"name":"AMC Metreon 16","slug":"amc-metreon-16","marketSlug":"san-francisco","latitude":37.7845,"longitude":-122.4036,"utcOffset":"-07:00","address":{"street":"135 Fourth St, Suite 3000","city":"San Francisco","stateCode":"CA","postalCode":"94103"}}]`,
      );

      const theatres = parseTheatres(html, observationTime, "http://test");

      expect(theatres).toEqual([
        {
          id: "amc:theatre:2325",
          providerId: "amc",
          name: "AMC Metreon 16",
          location: { lat: 37.7845, lng: -122.4036 },
          timezone: "America/Los_Angeles",
          city: "San Francisco",
          address: "135 Fourth St, Suite 3000, San Francisco, CA, 94103",
          slugs: { "san-francisco": "amc-metreon-16" },
          firstSeenAt: observationTime,
          lastSeenAt: observationTime,
        },
      ]);
    });

    it("parses the flat {marketSlug}-page shape, normalizing full state name to its 2-letter code", () => {
      // Flat shape confirmed in docs/amc-catalogue-plan.md §6.3: no nested `address` object;
      // `state` is the full name "Georgia", and `postalCode` "31707-4010" resolves to
      // America/New_York via its leading ZIP 31707 in the vendored timezone table.
      const html = makeHtml(
        `[{"theatreId":4200,"name":"AMC CLASSIC Albany 16","slug":"amc-classic-albany-16","marketSlug":"albany-ga","latitude":31.62187,"longitude":-84.20607,"addressLine1":"2823 Nottingham Way","addressLine2":null,"city":"Albany","state":"Georgia","postalCode":"31707-4010"}]`,
      );

      const theatres = parseTheatres(html, observationTime, "http://test");

      expect(theatres).toEqual([
        {
          id: "amc:theatre:4200",
          providerId: "amc",
          name: "AMC CLASSIC Albany 16",
          location: { lat: 31.62187, lng: -84.20607 },
          timezone: "America/New_York",
          city: "Albany",
          address: "2823 Nottingham Way, Albany, GA, 31707-4010",
          slugs: { "albany-ga": "amc-classic-albany-16" },
          firstSeenAt: observationTime,
          lastSeenAt: observationTime,
        },
      ]);
    });

    it("extracts city from both shapes and nulls empty/whitespace-only city (ADR 0029 §7)", () => {
      const html1 = makeHtml(
        `[{"theatreId":1001,"name":"AMC Test","slug":"amc-test","marketSlug":"test","latitude":37,"longitude":-122,"address":{"city":"   ","stateCode":"CA","postalCode":"94103"}}]`,
      );
      const theatres1 = parseTheatres(html1, observationTime, "http://test");
      expect(theatres1).toHaveLength(1);
      expect(theatres1[0]!.city).toBeNull();

      // Flat shape with missing city → null (address still formed without city).
      const html2 = makeHtml(
        `[{"theatreId":1002,"name":"AMC Flat No City","slug":"amc-flat-no-city","marketSlug":"test","latitude":37,"longitude":-122,"addressLine1":"123 Main St","state":"California","postalCode":"94103"}]`,
      );
      const theatres2 = parseTheatres(html2, observationTime, "http://test");
      expect(theatres2).toHaveLength(1);
      expect(theatres2[0]!.city).toBeNull();
      expect(theatres2[0]!.address).toBe("123 Main St, CA, 94103");

      // Flat shape with whitespace-padded city → trimmed and preserved.
      const html3 = makeHtml(
        `[{"theatreId":1003,"name":"AMC Flat Trim","slug":"amc-flat-trim","marketSlug":"test","latitude":37,"longitude":-122,"addressLine1":"123 Main St","city":"  Sunnyvale  ","state":"California","postalCode":"94086"}]`,
      );
      const theatres3 = parseTheatres(html3, observationTime, "http://test");
      expect(theatres3[0]!.city).toBe("Sunnyvale");
    });
  });

  describe("Movies", () => {
    it("parses synthetic movies correctly", () => {
      const html = makeHtml(
        `[{"movieId":456,"name":"Dune Part 3","slug":"dune-3","detailsPath":"/dune","showtimesPath":"/dune/showtimes"}]`,
      );
      const res = parseMovies(html, observationTime, "http://test");
      expect(res).toHaveLength(1);
      expect(res[0]!.movieId).toBe(456);
    });
  });

  describe("Showtimes", () => {
    it("builds a real Performance, resolving the schedule's own postal code to its IANA zone (P5.7/P5.8/P5.14)", () => {
      // theatreId 2325, postalCode 94103 are AMC Metreon 16's real captured values (same as the
      // Theatres describe block above and the seats real-fixture-excerpt tests below).
      // showDateTimeUtc 2026-08-13T05:00:00.000Z is the same real value used in those seats
      // tests, converted here to America/Los_Angeles independently (Node's own `Intl`, not by
      // asking `parseShowtimes` for its own answer): Wednesday 2026-08-12, 22:00:00, GMT-07:00.
      const payload = {
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
      };
      const res = parseShowtimes(
        makeHtml(JSON.stringify(payload)),
        observationTime,
        "http://test/showtimes",
      );

      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({
        showtimeId: "amc:showtime:144239197",
        providerId: "amc",
        theatreId: "amc:theatre:2325",
        movieId: "amc:movie:987",
        movieTitle: "Dune Part 3",
        auditorium: null,
        showDateTimeLocal: "2026-08-12T22:00:00",
        utcOffset: "-07:00",
        runtimeMinutes: 155,
        status: "OPEN",
        attributes: ["REC", "IMAX"],
        formatCode: "IMAX",
        minPrice: null,
        layoutId: null,
        // Placeholder before `getSchedule`'s deep-link enrichment overwrites it.
        deepLinkUrl: "http://test/showtimes",
      });
      expect(res[0]!.showDateTimeUtc).toEqual(new Date("2026-08-13T05:00:00.000Z"));
      expect(res[0]!.providerMeta).toMatchObject({ rawStatus: "Sellable" });
    });

    it("leaves formatCode null when format has a name but no code, rather than falling back to name (P5.4)", () => {
      const payload = {
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
            // No `code` — only AMC's display `name` is present. `formatCode` must stay `null`
            // rather than silently promoting a display name into the grouping field; only the
            // native `code`, when present, is ever normalized into `formatCode` (P5.4).
            format: { name: "IMAX" },
            attributes: [],
            showtimes: [
              {
                showtimeId: 144239197,
                status: "Sellable",
                showDateTimeUtc: "2026-08-13T05:00:00.000Z",
              },
            ],
          },
        ],
      };
      const res = parseShowtimes(
        makeHtml(JSON.stringify(payload)),
        observationTime,
        "http://test/showtimes",
      );

      expect(res).toHaveLength(1);
      expect(res[0]!.formatCode).toBeNull();
      expect(res[0]!.attributes).toEqual([]);
      expect(res[0]!.providerMeta).toMatchObject({
        rawFormatCode: null,
        rawAttributes: [],
      });
    });

    it("merges a non-null legacy-domain formatCode into attributes (ADR 0008 addendum)", () => {
      // ADR 0008 addendum (decided 2026-08-14): the legacy structured-shape domain carries a
      // real `group.format.code`; a format code is always also an attribute, so a non-null
      // `legacyFormatCode` must land in `attributes` alongside `formatCode` (paralleling
      // `resolvePooledOffering`'s pooled-display-name rule), deduped against `group.attributes`.
      const payload = {
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
            format: { code: "imax70mm", name: "IMAX 70MM" },
            attributes: [{ code: "reservedseating", name: "Reserved Seating" }],
            showtimes: [
              {
                showtimeId: 144239197,
                status: "Sellable",
                showDateTimeUtc: "2026-08-13T05:00:00.000Z",
              },
            ],
          },
        ],
      };
      const res = parseShowtimes(
        makeHtml(JSON.stringify(payload)),
        observationTime,
        "http://test/showtimes",
      );

      expect(res).toHaveLength(1);
      expect(res[0]!.formatCode).toBe("imax70mm");
      expect(res[0]!.attributes).toEqual(["reservedseating", "imax70mm"]);
    });

    it("normalizes an unrecognized native status to UNKNOWN rather than throwing (P5.6)", () => {
      const payload = {
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
            movie: { movieId: 987, name: "Dune Part 3" },
            showtimes: [
              {
                showtimeId: 1,
                status: "SomeFutureAmcStatus",
                showDateTimeUtc: "2026-08-13T05:00:00.000Z",
              },
            ],
          },
        ],
      };
      const res = parseShowtimes(makeHtml(JSON.stringify(payload)), observationTime, "http://test");
      expect(res[0]!.status).toBe("UNKNOWN");
    });

    it("fails loudly (P5.3/P5.14) when a postal code AMC sent is not in the timezone table", () => {
      const payload = {
        theatre: {
          theatreId: 789,
          name: "AMC Nowhere",
          postalCode: "00000",
          stateCode: "ZZ",
          utcOffset: "+00:00",
        },
        selectedDate: "2026-08-12",
        groups: [],
      };
      expect(() =>
        parseShowtimes(makeHtml(JSON.stringify(payload)), observationTime, "http://test"),
      ).toThrowError(/Postal code "00000" is not in the timezone table/);
    });

    it("fails loudly (P5.3) when the theatre object is missing its postal code", () => {
      const payload = {
        theatre: { theatreId: 123, name: "AMC", utcOffset: "-05:00", stateCode: "FL" },
        selectedDate: "2026-07-18",
        groups: [],
      };
      expect(() =>
        parseShowtimes(makeHtml(JSON.stringify(payload)), observationTime, "http://test"),
      ).toThrowError(/postalCode/);
    });
  });

  describe("Showtimes DOM resolver (schedule DOM/ARIA-association finding, docs/backlog.md)", () => {
    // Real theatre/movie/showtime records still parse as clean structured JSON in the Flight
    // stream (confirmed against a real 2026-08-13 capture); what's gone is the old single
    // `PublicTheatreSchedule` object nesting them together, so `parseShowtimes`'s primary
    // extraction throws UPSTREAM_CHANGED and falls back to `resolveScheduleFromDom`, which
    // re-associates them via the rendered HTML's `aria-describedby` IDREFs.
    const theatreSelected = {
      theatreId: 552,
      name: "AMC Empire 25",
      postalCode: "10036",
      stateCode: "NY",
      utcOffset: "-04:00",
      isSelected: true,
    };
    const theatreNearby = {
      theatreId: 2120,
      name: "AMC 34th Street 14",
      postalCode: "10001",
      stateCode: "NY",
      utcOffset: "-04:00",
      isSelected: false,
    };
    const movie = { movieId: 78598, name: "Spider-Man: Brand New Day", slug: "spider-man-78598" };
    const showtime = {
      showtimeId: 145866536,
      status: "Sellable",
      showDateTimeUtc: "2026-08-13T20:00:00.000Z",
      policyCodes: [],
      hasTrailers: true,
    };

    function domMarkup(opts?: { withFormat?: boolean; withAttributes?: boolean }): string {
      const withFormat = opts?.withFormat ?? true;
      const withAttributes = opts?.withAttributes ?? true;
      const formatId = "spider-man-78598-amc-empire-25-dolbycinema";
      const attrId = "spider-man-78598-amc-empire-25-dolbycinema-attributes";
      const tokens = [
        movie.slug,
        ...(withFormat ? [formatId] : []),
        ...(withAttributes ? [attrId] : []),
      ].join(" ");
      return (
        // The movie IDREF target itself: required to exist (standing rule this resolver was
        // built under — every token it actually consults must resolve to a real element,
        // never trusted as bare text).
        `<div id="${movie.slug}">Spider-Man: Brand New Day</div>` +
        `<a id="${showtime.showtimeId}" href="/showtimes/${showtime.showtimeId}" aria-describedby="${tokens}">4:00pm</a>` +
        (withFormat ? `<h3 id="${formatId}"><span>Dolby Cinema at AMC</span></h3>` : "") +
        (withAttributes
          ? `<ul id="${attrId}"><li>AMC Signature Recliners</li><li>Reserved Seating</li></ul>`
          : "")
      );
    }

    it("reconstructs a Performance from the rendered HTML when the old Flight shape is gone", () => {
      const html =
        makeHtml(JSON.stringify([theatreNearby, theatreSelected, movie, showtime])) + domMarkup();
      const res = parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");

      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({
        showtimeId: "amc:showtime:145866536",
        theatreId: "amc:theatre:552",
        movieId: "amc:movie:78598",
        movieTitle: "Spider-Man: Brand New Day",
        status: "OPEN",
      });
    });

    it("promotes DOM display names into formatCode/attributes via ADR 0008's approved table, pooling both DOM positions", () => {
      const html =
        makeHtml(JSON.stringify([theatreNearby, theatreSelected, movie, showtime])) + domMarkup();
      const res = parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");

      // "Dolby Cinema at AMC" (heading) -> dolbycinemaatamcprime (isFormat); "AMC Signature
      // Recliners" / "Reserved Seating" (badges) -> reclinerseating / reservedseating.
      expect(res[0]!.formatCode).toBe("dolbycinemaatamcprime");
      expect(res[0]!.attributes).toEqual([
        "dolbycinemaatamcprime",
        "reclinerseating",
        "reservedseating",
      ]);
      expect(res[0]!.providerMeta).toMatchObject({
        rawFormatCode: null,
        rawAttributes: [],
        rawFormatName: "Dolby Cinema at AMC",
        rawAttributeNames: ["AMC Signature Recliners", "Reserved Seating"],
      });
    });

    it("picks the isSelected theatre record, not a nearby-theatres widget entry sharing the shape", () => {
      const html =
        makeHtml(JSON.stringify([theatreNearby, theatreSelected, movie, showtime])) + domMarkup();
      const res = parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");

      expect(res[0]!.theatreId).toBe("amc:theatre:552");
    });

    it("returns an empty performance list when AMC's own no-showtimes alert is present, not UPSTREAM_CHANGED", () => {
      const html =
        makeHtml(JSON.stringify([theatreSelected, movie])) +
        `<p role="alert">Sorry, no showtimes found. Please check another AMC near you.</p>`;
      const res = parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");
      expect(res).toEqual([]);
    });

    it("fails loudly when a showtime anchor's aria-describedby references an id with no matching element", () => {
      const badHtml = `<a id="${showtime.showtimeId}" href="/showtimes/${showtime.showtimeId}" aria-describedby="no-such-element-id">x</a>`;
      const html = makeHtml(JSON.stringify([theatreSelected, movie, showtime])) + badHtml;
      expect(() =>
        parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13"),
      ).toThrowError(/has no matching element in the rendered HTML/);
    });

    it("fails loudly when a middle (format/theatre-name) aria-describedby token has no matching element, rather than silently falling through to a shallower token", () => {
      const badHtml =
        `<div id="${movie.slug}">Spider-Man: Brand New Day</div>` +
        `<a id="${showtime.showtimeId}" href="/showtimes/${showtime.showtimeId}" aria-describedby="${movie.slug} no-such-format-element">x</a>`;
      const html = makeHtml(JSON.stringify([theatreSelected, movie, showtime])) + badHtml;
      expect(() =>
        parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13"),
      ).toThrowError(/no-such-format-element.*has no matching element in the rendered HTML/);
    });

    it("fails loudly when the movie IDREF resolves to a real element whose id isn't a known movie slug", () => {
      const badHtml =
        `<div id="unrelated-element">not a movie</div>` +
        `<a id="${showtime.showtimeId}" href="/showtimes/${showtime.showtimeId}" aria-describedby="unrelated-element">x</a>`;
      const html = makeHtml(JSON.stringify([theatreSelected, movie, showtime])) + badHtml;
      expect(() =>
        parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13"),
      ).toThrowError(/does not match any known movie slug/);
    });

    it("fails loudly when a Flight showtime record is unreachable from any DOM anchor (counts don't round-trip)", () => {
      const orphanShowtime = { ...showtime, showtimeId: 999999999 };
      const html =
        makeHtml(JSON.stringify([theatreSelected, movie, showtime, orphanShowtime])) + domMarkup();
      expect(() =>
        parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13"),
      ).toThrowError(/only 1 were reachable from a showtime anchor/);
    });

    it("leaves rawFormatName/rawAttributeNames absent when no format/attributes IDREFs resolve", () => {
      const html =
        makeHtml(JSON.stringify([theatreSelected, movie, showtime])) +
        domMarkup({ withFormat: false, withAttributes: false });
      const res = parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");
      expect(res[0]!.providerMeta).toMatchObject({
        rawFormatName: null,
        rawAttributeNames: [],
      });
    });
  });

  describe("Seats (Grid + Verification criteria)", () => {
    it("Criterion 1 & 4 & 5: synthetic payload parses correctly, row/column mapped, missing rows fails loudly", () => {
      // The real payload splits these into two Flight rows (see the real-excerpt tests below):
      // a showtime row and a seat-map row.
      const validShowtime = {
        showtimeId: 100,
        showDateTimeUtc: "2026-08-10T12:00:00Z",
        prices: [{ price: 15.99 }],
      };
      const validSeatMap = {
        seatingLayout: {
          columns: 10,
          rows: 5,
          seats: [
            {
              row: 1,
              column: 1,
              name: "A1",
              type: "CanReserve",
              available: true,
              shouldDisplay: true,
            }, // normal
            {
              row: 1,
              column: 2,
              name: "A2",
              type: "Wheelchair",
              available: false,
              shouldDisplay: true,
            }, // accessibility
            {
              row: 2,
              column: 1,
              name: "",
              type: "NotASeat",
              available: false,
              shouldDisplay: false,
            }, // gap
          ],
        },
      };
      const html = makeHtml(JSON.stringify(validShowtime), JSON.stringify(validSeatMap));
      const res = parseSeats(html, observationTime, "http://test", 100);

      expect(res.grid.rows).toBe(5);
      expect(res.grid.cells).toHaveLength(3);

      const normal = res.grid.cells.find((c) => c.name === "A1");
      expect(normal).toMatchObject({
        row: 1,
        column: 1,
        kind: "STANDARD",
        available: true,
        visible: true,
      });

      const wc = res.grid.cells.find((c) => c.name === "A2");
      expect(wc).toMatchObject({
        row: 1,
        column: 2,
        kind: "WHEELCHAIR",
        available: false,
        visible: true,
      });

      const gap = res.grid.cells.find((c) => c.row === 2 && c.column === 1);
      expect(gap).toMatchObject({
        row: 2,
        column: 1,
        kind: "NOT_A_SEAT",
        available: false,
        visible: false,
      });

      expect(res.minPrice).toBe(15.99);
      expect(res.priceBasis).toBe("TICKET_ONLY");

      // Criterion 5: missing fields
      const missingRowsShowtime = {
        showtimeId: 100,
        showDateTimeUtc: "2026-08-10T12:00:00Z",
      };
      const missingRowsSeatMap = { seatingLayout: { columns: 10, seats: [] } };
      const htmlBad = makeHtml(
        JSON.stringify(missingRowsShowtime),
        JSON.stringify(missingRowsSeatMap),
      );
      expect(() => parseSeats(htmlBad, observationTime, "http://test", 100)).toThrowError(
        /seatingLayout\.rows/,
      );
    });

    it("rejects a negative ticket price even when no visible standard seat exists (accessible-only page)", () => {
      const showtime = {
        showtimeId: 100,
        showDateTimeUtc: "2026-08-10T12:00:00Z",
        prices: [{ price: -5 }],
      };
      const seatMap = {
        seatingLayout: {
          columns: 2,
          rows: 1,
          seats: [
            {
              row: 1,
              column: 1,
              name: "A1",
              type: "Wheelchair",
              available: true,
              shouldDisplay: true,
            },
          ],
        },
      };
      const html = makeHtml(JSON.stringify(showtime), JSON.stringify(seatMap));
      expect(() => parseSeats(html, observationTime, "http://test", 100)).toThrowError(
        /Negative ticket price/,
      );
    });

    it("Criterion 2: structural mutation -> UPSTREAM_CHANGED", () => {
      const html = makeHtml(`{"notLayout": true}`);
      try {
        parseSeats(html, observationTime, "http://test", 100);
        expect.unreachable();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe("UPSTREAM_CHANGED");
      }
    });

    it("Criterion 3: invented vocabulary -> UNKNOWN", () => {
      const showtime = { showtimeId: 100, showDateTimeUtc: "2026-08-10T12:00:00Z" };
      const seatMap = {
        seatingLayout: {
          columns: 1,
          rows: 1,
          seats: [
            {
              row: 1,
              column: 1,
              name: "A1",
              type: "InventedSeatType",
              seatTier: "InventedTier",
              available: true,
              shouldDisplay: true,
            },
          ],
        },
      };
      const html = makeHtml(JSON.stringify(showtime), JSON.stringify(seatMap));
      const res = parseSeats(html, observationTime, "http://test", 100);

      const cell = res.grid.cells[0];
      expect(cell!.kind).toBe("UNKNOWN");
      expect(cell!.rawType).toBe("InventedSeatType");
      expect(cell!.tier).toBe("InventedTier");
    });

    it("parses the real 2026 two-row seat page shape (real fixture excerpt)", () => {
      // Both rows are real, trimmed excerpts from fixtures/redacted/seats-144239197.json
      // (2026-08-13 capture): the stream carries the showtime data (showtimeId,
      // performanceNumber, prices) in its own top-level row, separate from the seat-map row
      // that carries seatingLayout. The seat-map row's amenity/display siblings (attributes,
      // display, showtimeHeaderInfoAttributes, movie, theatre, hasTrailers) are omitted here
      // because the parser never reads them. Price items carry sku/type/convenienceFee/tax
      // fields the schema passes through.
      const realShowtimeRow = {
        showtimeId: 144239197,
        performanceNumber: 21155,
        showDateTimeUtc: "2026-08-13T05:00:00.000Z",
        prices: [
          {
            sku: "TICKET-RS-144239197-ADULT",
            type: "Adult",
            price: 19.99,
            convenienceFee: 2.69,
            tax: 0,
          },
          {
            sku: "TICKET-RS-144239197-CHILD",
            type: "Child",
            price: 16.99,
            convenienceFee: 2.69,
            tax: 0,
          },
          {
            sku: "TICKET-RS-144239197-SENIOR",
            type: "Senior",
            price: 18.49,
            convenienceFee: 2.69,
            tax: 0,
          },
        ],
      };
      const realSeatMapRow = {
        seatingLayout: {
          columns: 18,
          rows: 9,
          seats: [
            {
              available: false,
              column: 1,
              row: 1,
              name: "",
              type: "NotASeat",
              seatTier: "Regular",
              shouldDisplay: false,
            },
            {
              available: true,
              column: 3,
              row: 3,
              name: "C15",
              type: "CanReserve",
              seatTier: "Regular",
              shouldDisplay: true,
            },
          ],
        },
      };

      const html = makeHtml(JSON.stringify(realShowtimeRow), JSON.stringify(realSeatMapRow));
      const res = parseSeats(html, observationTime, "http://test", 144239197);

      expect(res.minPrice).toBe(16.99);
      expect(res.priceBasis).toBe("TICKET_ONLY");
      expect(res.providerMeta.performanceNumber).toBe(21155);
      expect(res.grid.cells).toHaveLength(2);
      const normal = res.grid.cells.find((c) => c.name === "C15");
      expect(normal).toMatchObject({ row: 3, column: 3, kind: "STANDARD", visible: true });
    });

    it("rejects a real showtime row whose id does not match the requested URL (real fixture excerpt)", () => {
      // Same real rows as the success case; only the URL-derived expected id differs, which is
      // the exact drift parseSeats exists to catch.
      const realShowtimeRow = {
        showtimeId: 144239197,
        performanceNumber: 21155,
        showDateTimeUtc: "2026-08-13T05:00:00.000Z",
        prices: [
          {
            sku: "TICKET-RS-144239197-ADULT",
            type: "Adult",
            price: 19.99,
            convenienceFee: 2.69,
            tax: 0,
          },
        ],
      };
      const realSeatMapRow = {
        seatingLayout: {
          columns: 18,
          rows: 9,
          seats: [
            {
              available: true,
              column: 3,
              row: 3,
              name: "C15",
              type: "CanReserve",
              seatTier: "Regular",
              shouldDisplay: true,
            },
          ],
        },
      };

      const html = makeHtml(JSON.stringify(realShowtimeRow), JSON.stringify(realSeatMapRow));
      expect(() => parseSeats(html, observationTime, "http://test", 999999)).toThrowError(
        /Showtime ID mismatch: expected 999999, got 144239197/,
      );
    });
  });

  describe("AmcProvider integration", () => {
    it("Criterion 6: branded error under 200 -> NOT_FOUND", async () => {
      const mockFetcher = {
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          code: "NOT_FOUND",
          message: "Branded error under 200",
          providerMeta: {},
        }),
      };
      const provider = new AmcProvider(mockFetcher as unknown as AmcFetcher);

      const res = await provider.getSeatPage("amc:showtime:123" as ShowtimeId);
      expect(res).toEqual({
        ok: false,
        code: "NOT_FOUND",
        message: "Branded error under 200",
        providerMeta: {},
      });
    });
  });
  describe("Market slugs (S26)", () => {
    it("extracts de-duplicated slugs in document order, excluding `states` and deeper city links", () => {
      const html = [
        '<a href="/movie-theatres/atlanta">Atlanta</a>',
        '<a href="/movie-theatres/albany-ga">Albany</a>',
        '<a href="/movie-theatres/atlanta">Atlanta</a>',
        '<a href="/movie-theatres/states">States</a>',
        '<a href="/movie-theatres/states/georgia/atlanta">Georgia</a>',
        '<a href="/movies">Movies</a>',
        '<a href="/movie-theatres/albuquerque-nm">Albuquerque</a>',
      ].join("\n");

      expect(parseMarketSlugs(html)).toEqual(["atlanta", "albany-ga", "albuquerque-nm"]);
    });

    it("returns an empty list when no market anchors are present", () => {
      expect(parseMarketSlugs('<a href="/movies">Movies</a>')).toEqual([]);
    });
  });
});
