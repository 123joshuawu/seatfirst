import { RecommendationReasonSchema } from "@seatfirst/core";
import { describe, expect, it } from "vitest";

import { ProviderError, ProviderErrorCodeSchema, type ProviderErrorCode } from "../src/index.js";

const ALL_CODES: readonly ProviderErrorCode[] = [
  "UPSTREAM_BLOCKED",
  "CHALLENGE_REQUIRED",
  "UPSTREAM_QUEUED",
  "RATE_LIMITED",
  "UPSTREAM_CHANGED",
  "NOT_FOUND",
  "NO_RESULTS",
  "UPSTREAM_UNAVAILABLE",
] as const;

describe("ProviderErrorCodeSchema", () => {
  it.each(ALL_CODES)("round-trips %s", (code) => {
    expect(ProviderErrorCodeSchema.parse(ProviderErrorCodeSchema.parse(code))).toBe(code);
  });

  it("rejects a code outside the documented eight (closed enum)", () => {
    expect(ProviderErrorCodeSchema.safeParse("UPSTREAM_TIMEOUT").success).toBe(false);
  });

  it("is exactly the eight hand-transcribed codes, no more and no fewer", () => {
    // `ALL_CODES` above is transcribed by hand from `seatfirst-query-design.md:49`, not
    // derived from `ProviderErrorCodeSchema.options` — deriving it from the schema would make
    // this assert that the schema equals itself. A ninth code added to the schema without a
    // matching addition here fails this test instead of passing silently.
    expect(ProviderErrorCodeSchema.options).toEqual(ALL_CODES);
  });

  it("is closed where ADR 0003's wire enums are deliberately open — the asymmetry is intentional, not an oversight", () => {
    // Same shape of question — "is this unrecognized discriminant acceptable?" — answered
    // oppositely on purpose. If either schema's openness flips, this test breaks in the
    // direction that flipped, pinning both halves of the documented asymmetry.
    const unrecognizedProviderCode = ProviderErrorCodeSchema.safeParse("FARTHER_THEATRE");
    const unrecognizedWireVariant = RecommendationReasonSchema.safeParse({
      kind: "FARTHER_THEATRE",
    });
    expect(unrecognizedProviderCode.success).toBe(false);
    expect(unrecognizedWireVariant.success).toBe(true);
  });
});

describe("ProviderError", () => {
  it("carries the parsed code, message, name, and an empty default providerMeta", () => {
    const error = new ProviderError("RATE_LIMITED", "AMC returned HTTP 429");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.name).toBe("ProviderError");
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toBe("AMC returned HTTP 429");
    expect(error.providerMeta).toEqual({});
  });

  it("carries a supplied providerMeta verbatim", () => {
    const error = new ProviderError("UPSTREAM_CHANGED", "seat page markup did not match", {
      providerMeta: { rawStatus: "unexpected-layout-v2" },
    });
    expect(error.providerMeta).toEqual({ rawStatus: "unexpected-layout-v2" });
  });

  it("throws when constructed with a code outside the closed enum", () => {
    // Falsifiable: remove the `.parse` call from the constructor and this becomes a silent
    // pass-through instead of a throw.
    function constructWithInvalidCode(): ProviderError {
      // @ts-expect-error — intentionally outside the closed enum, to exercise the runtime guard
      // an adapter bug (not a type error) would otherwise hit.
      return new ProviderError("UPSTREAM_TIMEOUT", "should never construct");
    }
    expect(constructWithInvalidCode).toThrow();
  });
});
