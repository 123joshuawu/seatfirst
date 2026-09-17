import { describe, expect, it, vi } from "vitest";

vi.mock("@/theme/animations", () => ({
  useSpinValue: () => "0deg",
}));

import { LoadingSpinner } from "./LoadingSpinner";

describe("LoadingSpinner", () => {
  it("exposes progressbar accessibility role and default label", () => {
    const el = LoadingSpinner() as unknown as { props: Record<string, unknown> };
    expect(el.props.accessibilityRole).toBe("progressbar");
    expect(el.props.accessibilityLabel).toBe("Loading…");
    expect(el.props.accessible).toBeUndefined();
    expect(el.props.importantForAccessibility).toBeUndefined();
  });

  it("supports custom accessibility label", () => {
    const el = LoadingSpinner({ accessibilityLabel: "Rechecking seats…" }) as unknown as {
      props: Record<string, unknown>;
    };
    expect(el.props.accessibilityRole).toBe("progressbar");
    expect(el.props.accessibilityLabel).toBe("Rechecking seats…");
  });

  it("defaults to the 34px mockup size", () => {
    const el = LoadingSpinner() as unknown as { props: { style: Record<string, unknown> } };
    expect(el.props.style).toMatchObject({
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 3,
    });
  });

  it("custom size overrides the rendered width/height/borderRadius", () => {
    const el = LoadingSpinner({ size: 14 }) as unknown as {
      props: { style: Record<string, unknown> };
    };
    expect(el.props.style).toMatchObject({ width: 14, height: 14, borderRadius: 7 });
  });
});
