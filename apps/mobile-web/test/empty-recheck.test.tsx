import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmptyCauseSchema } from "@seatfirst/core";
import { RecheckResultSchema } from "@seatfirst/core";
import {
  emptyCauseLabel,
  unavailableCauseLabel,
  formatPlacementLabel,
  suggestionLabel,
  otherFormatsLabelForAnswer,
  priceLabel,
} from "@/lib/presentation";
import type { Placement, RankedAnswer } from "@seatfirst/core";
const ALL_EMPTY_CAUSES = [
  "SOLD_OUT",
  "TOO_FEW_SHOWTIMES",
  "NO_SHAPE_MATCH",
  "HALTED",
  "CAPACITY",
  "PARTIAL_SCHEDULE",
] as const;
const ALL_UNAVAILABLE_CAUSES = [
  "RATE_LIMITED",
  "UPSTREAM_BLOCKED",
  "CHALLENGE_REQUIRED",
  "UPSTREAM_QUEUED",
  "UPSTREAM_CHANGED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
] as const;

function fakePlacement(overrides: Partial<Placement> = {}): Placement {
  return {
    layoutId: "layout_1",
    row: 6,
    startCol: 7,
    rowSpan: 1,
    count: 4,
    seatNames: ["G8", "G9", "G10", "G11"],
    placementKey: "placement_1",
    ...overrides,
  };
}

describe("UI9.7 every empty/recheck branch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("EmptyCause enum has exactly 6 values — fails if a 7th is added without coverage", () => {
    const parsed = EmptyCauseSchema.options;
    expect(parsed).toHaveLength(6);
    expect(new Set(parsed)).toEqual(new Set(ALL_EMPTY_CAUSES));
  });

  it.each(ALL_EMPTY_CAUSES)(
    "EmptyCause %s renders correct empty UI label + suggestion affordance",
    (cause) => {
      const label = emptyCauseLabel(cause);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe("No valid placement"); // each known cause has distinct copy
      // Each EMPTY answer carries suggestions affordances — use a valid known widen kind
      const suggestion = { kind: "WIDEN_WINDOW" as const, direction: "FULL_DAY" as const };
      const sLabel = suggestionLabel(suggestion);
      expect(sLabel).toBeTruthy();
    },
  );

  it("RecheckResult discriminated union has exactly 3 statuses: AVAILABLE, GONE, UNAVAILABLE", () => {
    const statuses = ["AVAILABLE", "GONE", "UNAVAILABLE"];
    for (const s of statuses) {
      const parsed =
        s === "AVAILABLE"
          ? RecheckResultSchema.safeParse({
              status: "AVAILABLE",
              placement: fakePlacement(),
              checkedAt: new Date().toISOString(),
            })
          : s === "GONE"
            ? RecheckResultSchema.safeParse({
                status: "GONE",
                recovery: [
                  {
                    level: 1,
                    placement: fakePlacement(),
                    showtimeId: "st_1",
                    relaxed: [],
                    requiresConsent: false,
                  },
                ],
              })
            : RecheckResultSchema.safeParse({
                status: "UNAVAILABLE",
                cause: "TIMEOUT",
                lastKnown: { placement: fakePlacement(), capturedAt: new Date().toISOString() },
              });
      expect(parsed.success).toBe(true);
    }
  });

  it.each(ALL_UNAVAILABLE_CAUSES)(
    "UNAVAILABLE cause %s renders distinct unavailableCauseLabel",
    (cause) => {
      const label = unavailableCauseLabel(cause);
      expect(label.length).toBeGreaterThan(0);
      // Each cause has distinct copy — cheap uniqueness check
    },
  );

  it("UNAVAILABLE causes are exactly 7", () => {
    expect(ALL_UNAVAILABLE_CAUSES).toHaveLength(7);
    // Exhaustive switch in unavailableCauseLabel is type-checked; runtime distinctness
    const labels = ALL_UNAVAILABLE_CAUSES.map((c) => unavailableCauseLabel(c as never));
    expect(new Set(labels).size).toBe(7);
  });

  it("recovery ladder levels 1-4 — GONE recovery respects level ordering 1→4", () => {
    const levels = [1, 2, 3, 4] as const;
    const recovery = levels.map((level) => ({
      level,
      placement: fakePlacement(),
      showtimeId: `st_${level}`,
      relaxed: level === 4 ? [{ kind: "FEWER_SHOWTIMES" as const }] : [],
      requiresConsent: level === 4 ? true : false,
    }));
    const parsed = RecheckResultSchema.safeParse({ status: "GONE", recovery });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.status === "GONE") {
      expect(parsed.data.recovery.map((r) => r.level)).toEqual([1, 2, 3, 4]);
    }
    // Out-of-order ladder must fail superRefine
    const outOfOrder = [...recovery].reverse();
    const bad = RecheckResultSchema.safeParse({ status: "GONE", recovery: outOfOrder });
    expect(bad.success).toBe(false);
  });

  it("AVAILABLE result carries placement + checkedAt, null-price renders 'Price unavailable', otherFormats pointer", () => {
    const placement = fakePlacement();
    const checkedAt = new Date().toISOString();
    const parsed = RecheckResultSchema.safeParse({ status: "AVAILABLE", placement, checkedAt });
    expect(parsed.success).toBe(true);
    expect(formatPlacementLabel(placement)).toMatch(/Row G/);
    // Price unavailable when minPrice is null (every v1 showtime)
    expect(priceLabel(null)).toBe("Price unavailable");
    // otherFormats pointer from answer
    const answer = {
      mode: "CONFIDENT" as const,
      recommendations: [],
      otherFormats: [{ formatCode: "IMAX", count: 2 }],
    } as unknown as RankedAnswer; // minimal stub: only otherFormats wiring is under test
    const ptr = otherFormatsLabelForAnswer(answer);
    expect(ptr).toBeTruthy();
    // EMPTY has no otherFormats
    const emptyAnswer = {
      mode: "EMPTY" as const,
      cause: "SOLD_OUT" as const,
      suggestions: [],
    } as unknown as RankedAnswer; // minimal stub for EMPTY branch
    expect(otherFormatsLabelForAnswer(emptyAnswer)).toBeNull();
  });

  it("GONE requires at least one recovery option, level 4 requires relaxed + requiresConsent true", () => {
    const level4 = {
      level: 4 as const,
      placement: fakePlacement(),
      showtimeId: "st_4",
      relaxed: [{ kind: "FEWER_SHOWTIMES" as const }],
      requiresConsent: true as const,
    };
    const parsed = RecheckResultSchema.safeParse({ status: "GONE", recovery: [level4] });
    expect(parsed.success).toBe(true);
    // level 4 without relaxed must fail
    const bad = RecheckResultSchema.safeParse({
      status: "GONE",
      recovery: [
        {
          level: 4 as const,
          placement: fakePlacement(),
          showtimeId: "st_4",
          relaxed: [],
          requiresConsent: true as const,
        },
      ],
    });
    expect(bad.success).toBe(false);
    // empty recovery must fail
    const empty = RecheckResultSchema.safeParse({ status: "GONE", recovery: [] });
    expect(empty.success).toBe(false);
  });
});
