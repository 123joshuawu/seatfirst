import { describe, it, expect } from "vitest";
import { extractFlightJSON } from "../src/amc/flight.js";

/**
 * P5.12 follow-up: `extractFlightJSON` previously `JSON.parse`d every numbered Flight-protocol
 * row unconditionally and threw `UPSTREAM_CHANGED` on AMC's real streams, which carry row types
 * that are not bare JSON — `T<hexlen>,<text>` text rows (scripts/CSS/SVG), `S...` string
 * references, `H...` preload hints, and `E{...}` error digests. This is a synthetic,
 * corpus-independent regression test for that fix: it does not depend on any real captured
 * fixture, only on the documented Flight-protocol row shapes.
 */
function buildNextFPushHtml(streamLines: string[]): string {
  const streamContent = streamLines.join("\n");
  const chunk = JSON.stringify([1, streamContent]);
  return `<html><body><script>self.__next_f.push(${chunk})</script></body></html>`;
}

describe("extractFlightJSON — mixed Flight row types", () => {
  it("skips T (text), S (string ref), H (hint), and E (error digest) rows without throwing", () => {
    const html = buildNextFPushHtml([
      "0:T5,hello",
      "1:Ssome-string-ref",
      "2:HL",
      '3:E{"digest":"NEXT_NOT_FOUND"}',
      '4:{"seatingLayout":{"columns":2,"rows":2,"seats":[]}}',
    ]);

    const results = extractFlightJSON(html);

    // Only the real JSON model row survives; the four non-JSON row types are skipped, not thrown on.
    expect(results).toEqual([{ seatingLayout: { columns: 2, rows: 2, seats: [] } }]);
  });

  it("strips the leading 'I' marker on import rows and parses the JSON that follows", () => {
    const html = buildNextFPushHtml(['0:I["module-a","module-b"]', '1:{"theatreId":123}']);

    const results = extractFlightJSON(html);

    expect(results).toEqual([["module-a", "module-b"], { theatreId: 123 }]);
  });

  it("still throws UPSTREAM_CHANGED when a genuine JSON model row is malformed", () => {
    const html = buildNextFPushHtml(["0:{not valid json"]);

    expect(() => extractFlightJSON(html)).toThrow(/Malformed Flight payload/);
  });

  it("returns an empty array when no self.__next_f.push chunk is present", () => {
    expect(extractFlightJSON("<html><body>no flight data here</body></html>")).toEqual([]);
  });
});
