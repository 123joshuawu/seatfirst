/**
 * S8.17 — the `run.SHOWTIME_FETCH` registry-slot factory. A thin closure over the
 * shared provider fetch actor: every behavior (semaphore, control read, B4/B3 fencing,
 * navigation, outcome mapping, capacity release) lives in
 * `./provider-fetch-actor.js`, written once for both run kinds.
 */
import type { RunHandlerFn } from "../types.js";

import { runProviderFetch } from "./provider-fetch-actor.js";
import type { ProviderFetchActorDeps } from "./provider-fetch-actor.js";

export function createShowtimeFetchRunHandler(deps: ProviderFetchActorDeps): RunHandlerFn {
  return (context) => runProviderFetch(deps, context, "SHOWTIME_FETCH");
}
