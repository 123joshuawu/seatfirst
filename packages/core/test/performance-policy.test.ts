import { describe, expect, it } from "vitest";

import { ShowtimeStatusSchema, performancePolicy, type ShowtimeStatus } from "../src/index.js";

describe("performancePolicy", () => {
  it("maps every schema member to its accepted policy", () => {
    const expected: Readonly<Record<ShowtimeStatus, ReturnType<typeof performancePolicy>>> = {
      OPEN: "FETCH",
      LOW_AVAILABILITY: "FETCH",
      SOLD_OUT: "SKIP_SOLD_OUT",
      CANCELED: "SKIP_SOLD_OUT",
      UNKNOWN: "FETCH_UNKNOWN",
    };

    expect(ShowtimeStatusSchema.options).toHaveLength(Object.keys(expected).length);
    for (const status of ShowtimeStatusSchema.options) {
      expect(performancePolicy(status)).toBe(expected[status]);
    }
  });

  it("fails open for an unrecognized persisted runtime value", () => {
    expect(performancePolicy("FUTURE_STATUS" as ShowtimeStatus)).toBe("FETCH_UNKNOWN");
  });
});
