import { useCallback } from "react";
import type { Placement, RankedAnswer, RecheckResult, RecoveryOption } from "@seatfirst/core";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import {
  formatPlacementLabel,
  recheckErrorLabel,
  unavailableCauseLabel,
  resolveHandoffTarget,
  resolveActivePlacementCard,
} from "@/lib/presentation";
import type { PlacementCard, SeatGridRow } from "@/types/placement";
import { GRID_COLS, GRID_ROWS } from "../demoData";
export interface HandoffViewModel {
  recheckStatus: RecheckResult["status"] | "idle" | "rechecking" | "unavailable";
  isRechecking: boolean;
  recheckResult: RecheckResult | null;
  recheckErrorCode: string | null;
  recheckErrorMessage: string | null;
  recheckErrorLabel: string | null;
  recheckStoreStatus: "idle" | "rechecking" | "available" | "gone" | "unavailable";
  leftIsAuditorium: boolean;
  activePlacement: PlacementCard | null;
  /** The lost original placement's compact row-and-seat label, when resolvable. */
  originalPlacementLabel?: string | null;
  gridRows: SeatGridRow[];
  actions: {
    recheck: () => Promise<void>;
    clearRecheck: () => void;
    retryRecheck: () => Promise<void>;
    restoreRecommendation: () => void;
    continueHandoff: () => void;
    acceptReplacement: () => void;
  };
}

function resolveOriginalPlacement(
  answer: RankedAnswer,
  showtimeId: string | null,
): Placement | null {
  if (answer.mode === "CONFIDENT") {
    return showtimeId === null ||
      answer.primary.showtimes.some((offer) => offer.showtimeId === showtimeId)
      ? answer.primary.placement
      : null;
  }
  if (answer.mode === "HEDGED") {
    const recommendation =
      showtimeId === null
        ? answer.alternatives[0]
        : answer.alternatives.find((alternative) =>
            alternative.showtimes.some((offer) => offer.showtimeId === showtimeId),
          );
    return recommendation?.placement ?? null;
  }
  return null;
}

function buildGrid(
  placement: PlacementCard,
  mini: boolean,
  focusedRecoveryOption: RecoveryOption | null,
  isReplacement: boolean,
): SeatGridRow[] {
  const lostSet = new Set<string>();
  const activeSet = new Set<string>();
  const addRun = (
    run: { row: number; startCol: number; count: number },
    target: Set<string>,
  ): void => {
    for (let c = run.startCol; c < run.startCol + run.count; c += 1) {
      target.add(`${run.row}-${c}`);
    }
  };
  if (isReplacement) {
    addRun(placement.run, lostSet);
    if (focusedRecoveryOption !== null) addRun(focusedRecoveryOption.placement, activeSet);
  } else {
    addRun(placement.run, activeSet);
  }

  const base = mini ? 5 : 8;
  const big = mini ? 7 : 11;
  const gridCols = Math.max(
    GRID_COLS,
    placement.run.startCol + placement.run.count,
    focusedRecoveryOption === null
      ? 0
      : focusedRecoveryOption.placement.startCol + focusedRecoveryOption.placement.count,
  );
  const rows: SeatGridRow[] = [];
  for (let r = 0; r < GRID_ROWS; r += 1) {
    const dots = [];
    for (let c = 0; c < gridCols; c += 1) {
      const key = `${r}-${c}`;
      const lost = lostSet.has(key);
      const active = !lost && activeSet.has(key);
      dots.push({
        active,
        hue: isReplacement && active ? "amber" : placement.hue,
        size: active || lost ? big : base,
        lost,
      });
    }
    rows.push({ dots });
  }
  return rows;
}

