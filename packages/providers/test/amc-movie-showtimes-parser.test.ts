import { describe, it, expect } from "vitest";
import { parseMovieShowtimes } from "../src/amc/parse/movie-showtimes.js";
import { PerformanceSchema } from "../src/contract.js";
import { ProviderError, getUpstreamChangedDiagnostic } from "../src/errors.js";

function makeHtml(...jsonRows: string[]): string {
  const lines = [`0:"$L1"`, ...jsonRows.map((row, i) => `${i + 1}:${row}`)];
  return `<script>self.__next_f.push([1, ${JSON.stringify(`${lines.join("\n")}\n`)}])</script>`;
}

const observationTime = new Date("2026-08-10T12:00:00Z");
const requestUrl =
  "https://www.amctheatres.com/movies/dune-part-3/showtimes?date=2026-08-13&theatre=amc-metreon-16";

// Real captured values where they exist: theatreId 2325 / postalCode 94103 are AMC Metreon 16's
// (packages/providers/test/amc-parsers.test.ts, Theatres block); theatreId 552 is AMC Empire
// 25's. Slugs, movie/showtime ids, and the movie itself are synthetic but shape-faithful.
const metreon = {
  theatreId: 2325,
  name: "AMC Metreon 16",
  slug: "amc-metreon-16",
  postalCode: "94103",
  stateCode: "CA",
  utcOffset: "-07:00",
  isSelected: true,
};
const empire = {
  theatreId: 552,
  name: "AMC Empire 25",
  slug: "amc-empire-25",
  postalCode: "10036",
  stateCode: "NY",
  utcOffset: "-04:00",
  isSelected: false,
};
const movie = { movieId: 987, name: "Dune Part 3", slug: "dune-part-3", runTimeMinutes: 155 };

// Same UTC instant at both theatres — per-theatre zones must produce distinct local times.
const metreonShowtime = {
  showtimeId: 144239197,
  status: "Sellable",
  showDateTimeUtc: "2026-08-13T02:00:00.000Z",
  policyCodes: [],
  hasTrailers: true,
};
const empireShowtime = {
  showtimeId: 145866536,
  status: "Sellable",
  showDateTimeUtc: "2026-08-13T02:00:00.000Z",
  policyCodes: [],
  hasTrailers: true,
};

function multiTheatreMarkup(): string {
  return (
    `<div id="dune-part-3">Dune Part 3</div>` +
    `<div role="group" aria-label="Showtimes at AMC Metreon 16">` +
    `<div id="dune-part-3-amc-metreon-16"></div>` +
    `<h3 id="dune-part-3-amc-metreon-16-dolbycinema"><span>Dolby Cinema at AMC</span></h3>` +
    `<a id="144239197" href="/showtimes/144239197" aria-describedby="dune-part-3 dune-part-3-amc-metreon-16 dune-part-3-amc-metreon-16-dolbycinema dune-part-3-amc-metreon-16-dolbycinema-attributes">10:00pm</a>` +
    `<ul id="dune-part-3-amc-metreon-16-dolbycinema-attributes"><li>AMC Signature Recliners</li><li>Reserved Seating</li></ul>` +
    `</div>` +
    `<div>NEARBY THEATRES</div>` +
    `<div role="group" aria-label="Showtimes at AMC Empire 25">` +
    `<div id="dune-part-3-amc-empire-25"></div>` +
    `<h3 id="dune-part-3-amc-empire-25-imaxlaser"><span>IMAX with Laser at AMC</span></h3>` +
    `<a id="145866536" href="/showtimes/145866536" aria-describedby="dune-part-3 dune-part-3-amc-empire-25 dune-part-3-amc-empire-25-imaxlaser dune-part-3-amc-empire-25-imaxlaser-attributes">10:00pm</a>` +
    `<ul id="dune-part-3-amc-empire-25-imaxlaser-attributes"><li>Reserved Seating</li></ul>` +
    `</div>` +
    `<select name="theatre"><option value="amc-metreon-16">AMC Metreon 16</option><option value="amc-empire-25">AMC Empire 25</option></select>`
  );
}

