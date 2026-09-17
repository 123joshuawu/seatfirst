import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared flat config for the whole workspace. Consumed by the root eslint.config.js.
 * Type-aware rules are on: the architecture's "no `any` across the adapter boundary"
 * rule (§12) is only enforceable with type information.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.expo/**",
      "**/cdk.out/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Config files and other loose JS are not part of any tsconfig project. They run
    // directly under Node (a shebang script, or a tool config file), so Node's globals
    // (`process`, `console`, `__dirname`, …) are in scope — nothing here runs in a browser.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
);
