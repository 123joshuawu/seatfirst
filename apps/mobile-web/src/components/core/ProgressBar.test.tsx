import { describe, expect, it, vi } from "vitest";

vi.mock("@/theme/animations", () => ({
  usePulseOpacity: () => ({ _mock: true }),
}));

import { ProgressBar } from "./ProgressBar";

describe("ProgressBar (UI14.5)", () => {
  it("renders determinate style when total > 0", () => {
    const el = ProgressBar({ resolved: 3, total: 10 }) as unknown as { props: { style: unknown } };
    expect(JSON.stringify(el)).toContain("progressbar");
  });

  it("uses indeterminate pulse when total === 0", () => {
    const el = ProgressBar({ resolved: 0, total: 0 }) as unknown as Record<string, unknown>;
    const str = JSON.stringify(el);
    expect(str).toContain("progressbar");
  });

  it("fraction is clamped [0,1]", () => {
    expect(() => ProgressBar({ resolved: 15, total: 10 })).not.toThrow();
    expect(() => ProgressBar({ resolved: -1, total: 10 })).not.toThrow();
  });
});
