import { defineConfig, type ViteUserConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "react-native": path.resolve(__dirname, "src/__mocks__/react-native.ts"),
      "test-renderer": path.resolve(__dirname, "node_modules/react-test-renderer"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      // Test-double shims aliased over real modules are not production code, and
      // neither is the dev-only scenario seeder and its fixtures.
      exclude: ["src/__mocks__/**", "src/fixtures/**", "src/components/dev/**"],
    },
  },
  // Vite server deps inline for RNTL CJS transform. Vitest reads `server.deps.inline`
  // at runtime, but Vite's ServerOptions type doesn't declare `deps`, so the value is
  // cast through a typed ServerOptions shape rather than `as any`.
  server: {
    deps: { inline: [/@testing-library\/react-native/, /react-test-renderer/] },
  } as unknown as NonNullable<ViteUserConfig["server"]>,
});
