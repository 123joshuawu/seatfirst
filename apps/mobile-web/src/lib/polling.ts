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
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2000;

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

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result: GetSearchResult = await trpcClient.searches.get.query({ searchId });
      if (stopped) return;
      if (result == null) return;
      opts.onResult(result);
      if (isTerminalStatus(result.status)) {
        stop();
      }
    } catch (err) {
      if (!stopped) opts.onError?.(err);
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
