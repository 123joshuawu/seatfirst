import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * S22.9 / ADR 0017 — the stateless HMAC-signed recheck nonce.
 *
 * The nonce is a signed token, not a stored row: it embeds its own `id` (a fresh ULID
 * minted at issuance), the five bound fields `{sessionId, searchId, resultVersion,
 * showtimeId, placementKey}`, and an `expiry`, and is HMAC-SHA256-signed over the payload
 * with an injected shared secret (`docs/adr/0017-showtimes-recheck-implementation-decisions.md`).
 *
 * Wire format `{base64url(json)}.{hexHmac}` — the same `value.hmac` shape as S16.10's
 * signed session cookie (`session/cookie.ts`), with the payload JSON base64url-encoded so
 * the eight fields survive the token string unambiguously. Verification is constant-time
 * and ANY failure (bad shape, bad signature, unparseable payload) is "no nonce": the
 * route then rejects, never trusts a forged/transplanted token.
 *
 * Issuance (the token's producer) lives in `session/nonce-issuance.ts` (S34): it walks a
 * served ranked answer and signs one nonce per offer, binding `placementKey` + `showtimeId`.
 * `signRecheckNonce` is the SHARED signing primitive both the issuer and the verifier
 * consume — issuance and verification cannot drift on shape or serialization, and the
 * route's tests mint valid tokens against the exact shape the verifier reads.
 */

/** ADR 0017's considered number — 10 minutes, not a defaulted figure. */
export const RECHECK_NONCE_TTL_MS = 10 * 60 * 1000;

/** The verified nonce payload. `expiry` is epoch milliseconds. */
export interface RecheckNonce {
  readonly id: string;
  readonly sessionId: string;
  readonly searchId: string;
  readonly resultVersion: number;
  readonly showtimeId: string;
  readonly placementKey: string;
  readonly expiry: number;
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Mint a token — the shared signing primitive for `nonce-issuance.ts` and the recheck route's tests. */
export function signRecheckNonce(nonce: RecheckNonce, secret: string): string {
  const payload = Buffer.from(JSON.stringify(nonce), "utf8").toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
}

/** Verify a token, returning its payload, or `null` on ANY failure (constant-time). */
export function verifyRecheckNonce(token: string, secret: string): RecheckNonce | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  const payload = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1), "utf8");
  const expected = Buffer.from(hmac(payload, secret), "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.searchId !== "string" ||
    typeof record.resultVersion !== "number" ||
    typeof record.showtimeId !== "string" ||
    typeof record.placementKey !== "string" ||
    typeof record.expiry !== "number"
  ) {
    return null;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    searchId: record.searchId,
    resultVersion: record.resultVersion,
    showtimeId: record.showtimeId,
    placementKey: record.placementKey,
    expiry: record.expiry,
  };
}
