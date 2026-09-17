import { defineConfig } from "vitest/config";

// Scoped separately from every package's own `vitest.config.ts`: this repo's root-level
// `scripts/*.mjs` are not part of any pnpm workspace package, so they need their own project
// root and their own narrow `include` — otherwise a bare `vitest run` from the repo root would
// also try (and fail) to discover every package's tests without their package-local config.
// `.mjs`, not `.ts`: there is no root `tsconfig.json` for the type-aware eslint project
// service to attach a loose root-level `.ts` file to (`eslint.base.js`'s comment on config
// files applies here too — this is scaffolding, not part of any package's type graph).
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["scripts/**"],
    },
  },
});
