import type { RunHandlerFn } from "../types.js";

import { runProviderFetch } from "./provider-fetch-actor.js";
import type { ProviderFetchActorDeps } from "./provider-fetch-actor.js";

export function createMovieScheduleResolutionRunHandler(
  deps: ProviderFetchActorDeps,
): RunHandlerFn {
  return (context) => runProviderFetch(deps, context, "MOVIE_SCHEDULE_RESOLUTION");
}
