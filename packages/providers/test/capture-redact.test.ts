import { describe, it, expect } from "vitest";
import { redact, type RedactTarget } from "../src/amc/capture-redact.js";

describe("redact module — promoted src/amc/capture-redact (P7.3)", () => {
  it("keeps only q and date in the URL query string", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies?q=matrix&date=2026-10-15&token=eyJh.bcd.efg&auth=123",
      status: 200,
      headers: {},
      body: "no ip here",
    };

    const redacted = redact(payload);

    expect(redacted.url).toBe("https://www.amctheatres.com/movies?q=matrix&date=2026-10-15");
  });

  it("redacts headers through the shared allowlist primitive", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {
        "content-type": "text/html",
        "cf-mitigated": "challenge",
        "set-cookie": "session=12345",
        authorization: "Bearer token",
      },
      body: "no ip here",
    };

    const redacted = redact(payload);

    expect(redacted.headers["content-type"]).toBe("text/html");
    expect(redacted.headers["cf-mitigated"]).toBe("challenge");
    expect(redacted.headers["set-cookie"]).toBeUndefined();
    expect(redacted.headers["authorization"]).toBeUndefined();
  });

  it("redacts an IPv4 literal in the body", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {},
      body: "Server at 192.168.1.1 responded.",
    };

    const redacted = redact(payload);

    expect(redacted.body).not.toContain("192.168.1.1");
    expect(redacted.body).toContain("[REDACTED_IPV4]");
  });

  it("redacts an IPv6 literal in the body", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {},
      body: "Compressed IPv6: ::1 and fe80::1ff:fe23:4567:890a.",
    };

    const redacted = redact(payload);

    expect(redacted.body).not.toContain("::1");
    expect(redacted.body).not.toContain("fe80::1ff:fe23:4567:890a");
    expect(redacted.body).toContain("[REDACTED_IPV6]");
  });

  it("redacts a JWT-shaped token in the body", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {},
      body: "Authorization header carried eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U token.",
    };

    const redacted = redact(payload);

    expect(redacted.body).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted.body).toContain("[REDACTED_TOKEN]");
  });

  it("throws fail-closed when a forbidden marker survives redaction", () => {
    const payload: RedactTarget = {
      url: "https://www.amctheatres.com/movies",
      status: 200,
      headers: {},
      // A body that CONTAINS the forbidden marker but does not match the scrub regex,
      // simulating the regex missing something the safety net still catches.
      body: "A rogue cf_clearance value that sneaked past.",
    };

    expect(() => redact(payload)).toThrow(/Redaction failure: forbidden marker/);
  });
});
