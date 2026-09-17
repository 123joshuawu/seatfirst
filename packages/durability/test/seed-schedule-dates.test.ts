import { describe, expect, it } from "vitest";

import {
  addLocalDays,
  assignFixtureDatesToWindow,
  SEED_RNG_SEED,
  SEED_WINDOW_DAYS,
} from "../scripts/seed-schedule-dates.js";

const WINDOW_START = "2026-09-04";
const IDS = [145927006, 145927008, 146024502, 146089621, 145927010];

function windowEnd(): string {
  return addLocalDays(WINDOW_START, SEED_WINDOW_DAYS - 1);
}

describe("assignFixtureDatesToWindow", () => {
  it("is deterministic: same input always produces the same output", () => {
    const first = assignFixtureDatesToWindow(IDS, WINDOW_START);
    const second = assignFixtureDatesToWindow(IDS, WINDOW_START);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("assigns every id to a date within the 30-day window", () => {
    expect(SEED_WINDOW_DAYS).toBe(30);
    const assigned = assignFixtureDatesToWindow(IDS, WINDOW_START);
    expect(assigned.size).toBe(IDS.length);
    for (const date of assigned.values()) {
      expect(date >= WINDOW_START).toBe(true);
      expect(date <= windowEnd()).toBe(true);
    }
  });

  it("is stable regardless of input array order", () => {
    const shuffled = [...IDS].reverse();
    const fromOrdered = assignFixtureDatesToWindow(IDS, WINDOW_START);
    const fromShuffled = assignFixtureDatesToWindow(shuffled, WINDOW_START);
    expect([...fromShuffled.entries()].sort()).toEqual([...fromOrdered.entries()].sort());
  });

  it("uses the fixed seed literal by default (explicit seed matches)", () => {
    const implicit = assignFixtureDatesToWindow(IDS, WINDOW_START);
    const explicit = assignFixtureDatesToWindow(IDS, WINDOW_START, SEED_WINDOW_DAYS, SEED_RNG_SEED);
    expect([...explicit.entries()]).toEqual([...implicit.entries()]);
  });

  it("spreads assignments across multiple dates for a realistic id count", () => {
    // 197 consecutive ids through the real seeded RNG: must not collapse to one date.
    const many = Array.from({ length: 197 }, (_, i) => 145927000 + i);
    const assigned = assignFixtureDatesToWindow(many, WINDOW_START);
    expect(new Set(assigned.values()).size).toBeGreaterThan(1);
  });
});

describe("addLocalDays", () => {
  it("adds whole days across a month boundary", () => {
    expect(addLocalDays("2026-09-04", 29)).toBe("2026-10-03");
    expect(addLocalDays("2026-09-04", 0)).toBe("2026-09-04");
  });
});
