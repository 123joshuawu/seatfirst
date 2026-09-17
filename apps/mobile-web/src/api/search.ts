/**
 * Thin API bindings for `searches.*` procedures.
 * Spec UI3.2 (create), UI3.3 (get), UI3.9 (cancel).
 */
import type { CancelSearchResponse, CreateSearchResponse, SearchStatus } from "@seatfirst/core";
import type { SearchSpec } from "@seatfirst/core";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@seatfirst/server";

import { trpcClient } from "@/lib/trpc";

export type GetSearchResult = inferRouterOutputs<AppRouter>["searches"]["get"];

/**
 * Call `searches.create` with the given spec and idempotency key.
 * Discriminated response: `PENDING_SCHEDULE` vs `RUNNING`.
 */
export async function createSearch(
  spec: SearchSpec,
  idempotencyKey: string,
  continuesSearchId?: string,
): Promise<CreateSearchResponse> {
  const input: { spec: SearchSpec; idempotencyKey: string; continuesSearchId?: string } = {
    spec,
    idempotencyKey,
  };
  if (continuesSearchId !== undefined) input.continuesSearchId = continuesSearchId;
  return trpcClient.searches.create.mutate(input);
}

/**
 * Call `searches.get` for the given searchId.
 * Returns the full `SearchResult` — typed as the router's inferred output
 * (which should be structurally identical to `SearchResult` from @seatfirst/core;
 * see note on spec.where NOT mismatch below).
 */
export async function getSearch(searchId: string): Promise<GetSearchResult> {
  return trpcClient.searches.get.query({ searchId });
}

/**
 * Call `searches.cancel` — exposed for UI5, no UI in UI3.
 * Idempotent no-op when already terminal (server echoes existing status).
 */
export async function cancelSearch(searchId: string): Promise<CancelSearchResponse> {
  return trpcClient.searches.cancel.mutate({ searchId });
}

/**
 * Call `searches.status` — lightweight status probe for S60 timeout recovery.
 * Unlike `searches.get`, it resolves for CANCELLED searches.
 */
export async function getSearchStatus(
  searchId: string,
): Promise<{ searchId: string; status: SearchStatus }> {
  return trpcClient.searches.status.query({ searchId });
}
