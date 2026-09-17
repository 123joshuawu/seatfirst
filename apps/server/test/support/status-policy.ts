import { performancePolicy, ShowtimeStatusSchema } from "@seatfirst/core";
import type { ShowtimeStatus } from "@seatfirst/core";

/**
 * The single table-driven fixture binding BOTH of `performancePolicy`'s call sites to one
 * derivation (S15 verification item 7): the warm path's reservation filter in
 * `searches.create` (S15.5) and the cold path's `skipFetch` gate in the provider fetch
 * actor (ADR 0009, `apps/server/src/dispatch/handlers/provider-fetch-actor.ts`).
 *
 * Every row is derived by CALLING `performancePolicy` once per enum member here — never
 * hand-picked — so the two call sites' tests cannot silently drift into two independent
 * status lists. `excluded` is the shared verdict: `SKIP_SOLD_OUT` excludes a performance
 * from warm-path reservation exactly as it excludes it from cold-path fetch work.
 */
export interface StatusPolicyRow {
  readonly status: ShowtimeStatus;
  readonly policy: "FETCH" | "SKIP_SOLD_OUT" | "FETCH_UNKNOWN";
  readonly excluded: boolean;
}

const STATUSES = ShowtimeStatusSchema.options as readonly ShowtimeStatus[];

export const STATUS_POLICY_FIXTURE: readonly StatusPolicyRow[] = STATUSES.map((status) => {
  const policy = performancePolicy(status);
  return { status, policy, excluded: policy === "SKIP_SOLD_OUT" };
});
