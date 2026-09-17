// Proves the fixture-hygiene guard's leakage detector (packages/providers/scripts/
// check-fixture-hygiene.mjs) actually fires on every signature class it claims to check,
// not just passes vacuously on already-clean fixtures. See that script's header for why the
// check exists and why it deliberately mirrors capture-redact.ts's full TOKEN_REGEXES set
// (broader than that module's own narrower fail-closed spot-check).

import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations; imported for its pure function only.
import { detectLeakage as detectLeakageUntyped } from "../scripts/check-fixture-hygiene.mjs";

const detectLeakage = detectLeakageUntyped as (content: string) => string[];

describe("check-fixture-hygiene.mjs detectLeakage", () => {
  it("passes clean, ordinary HTML/script content", () => {
    const clean = `<!doctype html><html><body><script>self.__next_f.push([1,"hello"])</script></body></html>`;
    expect(detectLeakage(clean)).toEqual([]);
  });

  it("catches an unredacted JWT", () => {
    const leak = `"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"`;
    expect(detectLeakage(leak).join(" ")).toMatch(/JWT/);
  });

  it("catches a Queue-it wait token / UUID marker", () => {
    expect(detectLeakage("redirect?c=1a2b3c4d-5678-90ab").join(" ")).toMatch(/Queue-it/);
  });

  it("catches an unredacted cf_clearance cookie value", () => {
    expect(detectLeakage("Set-Cookie: cf_clearance=abcDEF123_-").join(" ")).toMatch(/cf_clearance/);
  });

  it("catches an unredacted __cf_bm cookie value", () => {
    expect(detectLeakage("Set-Cookie: __cf_bm=abcDEF123_-").join(" ")).toMatch(/__cf_bm/);
  });

  it("catches a CF-Ray trace", () => {
    expect(detectLeakage("cf-ray: 7d1f2e3a4b5c6d7e-SJC").join(" ")).toMatch(/CF-Ray/);
  });

  it("catches a Bearer token", () => {
    expect(detectLeakage("Authorization: Bearer abc123.def456-ghi").join(" ")).toMatch(/Bearer/);
  });

  it("catches a raw Cookie header line", () => {
    expect(detectLeakage("Cookie: session=abc123; other=xyz").join(" ")).toMatch(/Cookie header/);
  });

  it("catches an unredacted IPv4 address", () => {
    expect(detectLeakage("client ip 203.0.113.42 connected").join(" ")).toMatch(/IPv4/);
  });

  it("catches an unredacted IPv6 address", () => {
    expect(
      detectLeakage("client ip 2001:0db8:85a3:0000:0000:8a2e:0370:7334 connected").join(" "),
    ).toMatch(/IPv6/);
  });
});
