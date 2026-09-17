/**
 * Four-stage browser-corridor origin allowlist — ADR 0005 §B
 * (`docs/adr/0005-security-privacy-operations.md:203-253`), task P6.
 *
 * Every document URL is parsed and canonicalized with the WHATWG `URL` API, then checked
 * by exact origin, pathname, and allowed-query rules before the next navigation proceeds.
 * Regex matches, substring tests, `startsWith`/`endsWith`, and open redirects are not
 * authorization (P6.4). A guard ambiguity or unexpected document fails closed — the
 * navigation halts rather than guessing.
 *
 * The `AMC_INITIAL` and `AMC_CLEAN_RETURN` stages reuse `packages/providers/src/amc/routes.ts`
 * `isAllowedUrl` — not a reimplementation (P6.6).
 */

import { isAllowedUrl } from "@seatfirst/providers";

export const CORRIDOR_STAGES = [
  "AMC_INITIAL",
  "QUEUE_ENTRY",
  "AMC_TOKEN_RETURN",
  "AMC_CLEAN_RETURN",
] as const;

export type CorridorStage = (typeof CORRIDOR_STAGES)[number];

/**
 * Exact Queue-it transit origin, per ADR 0005 §B's table
 * (`docs/adr/0005-security-privacy-operations.md:217`).
 *
 * Deliberately NOT the `.queue-it.net` host heuristic in
 * `packages/providers/src/amc/classify.ts:36`: the one captured real corridor transits
 * `queue.amctheatres.com` and never visits `.queue-it.net` (P6.10 — this guard must not
 * replicate `classify.ts`'s host check).
 */
export const QUEUE_ENTRY_ORIGIN = "https://queue.amctheatres.com";

/**
 * QUEUE_ENTRY query-key allowlist (ADR 0005 §B, `:217`).
 *
 * PROVISIONAL (P6.7): derived from exactly one authorized capture session, not a stable
 * Queue-it API contract. Implemented as an explicit documented allowlist — never a
 * pass-through — and flagged for reconfirmation against a fresh capture or Queue-it
 * integration documentation. The pathname constraint (exactly `/`) rests on firmer
 * ground and is not subject to the same caveat.
 *
 * `t` is not opaque: it is the return target, and must URL-decode to something
 * satisfying `AMC_INITIAL`'s rule (P6.7). The remaining keys' values are not further
 * constrained (Queue-it-issued tokens/versions).
 */
export const QUEUE_ENTRY_ALLOWED_QUERY_KEYS = [
  "c",
  "e",
  "ver",
  "cver",
  "man",
  "enqueuetoken",
  "t",
  "kupver",
] as const;

export type GuardRejectionReason =
  | "UNPARSEABLE_URL"
  | "CREDENTIALS_OR_HASH"
  | "INITIAL_NOT_ALLOWED"
  | "WRONG_ORIGIN"
  | "UNEXPECTED_PATHNAME"
  | "DISALLOWED_QUERY_KEY"
  | "MISSING_T"
  | "INVALID_T_TARGET"
  | "UNEXPECTED_QUERY_SHAPE"
  | "EXTRA_PARAMS"
  | "UNEXPECTED_HOP";

/**
 * Sanitized shape of the accepted initial document. Query values are never retained —
 * only the key names, per the safe-outcome field list
 * (`docs/seatfirst-architecture.md:207`).
 */
export interface InitialDocumentShape {
  readonly origin: string;
  readonly pathname: string;
  readonly queryKeys: readonly string[];
}

export interface CorridorState {
  /**
   * The stage the NEXT document request must satisfy. `COMPLETE` means the four-document
   * corridor has been traversed; any further document fails closed.
   */
  readonly stage: CorridorStage | "COMPLETE";
  /** Null only before the first (AMC_INITIAL) document has been accepted. */
  readonly initial: InitialDocumentShape | null;
}

export const INITIAL_CORRIDOR_STATE: CorridorState = { stage: "AMC_INITIAL", initial: null };

export type GuardCheckResult =
  | { readonly ok: true; readonly classification: CorridorStage; readonly next: CorridorState }
  | { readonly ok: false; readonly reason: GuardRejectionReason };

function reject(reason: GuardRejectionReason): GuardCheckResult {
  return { ok: false, reason };
}

function parseDocumentUrl(rawUrl: string): URL | GuardRejectionReason {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "UNPARSEABLE_URL";
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return "CREDENTIALS_OR_HASH";
  }
  return url;
}

function checkInitial(url: URL): GuardCheckResult {
  if (!isAllowedUrl(url)) {
    return reject("INITIAL_NOT_ALLOWED");
  }
  const initial: InitialDocumentShape = {
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: Array.from(url.searchParams.keys()),
  };
  return { ok: true, classification: "AMC_INITIAL", next: { stage: "QUEUE_ENTRY", initial } };
}

