// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { create } from "zustand";
import {
  createSearchFormSlice,
  searchFormInitialState,
  hasWhereSelection,
  getWhereMode,
  getWhereFieldMode,
  type SearchFormSlice,
} from "./searchFormSlice";
import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";

// Isolated slice store for Where tests — does not depend on full SeatfirstStore composition.
function createWhereStore() {
  return create<SearchFormSlice>()((...a) => ({
    ...createSearchFormSlice(...a),
  }));
}

describe("searchFormSlice Where selection (UI18 Phase 1, ADR 0042 §3)", () => {
  let useStore: ReturnType<typeof createWhereStore>;

  beforeEach(() => {
    useStore = createWhereStore();
  });

  it("initial state has no selection — hasWhereSelection false, mode none, chips/CTA disabled", () => {
    const s = useStore.getState();
    expect(s.deviceCenter).toBeNull();
    expect(s.wherePlace).toBeNull();
    expect(s.selectedTheatres).toEqual([]);
    expect(s.whereQuery).toBe("");
    expect(s.whereFocused).toBe(false);
    expect(hasWhereSelection(s)).toBe(false);
    expect(getWhereMode(s)).toBe("none");
    expect(s.hasWhereSelection()).toBe(false);
    expect(s.getWhereMode()).toBe("none");
    expect(getWhereFieldMode(s)).toBe("empty");
    // Radius/limit defaults clamped correctly
    expect(s.whereRadiusKm).toBeCloseTo(10 * 1.609344);
    expect(s.whereLimit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    // Existing fields untouched
    expect(s.selectedDates).toEqual(searchFormInitialState.selectedDates);
    expect(s.movie).toBe("");
  });

  it("device select enables hasWhereSelection and mode device", () => {
    const s0 = useStore.getState();
    expect(s0.hasWhereSelection()).toBe(false);
    useStore.getState().selectDeviceLocation({ lat: 37.7749, lng: -122.4194 });
    const s = useStore.getState();
    expect(s.deviceCenter).toEqual({ lat: 37.7749, lng: -122.4194 });
    expect(s.wherePlace).toBeNull();
    expect(hasWhereSelection(s)).toBe(true);
    expect(getWhereMode(s)).toBe("device");
    expect(getWhereFieldMode(s)).toBe("place");
    expect(s.hasWhereSelection()).toBe(true);
  });

  it("place select stores the resolved display name separately and clamps radiusKm/limit", () => {
    const place = {
      query: "Sunnyvale",
      label: "Sunnyvale · 40 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      radiusKm: 40.23, // 25 mi — must clamp to 40
      limit: 100, // must clamp to 25
    };
    useStore.getState().selectPlace(place);
    const s = useStore.getState();
    // Clamped via DEFAULT_SEARCH_LIMITS
    expect(s.wherePlace?.radiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
    expect(s.wherePlace?.limit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    expect(s.whereRadiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
    expect(s.whereLimit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    expect(s.wherePlace?.query).toBe("Sunnyvale");
    expect(s.wherePlace?.label).toBe("Sunnyvale · 40 km around Sunnyvale");
    expect(s.wherePlace?.resolvedPlaceName).toBe("Sunnyvale, California, United States");
    // Not storing coordinate
    expect((s.wherePlace as unknown as { lat?: number }).lat).toBeUndefined();
    expect(s.deviceCenter).toBeNull();
    expect(hasWhereSelection(s)).toBe(true);
    expect(getWhereMode(s)).toBe("place");
    // Selected theatres retained — caller will populate via setSelectedTheatres
    expect(s.selectedTheatres).toEqual([]);
    // Now simulate resolved theatres LIST
    const theatres = [
      { id: "amc:theatre:1", providerId: "amc" },
      { id: "amc:theatre:2", providerId: "amc" },
    ];
    useStore.getState().setSelectedTheatres(theatres);
    expect(useStore.getState().selectedTheatres).toEqual(theatres);
    expect(hasWhereSelection(useStore.getState())).toBe(true);
    // Still place mode (device null, place not null)
    expect(getWhereMode(useStore.getState())).toBe("place");
    expect(getWhereFieldMode(useStore.getState())).toBe("place");
  });

  it("never stores typed place coordinate — only deviceCenter stores coordinate", () => {
    // Typed place
    useStore.getState().selectPlace({
      query: "near work",
      label: "near work · 10 km around near work",
      resolvedPlaceName: "Near Work, California, United States",
      radiusKm: 10,
      limit: 25,
    });
    const s1 = useStore.getState();
    expect(s1.wherePlace).not.toHaveProperty("lat");
    expect(s1.wherePlace).not.toHaveProperty("lng");
    expect(s1.wherePlace).not.toHaveProperty("center");
    expect(s1.deviceCenter).toBeNull();

    // Device location does store center (allowed per ADR 0045)
    useStore.getState().selectDeviceLocation({ lat: 10, lng: 20 });
    const s2 = useStore.getState();
    expect(s2.deviceCenter).toEqual({ lat: 10, lng: 20 });
    expect(s2.wherePlace).toBeNull();
  });

  it("keeps area selections and resolved refs intact when theatre editing is attempted", () => {
    const deviceRefs = [
      { id: "amc:theatre:1", providerId: "amc" },
      { id: "amc:theatre:2", providerId: "amc" },
    ];
    useStore.getState().selectDeviceLocation({ lat: 37.7, lng: -122.4 });
    useStore.getState().setSelectedTheatres(deviceRefs);

    // UI31.8: removals proceed while an area selection is active and mark the
    // draft hand-edited; pure adds stay guarded no-ops.
    useStore.getState().toggleTheatre(deviceRefs[0]);
    expect(useStore.getState().selectedTheatres).toEqual([deviceRefs[1]]);
    expect(useStore.getState().theatreListHandPruned).toBe(true);
    useStore.getState().selectTheatre({ id: "amc:theatre:3", providerId: "amc" });
    expect(useStore.getState().selectedTheatres).toEqual([deviceRefs[1]]);
    useStore.getState().deselectTheatre(deviceRefs[1].id);

    const deviceState = useStore.getState();
    expect(deviceState.deviceCenter).toEqual({ lat: 37.7, lng: -122.4 });
    expect(deviceState.wherePlace).toBeNull();
    expect(deviceState.selectedTheatres).toEqual([]);
    expect(deviceState.theatreListHandPruned).toBe(true);
    expect(getWhereMode(deviceState)).toBe("device");
    expect(getWhereFieldMode(deviceState)).toBe("place");

    useStore.setState({ ...searchFormInitialState });
    useStore.getState().selectPlace({
      query: "Sunnyvale",
      label: "Sunnyvale · 10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      radiusKm: 10,
      limit: 25,
    });
    const placeRefs = [
      { id: "amc:theatre:3", providerId: "amc" },
      { id: "amc:theatre:4", providerId: "amc" },
    ];
    useStore.getState().setSelectedTheatres(placeRefs);

    useStore.getState().toggleTheatre(placeRefs[0]);
    expect(useStore.getState().selectedTheatres).toEqual([placeRefs[1]]);
    expect(useStore.getState().theatreListHandPruned).toBe(true);
    useStore.getState().selectTheatre({ id: "amc:theatre:5", providerId: "amc" });
    expect(useStore.getState().selectedTheatres).toEqual([placeRefs[1]]);
    useStore.getState().deselectTheatre(placeRefs[1].id);

    const placeState = useStore.getState();
    expect(placeState.wherePlace?.query).toBe("Sunnyvale");
    expect(placeState.deviceCenter).toBeNull();
    expect(placeState.selectedTheatres).toEqual([]);
    expect(placeState.theatreListHandPruned).toBe(true);
    expect(getWhereMode(placeState)).toBe("place");
    expect(getWhereFieldMode(placeState)).toBe("place");
  });

  it("atomically replaces area refs and converts only on explicit request", () => {
    useStore.getState().selectTheatre({ id: "amc:theatre:0", providerId: "amc" });
    expect(getWhereFieldMode(useStore.getState())).toBe("theatres");
    useStore.getState().selectPlace({
      query: "Sunnyvale",
      label: "Sunnyvale · 10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      radiusKm: 10,
      limit: 25,
    });
    expect(useStore.getState().selectedTheatres).toEqual([]);
    expect(getWhereFieldMode(useStore.getState())).toBe("place");
    useStore.getState().setWhereRadiusKm(22);
    useStore.getState().setSelectedTheatres([
      { id: "amc:theatre:1", providerId: "amc", name: "AMC Sunnyvale" },
      { id: "amc:theatre:2", providerId: "amc", distanceKm: 2.5 },
    ]);

    useStore.getState().selectDeviceLocation({ lat: 37.7, lng: -122.4 });
    const deviceState = useStore.getState();
    expect(deviceState.deviceCenter).toEqual({ lat: 37.7, lng: -122.4 });
    expect(deviceState.wherePlace).toBeNull();
    expect(deviceState.whereRadiusKm).toBe(22);
    expect(deviceState.selectedTheatres).toEqual([]);
    expect(getWhereFieldMode(deviceState)).toBe("place");

    const resolvedRefs = [
      { id: "amc:theatre:3", providerId: "amc", name: "AMC Metreon" },
      { id: "amc:theatre:4", providerId: "amc", distanceKm: 3.5 },
    ];
    useStore.getState().setSelectedTheatres(resolvedRefs);
    useStore.getState().convertWherePlaceToTheatres();

    const converted = useStore.getState();
    expect(converted.deviceCenter).toBeNull();
    expect(converted.wherePlace).toBeNull();
    expect(converted.selectedTheatres).toEqual(resolvedRefs);
    expect(getWhereMode(converted)).toBe("theatres");
    expect(getWhereFieldMode(converted)).toBe("theatres");
  });

  it("selectTheatre/deselectTheatre work without clearing hand-edit already LIST", () => {
    useStore.getState().setSelectedTheatres([{ id: "amc:theatre:1", providerId: "amc" }]);
    expect(getWhereMode(useStore.getState())).toBe("theatres");
    useStore.getState().selectTheatre({ id: "amc:theatre:2", providerId: "amc" });
    expect(useStore.getState().selectedTheatres).toHaveLength(2);
    useStore.getState().deselectTheatre("amc:theatre:1");
    expect(useStore.getState().selectedTheatres).toEqual([
      { id: "amc:theatre:2", providerId: "amc" },
    ]);
    // No spurious clearing when already LIST
    expect(useStore.getState().deviceCenter).toBeNull();
    expect(useStore.getState().wherePlace).toBeNull();
    expect(getWhereFieldMode(useStore.getState())).toBe("theatres");
  });

  it("backspace removes a list theatre or an entire area selection", () => {
    // Case 1: theatres present — pops last
    useStore.getState().setSelectedTheatres([
      { id: "amc:theatre:1", providerId: "amc" },
      { id: "amc:theatre:2", providerId: "amc" },
      { id: "amc:theatre:3", providerId: "amc" },
    ]);
    useStore.getState().removeLastChip();
    expect(useStore.getState().selectedTheatres).toEqual([
      { id: "amc:theatre:1", providerId: "amc" },
      { id: "amc:theatre:2", providerId: "amc" },
    ]);
    useStore.getState().removeLastChip();
    useStore.getState().removeLastChip();
    expect(useStore.getState().selectedTheatres).toEqual([]);
    expect(hasWhereSelection(useStore.getState())).toBe(false);

    // Case 2: place chip when no theatres
    useStore.getState().selectPlace({
      query: "Sunnyvale",
      label: "Sunnyvale · 10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      radiusKm: 10,
      limit: 25,
    });
    useStore.getState().setSelectedTheatres([{ id: "amc:theatre:4", providerId: "amc" }]);
    expect(useStore.getState().wherePlace).not.toBeNull();
    useStore.getState().removeLastChip();
    expect(useStore.getState().wherePlace).toBeNull();
    expect(useStore.getState().selectedTheatres).toEqual([]);
    expect(hasWhereSelection(useStore.getState())).toBe(false);

    // Case 3: device chip when no theatres/place
    useStore.getState().selectDeviceLocation({ lat: 1, lng: 2 });
    expect(useStore.getState().deviceCenter).not.toBeNull();
    useStore.getState().removeLastChip();
    expect(useStore.getState().deviceCenter).toBeNull();
    expect(hasWhereSelection(useStore.getState())).toBe(false);
  });

  it("radius widening preserves the resolved device theatre set", () => {
    const resolvedRefs = [
      { id: "amc:theatre:1", providerId: "amc" },
      { id: "amc:theatre:2", providerId: "amc" },
    ];
    useStore.getState().selectDeviceLocation({ lat: 37.7, lng: -122.4 });
    useStore.getState().setSelectedTheatres(resolvedRefs);

    useStore.getState().setWhereRadiusKm(40);
    const widened = useStore.getState();
    expect(widened.whereRadiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
    expect(widened.selectedTheatres).toEqual(resolvedRefs);
    expect(getWhereFieldMode(widened)).toBe("place");
  });

  it("clearWhere resets all Where state but keeps existing form fields", () => {
    useStore.getState().selectDeviceLocation({ lat: 1, lng: 2 });
    useStore.getState().setWhereQuery("test");
    useStore.getState().setSelectedTheatres([{ id: "amc:theatre:1", providerId: "amc" }]);
    useStore.getState().setWhereRadiusKm(15);
    useStore.getState().selectMovie("Test Movie", "amc:movie:1");
    expect(useStore.getState().movie).toBe("Test Movie");
    useStore.getState().clearWhere();
    const s = useStore.getState();
    expect(s.deviceCenter).toBeNull();
    expect(s.wherePlace).toBeNull();
    expect(s.selectedTheatres).toEqual([]);
    expect(s.whereQuery).toBe("");
    expect(s.whereFocused).toBe(false);
    expect(s.whereRadiusKm).toBeCloseTo(10 * 1.609344);
    expect(s.whereLimit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    expect(hasWhereSelection(s)).toBe(false);
    // Existing fields untouched by clearWhere (movie persists)
    expect(s.movie).toBe("Test Movie");
  });

  it("changing theatre set keeps movie if still plays (reuse movieClearedNotice)", () => {
    useStore.getState().selectMovie("My Movie", "amc:movie:1");
    expect(useStore.getState().selectedMovieId).toBe("amc:movie:1");
    // Change theatres — movie not cleared automatically
    useStore.getState().setSelectedTheatres([{ id: "amc:theatre:1", providerId: "amc" }]);
    expect(useStore.getState().selectedMovieId).toBe("amc:movie:1");
    expect(useStore.getState().movie).toBe("My Movie");
    // toggle also keeps movie
    useStore.getState().toggleTheatre({ id: "amc:theatre:2", providerId: "amc" });
    expect(useStore.getState().selectedMovieId).toBe("amc:movie:1");
  });

  it("whereQuery and whereFocused management", () => {
    useStore.getState().setWhereQuery("Sunnyvale");
    expect(useStore.getState().whereQuery).toBe("Sunnyvale");
    useStore.getState().setWhereFocused(true);
    expect(useStore.getState().whereFocused).toBe(true);
    useStore.getState().setWhereFocused(false);
    expect(useStore.getState().whereFocused).toBe(false);
    useStore.getState().onWhereFocus();
    expect(useStore.getState().whereFocused).toBe(true);
    // onWhereBlur is async (150ms) — we test via setWhereFocused fallback
  });

  it("setWhereRadiusKm clamps to DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm, never hardcoded 40", () => {
    useStore.getState().setWhereRadiusKm(100);
    expect(useStore.getState().whereRadiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
    expect(useStore.getState().whereRadiusKm).toBe(40); // value check but via constant
    useStore.getState().setWhereRadiusKm(40.01);
    expect(useStore.getState().whereRadiusKm).toBe(40);
    useStore.getState().setWhereRadiusKm(5);
    expect(useStore.getState().whereRadiusKm).toBe(5);
    // wherePlace radius also clamped
    useStore.getState().selectPlace({
      query: "q",
      label: "q · 100 km around q",
      resolvedPlaceName: "Q, California, United States",
      radiusKm: 100,
      limit: 25,
    });
    expect(useStore.getState().wherePlace?.radiusKm).toBe(40);
  });

  it("setWhereLimit clamps to DEFAULT_SEARCH_LIMITS.maxTheatres", () => {
    useStore.getState().setWhereLimit(100);
    expect(useStore.getState().whereLimit).toBe(DEFAULT_SEARCH_LIMITS.maxTheatres);
    useStore.getState().setWhereLimit(5);
    expect(useStore.getState().whereLimit).toBe(5);
  });

  it("hasWhereSelection gate — fail→pass demonstration: CTA disabled when !hasWhereSelection", () => {
    // This is the gate ADR 0042 §3 requires: radius chips and CTA disabled when no selection.
    // If hasWhereSelection were removed (always true), this would fail — proving the gate matters.
    const initial = useStore.getState();
    expect(!hasWhereSelection(initial)).toBe(true);

    useStore.getState().selectDeviceLocation({ lat: 37.7, lng: -122.4 });
    expect(!hasWhereSelection(useStore.getState())).toBe(false);

    useStore.setState({ ...searchFormInitialState });
    useStore.getState().selectPlace({
      query: "Sunnyvale",
      label: "Sunnyvale · 10 km around Sunnyvale",
      resolvedPlaceName: "Sunnyvale, California, United States",
      radiusKm: 10,
      limit: 25,
    });
    expect(!hasWhereSelection(useStore.getState())).toBe(false);

    useStore.setState({ ...searchFormInitialState });
    useStore.getState().setSelectedTheatres([{ id: "amc:theatre:1", providerId: "amc" }]);
    expect(!hasWhereSelection(useStore.getState())).toBe(false);
  });
});
