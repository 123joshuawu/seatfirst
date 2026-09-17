import base from "@seatfirst/config/eslint";

export default [
  {
    ignores: ["**/.pi/**"],
  },
  ...base,
  {
    // The durability harness reads rows out of Postgres, whose shape is decided by the SQL
    // in `src/boundaries.ts` rather than by TypeScript. Naming a type for every projection
    // would restate the `RETURNING` clause in a second place that can drift from it — and
    // the assertion in the test, not the annotation, is what actually checks the shape.
    // Scoped to the harness's tests: the "no `any` across the adapter boundary" rule
    // (architecture §12) still applies everywhere it means something.
    files: ["packages/durability/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
];