function checkQueueEntry(url: URL, initial: InitialDocumentShape): GuardCheckResult {
  if (url.origin !== QUEUE_ENTRY_ORIGIN) {
    return reject("WRONG_ORIGIN");
  }
  if (url.pathname !== "/") {
    return reject("UNEXPECTED_PATHNAME");
  }
  const allowed = new Set<string>(QUEUE_ENTRY_ALLOWED_QUERY_KEYS);
  for (const key of url.searchParams.keys()) {
    // Strict: every key must be in the allowlist exactly once (no duplicates).
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      return reject("DISALLOWED_QUERY_KEY");
    }
  }
  // `t` is required: it is the return target, not a Queue-it-internal token (P6.7).
  const t = url.searchParams.get("t");
  if (t === null || t === "") {
    return reject("MISSING_T");
  }
  // URL-decode `t` (searchParams.get already decodes once) and require the result to
  // itself satisfy AMC_INITIAL's exact rule.
  let tUrl: URL;
  try {
    tUrl = new URL(t);
  } catch {
    return reject("INVALID_T_TARGET");
  }
  if (tUrl.username !== "" || tUrl.password !== "" || tUrl.hash !== "") {
    return reject("INVALID_T_TARGET");
  }
  if (!isAllowedUrl(tUrl)) {
    return reject("INVALID_T_TARGET");
  }
  return {
    ok: true,
    classification: "QUEUE_ENTRY",
    next: { stage: "AMC_TOKEN_RETURN", initial },
  };
}

function checkTokenReturn(url: URL, initial: InitialDocumentShape): GuardCheckResult {
  if (url.origin !== initial.origin) {
    return reject("WRONG_ORIGIN");
  }
  if (url.pathname !== initial.pathname) {
    return reject("UNEXPECTED_PATHNAME");
  }
  // Same query as the initial document plus exactly one added `queueittoken` param.
  // Constraint is at the key level (architecture §12: "allowed-query rules"); Queue-it
  // may re-encode values, and the ADR rule names the key, not value equality.
  const counts = new Map<string, number>();
  for (const key of url.searchParams.keys()) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.get("queueittoken") !== 1) {
    return reject("UNEXPECTED_QUERY_SHAPE");
  }
  const token = url.searchParams.get("queueittoken");
  if (token === null || token === "") {
    return reject("UNEXPECTED_QUERY_SHAPE");
  }
  for (const key of initial.queryKeys) {
    if (counts.get(key) !== 1) {
      return reject("UNEXPECTED_QUERY_SHAPE");
    }
  }
  if (counts.size !== initial.queryKeys.length + 1) {
    return reject("UNEXPECTED_QUERY_SHAPE");
  }
  return {
    ok: true,
    classification: "AMC_TOKEN_RETURN",
    next: { stage: "AMC_CLEAN_RETURN", initial },
  };
}

function checkCleanReturn(url: URL, initial: InitialDocumentShape): GuardCheckResult {
  if (url.origin !== initial.origin) {
    return reject("WRONG_ORIGIN");
  }
  if (url.pathname !== initial.pathname) {
    return reject("UNEXPECTED_PATHNAME");
  }
  // No added params: re-validated against the same isAllowedUrl rule as the initial
  // request (P6.9). Any extra/missing query key fails here.
  if (!isAllowedUrl(url)) {
    return reject("EXTRA_PARAMS");
  }
  return {
    ok: true,
    classification: "AMC_CLEAN_RETURN",
    next: { stage: "COMPLETE", initial },
  };
}

/**
 * Validate one corridor document against the state machine. `state.stage` names the
 * stage this document must satisfy; on success the returned `next` state names the stage
 * the following document (if any) must satisfy. Fail-closed on anything unrecognized.
 */
export function checkDocument(state: CorridorState, rawUrl: string): GuardCheckResult {
  const url = parseDocumentUrl(rawUrl);
  if (typeof url === "string") {
    return reject(url);
  }
  switch (state.stage) {
    case "AMC_INITIAL":
      return checkInitial(url);
    case "QUEUE_ENTRY": {
      // Unreachable through the machine: QUEUE_ENTRY is only offered after an accepted
      // AMC_INITIAL document. Defensive invariant, not a corridor-guard rejection.
      if (state.initial === null) {
        throw new Error("corridor invariant violated: QUEUE_ENTRY without an initial document");
      }
      return checkQueueEntry(url, state.initial);
    }
    case "AMC_TOKEN_RETURN": {
      if (state.initial === null) {
        throw new Error(
          "corridor invariant violated: AMC_TOKEN_RETURN without an initial document",
        );
      }
      return checkTokenReturn(url, state.initial);
    }
    case "AMC_CLEAN_RETURN": {
      if (state.initial === null) {
        throw new Error(
          "corridor invariant violated: AMC_CLEAN_RETURN without an initial document",
        );
      }
      return checkCleanReturn(url, state.initial);
    }
    case "COMPLETE":
      return reject("UNEXPECTED_HOP");
  }
}
