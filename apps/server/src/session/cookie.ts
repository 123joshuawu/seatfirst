import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed session cookie (S16.10; seatfirst-architecture.md:403,674,680).
 *
 * Value `{sessionId}.{hmac}` — HMAC-SHA256 over the id, keyed by an injected secret
 * (Secrets Manager/ECS task injection, never in the repo or image,
 * seatfirst-architecture.md:675). Verification is constant-time and ANY signature
 * mismatch is treated as "no session": S16.11 then mints a fresh id, and an unsigned or
 * forged id is never trusted (S16 verification item 8).
 *
 * Attributes are implemented, not re-decided: `HttpOnly` (architecture:403) and
 * `Secure` (architecture:680 — TLS terminates at the relay) are fixed by accepted
 * documents, as is the PRESENCE of a `SameSite` attribute (architecture:674). Two
 * values are deliberately NOT decided by any accepted document and are therefore
 * injected with no default — reported findings, never silently picked (S16.10):
 * - the `SameSite` value (`Lax` vs `Strict`);
 * - the cookie `Max-Age`/lifetime.
 *
 * The cookie NAME (`seatfirst_session`) is this module's own mechanical choice — no
 * accepted document fixes one.
 */

export const SESSION_COOKIE_NAME = "seatfirst_session";

export interface SessionCookiePolicy {
  readonly sameSite: "Lax" | "Strict";
  readonly maxAgeSeconds: number;
}

function hmac(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("hex");
}

/** The signed cookie VALUE (`{sessionId}.{hmac}`), for tests and for the mint path. */
export function signSessionId(sessionId: string, secret: string): string {
  return `${sessionId}.${hmac(sessionId, secret)}`;
}

/**
 * Verifies a signed cookie value and returns the session id, or `undefined` on ANY
 * mismatch (bad format, wrong length, wrong signature) — constant-time comparison.
 */
export function verifySessionCookie(value: string, secret: string): string | undefined {
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }
  const sessionId = value.slice(0, separator);
  const presented = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(hmac(sessionId, secret), "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  return sessionId;
}

/**
 * Extracts the session cookie from a `Cookie` header, verifying its signature. `Cookie`
 * headers carry several `name=value` pairs, so this parses rather than greps; a header
 * with no session cookie (or an unsigned one) is "no session".
 */
export function parseSessionCookie(
  cookieHeader: string | undefined,
  secret: string,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const name = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (name === SESSION_COOKIE_NAME) {
      return verifySessionCookie(value, secret);
    }
  }
  return undefined;
}

/**
 * The `Set-Cookie` header value for a freshly minted session. `sameSite` and
 * `maxAgeSeconds` are injected (findings above); the rest are the architecture's
 * decided attributes.
 */
export function buildSessionCookie(
  sessionId: string,
  secret: string,
  policy: SessionCookiePolicy,
): string {
  return (
    `${SESSION_COOKIE_NAME}=${signSessionId(sessionId, secret)}; ` +
    `Path=/; HttpOnly; Secure; SameSite=${policy.sameSite}; Max-Age=${policy.maxAgeSeconds}`
  );
}
