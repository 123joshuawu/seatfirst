import type { StateCreator } from "zustand";
import type {
  SessionBootstrapResponse,
  TheatreMoviesResponse,
  TheatreSearchHit,
} from "@seatfirst/core";

import type { SeatfirstStore } from "./seatfirstStore";

export interface BootstrapState {
  bootstrapReady: boolean;
  bootstrapLoading: boolean;
  bootstrapError: string | null;
  sessionId: string | null;
  limits: SessionBootstrapResponse["limits"] | null;
  selectedTheatre: TheatreSearchHit | null;
  selectedTheatreMovies: TheatreMoviesResponse | null;
}

export interface BootstrapActions {
  setBootstrapLoading: (loading: boolean) => void;
  setBootstrapSuccess: (sessionId: string, limits: SessionBootstrapResponse["limits"]) => void;
  setBootstrapError: (error: string | null) => void;
  setSelectedTheatre: (hit: TheatreSearchHit) => void;
  clearTheatreSelection: () => void;
  setTheatreMovies: (response: TheatreMoviesResponse | null) => void;
}

export type BootstrapSlice = BootstrapState & BootstrapActions;

export const bootstrapInitialState: BootstrapState = {
  bootstrapReady: false,
  bootstrapLoading: false,
  bootstrapError: null,
  sessionId: null,
  limits: null,
  selectedTheatre: null,
  selectedTheatreMovies: null,
};

export const createBootstrapSlice: StateCreator<SeatfirstStore, [], [], BootstrapSlice> = (
  set,
) => ({
  ...bootstrapInitialState,

  setBootstrapLoading: (loading) => set({ bootstrapLoading: loading }),

  setBootstrapSuccess: (sessionId, limits) =>
    set({
      bootstrapReady: true,
      bootstrapLoading: false,
      bootstrapError: null,
      sessionId,
      limits,
    }),

  setBootstrapError: (error) =>
    set({
      bootstrapLoading: false,
      bootstrapError: error,
    }),

  setSelectedTheatre: (hit) =>
    set({
      selectedTheatre: hit,
      // Clear stale movies when theatre changes
      selectedTheatreMovies: null,
    }),

  clearTheatreSelection: () =>
    set({
      selectedTheatre: null,
      selectedTheatreMovies: null,
    }),

  setTheatreMovies: (response) => set({ selectedTheatreMovies: response }),
});
