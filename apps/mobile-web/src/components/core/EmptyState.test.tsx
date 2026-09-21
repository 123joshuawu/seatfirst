import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { EmptyState } from "./EmptyState";

function renderState(props: Parameters<typeof EmptyState>[0]): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(EmptyState, props));
  });
  return renderer;
}

function tapByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const targets = renderer.root.findAll((node) => node.props?.accessibilityLabel === label);
  expect(targets.length).toBeGreaterThan(0);
  const target = targets[0]!;
  act(() => {
    (target.props as { onPress: () => void }).onPress();
  });
}

describe("EmptyState (UI38.1)", () => {
  it("renders title and description with no actions", () => {
    const renderer = renderState({ title: "No showtimes found", description: "Try another date." });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("No showtimes found");
    expect(str).toContain("Try another date.");
    const buttons = renderer.root.findAll((node) => node.props?.accessibilityRole === "button");
    expect(buttons).toHaveLength(0);
    renderer.unmount();
  });

  it("marks the container as summary and the title as header", () => {
    const renderer = renderState({
      title: "No showtimes found",
      description: "Try another date.",
      testID: "empty-state-no-results",
    });
    const str = JSON.stringify(renderer.toJSON());
    const summaries = renderer.root.findAll((node) => node.props?.accessibilityRole === "summary");
    // Composite View and its host both carry the role; at least one exposes
    // the accessible container contract with this state's testID.
    expect(
      summaries.filter(
        (node) => node.props.accessible === true && node.props.testID === "empty-state-no-results",
      ).length,
    ).toBeGreaterThan(0);
    const headers = renderer.root.findAll((node) => node.props?.accessibilityRole === "header");
    expect(headers.length).toBeGreaterThan(0);
    expect(str).toContain("No showtimes found");
    renderer.unmount();
  });

  it("renders a primary action by default and fires onPress on tap", () => {
    const onPress = vi.fn();
    const renderer = renderState({
      title: "No showtimes found",
      description: "Try another date.",
      action: { label: "Adjust search", onPress, testID: "empty-action" },
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("empty-action");
    tapByLabel(renderer, "Adjust search");
    expect(onPress).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("renders primary and secondary actions together and fires both onPress callbacks", () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    const renderer = renderState({
      title: "No showtimes match your criteria",
      description: "Try adjusting your search or party size.",
      action: { label: "Edit search", onPress: onPrimary },
      secondaryAction: {
        label: "See other dates",
        onPress: onSecondary,
        testID: "empty-secondary",
      },
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Edit search");
    expect(str).toContain("See other dates");
    // SecondaryButton drops testID (UI35), so the id rides a wrapping View.
    const wrapped = renderer.root.findAll((node) => node.props?.testID === "empty-secondary");
    expect(wrapped.length).toBeGreaterThan(0);
    tapByLabel(renderer, "Edit search");
    tapByLabel(renderer, "See other dates");
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("honors an explicit variant override on either slot", () => {
    const onPress = vi.fn();
    const renderer = renderState({
      title: "No seats to preview",
      description: "Adjust your filters.",
      action: { label: "Reset", onPress, variant: "secondary" },
      secondaryAction: { label: "Go", onPress, variant: "primary", testID: "empty-go" },
    });
    // Primary-slot override renders through SecondaryButton (no direct testID);
    // secondary-slot override renders through PrimaryButton (testID on the button).
    const goButtons = renderer.root.findAll(
      (node) => node.props?.accessibilityRole === "button" && node.props?.testID === "empty-go",
    );
    expect(goButtons.length).toBeGreaterThan(0);
    tapByLabel(renderer, "Reset");
    tapByLabel(renderer, "Go");
    expect(onPress).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it("renders a provided icon above the title", () => {
    const renderer = renderState({
      icon: React.createElement("span", null, "ICON-GLYPH"),
      title: "No showtimes found",
      description: "Try another date.",
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("ICON-GLYPH");
    renderer.unmount();
  });
});
