import { describe, it, expect } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { ReplacementCard } from "@/components/flow/ReplacementCard";
import type { Placement, RecoveryOption } from "@seatfirst/core";

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

function optionForLevel(level: RecoveryOption["level"]): RecoveryOption {
  const base = {
    placement: fakePlacement({ placementKey: `placement_${level}` }),
    showtimeId: `st_${level}`,
  };
  switch (level) {
    case 1:
      return { ...base, level: 1, relaxed: [], requiresConsent: false };
    case 2:
      return { ...base, level: 2, relaxed: [], requiresConsent: false };
    case 3:
      return { ...base, level: 3, relaxed: [], requiresConsent: false };
    case 4:
      return {
        ...base,
        level: 4,
        relaxed: [{ kind: "LATER_THAN_PREFERRED" as const }],
        requiresConsent: true as const,
      };
  }
}

function renderLabels(recovery: readonly RecoveryOption[]): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(ReplacementCard, { recovery }));
  });
  return JSON.stringify(renderer.toJSON());
}

const EXPECTED: Readonly<Record<RecoveryOption["level"], string>> = {
  1: "Closest seats nearby",
  2: "Same seats, different showtime",
  3: "Different seats, same showtime",
  4: "A different showtime",
};

describe("ReplacementCard recovery badge labels", () => {
  it.each([1, 2, 3, 4] as const)(
    "level %i renders its friendly label, not the raw 'Level N' string",
    (level) => {
      const output = renderLabels([optionForLevel(level)]);
      expect(output).toContain(EXPECTED[level]);
      expect(output).not.toContain(`Level ${level}`);
    },
  );

  it("a full 1-4 ladder renders all four friendly labels and no raw level badges", () => {
    const output = renderLabels([1, 2, 3, 4].map((l) => optionForLevel(l as 1 | 2 | 3 | 4)));
    for (const label of Object.values(EXPECTED)) {
      expect(output).toContain(label);
    }
    for (const level of [1, 2, 3, 4]) {
      expect(output).not.toContain(`Level ${level}`);
    }
  });

  it("level 4 keeps its consent-required UI alongside the friendly label", () => {
    const output = renderLabels([optionForLevel(4)]);
    expect(output).toContain("A different showtime");
    expect(output).toContain("Requires consent");
    expect(output).toContain("I understand this is a different showtime and seat");
  });
});
