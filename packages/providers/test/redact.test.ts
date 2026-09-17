import { describe, it, expect } from "vitest";
import { redact, type RedactTarget } from "../scripts/redact.js";

describe("redact module (P3.5)", () => {
  it("strips banned headers, IP addresses in body, and enforces an allowlist (P3.1)", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {
        "content-type": "text/html",
        "cf-mitigated": "challenge",
        "set-cookie": "session=12345",
        authorization: "Bearer token",
        "cf-ray": "1234567890abcdef",
        "x-queueit-connector": "123",
        "x-invented-header": "drop-me",
      },
      body: "Here is an IPv4 192.168.1.1 and an IPv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 literal. Timestamp: 2026-08-10T12:00:00Z",
    };

    const redacted = redact(payload);

    // Parser-needed fields still present
    expect(redacted.headers["content-type"]).toBe("text/html");
    expect(redacted.headers["cf-mitigated"]).toBe("challenge");

    // Banned headers gone
    expect(redacted.headers["set-cookie"]).toBeUndefined();
    expect(redacted.headers["authorization"]).toBeUndefined();
    expect(redacted.headers["cf-ray"]).toBeUndefined();
    expect(redacted.headers["x-queueit-connector"]).toBeUndefined();

    // Invented header gone (proves allowlist, not denylist)
    expect(redacted.headers["x-invented-header"]).toBeUndefined();

    // IPs gone from body
    expect(redacted.body).not.toContain("192.168.1.1");
    expect(redacted.body).toContain("[REDACTED_IPV4]");

    expect(redacted.body).not.toContain("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(redacted.body).toContain("[REDACTED_IPV6]");

    // Timestamp survived
    expect(redacted.body).toContain("Timestamp: 2026-08-10T12:00:00Z");
  });

  it("strips URL query parameters except q and date, and redacts tokens/compressed IPv6", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies?q=matrix&date=2026-10-15&token=eyJh.bcd.efg&auth=123",
      status: 200,
      headers: {
        "content-type": "text/html",
      },
      body: "Compressed IPv6: ::1 and fe80::1ff:fe23:4567:890a. Token: eyJh.something.else and wait token c=12345-67890. CF ray: CF-RAY: 1234abcd-ORD",
    };

    const redacted = redact(payload);

    expect(redacted.url).toBe("https://www.amctheatres.com/movies?q=matrix&date=2026-10-15");
    expect(redacted.body).not.toContain("::1");
    expect(redacted.body).not.toContain("fe80::1ff:fe23:4567:890a");
    expect(redacted.body).toContain("[REDACTED_IPV6]");
    expect(redacted.body).not.toContain("eyJh.");
    expect(redacted.body).not.toContain("c=12345");
    expect(redacted.body).not.toContain("CF-RAY");
    expect(redacted.body).toContain("[REDACTED_TOKEN]");
  });

  it("throws fail-closed error if forbidden markers survive", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {},
      // We use a body that CONTAINS the forbidden marker but doesn't match the regex,
      // to simulate the regex missing something but the safety net catching it.
      body: "A rogue cf_clearance value that sneaked past.",
    };

    expect(() => redact(payload)).toThrow(/Redaction failure: forbidden marker/);
  });

  it("fully redacts a quoted cookie value and every subsequent pair on the same line (P3.5 regression)", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: { "content-type": "text/html" },
      body: 'Embedded header text: Cookie: session="s3cr3t-value"; theme=dark; other=abc',
    };

    const redacted = redact(payload);

    expect(redacted.body).not.toContain("s3cr3t-value");
    expect(redacted.body).not.toContain("theme=dark");
    expect(redacted.body).not.toContain("other=abc");
  });

  it("redacts an IP literal inside a retained (allowlisted) header value, not just the body (P3.5 regression)", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {
        "content-type": "text/html",
        server: "cloudflare from 203.0.113.7",
      },
      body: "no ip here",
    };

    const redacted = redact(payload);

    expect(redacted.headers["server"]).not.toContain("203.0.113.7");
    expect(redacted.headers["server"]).toContain("[REDACTED_IPV4]");
  });
});
