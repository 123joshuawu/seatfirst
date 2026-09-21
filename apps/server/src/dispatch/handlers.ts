/**
 * Loud-fail placeholder handlers (S11.7/S11.8) and the registry construction helpers.
 * The message text is the single source of truth for both the pre-lease log line the
 * harness emits and the error a placeholder throws if ever invoked directly — no drift
 * between the two.
 */
import type {
  AggregateHandlerFn,
  DispatchRegistry,
  HandlerEntry,
  JobHandlerFn,
  RunHandlerFn,
} from "./types.js";
import { createShowtimeFetchRunHandler } from "./handlers/run-showtime-fetch.js";
import { createRecheckRunHandler } from "./handlers/run-recheck.js";
import { createScheduleResolutionRunHandler } from "./handlers/run-schedule-resolution.js";
import { createMovieScheduleResolutionRunHandler } from "./handlers/run-movie-schedule-resolution.js";
import type { ProviderFetchActorDeps } from "./handlers/provider-fetch-actor.js";

/** Wraps a real, implemented handler for a registry slot. */
export function implementedHandler<Fn>(handler: Fn): HandlerEntry<Fn> {
  return { implemented: true, handler };
}

/**
 * Builds a registry slot that the harness never invokes (S11.3/S11.4 check `implemented`
 * first) but which throws `reason` verbatim if invoked directly (S11.7) — it does not
 * guess, silently skip, or return a fake success.
 */
export function notImplementedHandler<Fn extends (...args: never[]) => unknown>(
  reason: string,
): HandlerEntry<Fn> {
  return {
    implemented: false,
    reason,
    handler: (() => {
      throw new Error(reason);
    }) as unknown as Fn,
  };
}

export const SHOWTIME_FETCH_NOT_IMPLEMENTED =
  "SHOWTIME_FETCH handler not yet implemented — blocked on S8 (provider fetch actor)";
export const SCHEDULE_RESOLUTION_NOT_IMPLEMENTED =
  "SCHEDULE_RESOLUTION handler not yet implemented — blocked on S8 (provider fetch actor)";
export const MOVIE_SCHEDULE_RESOLUTION_NOT_IMPLEMENTED =
  "MOVIE_SCHEDULE_RESOLUTION handler not yet implemented — blocked on S8 (provider fetch actor)";
export const RECHECK_NOT_IMPLEMENTED =
  "RECHECK handler not yet implemented — blocked on S22 (showtimes.recheck)";
export const AGGREGATE_NOT_IMPLEMENTED =
  "AGGREGATE handler not yet implemented — blocked on gate 22a (accessibility ranking " +
  "semantics) and E4/E5 (answer assembly)";

/**
 * The default registry: all five slots (JOB×2, RUN×2, AGGREGATE) are loud-fail
 * placeholders (S11.7/S11.8). Real deployments override individual slots with
 * `implementedHandler` as S8/E4/E5 land; nothing here guesses ahead of them
 * (S11.11: no Playwright, Chrome, browser-runtime, or answer-engine import).
 */
export function createPlaceholderRegistry(): DispatchRegistry {
  return {
    job: {
      SHOWTIME_FETCH: notImplementedHandler<JobHandlerFn>(SHOWTIME_FETCH_NOT_IMPLEMENTED),
      SCHEDULE_RESOLUTION: notImplementedHandler<JobHandlerFn>(SCHEDULE_RESOLUTION_NOT_IMPLEMENTED),
      MOVIE_SCHEDULE_RESOLUTION: notImplementedHandler<JobHandlerFn>(
        MOVIE_SCHEDULE_RESOLUTION_NOT_IMPLEMENTED,
      ),
    },
    run: {
      SHOWTIME_FETCH: notImplementedHandler<RunHandlerFn>(SHOWTIME_FETCH_NOT_IMPLEMENTED),
      SCHEDULE_RESOLUTION: notImplementedHandler<RunHandlerFn>(SCHEDULE_RESOLUTION_NOT_IMPLEMENTED),
      MOVIE_SCHEDULE_RESOLUTION: notImplementedHandler<RunHandlerFn>(
        MOVIE_SCHEDULE_RESOLUTION_NOT_IMPLEMENTED,
      ),
      RECHECK: notImplementedHandler<RunHandlerFn>(RECHECK_NOT_IMPLEMENTED),
    },
    aggregate: notImplementedHandler<AggregateHandlerFn>(AGGREGATE_NOT_IMPLEMENTED),
  };
}

/**
 * S8.17 — wires the two `RUN` slots to the real provider fetch actor handlers built
 * from the injected dependency set, returning a new registry. `createPlaceholderRegistry`
 * itself is untouched: zero-arg callers keep the all-placeholder registry unchanged, and
 * deployment code composes the real one from it without altering any existing
 * placeholder behavior. The `job.*` and `aggregate` slots are never altered (S8.1).
 */
export function withProviderFetchActor(
  registry: DispatchRegistry,
  deps: ProviderFetchActorDeps,
): DispatchRegistry {
  return {
    ...registry,
    run: {
      ...registry.run,
      SHOWTIME_FETCH: implementedHandler(createShowtimeFetchRunHandler(deps)),
      SCHEDULE_RESOLUTION: implementedHandler(createScheduleResolutionRunHandler(deps)),
      MOVIE_SCHEDULE_RESOLUTION: implementedHandler(createMovieScheduleResolutionRunHandler(deps)),
      RECHECK: implementedHandler(createRecheckRunHandler(deps)),
    },
  };
}
