import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSessionCookie,
  parseSessionCookie,
  signSessionId,
  verifySessionCookie,
} from "../src/session/cookie.js";
import {
  extractSessionContext,
  loadAsnLookup,
  makeRelayPeerGate,
  parseGeoLiteAsnCsv,
  singleXffEntry,
} from "../src/session/extract.js";
import { TEST_COOKIE_POLICY, TEST_COOKIE_SECRET } from "./support/app.js";

/**
 * S16 verification items 9 and 10 — extraction fail-closed behavior and the offline ASN
 * lookup — as pure unit tests over the module seams, plus the S16.10 cookie's
 * sign/verify/tamper round-trip.
 *
 * Item 9's "none of these paths writes any IP to Postgres or to any log line" is proven
 * by construction: `extractSessionContext` returns data, it performs no I/O of any kind,
 * and the app assembly (app.ts) configures no logger. Nothing in this module can
 * observe IP/ASN values — only the caller may pass them to S16.9's Redis breach keys.
 */

const RELAY_CIDR = "10.99.0.0/16";
const RELAY_PEER = "10.99.7.4";
const OUTSIDE_PEER = "192.0.2.9";
const CLIENT_IP = "203.0.113.7";

describe("relay peer gate (S16.7)", () => {
  it("accepts exactly the configured CIDR's members", () => {
    const gate = makeRelayPeerGate(RELAY_CIDR);
    expect(gate(RELAY_PEER)).toBe(true);
    expect(gate("10.99.255.254")).toBe(true);
    expect(gate(OUTSIDE_PEER)).toBe(false);
    expect(gate("10.98.0.1")).toBe(false);
    expect(gate(undefined)).toBe(false);
  });

  it("fails at wiring time on a malformed CIDR", () => {
    expect(() => makeRelayPeerGate("not-a-cidr")).toThrow();
  });
});

describe("single XFF entry rule (S16.7)", () => {
  it("accepts exactly one entry, rejecting zero, two, or garbage", () => {
    expect(singleXffEntry(CLIENT_IP)).toBe(CLIENT_IP);
    expect(singleXffEntry(`${CLIENT_IP}, 198.51.100.2`)).toBeUndefined();
    expect(singleXffEntry(undefined)).toBeUndefined();
    expect(singleXffEntry("")).toBeUndefined();
    expect(singleXffEntry("garbage")).toBeUndefined();
    // Fastify may deliver repeated headers as an array — same single-entry rule.
    expect(singleXffEntry([CLIENT_IP, "198.51.100.2"])).toBeUndefined();
  });
});

describe("extractSessionContext (S16.7/S16.8)", () => {
  const gate = makeRelayPeerGate(RELAY_CIDR);
  const asnLookup = parseGeoLiteAsnCsv("203.0.113.0/24,64500,RESERVED-EXAMPLE\n");

  it("relay peer + exactly one XFF entry → that entry is the client IP, with its ASN", () => {
    expect(extractSessionContext(RELAY_PEER, CLIENT_IP, gate, asnLookup)).toEqual({
      clientIp: CLIENT_IP,
      asn: "64500",
    });
  });

  it("non-relay socket peer with an XFF header present → clientIp undefined", () => {
    expect(extractSessionContext(OUTSIDE_PEER, CLIENT_IP, gate, asnLookup)).toEqual({
      clientIp: undefined,
      asn: undefined,
    });
  });

  it("relay peer with two XFF entries → undefined (single-entry rule)", () => {
    expect(
      extractSessionContext(RELAY_PEER, `${CLIENT_IP}, 198.51.100.2`, gate, asnLookup),
    ).toEqual({ clientIp: undefined, asn: undefined });
  });

  it("relay peer with no XFF → undefined", () => {
    expect(extractSessionContext(RELAY_PEER, undefined, gate, asnLookup)).toEqual({
      clientIp: undefined,
      asn: undefined,
    });
  });
});

