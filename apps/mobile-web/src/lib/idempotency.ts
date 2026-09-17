/**
 * Idempotency-key helpers for `searches.create`.
 * See spec UI3.1 and ADR 0025 Decision 2 item 8.
 */
import { useSeatfirstStore } from "../store/seatfirstStore";

function randomUUIDFallback(): string {
  const g = globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const s = () => Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `${s()}-${s().slice(0, 4)}-4${s().slice(0, 3)}-a${s().slice(0, 3)}-${s()}${s().slice(0, 4)}`;
}

/**
 * Mint a fresh idempotency key for an intentional new search.
 * Uses `crypto.randomUUID()` when available, otherwise a manual fallback.
 */
export function createIdempotencyKey(): string {
  try {
    // Try expo-crypto if installed (optional peer, not a hard dep)

    const expoCrypto: { randomUUID?: () => string } | null = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- expo-crypto is an optional peer; dynamic require avoids a hard dependency when absent
        return require("expo-crypto") as { randomUUID?: () => string };
      } catch {
        return null;
      }
    })();
    if (expoCrypto?.randomUUID) return expoCrypto.randomUUID();
  } catch {
    // ignore — fall through to Web Crypto
  }
  return randomUUIDFallback();
}

/**
 * Store-backed helper: return the same key when retrying the same attempt
 * after an ambiguous transport failure (no `searchId` yet, same `specHash`),
 * or mint a fresh key for a new intentional search (different `specHash`).
 */
export function getOrCreatePendingKey(specHashValue: string): string {
  const state = useSeatfirstStore.getState();
  if (
    state.pendingIdempotencyKey !== null &&
    state.pendingSpecHash === specHashValue &&
    state.searchId === null
  ) {
    return state.pendingIdempotencyKey;
  }
  const fresh = createIdempotencyKey();
  state.setPendingKey(fresh, specHashValue);
  return fresh;
}
