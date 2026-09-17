import { describe, it, expect } from "vitest";
import { redactHeaders } from "../src/amc/redact.js";

/**
 * `redactHeaders()` has a second, production call site (P6, ADR 0005 §D) and must carry
 * coverage independent of the fixture-capture `redact()` assertions
 * (`docs/adr/0005-security-privacy-operations.md:308-312`).
 */
describe("redactHeaders (ADR 0005 §D / P6.12)", () => {
  it("passes through only the six allowlisted headers, dropping everything else", () => {
    const output = redactHeaders({
      "content-type": "text/html",
      "content-length": "4096",
      date: "Wed, 12 Aug 2026 10:00:00 GMT",
      server: "cloudflare",
      "cf-mitigated": "challenge",
      "retry-after": "60",
      // Banned keys must not pass through — allowlist, not denylist (P3.1 pattern).
      "set-cookie": "qf_token=secret",
      cookie: "session=abc",
      "cf-ray": "8f1a2b3c4d5e6f7-LAX",
      authorization: "Bearer tok",
      "x-invented-header": "value",
    });

    expect(Object.keys(output).sort()).toEqual([
      "cf-mitigated",
      "content-length",
      "content-type",
      "date",
      "retry-after",
      "server",
    ]);
  });

  it("preserves original key casing of allowlisted headers", () => {
    const output = redactHeaders({ SERVER: "cloudflare", "Content-Type": "text/html" });
    expect(output["SERVER"]).toBe("cloudflare");
    expect(output["Content-Type"]).toBe("text/html");
  });

  it("scrubs an IPv4 literal inside an allowlisted header value", () => {
    const output = redactHeaders({ server: "proxy at 192.0.2.1" });
    expect(output["server"]).toBe("proxy at [REDACTED_IPV4]");
    expect(output["server"]).not.toContain("192.0.2.1");
  });

  it("scrubs every IPv4 literal in a value, not just the first", () => {
    const output = redactHeaders({ server: "10.0.0.1 via 10.0.0.2" });
    expect(output["server"]).toBe("[REDACTED_IPV4] via [REDACTED_IPV4]");
  });

  it("scrubs full and compressed IPv6 literals inside an allowlisted header value", () => {
    const output = redactHeaders({
      server: "edge 2001:db8::1 behind 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    });
    expect(output["server"]).toBe("edge [REDACTED_IPV6] behind [REDACTED_IPV6]");
    expect(output["server"]).not.toContain("2001:db8");
    expect(output["server"]).not.toContain("8a2e");
  });

  it("scrubs a loopback IPv6 literal (::1)", () => {
    const output = redactHeaders({ server: "localhost ::1" });
    expect(output["server"]).toBe("localhost [REDACTED_IPV6]");
  });

  it("returns non-IP allowlisted values unchanged", () => {
    const output = redactHeaders({
      "content-type": "text/html; charset=utf-8",
      date: "Wed, 12 Aug 2026 10:00:00 GMT",
      server: "nginx/1.25.3",
    });
    expect(output["content-type"]).toBe("text/html; charset=utf-8");
    expect(output["date"]).toBe("Wed, 12 Aug 2026 10:00:00 GMT");
    expect(output["server"]).toBe("nginx/1.25.3");
  });

  it("conservatively scrubs a four-part version string that looks like a dotted quad", () => {
    const output = redactHeaders({ server: "openresty/1.21.4.1" });
    // A dotted quad is ambiguous: the scrub conservatively treats it as an IP literal.
    expect(output["server"]).toBe("openresty/[REDACTED_IPV4]");
  });

  it("throws fail-closed when an IP literal survives the scrub (leading-zero dotted quad)", () => {
    // Crafted per verification item 5 (docs/tasks/P6-browser-runtime-transport/spec.md):
    // a leading-zero IPv4 literal that the fixture-capture scrub regex misses because
    // every candidate start position is word-adjacent, but which inet_pton parses.
    const input = { server: "gateway 001.002.003.004" };
    expect(() => redactHeaders(input)).toThrow(/IPv4 literal survived in header 'server'/);
  });

  it("throws fail-closed when a leading-zero literal survives in a non-first octet", () => {
    const input = { server: "gateway 10.0.0.01" };
    expect(() => redactHeaders(input)).toThrow(/IPv4 literal survived in header 'server'/);
  });

  it("does not throw for a banned header containing an IP — it never reaches the output", () => {
    // The fail-closed postcondition governs the output: a dropped key cannot leak.
    const output = redactHeaders({ "x-forwarded-for": "203.0.113.7", server: "cloudflare" });
    expect(output["x-forwarded-for"]).toBeUndefined();
    expect(output["server"]).toBe("cloudflare");
  });

  it("returns an empty object for an empty header map", () => {
    expect(redactHeaders({})).toEqual({});
  });
});
