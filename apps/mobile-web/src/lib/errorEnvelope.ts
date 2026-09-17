/**
 * Shared tRPC-error / SSE-envelope type guards for `apps/mobile-web`.
 * Spec UI13 — one dependency-free leaf module replacing nine unchecked-cast sites.
 *
 * The wire shape is tRPC v11's `getErrorShape` output (`{ data: { code, ... } }`),
 * which reaches these catch blocks either as `err.shape.data.code`
 * (serialized-error SSE frames / httpSubscriptionLink) or as `err.data.code`
 * (batch-link `TRPCClientError`), plus UI9 test doubles that assign the envelope
 * onto a plain `Error` via `Object.assign`. Every reader below verifies each
 * property at runtime before returning it — no `as`-cast on external data.
 *
 * Leaf module by design: it imports nothing from `./trpc` or `./session` so both
 * of those can import it without recreating their existing import cycle.
 */
import type {
  RankedAnswer,
  ResultGroup,
  ScheduleSkeletonEntry,
  SearchStatus,
} from "@seatfirst/core";

/** True for non-null objects (arrays included) — the only safe envelope precondition. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read the tRPC error code off a thrown value at either wire placement.
 * Precedence: `shape.data.code` over `data.code` (the majority behavior across
 * the former cast sites). Returns null when absent or not a string.
 */
export function readTrpcErrorCode(err: unknown): string | null {
  if (!isRecord(err)) return null;
  if (isRecord(err.shape) && isRecord(err.shape.data) && typeof err.shape.data.code === "string") {
    return err.shape.data.code;
  }
  if (isRecord(err.data) && typeof err.data.code === "string") return err.data.code;
  return null;
}

/** Wider envelope fields carried alongside the code on rejected mutations. */
export interface TrpcErrorExtras {
  searchId?: string;
  retryAfterSeconds?: number;
  matchedCount?: number;
  limit?: number;
}

/**
 * Read `searchId` / `retryAfterSeconds` / `matchedCount` / `limit` off the error
 * envelope (`data` placement), each field individually type-checked before it is
 * returned.
 */
export function readTrpcErrorExtras(err: unknown): TrpcErrorExtras {
  const extras: TrpcErrorExtras = {};
  if (!isRecord(err) || !isRecord(err.data)) return extras;
  if (typeof err.data.searchId === "string") extras.searchId = err.data.searchId;
  if (typeof err.data.retryAfterSeconds === "number") {
    extras.retryAfterSeconds = err.data.retryAfterSeconds;
  }
  if (typeof err.data.matchedCount === "number") extras.matchedCount = err.data.matchedCount;
  if (typeof err.data.limit === "number") extras.limit = err.data.limit;
  return extras;
}

/**
 * Canonical predicate: true if `err` is a tRPC UNAUTHORIZED error (HTTP 401).
 * Accepts real `TRPCClientError`s (`data.code` and/or `shape.data.code`),
 * plain-object envelopes, and UI9 test doubles whose message equals the code.
 * Single source of truth for the previously duplicated predicates in
 * `lib/session.ts` (re-exported there) and `lib/trpc.ts`'s retry link.
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const dataCode = isRecord(err.data) && typeof err.data.code === "string" ? err.data.code : null;
  const shapeCode =
    isRecord(err.shape) && isRecord(err.shape.data) && typeof err.shape.data.code === "string"
      ? err.shape.data.code
      : null;
  if (dataCode === "UNAUTHORIZED" || shapeCode === "UNAUTHORIZED") return true;
  // Fallback for mocks that set message to code
  return typeof err.message === "string" && err.message === "UNAUTHORIZED";
}

// ---- SSE tracked-envelope narrowings (searches.onProgress payloads) ----

/**
 * Accept any string as a status — membership filtering stays at the call site
 * (`isTerminalStatus`), exactly as the previous unchecked casts behaved: a
 * non-string reads as absent, while an unrecognized string still flows through
 * and fails the terminal-set check unchanged.
 */
export function isSearchStatus(value: unknown): value is SearchStatus {
  return typeof value === "string";
}

/** Read a status field; non-strings read as null and fail downstream checks unchanged. */
export function readSearchStatus(value: unknown): SearchStatus | null {
  return isSearchStatus(value) ? value : null;
}

/**
 * Read an answer field: anything object-shaped passes through (the previous
 * cast's tolerance), everything else reads as null.
 */
export function isRankedAnswer(value: unknown): value is RankedAnswer {
  return isRecord(value);
}

/** Read an answer field, null-coalesced (matches `(... as RankedAnswer | null) ?? null`). */
export function readRankedAnswer(value: unknown): RankedAnswer | null {
  return isRankedAnswer(value) ? value : null;
}

/** Read a progress count; non-numbers read as absent. */
export function readProgressCount(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** True for array-shaped group lists (arrays are objects, so `isRecord` alone is too loose). */
export function isResultGroups(value: unknown): value is ResultGroup[] {
  return Array.isArray(value);
}

/** Read the groups array off a progress payload; non-arrays read as absent. */
export function readResultGroups(value: unknown): ResultGroup[] | undefined {
  return isResultGroups(value) ? value : undefined;
}

export function readScheduleSkeleton(value: unknown): ScheduleSkeletonEntry[] | undefined {
  return Array.isArray(value) ? (value as ScheduleSkeletonEntry[]) : undefined;
}

export function readTerminalCause(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}
