import { defineConfig } from "vitest/config";

// Only pins the coverage provider; test discovery stays on vitest defaults.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
    },
  },
});
