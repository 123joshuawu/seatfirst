import { describe, it, expect } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { Chip } from "@/components/core/Chip";
import { ChipRow } from "@/components/search/ChipRow";

function renderChip(active: boolean, checkbox = false): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(
      React.createElement(Chip, { label: "Friday", active, onPress: () => {}, checkbox }),
    );
  });
  return JSON.stringify(renderer.toJSON());
}

describe("Chip a11y state — date chips must not invert selected/checked", () => {
  it("pill chip (dates) active=true => accessibilityState.selected true", () => {
    const strActive = renderChip(true, false);
    expect(strActive).toContain('"selected":true');
    const strInactive = renderChip(false, false);
    expect(strInactive).toContain('"selected":false');
  });

  it("pill chip inactive does not report selected true (no inversion)", () => {
    const str = renderChip(false, false);
    expect(str).not.toContain('"selected":true');
  });

  it("checkbox chip (seatPrefs) active=true => checked true", () => {
    const strActive = renderChip(true, true);
    expect(strActive).toContain('"checked":true');
    const strInactive = renderChip(false, true);
    expect(strInactive).toContain('"checked":false');
  });

  it("ChipRow renders Friday active chips with correct selected state (behavior)", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChipRow, {
          label: "Dates",
          chips: [
            { label: "Friday", active: true, onPress: () => {} },
            { label: "Saturday", active: false, onPress: () => {} },
          ],
        }),
      );
    });
    const str = JSON.stringify(renderer.toJSON());
    // Friday active => selected true should appear once
    expect((str.match(/"selected":true/g) || []).length).toBe(1);
    expect((str.match(/"selected":false/g) || []).length).toBe(1);
  });
});
