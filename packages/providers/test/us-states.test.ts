import { describe, it, expect } from "vitest";
import { normalizeStateCode } from "../src/amc/us-states.js";

describe("normalizeStateCode", () => {
  it("maps a full state name to its 2-letter code", () => {
    expect(normalizeStateCode("Georgia")).toBe("GA");
  });

  it("is case-insensitive", () => {
    expect(normalizeStateCode("georgia")).toBe("GA");
  });

  it("passes an already-valid 2-letter code through as identity", () => {
    expect(normalizeStateCode("GA")).toBe("GA");
  });

  it("passes unrecognized input through unchanged rather than throwing", () => {
    expect(normalizeStateCode("Nonexistent Place")).toBe("Nonexistent Place");
  });
});
