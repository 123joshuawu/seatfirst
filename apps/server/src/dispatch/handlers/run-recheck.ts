/**
 * S22.2 — the `run.RECHECK` registry-slot factory. A thin closure over the shared
 * provider fetch actor, byte-for-byte the shape of `run-schedule-resolution.ts`: every
 * behavior (semaphore, control read, B4/B3 fencing, navigation, outcome mapping) lives in
 * `./provider-fetch-actor.js`, written once for every run kind.
 */
import type { RunHandlerFn } from "../types.js";

import { runProviderFetch } from "./provider-fetch-actor.js";
import type { ProviderFetchActorDeps } from "./provider-fetch-actor.js";

export function createRecheckRunHandler(deps: ProviderFetchActorDeps): RunHandlerFn {
  return (context) => runProviderFetch(deps, context, "RECHECK");
}
