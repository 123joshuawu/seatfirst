import type { CancelSearchResponse } from "@seatfirst/core";
import { cancelSearch, getSearchStatus } from "@/api/search";
import { getStopSubscription } from "./searchSubscriptionController";
import { useSeatfirstStore } from "@/store/seatfirstStore";

/**
 * UI5 cancel orchestration — cancels the active search via the API and
 * tears down the live subscription.
 */
export async function cancelCurrentSearch(): Promise<CancelSearchResponse> {
  // Fence out any subsequently-arriving stale SSE/poll/reconcile callback for
  // the search being cancelled, even if the cancel API call itself later fails.
  useSeatfirstStore.getState().incrementOperationGeneration();
  const store = useSeatfirstStore.getState();
  const searchId = store.searchId;
  if (searchId === null || searchId === undefined || searchId.length === 0) {
    throw new Error("No active search");
  }
  if (store.isCanceling) {
    throw new Error("Cancel already in progress");
  }

  useSeatfirstStore.setState({ isCanceling: true, cancelError: null });

  try {
    const res = await cancelSearch(searchId);

    const status = res.status;

    // Route through setSearchTerminal (not raw setState) so a CANCELLED result
    // returns control to the form (docs/ux-spec-search-initial-experience.md:69)
    // and terminal bookkeeping (phase, pending keys, cancel flags) matches the
    // SSE SEARCH_TERMINAL path. Echoed terminal statuses keep prior answer/groups.
    // `answer: null` preserves any prior answer (echo COMPLETE keeps its payload).
    useSeatfirstStore.getState().setSearchTerminal({ status, answer: null });

    const stop = getStopSubscription();
    if (stop !== null) {
      try {
        stop();
      } catch {
        // ignore
      }
    }

    return res;
  } catch (err) {
    // S60/ADR 0066 §5: the client cannot otherwise distinguish a committed
    // cancel from a dropped response (searches.get rejects CANCELLED
    // searches), so probe the lightweight searches.status endpoint before
    // giving up on a timeout/network failure.
    try {
      const probe = await getSearchStatus(searchId);
      if (probe.status === "CANCELLED") {
        // The cancel landed server-side despite the client-visible failure —
        // route through the same success path as the happy branch.
        useSeatfirstStore.getState().setSearchTerminal({ status: "CANCELLED", answer: null });

        const stop = getStopSubscription();
        if (stop !== null) {
          try {
            stop();
          } catch {
            // ignore
          }
        }

        return { searchId, status: "CANCELLED" };
      }
    } catch {
      // Probe failed — fall through to the existing failure behavior below.
    }
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.toLowerCase().includes("cancel") ? raw : `Cancel failed: ${raw}`;
    useSeatfirstStore.setState({ isCanceling: false, cancelError: msg });
    if (err instanceof Error) throw err;
    throw new Error(msg, { cause: err });
  }
}
