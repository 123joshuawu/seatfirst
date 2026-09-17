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
