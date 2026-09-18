import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";

beforeEach(() => {
  useSeatfirstStore.setState({
    screen: "result",
    movie: "Dune: Part Three",
    selectedMovieId: "mv_dune3",
    movieFocused: false,
    movieSelectionSource: "custom",
    isCheckingLiveSchedule: true,
    liveScheduleError: "Live schedule check failed",
    selectedShowtimeIdx: 2,
    searchId: "srch_cold",
    status: "COMPLETE",
    resolved: 4,
    total: 4,
  });
});

describe("flowSlice.showPlayingHere discovery (UI42.9)", () => {
  it("returns to the search form with the movie picker focused", () => {
    useSeatfirstStore.getState().showPlayingHere();
    expect(useSeatfirstStore.getState().screen).toBe("search");
    expect(useSeatfirstStore.getState().movieFocused).toBe(true);
  });

  it("ends the live search session so the result screen cannot re-derive", () => {
    useSeatfirstStore.getState().showPlayingHere();
    expect(useSeatfirstStore.getState().searchId).toBeNull();
    expect(useSeatfirstStore.getState().status).toBeNull();
    expect(useSeatfirstStore.getState().answer).toBeNull();
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBeNull();
  });

  it("keeps the user's movie selection — picking its replacement is the point", () => {
    useSeatfirstStore.getState().showPlayingHere();
    expect(useSeatfirstStore.getState().movie).toBe("Dune: Part Three");
    expect(useSeatfirstStore.getState().selectedMovieId).toBe("mv_dune3");
    expect(useSeatfirstStore.getState().movieSelectionSource).toBe("custom");
  });

  it("clears stale live-schedule footer state so the reopened picker starts clean", () => {
    useSeatfirstStore.getState().showPlayingHere();
    expect(useSeatfirstStore.getState().isCheckingLiveSchedule).toBe(false);
    expect(useSeatfirstStore.getState().liveScheduleError).toBeNull();
  });
});
