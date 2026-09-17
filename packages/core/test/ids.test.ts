import { describe, expect, it } from "vitest";

import {
  MovieIdSchema,
  ShowtimeIdSchema,
  TheatreIdSchema,
  formatNamespacedId,
  parseNamespacedId,
  type NamespacedIdParts,
} from "../src/index.js";

describe("namespaced identifiers", () => {
  const cases: readonly NamespacedIdParts[] = [
    { providerId: "amc", kind: "showtime", raw: "142125592" },
    { providerId: "amc", kind: "theatre", raw: "2325" },
    { providerId: "cinema", kind: "movie", raw: "catalog:78421" },
  ];

  it.each(cases)("round-trips $kind identifiers", (parts) => {
    const formatted = formatNamespacedId(parts);
    expect(parseNamespacedId(formatted)).toEqual({ ok: true, value: parts });
    const parsed = parseNamespacedId(formatted);
    expect(parsed.ok && formatNamespacedId(parsed.value)).toBe(formatted);
  });

  it("returns a typed failure for malformed and unknown-kind identifiers", () => {
    expect(parseNamespacedId("142125592")).toEqual({
      ok: false,
      error: { code: "INVALID_NAMESPACED_ID", value: "142125592" },
    });
    expect(parseNamespacedId("amc:screening:1").ok).toBe(false);
    expect(parseNamespacedId("amc:movie:").ok).toBe(false);
  });

  it("enforces the kind-specific schemas without a provider allowlist", () => {
    expect(ShowtimeIdSchema.parse("future:showtime:one")).toBe("future:showtime:one");
    expect(TheatreIdSchema.safeParse("amc:showtime:1").success).toBe(false);
    expect(MovieIdSchema.safeParse("movie:1").success).toBe(false);
  });
});
