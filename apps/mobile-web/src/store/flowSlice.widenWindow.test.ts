import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";

beforeEach(() => {
  useSeatfirstStore.setState({
    screen: "search",
    selectedDates: ["2026-08-28", "2026-08-29"],
    selectedBands: ["Evening"],
    timeOfDay: "Evening",
    formatPref: "any",
    selectedShowtimeIdx: 2,
  });
});

describe("flowSlice.widenWindow recovery ordering (UI24.8)", () => {
  it("clears time first when a time filter is active, keeping format and dates", () => {
    useSeatfirstStore.setState({
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      formatPref: "imax",
    });
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().timeOfDay).toBe("All times");
    expect(useSeatfirstStore.getState().selectedBands).toEqual([]);
    // Format waits its turn; dates are never widened automatically.
    expect(useSeatfirstStore.getState().formatPref).toBe("imax");
    expect(useSeatfirstStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("clears format once time is already clear, keeping dates", () => {
    useSeatfirstStore.setState({
      timeOfDay: "All times",
      selectedBands: [],
      formatPref: "imax",
    });
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().formatPref).toBe("any");
    expect(useSeatfirstStore.getState().timeOfDay).toBe("All times");
    expect(useSeatfirstStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("bare-resets when neither time nor format is filtered, keeping dates", () => {
    useSeatfirstStore.setState({
      timeOfDay: "All times",
      selectedBands: [],
      formatPref: "any",
    });
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().screen).toBe("search");
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBeNull();
    expect(useSeatfirstStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("time clears before format across two calls (ordering)", () => {
    useSeatfirstStore.setState({
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      formatPref: "imax",
    });
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().timeOfDay).toBe("All times");
    expect(useSeatfirstStore.getState().formatPref).toBe("imax");
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().formatPref).toBe("any");
    expect(useSeatfirstStore.getState().selectedDates).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("resets selectedShowtimeIdx and does not mint new search", () => {
    useSeatfirstStore.setState({ selectedShowtimeIdx: 5, searchId: null, status: null });
    useSeatfirstStore.getState().widenWindow();
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBeNull();
    expect(useSeatfirstStore.getState().searchId).toBeNull();
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });
});

describe("flowSlice.prepareSubmit (ADR 0054)", () => {
  it("never flips screen — checking arrives only via setSearchId after create succeeds", () => {
    useSeatfirstStore.setState({
      screen: "search",
      movie: "Dune",
      selectedTheatre: null,
      selectedTheatres: [
        {
          id: "amc:theatre:1",
          providerId: "amc",
          name: "Metreon",
          city: "SF",
          distanceKm: 2,
        },
      ],
    });
    useSeatfirstStore.getState().prepareSubmit();
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });

  it("resets selectedShowtimeIdx while leaving the form on search", () => {
    useSeatfirstStore.setState({
      screen: "search",
      movie: "Dune",
      selectedTheatre: null,
      selectedTheatres: [
        {
          id: "amc:theatre:1",
          providerId: "amc",
          name: "Metreon",
          city: "SF",
          distanceKm: 2,
        },
      ],
      selectedShowtimeIdx: 2,
    });
    useSeatfirstStore.getState().prepareSubmit();
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBeNull();
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });

  it("is a no-op when no theatre is selected (same guard as the old startSearch)", () => {
    useSeatfirstStore.setState({
      screen: "search",
      movie: "Dune",
      selectedTheatre: null,
      selectedTheatres: [],
      selectedShowtimeIdx: 2,
    });
    useSeatfirstStore.getState().prepareSubmit();
    expect(useSeatfirstStore.getState().screen).toBe("search");
    expect(useSeatfirstStore.getState().selectedShowtimeIdx).toBe(2);
  });
});
