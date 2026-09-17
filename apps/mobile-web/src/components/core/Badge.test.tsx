import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders tag variant with label and does not suppress accessibility tree", () => {
    const el = Badge({ label: "Matinee", background: "#f6e6d6", color: "#974d0e" }) as unknown as {
      props: Record<string, unknown>;
    };
    // Root container View must not silence screen readers with accessible=false or importantForAccessibility="no"
    expect(el.props.accessible).toBeUndefined();
    expect(el.props.importantForAccessibility).toBeUndefined();
  });

  it("renders eyebrow variant without accessibility suppression", () => {
    const el = Badge({
      label: "Sold out",
      background: "#fee2e2",
      color: "#991b1b",
      variant: "eyebrow",
    }) as unknown as { props: Record<string, unknown> };
    expect(el.props.accessible).toBeUndefined();
    expect(el.props.importantForAccessibility).toBeUndefined();
  });
});
