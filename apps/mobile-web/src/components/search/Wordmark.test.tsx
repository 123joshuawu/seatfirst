import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { AppText } from "@/components/core/AppText";
import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("renders the dot + Seatfirst wordmark row", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(Wordmark, null));
    });
    const marks = renderer.root
      .findAllByType(AppText)
      .filter((n) => n.props.children === "Seatfirst");
    expect(marks).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Seatfirst");
    renderer.unmount();
  });
});
