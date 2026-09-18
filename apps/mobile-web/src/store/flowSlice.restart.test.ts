import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";

beforeEach(() => {
  useSeatfirstStore.setState({
    screen: "result",
    movie: "Fathom Event Title",
    selectedMovieId: "custom:fathom-event-title",
    movieSelectionSource: "custom",
    isCheckingLiveSchedule: true,
    liveScheduleError: "Live schedule check failed",
  });
});

// UI42 follow-up (Task A fields): restart clears the movie, so it must reset
// the source flag alongside it — otherwise a stale custom-source flag would
// misroute buildSearchSpec to titles mode on the next submit.
describe("flowSlice.restart resets UI42 movie/check state", () => {
  it("clears the movie, its selection source, and transient live-schedule state", () => {
    useSeatfirstStore.getState().restart();
    const s = useSeatfirstStore.getState();
    expect(s.screen).toBe("search");
    expect(s.movie).toBe("");
    expect(s.selectedMovieId).toBeNull();
    expect(s.movieSelectionSource).toBeNull();
    expect(s.isCheckingLiveSchedule).toBe(false);
    expect(s.liveScheduleError).toBeNull();
  });
});
