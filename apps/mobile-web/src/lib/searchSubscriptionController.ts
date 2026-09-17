/**
 * Shared registry for the active search subscription teardown.
 * UI3's `useSearchSubscription` registers its `stopSubscription` here so
 * UI5's cancel orchestration can call it without hook-in-hook coupling.
 */
let stopFn: (() => void) | null = null;

export function setStopSubscription(fn: (() => void) | null): void {
  stopFn = fn;
}

export function getStopSubscription(): (() => void) | null {
  return stopFn;
}
