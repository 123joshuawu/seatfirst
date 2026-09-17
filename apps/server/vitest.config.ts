import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    // The Redis-backed suite starts a real Redis 7 container via
    // testcontainers (persistence disabled, matching ADR 0005 §A) and
    // exercises real reconnects; the default 5 s bound is not useful here.
    testTimeout: 60_000,
    hookTimeout: 240_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
    },
  },
});
