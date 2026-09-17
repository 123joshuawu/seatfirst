import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { CollapsedFormBar } from "./CollapsedFormBar";
import { makeMockVm, setMockVm } from "../../../test/mockViewModels";

vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

describe("CollapsedFormBar (UI7 regression)", () => {
  it("keeps the compact search summary accessible and re-expands the form", () => {
    const setFormCollapsed = vi.fn();
    const vm = makeMockVm({
      theaterName: "AMC Metreon 16",
      theaterCity: "San Francisco",
      quickWindowLabel: "This weekend · Evenings",
      quickFormatLabel: "Any format",
      quickPartyLabel: "4 seats",
      actions: { setFormCollapsed },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create((setMockVm(vm), React.createElement(CollapsedFormBar, null)));
    });

    const button = renderer.root.findByProps({
      accessibilityLabel:
        "AMC Metreon 16 · This weekend · Evenings · Any format · 4 seats, Edit search",
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Edit search");
    const onPress = (button.props as unknown as { onPress: () => void }).onPress;
    act(() => onPress());
    expect(setFormCollapsed).toHaveBeenCalledWith(false);
  });
});
