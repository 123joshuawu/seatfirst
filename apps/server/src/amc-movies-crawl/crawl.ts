import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { SeatfirstMetrics } from "@seatfirst/config/otel";

import type { AmcMoviesCrawlDeps, AmcMoviesCrawlTick } from "./duties.js";
import { runAmcMoviesCrawlTick } from "./duties.js";

export type AmcMoviesCrawlLogger = SeatfirstLogger;

/**
 * ADR 0102 decision 2 — the crawl's pacing tick is fixed at ten minutes, hard-coded. It
 * is the retry cadence inside the 07:00-Eastern boundary's 4-hour give-up window: neither
 * it nor the daily cadence is an injected gate-14 tunable and neither may become
 * configurable (mirrors `catalogue-crawl/crawl.ts`'s ADR 0022 hard-coding rationale).
 */
export const AMC_MOVIES_CRAWL_TICK_INTERVAL_MS = 10 * 60 * 1000;

export interface AmcMoviesCrawlerHandle {
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface AmcMoviesCrawlerOptions {
  readonly logger: AmcMoviesCrawlLogger;
  readonly onTickComplete?: (tick: AmcMoviesCrawlTick) => void;
  /**
   * Held for call-shape parity with `runCatalogueCrawler` (the fetch-worker passes the
   * shared OTel handle through). Currently unread: `SeatfirstMetrics` has no ADR 0102
   * tick-duration histogram yet, and recording into `catalogueCrawlTickDuration` would
   * misattribute AMC-movies ticks to the theatre catalogue — a config-slice follow-up
   * adds the dedicated histogram and the `record` call here.
   */
  readonly metrics?: SeatfirstMetrics;
}

/**
 * Runs the duty immediately (ADR 0102 decision 2: due-ness is re-checked on process
 * restart), then once per the hard-coded tick interval. A tick that overruns the
 * interval delays the next one rather than overlapping it — the loop body is sequential,
 * so two ticks never act on the corridor concurrently from this process (same guarantee
 * as `runCatalogueCrawler`/`runSweeper`).
 */
export function runAmcMoviesCrawler(
  deps: AmcMoviesCrawlDeps,
  options: AmcMoviesCrawlerOptions,
): AmcMoviesCrawlerHandle {
  const { logger, onTickComplete } = options;
  const controller = new AbortController();
  let stopped = false;
  let paused = false;

  const loop = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      if (!paused) {
        logger.debug({}, "amc movies crawl tick started");
        const started = Date.now();
        try {
          const tick = await runAmcMoviesCrawlTick(deps);
          onTickComplete?.(tick);
        } catch (error) {
          logger.error({ error }, "amc movies crawl tick failed");
        } finally {
          const duration_ms = Date.now() - started;
          logger.debug({ duration_ms }, "amc movies crawl tick completed");
        }
      }
      await delay(AMC_MOVIES_CRAWL_TICK_INTERVAL_MS, controller.signal);
    }
  };

  void loop();

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}

/** Abortable sleep — `stop()` does not wait out a full interval. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
