import { defineConfig } from "vitest/config";

// The corridor suite drives real Chrome processes (offline, against the synthetic
// fulfillment harness — never AMC). One Chrome at a time keeps the suite deterministic;
// the generous timeouts are test-harness bounds, not the injected runtime tunables
// (those — navigation timeout, cleanup grace, readiness timeout — are per-call
// parameters inside the tests, gate 14 / ADR 0006).
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
    },
  },
});
