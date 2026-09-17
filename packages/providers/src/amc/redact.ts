/**
 * Production log/trace redaction primitive — ADR 0005 §D
 * (`docs/adr/0005-security-privacy-operations.md:292-319`).
 *
 * `redactHeaders()` carries the same two steps the fixture-capture `redact()` already
 * applies to headers (`packages/providers/scripts/redact.ts`): the six-item header
 * allowlist and IPv4/IPv6 scrubbing of the surviving values, plus the fail-closed
 * postcondition — it throws if an IP literal survives in its output, mirroring
 * `redact()`'s existing check rather than dropping it for this narrower function.
 *
 * Every browser-runtime code path that attaches AMC-derived headers to an OTel span
 * attribute, a structured log line, or a crash bundle must call `redactHeaders()` first
 * (P6.12, `docs/tasks/P6-browser-runtime-transport/spec.md`).
 *
 * Allowlisted does not mean unscrubbed: an allowed header's _value_ can still contain an
 * IP literal (`scripts/redact.ts:45-51`), so surviving values are scrubbed, then the
 * whole output is re-checked fail-closed.
 */

/** The six safe headers only — identical to `packages/providers/scripts/redact.ts:8-15`. */
const HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "date",
  "server",
  "cf-mitigated",
  "retry-after",
]);

// Identical scrub patterns to `packages/providers/scripts/redact.ts:17-20`.
const IPV4_REGEX =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6_REGEX =
  /(?<![a-zA-Z0-9])(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?::(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?)(?![a-zA-Z0-9])/gi;

/**
 * The fail-closed postcondition must catch at least one class of IP literal the
 * fixture-capture scrub regexes miss, or it could never fire at all (verification item 5
 * of `docs/tasks/P6-browser-runtime-transport/spec.md`). The scrub's `\b[1-9]?\d…`
 * octets cannot match a leading-zero dotted quad such as `001.002.003.004` (every
 * candidate start position is word-adjacent), which `inet_pton` nevertheless parses as
 * `1.2.3.4`. A four-dotted-digit-group literal with any leading-zero octet is treated as
 * a surviving IP literal and throws.
 */
function hasLeadingZeroIpv4Literal(value: string): boolean {
  const dottedQuad = new RegExp("\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", "g");
  for (const match of value.matchAll(dottedQuad)) {
    const octets = match[0].split(".");
    if (octets.some((octet) => octet.length > 1 && octet.startsWith("0"))) {
      return true;
    }
  }
  return false;
}

/**
 * Redact an AMC-derived response-header map for operational records (ADR 0005 §D).
 *
 * - Only the six-item allowlist passes through at all; every other key is dropped.
 * - IPv4/IPv6 literals in surviving values are replaced with `[REDACTED_IPV4]` /
 *   `[REDACTED_IPV6]`.
 * - Fail-closed: throws if any IP literal survives in the output, rather than emitting a
 *   partially-redacted payload.
 *
 * Original key casing of allowlisted headers is preserved.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_ALLOWLIST.has(key.toLowerCase())) {
      continue;
    }
    let safeValue = value;
    safeValue = safeValue.replace(IPV4_REGEX, "[REDACTED_IPV4]");
    safeValue = safeValue.replace(IPV6_REGEX, "[REDACTED_IPV6]");
    redacted[key] = safeValue;
  }

  // Fail-closed post-redaction check (mirrors `scripts/redact.ts:64-78` for headers).
  for (const [key, value] of Object.entries(redacted)) {
    if (IPV4_REGEX.test(value)) {
      throw new Error(`Redaction failure: IPv4 literal survived in header '${key}'.`);
    }
    if (IPV6_REGEX.test(value)) {
      throw new Error(`Redaction failure: IPv6 literal survived in header '${key}'.`);
    }
    if (hasLeadingZeroIpv4Literal(value)) {
      throw new Error(`Redaction failure: leading-zero IPv4 literal survived in header '${key}'.`);
    }
  }

  return redacted;
}
