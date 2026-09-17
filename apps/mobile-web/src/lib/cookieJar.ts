/**
 * The single transport seam that touches `Set-Cookie` / `Cookie`.
 * Web path delegates to the browser jar via `credentials: 'include'`.
 * Native path uses explicit header injection with in-memory + optional
 * persistent storage (expo-secure-store when available).
 *
 * This is UI2's Finding 2 decision point; see
 * docs/tasks/UI2-trpc-session-theatre-bootstrap/finding.md.
 */
let Platform: { OS: string; select?: (o: Record<string, unknown>) => unknown } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- react-native Platform is resolved via Vite alias to a mock; static import would resolve to the mock unconditionally, dynamic require preserves the alias indirection for tests
  const rn = require("react-native") as {
    Platform?: { OS: string; select?: (o: Record<string, unknown>) => unknown };
  };
  Platform = rn.Platform ?? null;
} catch {
  Platform = null;
}

export const SESSION_COOKIE_NAME = "seatfirst_session";

// In-memory jar — the authoritative value for the current process.
let cookieValue: string | null = null;

// Optional persistent backend resolved at runtime (expo-secure-store when
// installed). No hard dependency — if unavailable we degrade to memory-only.
type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

let secureStore: SecureStoreLike | null | undefined;
let secureStoreProbed = false;

async function getSecureStore(): Promise<SecureStoreLike | null> {
  if (secureStoreProbed) return secureStore ?? null;
  secureStoreProbed = true;
  try {
    const mod: unknown = await import("expo-secure-store");
    if (
      mod !== null &&
      typeof mod === "object" &&
      "getItemAsync" in mod &&
      typeof (mod as Record<string, unknown>).getItemAsync === "function"
    ) {
      secureStore = mod as SecureStoreLike;
      return secureStore;
    }
  } catch {
    // Not installed or not available in this environment (web / test)
  }
  secureStore = null;
  return null;
}

const PERSIST_KEY = "seatfirst_session_cookie";

/**
 * Persist the raw `sessionId.hmac` value. Called after bootstrap.
 */
export async function persistCookie(value: string): Promise<void> {
  cookieValue = value;
  const store = await getSecureStore();
  if (store) {
    try {
      await store.setItemAsync(PERSIST_KEY, value);
    } catch {
      // Persistence is best-effort; in-memory jar still covers the session.
    }
  }
}

/**
 * Hydrate the in-memory jar from persistence. Call once before the first
 * bootstrap so a returning user re-presents a still-valid cookie and hits
 * the server's "recognize" branch (no new Set-Cookie).
 */
export async function hydrateCookieJar(): Promise<void> {
  const store = await getSecureStore();
  if (!store) return;
  try {
    const stored = await store.getItemAsync(PERSIST_KEY);
    if (stored) cookieValue = stored;
  } catch {
    // Ignore — will bootstrap fresh.
  }
}

/** Synchronous accessor for tests / header injection check. */
export function getStoredCookieValue(): string | null {
  return cookieValue;
}

export function clearCookieJar(): void {
  cookieValue = null;
  // Deletion is best-effort async; caller can await clearPersistedCookie if needed.
  void (async () => {
    const store = await getSecureStore();
    if (store) {
      try {
        await store.deleteItemAsync(PERSIST_KEY);
      } catch {
        // ignore
      }
    }
  })();
}

export async function clearPersistedCookie(): Promise<void> {
  cookieValue = null;
  const store = await getSecureStore();
  if (store) {
    try {
      await store.deleteItemAsync(PERSIST_KEY);
    } catch {
      // ignore
    }
  }
}

/**
 * Parse a `Set-Cookie` header value and extract the `seatfirst_session` cookie
 * value (`sessionId.hmac`). Returns null if not present. Handles comma-joined
 * or single header values and strips attributes after `;`.
 */
export function parseSetCookieHeader(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  // Split on comma only when it precedes a new cookie name, but our cookie
  // name is fixed so we can simply search for `seatfirst_session=` in the raw string.
  // The header may contain multiple cookies joined with `, `; attributes contain `;`.
  // We scan each `;`-terminated segment start.
  const raw = headerValue;
  // Try each comma-separated piece plus the whole raw (covers single-cookie case).
  const candidates = raw.split(",");
  for (const piece of candidates) {
    const segments = piece.split(";");
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1).trim();
        if (value) return value;
      }
    }
  }
  // Fallback: direct search in unsplit raw (handles Set-Cookie without comma join)
  const needle = `${SESSION_COOKIE_NAME}=`;
  const idx = raw.indexOf(needle);
  if (idx !== -1) {
    const after = raw.slice(idx + needle.length);
    const semi = after.indexOf(";");
    const comma = after.indexOf(",");
    let end = after.length;
    if (semi !== -1 && semi < end) end = semi;
    if (comma !== -1 && comma < end) end = comma;
    const value = after.slice(0, end).trim();
    if (value) return value;
  }
  return null;
}

/** For tests: force the in-memory value without touching persistence. */
export function setCookieValueForTest(value: string | null): void {
  cookieValue = value;
}

/**
 * The `fetch` wrapper passed to `httpBatchLink`. Web: `credentials: 'include'`
 * delegates to the browser. Native: inject `Cookie` from the jar and capture
 * `Set-Cookie` from the bootstrap response.
 */
export async function cookieAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const isWeb = Platform === null ? true : Platform.OS === "web";

  const headers = new Headers(init?.headers);

  if (!isWeb && cookieValue) {
    // Only set if caller hasn't already provided one.
    if (!headers.has("Cookie") && !headers.has("cookie")) {
      headers.set("Cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
    }
  }

  const fetchInit: RequestInit = {
    ...init,
    headers,
    ...(isWeb ? { credentials: "include" } : {}),
  };

  const response = await fetch(input as RequestInfo, fetchInit);

  // Capture Set-Cookie on any response that carries it (bootstrap is the primary
  // producer, but capturing broadly is harmless and covers re-bootstrap).
  // On web HttpOnly prevents JS reading Set-Cookie — get() will return null,
  // which is expected; browser handles it.
  let setCookie: string | null = null;
  try {
    setCookie = response.headers.get("set-cookie") ?? response.headers.get("Set-Cookie");
  } catch {
    // Some polyfills throw on unknown header access
  }
  if (setCookie) {
    const parsed = parseSetCookieHeader(setCookie);
    if (parsed) {
      // Persist best-effort; do not block response propagation on SecureStore I/O.
      void persistCookie(parsed);
      // Also update synchronously so subsequent requests in this tick see it.
      cookieValue = parsed;
    }
  }

  return response;
}
