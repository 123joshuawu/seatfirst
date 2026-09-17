import { describe, expect, it } from "vitest";

import { localSeedDate } from "../scripts/seed-date.js";

const date = (value: string) => new Date(`${value}T12:00:00.000Z`);

describe("localSeedDate", () => {
  it.each([
    ["2026-08-28", "2026-08-28"], // Friday: preserve today.
    ["2026-08-29", "2026-08-29"], // Saturday: preserve today.
    ["2026-08-30", "2026-08-30"], // Sunday: preserve today.
    ["2026-08-24", "2026-08-28"], // Monday: next Friday.
    ["2026-08-25", "2026-08-28"], // Tuesday: next Friday.
    ["2026-08-26", "2026-08-28"], // Wednesday: next Friday.
    ["2026-08-27", "2026-08-28"], // Thursday: next Friday.
  ])("maps %s to %s", (input, expected) => {
    expect(localSeedDate(date(input))).toBe(expected);
  });

  it("always returns a Friday, Saturday, or Sunday", () => {
    for (let day = 0; day < 7; day += 1) {
      const input = new Date(Date.UTC(2026, 7, 23 + day));
      const result = date(localSeedDate(input)).getUTCDay();
      expect([0, 5, 6]).toContain(result);
    }
  });
});
