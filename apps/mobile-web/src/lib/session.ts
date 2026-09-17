/**
 * Session renewal helpers — reactive, not timer-based.
 * S16.10: cookie Max-Age is not decided, so renewal is only on 401/UNAUTHORIZED.
 * `session.bootstrap` is idempotent: with a valid cookie it returns the same session
 * (no Set-Cookie), so it is safe to call repeatedly as the renewal mechanism.
 */

let pendingRenewal: Promise<void> | null = null;

/**
 * True if `err` is a tRPC UNAUTHORIZED error (HTTP 401) — canonical implementation
 * lives in the shared UI13 guard; re-exported here for existing consumers.
 */
export { isUnauthorizedError } from "./errorEnvelope";

/**
 * Renew the session by calling `session.bootstrap` and updating the store.
 * Deduplicates concurrent callers — only one bootstrap request is in flight.
 * On success, updates `sessionId`/`limits`/`bootstrapReady` via the store.
 * Never throws for UNAUTHORIZED (bootstrap always mints), but propagates
 * network/other errors to the caller so the retry link can surface the original.
 */
export async function renewSession(): Promise<void> {
  if (pendingRenewal) return pendingRenewal;
  pendingRenewal = (async () => {
    // Dynamic import to avoid circular dep with trpc.ts (which imports this module
    // for the retry link). At call time both modules are already evaluated.
    const { trpcClient } = await import("./trpc");
    const { useSeatfirstStore } = await import("@/store/seatfirstStore");
    const result = await trpcClient.session.bootstrap.mutate();
    // Mirror BootstrapGate's success path — same store shape.
    useSeatfirstStore.getState().setBootstrapSuccess(result.sessionId, result.limits);
  })().finally(() => {
    pendingRenewal = null;
  });
  return pendingRenewal;
}

/** For tests: clear the in-flight dedup so each test starts clean. */
export function _resetRenewalForTest(): void {
  pendingRenewal = null;
}