export function useHandoffViewModel(
  focusedRecoveryOption: RecoveryOption | null = null,
): HandoffViewModel {
  const store = useSeatfirstStore();
  const {
    recheckStatus: recheckStoreStatus,
    recheckResult,
    recheckErrorCode,
    recheckErrorMessage,
    clearRecheck,
    restoreRecommendation,
    continueHandoff,
    acceptReplacement,
  } = store;

  const isRechecking = recheckStoreStatus === "rechecking";
  let recheckStatus: HandoffViewModel["recheckStatus"] = "idle";
  let recheckErrorLabelStr: string | null = null;
  if (recheckResult !== null) {
    if (recheckResult.status === "UNAVAILABLE") {
      recheckStatus = "unavailable";
      recheckErrorLabelStr = unavailableCauseLabel(recheckResult.cause);
    } else if (recheckResult.status === "AVAILABLE") {
      recheckStatus = "AVAILABLE";
    } else if (recheckResult.status === "GONE") {
      recheckStatus = "GONE";
    }
  } else if (recheckStoreStatus === "rechecking") {
    recheckStatus = "rechecking";
  } else if (recheckStoreStatus === "unavailable") {
    recheckStatus = "unavailable";
    recheckErrorLabelStr = recheckErrorLabel(recheckErrorCode, recheckErrorMessage);
  } else if (recheckStoreStatus === "available") {
    recheckStatus = "AVAILABLE";
  } else if (recheckStoreStatus === "gone") {
    recheckStatus = "GONE";
  }
  if (recheckResult === null && recheckStoreStatus === "idle") {
    recheckStatus = "idle";
  }

  const liveAnswer = store.answer;
  const liveGroups = store.groups;
  // ADR 0017 amendment — resolve the actually-clicked showtime's own card: primary,
  // whichever alternative covers it, or (now that every resolved hit carries a nonce)
  // the hit-fallback's own row/seats — never silently reusing primary's/alternatives[0]'s.
  const activePlacement: PlacementCard | null =
    liveAnswer !== null && liveGroups.length > 0
      ? resolveActivePlacementCard(
          liveAnswer,
          liveGroups,
          store.recheckSelectedShowtimeId,
          store.partySize,
        )
      : null;
  const originalPlacement =
    store.screen === "replacement" && liveAnswer !== null
      ? resolveOriginalPlacement(liveAnswer, store.recheckSelectedShowtimeId)
      : null;
  const originalPlacementLabel =
    originalPlacement === null ? null : formatPlacementLabel(originalPlacement);
  const recovery =
    recheckResult !== null && recheckResult.status === "GONE" ? recheckResult.recovery : null;
  const replacementFocus =
    store.screen === "replacement" ? (focusedRecoveryOption ?? recovery?.[0] ?? null) : null;
  const gridRows =
    activePlacement === null
      ? []
      : buildGrid(activePlacement, false, replacementFocus, store.screen === "replacement");

  const leftIsAuditorium =
    store.screen === "recheck" || store.screen === "replacement" || store.screen === "confirmed";

  const executeRecheck = useCallback(
    async (
      placement: Pick<Placement, "placementKey">,
      targetShowtimeId: string,
      nonce: string | null,
    ) => {
      const { recheckShowtime } = await import("@/api/showtimes");
      const { isRecord, readTrpcErrorCode } = await import("@/lib/errorEnvelope");
      const s = useSeatfirstStore.getState();
      const setError = s.setRecheckError;
      const start = s.startRecheck;
      const currentSearchId = s.searchId;
      if (currentSearchId === null || currentSearchId.length === 0) return;
      if (nonce === null || nonce.length === 0) {
        setError({ code: "NONCE_MISSING", message: "Not ready — return to results" });
        return;
      }
      const input = {
        searchId: currentSearchId,
        showtimeId: targetShowtimeId,
        placementKey: placement.placementKey,
        nonce,
      };
      start(input);
      try {
        const result = await recheckShowtime(input);
        s.setRecheckResult(result);
      } catch (err: unknown) {
        let code: string | null = readTrpcErrorCode(err);
        let message: string | null =
          isRecord(err) && typeof err.message === "string" ? err.message : null;
        if (code === null && err instanceof Error) {
          if (
            err.message === "UNAUTHORIZED" ||
            err.message === "CONFLICT" ||
            err.message === "TIMEOUT" ||
            err.message === "TOO_MANY_REQUESTS" ||
            err.message === "NETWORK_ERROR"
          ) {
            code = err.message;
          } else if (
            err.message.includes("Network") ||
            err.message.includes("fetch") ||
            err.message.includes("Failed to fetch")
          ) {
            code = "NETWORK_ERROR";
            message = "Couldn't re-verify — check your connection and try again";
          } else {
            code = "UNKNOWN";
          }
        }
        if (code === "NETWORK_ERROR") {
          setError({ code, message: "Couldn't re-verify — check your connection and try again" });
          return;
        }
        if (code === "UNAUTHORIZED") {
          setError({
            code,
            message: "This selection expired — pick the seats again from the answer",
          });
          return;
        }
        if (code === "CONFLICT") {
          setError({ code, message: "Already checked — pick again" });
          return;
        }
        if (code === "TIMEOUT") {
          // ADR 0024 amendment (2026-09-03): TIMEOUT always shows the canonical reassurance
          // copy via `recheckErrorLabel`'s code branch, never a raw/generic upstream message
          // — `recheckErrorLabel` checks `fallback` before `code`, so this must stay null.
          setError({ code, message: null });
          return;
        }
        if (code === "TOO_MANY_REQUESTS") {
          setError({ code, message: message ?? "Too many requests — try again shortly" });
          return;
        }
        setError({ code: code ?? "UNKNOWN", message: message ?? "Couldn't re-verify — try again" });
      }
    },
    [],
  );

  const triggerRecheck = useCallback(async () => {
    const s = useSeatfirstStore.getState();
    const currentAnswer = s.answer;
    const currentStatus = s.status;
    const idx = s.selectedShowtimeIdx;
    const isTerminal =
      currentStatus === "COMPLETE" || currentStatus === "PARTIAL" || currentStatus === "HALTED";
    if (!isTerminal) return;
    if (s.searchId === null || s.searchId.length === 0) return;
    if (currentAnswer === null) return;
    // ADR 0017 amendment — resolve the actually-clicked showtime generically
    // (primary, every alternative, then best-hit fallback) instead of hardcoding
    // primary/alternatives[0]. The clicked showtime is the handoff's own selection
    // when one started; else the legacy index resolved against the same generic
    // lookup so a non-first HEDGED alternative keeps its own placement/nonce.
    const clickedShowtimeId = s.recheckSelectedShowtimeId;
    if (clickedShowtimeId !== null) {
      const target = resolveHandoffTarget(currentAnswer, s.groups, clickedShowtimeId);
      if (target === null) return;
      await executeRecheck({ placementKey: target.placementKey }, target.showtimeId, target.nonce);
      return;
    }
    let placement: Pick<Placement, "placementKey"> | null = null;
    let offer: { showtimeId: string; nonce: string | null } | null = null;
    if (currentAnswer.mode === "CONFIDENT") {
      placement = currentAnswer.primary.placement;
      const offers = currentAnswer.primary.showtimes;
      if (idx !== null && offers[idx]) offer = offers[idx];
    } else if (currentAnswer.mode === "HEDGED") {
      // Scan every alternative for the indexed offer instead of assuming [0]: the
      // index addresses each alternative's own showtimes array, so the first
      // alternative carrying that position wins (byte-identical when idx is valid
      // in alternatives[0], correct otherwise).
      for (const alternative of currentAnswer.alternatives) {
        const offers = alternative.showtimes;
        if (idx !== null && offers[idx]) {
          placement = alternative.placement;
          offer = offers[idx];
          break;
        }
      }
    } else {
      return;
    }
    if (placement === null || offer === null) return;
    await executeRecheck(placement, offer.showtimeId, offer.nonce);
  }, [executeRecheck]);

  const retryRecheck = useCallback(async () => {
    await triggerRecheck();
  }, [triggerRecheck]);

  return {
    recheckStatus,
    isRechecking,
    recheckResult,
    recheckErrorCode,
    recheckErrorMessage,
    recheckErrorLabel: recheckErrorLabelStr,
    recheckStoreStatus,
    leftIsAuditorium,
    activePlacement,
    originalPlacementLabel,
    gridRows,
    actions: {
      recheck: triggerRecheck,
      clearRecheck,
      retryRecheck,
      restoreRecommendation,
      continueHandoff,
      acceptReplacement,
    },
  };
}
