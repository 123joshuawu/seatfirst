import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { SeatfirstMetrics } from "@seatfirst/config/otel";

import type { CatalogueCrawlDeps, CatalogueCrawlTick } from "./duties.js";
import { runCatalogueCrawlTick } from "./duties.js";

export type CatalogueCrawlLogger = SeatfirstLogger;

/**
 * ADR 0022 §1 — the crawl's pacing tick is fixed at ten minutes, hard-coded (S26.8). It is
 * the same category of accepted-document-fixed number as the one-month cadence (S26.7):
 * neither is an injected gate-14 tunable and neither may become configurable.
 */
export const CATALOGUE_CRAWL_TICK_INTERVAL_MS = 10 * 60 * 1000;

export interface CatalogueCrawlerHandle {
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface CatalogueCrawlerOptions {
  readonly logger: CatalogueCrawlLogger;
  readonly onTickComplete?: (tick: CatalogueCrawlTick) => void;
  readonly metrics?: SeatfirstMetrics;
}

/**
 * Runs the duty immediately (S26.7: due-ness is re-checked on process restart), then once
 * per the hard-coded tick interval. A tick that overruns the interval delays the next one
 * rather than overlapping it — the loop body is sequential, so two ticks never act on the
 * same page concurrently from this process (same guarantee as `runSweeper`).
 */
export function runCatalogueCrawler(
  deps: CatalogueCrawlDeps,
  options: CatalogueCrawlerOptions,
): CatalogueCrawlerHandle {
  const { logger, onTickComplete, metrics } = options;
  const controller = new AbortController();
  let stopped = false;
  let paused = false;

  const loop = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      if (!paused) {
        logger.debug({}, "catalogue crawl tick started");
        const started = Date.now();
        try {
          const tick = await runCatalogueCrawlTick(deps);
          onTickComplete?.(tick);
        } catch (error) {
          logger.error({ error }, "catalogue crawl tick failed");
        } finally {
          const duration_ms = Date.now() - started;
          if (metrics !== undefined) {
            metrics.catalogueCrawlTickDuration.record(duration_ms);
          }
          logger.debug({ duration_ms }, "catalogue crawl tick completed");
        }
      }
      await delay(CATALOGUE_CRAWL_TICK_INTERVAL_MS, controller.signal);
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