describe("parseMovieShowtimes (S64, ADR 0104)", () => {
  it("emits one Performance per theatre across primary + nearby theatres, each schema-valid in its own zone", () => {
    const html =
      makeHtml(JSON.stringify([metreon, empire, movie, metreonShowtime, empireShowtime])) +
      multiTheatreMarkup();
    const res = parseMovieShowtimes(html, observationTime, requestUrl);

    expect(res).toHaveLength(2);
    // Every emitted record passes the contract schema — no inference, actually parsed.
    for (const p of res) {
      expect(() => PerformanceSchema.parse(p)).not.toThrow();
    }
    const theatreIds = new Set(res.map((p) => p.theatreId));
    expect(theatreIds).toEqual(new Set(["amc:theatre:2325", "amc:theatre:552"]));

    const atMetreon = res.find((p) => p.theatreId === "amc:theatre:2325")!;
    expect(atMetreon).toMatchObject({
      showtimeId: "amc:showtime:144239197",
      providerId: "amc",
      movieId: "amc:movie:987",
      movieTitle: "Dune Part 3",
      auditorium: null,
      // 2026-08-13T02:00Z in America/Los_Angeles, computed by Node's own Intl data.
      showDateTimeLocal: "2026-08-12T19:00:00",
      utcOffset: "-07:00",
      runtimeMinutes: 155,
      status: "OPEN",
      formatCode: "dolbycinemaatamcprime",
      attributes: ["dolbycinemaatamcprime", "reclinerseating", "reservedseating"],
      minPrice: null,
      deepLinkUrl: "https://www.amctheatres.com/showtimes/144239197/seats",
      layoutId: null,
    });
    expect(atMetreon.showDateTimeUtc).toEqual(new Date("2026-08-13T02:00:00.000Z"));
    expect(atMetreon.providerMeta).toMatchObject({
      requestUrl,
      observationTime: "2026-08-10T12:00:00.000Z",
      rawStatus: "Sellable",
      rawFormatName: "Dolby Cinema at AMC",
      rawAttributeNames: ["AMC Signature Recliners", "Reserved Seating"],
    });

    const atEmpire = res.find((p) => p.theatreId === "amc:theatre:552")!;
    expect(atEmpire).toMatchObject({
      showtimeId: "amc:showtime:145866536",
      // Same instant, different zone: America/New_York, not the anchor's zone.
      showDateTimeLocal: "2026-08-12T22:00:00",
      utcOffset: "-04:00",
      status: "OPEN",
      formatCode: "imaxlaseratamc",
      attributes: ["imaxlaseratamc", "reservedseating"],
      deepLinkUrl: "https://www.amctheatres.com/showtimes/145866536/seats",
    });
    expect(atEmpire.providerMeta).toMatchObject({
      rawFormatName: "IMAX with Laser at AMC",
      rawAttributeNames: ["Reserved Seating"],
    });
  });

  it("returns [] on a valid 'no showtimes found' page", () => {
    const html =
      makeHtml(JSON.stringify([metreon, movie])) +
      `<p role="alert">Sorry, no showtimes found. Please check another AMC near you.</p>`;
    expect(parseMovieShowtimes(html, observationTime, requestUrl)).toEqual([]);
  });

  it("returns [] on the cluster-specific 'please select a nearby theatre' alert", () => {
    const html =
      makeHtml(JSON.stringify([metreon, empire, movie])) +
      `<div role="alert">In order to display showtimes, please select a nearby theatre.</div>`;
    expect(parseMovieShowtimes(html, observationTime, requestUrl)).toEqual([]);
  });

  it("throws UPSTREAM_CHANGED with a diagnostic on corrupted Flight JSON", () => {
    const html = `<script>self.__next_f.push([1, "oops"`;
    let caught: unknown;
    try {
      parseMovieShowtimes(html, observationTime, requestUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("UPSTREAM_CHANGED");
    const diagnostic = getUpstreamChangedDiagnostic(caught);
    expect(diagnostic).toMatchObject({ url: requestUrl, body: html });
  });

  it("throws UPSTREAM_CHANGED with a diagnostic on mismatched anchor IDREFs", () => {
    const badMarkup =
      `<div id="dune-part-3">Dune Part 3</div>` +
      `<a id="144239197" href="/showtimes/144239197" aria-describedby="dune-part-3 no-such-theatre-section">10:00pm</a>`;
    const html =
      makeHtml(JSON.stringify([metreon, movie, metreonShowtime])) + badMarkup;
    let caught: unknown;
    try {
      parseMovieShowtimes(html, observationTime, requestUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("UPSTREAM_CHANGED");
    expect((caught as ProviderError).message).toMatch(/no-such-theatre-section/);
    const diagnostic = getUpstreamChangedDiagnostic(caught);
    expect(diagnostic).toMatchObject({ url: requestUrl, body: html });
  });
});
