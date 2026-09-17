import { useCallback } from "react";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { cancelCurrentSearch } from "@/lib/cancelSearch";
import { isScanRunning } from "@/store/searchSlice";
import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import type { SearchPhase } from "@/store/searchSlice";

export interface SearchProgressViewModel {
  isChecking: boolean;
  etaLabel: string | null;
  checkedCount: number;
  totalShowtimes: number;
  isLocked: boolean;
  isScanRunning: boolean;
  isCanceling: boolean;
  cancelError: string | null;
  searchId: string | null;
  phase: SearchPhase;
  phaseDetail: string | null;
  actions: {
    cancelSearch: () => Promise<void>;
  };
}

export function useSearchProgressViewModel(): SearchProgressViewModel {
  const store = useSeatfirstStore();
  const liveStatus = store.status;
  const liveResolved = store.resolved;
  const liveTotal = store.total;

  const scheduleSkeleton = store.scheduleSkeleton;
  const scheduleSkeletonLen = scheduleSkeleton.length;
  const admittedLen = scheduleSkeleton.filter((e) => e.admitted).length;

  const checkedCount = liveStatus !== null ? liveResolved : 0;
  const totalShowtimes = (() => {
    if (liveStatus === null) return 0;
    if (scheduleSkeletonLen > 0) {
      const preferred = admittedLen > 0 ? admittedLen : scheduleSkeletonLen;
      if (liveTotal === 0) return preferred;
      if (liveTotal === DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes && preferred !== liveTotal)
        return preferred;
    }
    if (scheduleSkeletonLen === 0) {
      const isNonTerminal = liveStatus === "PENDING_SCHEDULE" || liveStatus === "RUNNING";
      if (isNonTerminal && liveTotal === DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes) return 0;
    }
    if (liveTotal > 0) return liveTotal;
    return 0;
  })();

  const isLocked = isScanRunning(liveStatus);
  const isCanceling = store.isCanceling;
  const cancelError = store.cancelError;
  const searchId = store.searchId;

  // Checking state derived logically just like in useSeatfirstDemo where screen="checking"
  // implies checking state. ADR 0054 (Rec 2.1): also cover the tap-to-first-signal
  // window — phase is "creating" while `create` is in flight, before liveStatus arrives.
  const isChecking =
    liveStatus === "PENDING_SCHEDULE" ||
    liveStatus === "RUNNING" ||
    store.phase === "creating" ||
    store.screen === "checking";

  const cancelSearchAction = useCallback(async () => {
    await cancelCurrentSearch();
  }, []);
  const etaLabel = (() => {
    if (!isChecking) return null;
    const ms = store.estimatedMs;
    if (ms === null) return null;
    return ms > 5000 ? "Larger search — this may take a bit…" : "This may take a few more seconds…";
  })();

  const phaseDetail = (() => {
    if (store.phase === "polling") return "Reconnecting…";
    if (store.phase === "reconciling") return "Syncing…";
    return null;
  })();

  return {
    isChecking,
    etaLabel,
    checkedCount,
    totalShowtimes,
    isLocked,
    isScanRunning: isLocked,
    isCanceling,
    cancelError,
    searchId,
    phase: store.phase,
    phaseDetail,
    actions: {
      cancelSearch: cancelSearchAction,
    },
  };
}