describe("offline ASN lookup (S16.8)", () => {
  it("parses a GeoLite2-style CSV: known IP → ASN, unknown IP → undefined, IPv6 rows skipped", () => {
    const lookup = parseGeoLiteAsnCsv(
      [
        "network,autonomous_system_number,autonomous_system_organization",
        "1.0.0.0/24,13335,CLOUDFLARENET",
        "203.0.113.0/24,64500,RESERVED-EXAMPLE",
        "2001:db8::/32,64496,IPV6-SKIPPED",
      ].join("\n"),
    );
    expect(lookup.lookup("203.0.113.7")).toBe("64500");
    expect(lookup.lookup("203.0.113.255")).toBe("64500");
    expect(lookup.lookup("198.51.100.9")).toBeUndefined();
    expect(lookup.lookup("2001:db8::1")).toBeUndefined(); // IPv6: no wrong answer
  });

  it("loads the synthetic fixture file from disk (no network-capable path exists)", async () => {
    const fixture = resolve(import.meta.dirname, "support/fixtures/geolite2-asn-synthetic.csv");
    const lookup = await loadAsnLookup(fixture);
    expect(lookup.lookup("203.0.113.7")).toBe("64500");
    expect(lookup.lookup("9.9.9.9")).toBe("19281");
    expect(lookup.lookup("198.51.100.9")).toBeUndefined();
  });
});

describe("signed session cookie (S16.10)", () => {
  it("signs and verifies a round-trip; any tamper fails closed to undefined", () => {
    const signed = signSessionId("sess_cookie_1", TEST_COOKIE_SECRET);
    expect(verifySessionCookie(signed, TEST_COOKIE_SECRET)).toBe("sess_cookie_1");

    // Forged id with a valid-looking signature, flipped payload byte, wrong secret:
    const forgedId = signSessionId("sess_forged", TEST_COOKIE_SECRET).replace(
      "sess_forged",
      "sess_stolen",
    );
    expect(verifySessionCookie(forgedId, TEST_COOKIE_SECRET)).toBeUndefined();

    const flipped =
      signSessionId("sess_cookie_1", TEST_COOKIE_SECRET).slice(0, -1) +
      (signSessionId("sess_cookie_1", TEST_COOKIE_SECRET).endsWith("a") ? "b" : "a");
    expect(verifySessionCookie(flipped, TEST_COOKIE_SECRET)).toBeUndefined();

    expect(
      verifySessionCookie(signSessionId("sess_cookie_1", TEST_COOKIE_SECRET), "other-secret"),
    ).toBeUndefined();
    expect(verifySessionCookie("garbage", TEST_COOKIE_SECRET)).toBeUndefined();
    expect(verifySessionCookie("nodot", TEST_COOKIE_SECRET)).toBeUndefined();
    expect(verifySessionCookie(".trailing", TEST_COOKIE_SECRET)).toBeUndefined();
  });

  it("parses the session cookie out of a multi-cookie header, ignoring the rest", () => {
    const signed = signSessionId("sess_cookie_2", TEST_COOKIE_SECRET);
    const header = `theme=dark; seatfirst_session=${signed}; track=no`;
    expect(parseSessionCookie(header, TEST_COOKIE_SECRET)).toBe("sess_cookie_2");
    expect(parseSessionCookie(undefined, TEST_COOKIE_SECRET)).toBeUndefined();
    expect(parseSessionCookie("theme=dark", TEST_COOKIE_SECRET)).toBeUndefined();
    // An unsigned session cookie is "no session" — never a trusted id.
    expect(
      parseSessionCookie("seatfirst_session=sess_unsigned", TEST_COOKIE_SECRET),
    ).toBeUndefined();
  });

  it("builds the Set-Cookie value with the architecture's attributes plus the injected policy", () => {
    const value = buildSessionCookie("sess_cookie_3", TEST_COOKIE_SECRET, TEST_COOKIE_POLICY);
    expect(value).toBe(
      "seatfirst_session=" +
        signSessionId("sess_cookie_3", TEST_COOKIE_SECRET) +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600",
    );
  });
});
