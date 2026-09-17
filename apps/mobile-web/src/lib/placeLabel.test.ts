import { describe, expect, it } from "vitest";
import { formatUsPlaceLabel } from "./placeLabel";

describe("formatUsPlaceLabel", () => {
  it("strips United States and abbreviates California", () => {
    expect(formatUsPlaceLabel("San Francisco, California, United States")).toBe(
      "San Francisco, CA",
    );
  });

  it("leaves a non-state label unchanged", () => {
    // Non-US label with no United States terminal — unchanged
    expect(formatUsPlaceLabel("Paris, France")).toBe("Paris, France");
  });

  it("removes United States but leaves unknown terminal segment unchanged", () => {
    expect(formatUsPlaceLabel("Someplace, Unknownland, United States")).toBe(
      "Someplace, Unknownland",
    );
  });

  it("abbreviates a terminal state even without United States", () => {
    expect(formatUsPlaceLabel("San Francisco, California")).toBe("San Francisco, CA");
  });
});
