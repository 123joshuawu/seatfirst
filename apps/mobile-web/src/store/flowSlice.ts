import type { StateCreator } from "zustand";
import { searchInitialState } from "./searchSlice";
import type { Screen } from "@/types/placement";
import type { SeatfirstStore } from "./seatfirstStore";

/**
 * Flow slice — owns screen FSM and derived-flow actions. Split per UI1 Design
 * so UI3 (search lifecycle/streaming) can land without touching the form slice.
 * Real search progress streams via useSearchSubscription (UI3); the legacy fake
 * progress timers were removed in UI12.4.
 */

export interface FlowState {
  screen: Screen;
  selectedShowtimeIdx: number | null;
  elapsedSeconds: number;
  hasShownReplacement: boolean;
}

export interface FlowActions {
  prepareSubmit: () => void;
  backToSearch: () => void;
  changeFormat: () => void;
  widenWindow: () => void;
  showPlayingHere: () => void;
  restoreRecommendation: () => void;
  selectShowtime: (idx: number) => void;
  continueHandoff: () => void;
  acceptReplacement: () => void;
  seeOtherOptions: () => void;
  restart: () => void;
}

export type FlowSlice = FlowState & FlowActions;

export const flowInitialState: FlowState = {
  screen: "search",
  selectedShowtimeIdx: null,
  elapsedSeconds: 4,
  hasShownReplacement: false,
};

export const createFlowSlice: StateCreator<SeatfirstStore, [], [], FlowSlice> = (set, get) => {
  // "checked N seconds ago" ticker while the result screen is showing.
  // Mirrors useSeatfirstDemo.ts:121-126. Runs for the store lifetime.
  const elapsedInterval = setInterval(() => {
    const s = get();
    if (s.screen === "result") {
      set({ elapsedSeconds: s.elapsedSeconds + 1 });
    }
  }, 1000);
  // Allow process to exit in tests / not block event loop teardown.
  // setInterval returns NodeJS.Timeout in Node (with unref) but number/DOM Timeout in browsers; narrow cast covers only this unref probe
  if (typeof (elapsedInterval as unknown as { unref?: () => void }).unref === "function") {
    (elapsedInterval as unknown as { unref: () => void }).unref?.();
  }

  return {
    ...flowInitialState,

    prepareSubmit: () => {
      const s = get();
      if (!s.movie.trim()) return;
      // Theatre is now explicitly selected via bootstrap `selectedTheatre` or `selectedTheatres`;
      // do not auto-confirm a theatre here — the form's Find action is gated on theatre
      // selection upstream (searchDisabled), so reaching this point means a theatre
      // is already selected (or the caller is the legacy demo harness).
      if (s.selectedTheatre === null && s.selectedTheatres.length === 0) return;
      // ADR 0054: no screen transition here. The screen:"checking" flip happens only
      // via searchSlice's setSearchId conditional branch after `create` succeeds, so a
      // rejected create never leaves screen:"search" and needs no revert.
      set({
        selectedShowtimeIdx: null,
      });
    },

    backToSearch: () => {
      // End the client-side search session along with the navigation: the screen
      // derivation in useSeatfirstDemo re-derives "result"/terminal screens from
      // liveStatus/liveAnswer every render, so leaving them set would override
      // screen:"search" on the very next render. Same reset a new startSearch does
      // (useSearchSubscription startSearch resets answer/groups before create).
      set({ screen: "search", ...searchInitialState });
    },

    changeFormat: () => {
      set({
        screen: "search",
        formatPref: "any",
        selectedShowtimeIdx: null,
        ...searchInitialState,
      });
    },

    widenWindow: () => {
      const s = get();
      // UI24 (ADR 0052 §6): clear-time, then clear-format, then the bare reset.
      // The weekday-reset branch is gone and no automatic date-widening rule
      // is added — `selectedDates` membership is never widened automatically.
      const timeFiltered =
        s.selectedBands.length > 0 || (s.timeOfDay !== "All times" && s.timeOfDay !== "Any time");
      const formatFiltered = s.formatPref !== "any";
      if (timeFiltered) {
        set({
          screen: "search",
          timeOfDay: "All times",
          selectedBands: [],
          selectedShowtimeIdx: null,
          ...searchInitialState,
        });
        return;
      }
      if (formatFiltered) {
        set({
          screen: "search",
          formatPref: "any",
          selectedShowtimeIdx: null,
          ...searchInitialState,
        });
        return;
      }
      set({
        screen: "search",
        selectedShowtimeIdx: null,
        ...searchInitialState,
      });
    },
    showPlayingHere: () => {
      // UI42.9 (ADR 0100 §5): 1-click discovery from an EMPTY no-schedule-match
      // outcome. Ends the client-side search session like backToSearch (a stale
      // terminal answer would re-derive the result screen over screen:"search")
      // and focuses the movie picker so it opens pre-populated with the newly
      // warmed theatre schedule in Hot Mode. Cross-slice write: movieFocused
      // lives in searchFormSlice, but all slices share the one Zustand store
      // instance, so set() reaches it directly. The user's movie selection is
      // kept — picking its replacement is the point of the flow.
      set({
        screen: "search",
        movieFocused: true,
        selectedShowtimeIdx: null,
        // UI42.6 follow-up: drop any stale live-schedule footer state so the
        // reopened picker starts clean. movieSelectionSource is kept alongside
        // the kept movie selection it describes.
        isCheckingLiveSchedule: false,
        liveScheduleError: null,
        ...searchInitialState,
      });
    },

    restoreRecommendation: () => set({ selectedShowtimeIdx: null, elapsedSeconds: 1 }),

    selectShowtime: (idx) => set({ selectedShowtimeIdx: idx }),

    continueHandoff: () => {
      const s = get();
      if (s.selectedShowtimeIdx === null) return;
      set({ screen: "recheck" });
    },

    acceptReplacement: () => {
      set({ screen: "confirmed" });
    },

    seeOtherOptions: () => {
      set({ screen: "result", selectedShowtimeIdx: null });
    },

    restart: () => {
      // Full reset includes the live search session — a stale terminal status/answer
      // would re-derive the result screen over screen:"search" (same override as
      // backToSearch). See docs/ux-spec-search-initial-experience.md:69 for the
      // cancel path; restart is the same "form is authoritative again" intent.
      set({
        screen: "search",
        formatPref: "any",
        selectedShowtimeIdx: null,
        hasShownReplacement: false,
        movie: "",
        selectedMovieId: null,
        movieSelectionSource: null,
        isCheckingLiveSchedule: false,
        liveScheduleError: null,
        theaterQuery: "",
        theaterFocused: false,
        movieClearedNotice: null,
        isFormCollapsed: false,
        selectedTheatre: null,
        selectedTheatreMovies: null,
        ...searchInitialState,
      });
    },
  };
};
