import { defineConfig } from "vitest/config";

// Only pins the coverage provider; test discovery stays on vitest defaults.
export default defineConfig({
  test: {
    // The fixture-corpus replay loops every recorded fixture through the parse
    // pipeline; v8 instrumentation roughly doubles its wall time, so the default
    // 5 s bound is not useful here.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
    },
  },
});
