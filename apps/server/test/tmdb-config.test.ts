import { describe, expect, it } from "vitest";

import { tmdbConfigFromEnv } from "../src/tmdb/config.js";

describe("tmdbConfigFromEnv (S25.5, ADR 0019 amendment decision 4)", () => {
  it("reads TMDB_API_KEY", () => {
    expect(tmdbConfigFromEnv({ TMDB_API_KEY: "secret" })).toEqual({ apiKey: "secret" });
  });

  it("rejects a missing key (no hardcoded default)", () => {
    expect(() => tmdbConfigFromEnv({})).toThrow(/TMDB_API_KEY is required and has no default/);
  });

  it("rejects an empty key", () => {
    expect(() => tmdbConfigFromEnv({ TMDB_API_KEY: "" })).toThrow(/TMDB_API_KEY is required/);
  });
});
