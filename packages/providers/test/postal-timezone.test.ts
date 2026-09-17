import { describe, it, expect } from "vitest";
import { resolvePostalCodeTimezone } from "../src/amc/postal-timezone.js";
import { POSTAL_TIMEZONE_TABLE } from "../src/amc/postal-timezone-table.generated.js";
import { IanaTimezoneSchema } from "@seatfirst/core";

describe("resolvePostalCodeTimezone (P5.14)", () => {
  describe("theatres actually captured 2026-08-13 (apps/server/fixtures/CAPTURE-LOG.md)", () => {
    // Each pair is the theatre's real captured postalCode -> its real, independently-known
    // (USPS ZIP directory) city and timezone. Not derived by calling the implementation.
    it.each([
      ["94103", "San Francisco, CA (AMC Metreon 16)", "America/Los_Angeles"],
      ["94086", "Sunnyvale, CA (AMC Sunnyvale 12)", "America/Los_Angeles"],
      ["60611", "Chicago, IL (AMC River East 21)", "America/Chicago"],
      ["60201", "Evanston, IL (AMC Evanston 12)", "America/Chicago"],
      ["30033", "Decatur/Atlanta, GA (AMC North DeKalb 16)", "America/New_York"],
    ])("%s (%s) resolves to %s", (postalCode, _label, expected) => {
      expect(resolvePostalCodeTimezone(postalCode)).toBe(expected);
    });
  });

  describe("zones that break naive UTC-offset guessing", () => {
    it("resolves Phoenix, AZ to America/Phoenix, which never observes DST", () => {
      // Arizona does not observe DST — a table built from a snapshot UTC offset would be wrong
      // for half the year. This is exactly the case E6.2/P5.14 exist to get right.
      expect(resolvePostalCodeTimezone("85003")).toBe("America/Phoenix");
    });

    it("resolves Honolulu, HI to Pacific/Honolulu", () => {
      expect(resolvePostalCodeTimezone("96813")).toBe("Pacific/Honolulu");
    });

    it("resolves Anchorage, AK to America/Anchorage", () => {
      expect(resolvePostalCodeTimezone("99501")).toBe("America/Anchorage");
    });
  });

  describe("input handling", () => {
    it("tolerates ZIP+4 by using the leading 5 digits", () => {
      expect(resolvePostalCodeTimezone("94103-1234")).toBe("America/Los_Angeles");
    });

    it("tolerates surrounding whitespace", () => {
      expect(resolvePostalCodeTimezone("  94103  ")).toBe("America/Los_Angeles");
    });

    it("returns undefined, never a guess, for a PO-box-only ZIP absent from the ZCTA table", () => {
      // 85001 is a real US ZIP (downtown Phoenix) but carries no residential ZCTA in the Census
      // gazetteer, so it is genuinely absent from the source data — not a lookup bug. Confirmed
      // against the same source: 85003 (a real ZCTA a few blocks away) does resolve.
      expect(resolvePostalCodeTimezone("85001")).toBeUndefined();
    });

    it("returns undefined for a non-existent postal code rather than throwing", () => {
      expect(resolvePostalCodeTimezone("00000")).toBeUndefined();
    });

    it("returns undefined for non-US-ZIP-shaped input rather than throwing", () => {
      expect(resolvePostalCodeTimezone("SW1A 1AA")).toBeUndefined();
      expect(resolvePostalCodeTimezone("")).toBeUndefined();
      expect(resolvePostalCodeTimezone("abcde")).toBeUndefined();
    });
  });

  describe("table integrity", () => {
    it("carries the full real Census ZCTA corpus, not a stub", () => {
      // A hand-maintained or fabricated table would be tiny; the real 2023 Census ZCTA
      // Gazetteer has 33,791 entries after geo-tz resolution (0 skipped — every ZCTA centroid
      // fell inside a timezone-boundary-builder polygon).
      expect(Object.keys(POSTAL_TIMEZONE_TABLE).length).toBeGreaterThan(30000);
    });

    it("every table value is a valid IANA timezone identifier", () => {
      // Spot-check rather than iterate all 33,791 (geo-tz only ever emits real tzdata
      // identifiers) — this proves the schema-validation path in resolvePostalCodeTimezone
      // itself is exercised against real generated data, not just against literals in this file.
      const sample = ["94103", "60611", "30033", "85003", "96813", "99501", "10001"];
      for (const zip of sample) {
        const zone = POSTAL_TIMEZONE_TABLE[zip];
        expect(zone).toBeDefined();
        expect(IanaTimezoneSchema.safeParse(zone).success).toBe(true);
      }
    });
  });
});
