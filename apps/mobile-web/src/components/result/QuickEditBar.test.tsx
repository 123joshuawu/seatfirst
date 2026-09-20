import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { QuickEditBar } from "./QuickEditBar";

vi.mock("@/components/core/AppText", () => ({
  AppText: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/core/Button", () => ({
  TextLinkButton: () => null,
}));
vi.mock("react-native", () => ({ StyleSheet: { create: (s: unknown) => s }, View: "View" }));

function renderTitle(movieTitle: string, theaterName: string): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(
      React.createElement(QuickEditBar, {
        movieTitle,
        theaterName,
        quickFormatLabel: "Any format",
        quickPartyLabel: "2",
        quickWindowLabel: "Tonight",
        showEditAction: false,
        actions: { backToSearch: () => {}, changeFormat: () => {}, widenWindow: () => {} },
      }),
    );
  });
  return JSON.stringify(renderer.toJSON());
}

describe("QuickEditBar title", () => {
  it("joins both values with separator", () => {
    expect(renderTitle("The Odyssey", "AMC Metreon")).toContain("The Odyssey · AMC Metreon");
  });
  it("omits separator when theater is empty", () => {
    const out = renderTitle("The Odyssey", "");
    expect(out).toContain("The Odyssey");
    expect(out).not.toContain("The Odyssey · ");
    expect(out).not.toContain("· AMC");
  });
});
