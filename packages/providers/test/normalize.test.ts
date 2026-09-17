import { describe, it, expect } from "vitest";
import {
  FORMAT_CODE_MAP,
  ATTRIBUTE_CODE_MAP,
  normalizeFormatCode,
  normalizeAttributeCode,
  resolvePooledOffering,
} from "../src/amc/normalize.js";

// P5.4/ADR 0008 (docs/adr/0008-p5-4-format-attribute-vocabulary.md, approved): FORMAT_CODE_MAP/
// ATTRIBUTE_CODE_MAP hold two disjoint domains — real upstream API `code` values (still no
// evidence, still absent) and ADR 0008's approved schedule-DOM display-name vocabulary
// (12 format + 22 attribute entries, populated below).
describe("AMC format/attribute normalization (P5.4/ADR 0008)", () => {
  it("ships with ADR 0008's approved vocabulary and no unevidenced API-code entries", () => {
    expect(Object.keys(FORMAT_CODE_MAP)).toHaveLength(12);
    expect(Object.keys(ATTRIBUTE_CODE_MAP)).toHaveLength(22);
    // Spot-check a couple of real-API-code-shaped keys are absent — the empty-domain claim.
    expect(FORMAT_CODE_MAP["IMAX"]).toBeUndefined();
    expect(ATTRIBUTE_CODE_MAP["REC"]).toBeUndefined();
  });

  it("passes an unrecognized native format code through unchanged", () => {
    expect(normalizeFormatCode("IMAX")).toBe("IMAX");
    expect(normalizeFormatCode("Some Future Native Code")).toBe("Some Future Native Code");
  });

  it("passes an unrecognized native attribute code through unchanged", () => {
    expect(normalizeAttributeCode("REC")).toBe("REC");
    expect(normalizeAttributeCode("Some Future Native Code")).toBe("Some Future Native Code");
  });
});

// ADR 0008 (docs/adr/0008-p5-4-format-attribute-vocabulary.md, approved): the schedule-page DOM
// resolver's raw display-name vocabulary is a separate table/mechanism from FORMAT_CODE_MAP/
// ATTRIBUTE_CODE_MAP above.
describe("AMC schedule-page offering vocabulary (ADR 0008)", () => {
  it("ships with the approved 34-entry combined vocabulary", () => {
    expect(Object.keys(FORMAT_CODE_MAP).length + Object.keys(ATTRIBUTE_CODE_MAP).length).toBe(34);
  });

  it("pools raw strings from both the heading and badge positions into attributes", () => {
    const result = resolvePooledOffering([
      { raw: "Laser at AMC", fromHeading: true },
      { raw: "AMC Signature Recliners", fromHeading: false },
      { raw: "Reserved Seating", fromHeading: false },
      { raw: "Closed Caption", fromHeading: false },
    ]);
    expect(result.attributes).toEqual([
      "laseratamc",
      "reclinerseating",
      "reservedseating",
      "closedcaption",
    ]);
    expect(result.formatCode).toBe("laseratamc");
  });

  it("dedupes a raw string observed in both the heading and a badge", () => {
    const result = resolvePooledOffering([
      { raw: "Laser at AMC", fromHeading: true },
      { raw: "Laser at AMC", fromHeading: false },
    ]);
    expect(result.attributes).toEqual(["laseratamc"]);
    expect(result.formatCode).toBe("laseratamc");
  });

  it("prefers the heading-position format code when multiple FORMAT_CODE_MAP codes are pooled", () => {
    // Real corpus case (ADR 0008): heading "IMAX 70MM" alongside badges "IMAX at AMC" and
    // "70mm" — three FORMAT_CODE_MAP members on one card. All three land in attributes; the
    // heading-position one wins formatCode, as a tie-break only, not a category rule.
    const result = resolvePooledOffering([
      { raw: "IMAX 70MM", fromHeading: true },
      { raw: "IMAX at AMC", fromHeading: false },
      { raw: "70mm", fromHeading: false },
    ]);
    expect(result.attributes).toEqual(["imax70mm", "imax", "70mm"]);
    expect(result.formatCode).toBe("imax70mm");
  });

  it("throws rather than inventing a precedence when multiple format candidates are pooled and none came from the heading position", () => {
    // ADR 0008 does not specify a tie-break for this shape (not observed in the corpus it was
    // approved against). `resolvePooledOffering` surfaces it as a thrown error rather than
    // silently picking one, matching this codebase's UPSTREAM_CHANGED-surfacing convention.
    expect(() =>
      resolvePooledOffering([
        { raw: "IMAX at AMC", fromHeading: false },
        { raw: "70mm", fromHeading: false },
      ]),
    ).toThrow(/does not specify a tie-break/);
  });

  it('reuses the select\'s prime3d code for the inexact-match heading text "PRIME 3D"', () => {
    const result = resolvePooledOffering([{ raw: "PRIME 3D", fromHeading: true }]);
    expect(result.formatCode).toBe("prime3d");
    expect(result.attributes).toEqual(["prime3d"]);
  });

  it("drops a raw string absent from the table rather than inventing a code for it", () => {
    const result = resolvePooledOffering([
      { raw: "Laser at AMC", fromHeading: true },
      { raw: "Some Future AMC Offering Nobody Has Reviewed", fromHeading: false },
    ]);
    expect(result.attributes).toEqual(["laseratamc"]);
    expect(result.formatCode).toBe("laseratamc");
  });

  it("returns a null formatCode and empty attributes when nothing is pooled", () => {
    const result = resolvePooledOffering([]);
    expect(result).toEqual({ formatCode: null, attributes: [] });
  });

  it("returns a null formatCode when every pooled code is non-format", () => {
    const result = resolvePooledOffering([
      { raw: "Reserved Seating", fromHeading: false },
      { raw: "Closed Caption", fromHeading: false },
    ]);
    expect(result.formatCode).toBeNull();
    expect(result.attributes).toEqual(["reservedseating", "closedcaption"]);
  });
});
