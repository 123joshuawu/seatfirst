import { defineConfig } from "vitest/config";

// Tiers are ordered by cost (docs/durability-harness-plan.md): a broken migration must
// fail in seconds, not after a suite of timeouts. Files are named tier<n>.* so the
// sequencer's alphabetical order is the tier order, run serially, and `--bail=1` in the
// `test` script stops at the first tier that fails.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    fileParallelism: false,
    sequence: { shuffle: false, concurrent: false },
    // Container start + per-test template clones; the default 5 s is not a useful bound here.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
    },
  },
});
