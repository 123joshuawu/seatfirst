/**
 * Polling fallback for when SSE is unavailable.
 * Spec UI3.5 — `startPolling(searchId, { intervalMs, onResult }): () => void`
 */
import type { SearchStatus } from "@seatfirst/core";
import type { GetSearchResult } from "@/api/search";

import { trpcClient } from "./trpc";

export interface PollingOptions {
  intervalMs?: number;
  onResult: (result: GetSearchResult) => void;
  /**
   * Invoked on every failed tick. `exhausted` is true exactly once — on the
   * tick that trips the consecutive-failure budget, after which the loop is
   * already stopped. Callers MUST only surface terminal UI (e.g.
   * `setSearchError`) when `exhausted` is true; transient ticks keep retrying
   * silently so a single blip never tears down the search.
   */
  onError?: (err: unknown, exhausted: boolean) => void;
}

const DEFAULT_INTERVAL_MS = 2000;
/**
 * Consecutive-failure budget before the loop gives up. A persistent 500 (e.g.
 * the Cold-Mode namespace 500 on `searches.get`) fails every tick identically,
 * so retrying forever just hammers a permanently-broken endpoint — stop after
 * a small bounded run and let the caller surface the failure.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function isTerminalStatus(status: SearchStatus): boolean {
  return (
    status === "COMPLETE" || status === "PARTIAL" || status === "HALTED" || status === "CANCELLED"
  );
}

export function startPolling(searchId: string, opts: PollingOptions): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let consecutiveFailures = 0;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result: GetSearchResult = await trpcClient.searches.get.query({ searchId });
      if (stopped) return;
      consecutiveFailures = 0;
      if (result == null) return;
      opts.onResult(result);
      if (isTerminalStatus(result.status)) {
        stop();
      }
    } catch (err) {
      if (stopped) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        stop();
        opts.onError?.(err, true);
      } else {
        opts.onError?.(err, false);
      }
    } finally {
      inFlight = false;
    }
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Immediate first tick, then interval
  void tick();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return stop;
}
