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
};

export const createRecheckSlice: StateCreator<SeatfirstStore, [], [], RecheckSlice> = (set) => ({
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
    }),

  setRecheckResult: (result) => {
    let next: RecheckStatus = "idle";
    if (result.status === "AVAILABLE") next = "available";
    else if (result.status === "GONE") next = "gone";
    else if (result.status === "UNAVAILABLE") next = "unavailable";
    set({
      recheckStatus: next,
      recheckingShowtimeId: null,
      recheckResult: result,
      recheckErrorCode: null,
      recheckErrorMessage: null,
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

  clearRecheck: () => set({ ...recheckInitialState }),
});
