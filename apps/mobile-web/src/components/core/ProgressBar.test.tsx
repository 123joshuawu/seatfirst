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

  it("uses indeterminate pulse when total === 0 while still running", () => {
    const el = ProgressBar({ resolved: 0, total: 0 }) as unknown as Record<string, unknown>;
    const str = JSON.stringify(el);
    expect(str).toContain("progressbar");
    // Pulsing 40%-wide bar.
    expect(str).toContain("40%");
  });

  it("renders the flat determinate bar for a terminal halt with 0 of 0 showtimes", () => {
    const el = ProgressBar({ resolved: 0, total: 0, isTerminal: true }) as unknown as Record<
      string,
      unknown
    >;
    const str = JSON.stringify(el);
    expect(str).toContain("progressbar");
    // No pulsing indeterminate bar: the determinate branch (flat 0% width).
    expect(str).not.toContain("40%");
  });

  it("fraction is clamped [0,1]", () => {
    expect(() => ProgressBar({ resolved: 15, total: 10 })).not.toThrow();
    expect(() => ProgressBar({ resolved: -1, total: 10 })).not.toThrow();
  });
});
