import type { StateCreator } from "zustand";
import type { RecheckResult } from "@seatfirst/core";
import type { SeatfirstStore } from "./seatfirstStore";

export type RecheckStatus = "idle" | "rechecking" | "available" | "gone" | "unavailable";

export interface RecheckState {
  recheckStatus: RecheckStatus;
  /** UI30 (ADR 0063 §2): which showtime offer has a recheck in flight, if any. */
  recheckingShowtimeId: string | null;
  recheckErrorCode: string | null;
  recheckErrorMessage: string | null;
  recheckResult: RecheckResult | null;
  recheckSelectedShowtimeId: string | null;
  recheckSelectedPlacementKey: string | null;
  recheckAttemptedNonce: string | null;
  /** UI41 (ADR 0071 §UI41.1): every showtime marked taken by a GONE result.
   *  Append-only across rechecks (never cleared by startRecheck/dismiss) so a
   *  second recheck can't revert a taken row back to available-looking. */
  takenShowtimeIds: string[];
  /** UI41 (ADR 0071 §UI41.1): whether the recovery overlay is open. */
  recoverySheetOpen: boolean;
}

export interface RecheckActions {
  startRecheck: (opts: {
    searchId: string;
    showtimeId: string;
    placementKey: string;
    nonce: string;
  }) => void;
  setRecheckResult: (result: RecheckResult) => void;
  setRecheckError: (opts: { code: string | null; message: string | null }) => void;
  clearRecheck: () => void;
  /** UI41 (ADR 0071 §UI41.1): closes the recovery overlay, preserving taken state. */
  dismissRecovery: () => void;
}

export type RecheckSlice = RecheckState & RecheckActions;

export const recheckInitialState: RecheckState = {
  recheckStatus: "idle",
  recheckingShowtimeId: null,
  recheckErrorCode: null,
  recheckErrorMessage: null,
  recheckResult: null,
  recheckSelectedShowtimeId: null,
  recheckSelectedPlacementKey: null,
  recheckAttemptedNonce: null,
  takenShowtimeIds: [],
  recoverySheetOpen: false,
};

export const createRecheckSlice: StateCreator<SeatfirstStore, [], [], RecheckSlice> = (
  set,
  get,
) => ({
  ...recheckInitialState,

  startRecheck: ({ showtimeId, placementKey, nonce }) =>
    set({
      recheckStatus: "rechecking",
      recheckingShowtimeId: showtimeId,
      recheckErrorCode: null,
      recheckErrorMessage: null,
      recheckResult: null,
      recheckSelectedShowtimeId: showtimeId,
      recheckSelectedPlacementKey: placementKey,
      recheckAttemptedNonce: nonce,
      // UI41: a new flight closes the sheet but preserves taken rows — a
      // second recheck must not revert an already-taken row to available.
      recoverySheetOpen: false,
    }),

  setRecheckResult: (result) => {
    let next: RecheckStatus = "idle";
    if (result.status === "AVAILABLE") next = "available";
    else if (result.status === "GONE") next = "gone";
    else if (result.status === "UNAVAILABLE") next = "unavailable";
    if (result.status === "GONE") {
      const target = get().recheckSelectedShowtimeId;
      const prev = get().takenShowtimeIds;
      set({
        recheckStatus: next,
        recheckingShowtimeId: null,
        recheckResult: result,
        recheckErrorCode: null,
        recheckErrorMessage: null,
        takenShowtimeIds: target !== null && !prev.includes(target) ? [...prev, target] : prev,
        recoverySheetOpen: true,
      });
      return;
    }
    set({
      recheckStatus: next,
      recheckingShowtimeId: null,
      recheckResult: result,
      recheckErrorCode: null,
      recheckErrorMessage: null,
      recoverySheetOpen: false,
    });
  },

  setRecheckError: ({ code, message }) =>
    set({
      recheckStatus: "unavailable",
      recheckingShowtimeId: null,
      recheckErrorCode: code,
      recheckErrorMessage: message,
      recheckResult: null,
    }),

  clearRecheck: () => set({ ...recheckInitialState, takenShowtimeIds: [] }),

  dismissRecovery: () => set({ recoverySheetOpen: false }),
});
