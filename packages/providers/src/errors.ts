import { z } from "zod";

/**
 * Normalized provider error codes (`seatfirst-query-design.md:49`, "Errors:"). Not every
 * provider emits every code.
 *
 * This enum is **closed** — deliberately unlike the open wire enums ADR 0003 §5 defines
 * (`RecommendationReason`, `Relaxation`, `SuggestedWiden`, each
 * `z.discriminatedUnion([...known]).or(UnknownVariant)` so a client on an older build still
 * parses a variant it doesn't recognize, `docs/adr/0003-searchspec-result-contracts.md:383-389`).
 * That openness exists because those types cross a wire to independently-versioned clients. A
 * `VenueProvider` error code never does: every adapter that can emit one lives inside this
 * codebase, built against this exact enum. An adapter that produces a ninth code has a bug to
 * fix, not a forward-compatible variant to preserve — so the schema fails closed on it rather
 * than accepting and silently carrying an unrecognized code forward.
 */
export const ProviderErrorCodeSchema = z.enum([
  "UPSTREAM_BLOCKED",
  "CHALLENGE_REQUIRED",
  "UPSTREAM_QUEUED",
  "RATE_LIMITED",
  "UPSTREAM_CHANGED",
  "NOT_FOUND",
  "NO_RESULTS",
  "UPSTREAM_UNAVAILABLE",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

export interface ProviderErrorOptions {
  readonly providerMeta?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * The normalized error codes are first-class result states, never empty data
 * (`seatfirst-query-design.md:49`) — that is what lets a caller distinguish "no results"
 * (`NO_RESULTS`) from "could not determine" (`UPSTREAM_UNAVAILABLE`, `UPSTREAM_BLOCKED`, ...) as
 * different control-flow paths, rather than as two shapes of the same successful value.
 *
 * **Not the `VenueProvider` contract's error channel.** A `VenueProvider`
 * method signals a failure code as the `{ ok: false, code, ... }` branch of
 * `ProviderOutcome<T>` (`contract.ts`), a typed return value, not by rejecting a promise —
 * `ProviderErrorCode` was previously referenced nowhere in `contract.ts`, so nothing forced a
 * caller to handle any of the eight codes. `ProviderError` remains available as an *internal*
 * transport an adapter may throw and catch entirely within its own boundary (e.g., to unwind out
 * of deeply nested parsing code before translating into a `ProviderOutcome`), but no
 * `VenueProvider` member throws or catches it, and no caller of `VenueProvider` should need to.
 *
 * The constructor parses `code` through `ProviderErrorCodeSchema`, so constructing a
 * `ProviderError` with a code outside the closed enum throws immediately rather than manufacturing
 * a `ProviderError` that carries an invalid code silently.
 */
export class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly providerMeta: Record<string, unknown>;

  public constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = ProviderErrorCodeSchema.parse(code);
    this.providerMeta = options.providerMeta ?? {};
  }
}

/**
 * Raw/unredacted diagnostic payload for an `UPSTREAM_CHANGED` terminal outcome
 * (risk-accepted standing capture, not counsel-cleared — see this batch's ADR amendments).
 *
 * Internal-only side channel, never a wire field: it is attached as a NON-ENUMERABLE own
 * `diagnostic` property (see `attachUpstreamChangedDiagnostic`), so every consumer that never
 * looks for it observes byte-identical behavior — `toEqual`, `toStrictEqual`,
 * `JSON.stringify`, golden diffs, and object spread all skip non-enumerable keys. It is never
 * placed in `providerMeta` (which IS persisted and golden-compared) and never added to any
 * Zod-validated wire schema.
 */
export interface UpstreamChangedDiagnostic {
  /** Raw request URL, full query string included — never redacted. */
  readonly url: string;
  /** Raw response body (the HTML string the parser failed on) — never redacted. */
  readonly body: string;
  /**
   * Raw response headers, only when the throw site genuinely has them in scope. The AMC
   * parse layer receives a body string + URL and nothing else (the fetcher returns no
   * headers), so this is absent there by construction — capture what is available, never
   * fabricate.
   */
  readonly headers?: Record<string, string | readonly string[]>;
}

/**
 * Attaches a diagnostic payload to an `UPSTREAM_CHANGED` error/outcome object. First write
 * wins; anything that is not an `UPSTREAM_CHANGED` `ProviderError` or a plain carrier object
 * (e.g. a different error code) is left untouched so non-`UPSTREAM_CHANGED` behavior is
 * identical with or without this call.
 */
export function attachUpstreamChangedDiagnostic(
  target: unknown,
  diagnostic: UpstreamChangedDiagnostic,
): void {
  if (typeof target !== "object" || target === null) return;
  if (target instanceof ProviderError && target.code !== "UPSTREAM_CHANGED") return;
  if (getUpstreamChangedDiagnostic(target) !== undefined) return;
  Object.defineProperty(target, "diagnostic", {
    value: diagnostic,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/**
 * Reads a diagnostic payload attached by `attachUpstreamChangedDiagnostic`. Returns
 * `undefined` when absent or malformed — never throws, so capture probing cannot break the
 * outcome path it inspects.
 */
export function getUpstreamChangedDiagnostic(
  target: unknown,
): UpstreamChangedDiagnostic | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const candidate = (target as { readonly diagnostic?: unknown }).diagnostic;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record["url"] !== "string" || typeof record["body"] !== "string") return undefined;
  return candidate as UpstreamChangedDiagnostic;
}
