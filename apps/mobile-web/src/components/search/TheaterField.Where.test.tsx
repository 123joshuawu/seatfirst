import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import { flowInitialState } from "@/store/flowSlice";
import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import { TheaterField } from "./TheaterField";

const { mockUseTheatreSearch } = vi.hoisted(() => ({ mockUseTheatreSearch: vi.fn() }));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: mockUseTheatreSearch,
}));
// Mock geocodeSeam to avoid real network
vi.mock("@/lib/geocodeSeam", () => ({
  createGeocodeResolver: () => ({
    resolvePlace: vi.fn((q: string) => {
      if (q.toLowerCase().includes("notfound")) return Promise.resolve({ kind: "PLACE_NOT_FOUND" });
      if (q.toLowerCase().includes("unavailable"))
        return Promise.resolve({ kind: "PLACE_RESOLUTION_UNAVAILABLE" });
      return Promise.resolve({
        theatres: [
          {
            theatreId: "amc:theatre:1",
            distanceKm: 1.2,
            name: "AMC Metreon 16",
            city: "San Francisco",
          },
        ],
        label: `${q} · 10 km`,
        resolvedPlaceName: `${q}, California, United States`,
        excluded: { outsideArea: 0, byLimit: 0 },
      });
    }),
  }),
  createSuggestPlaceResolver: () => ({
    suggestPlace: vi.fn().mockResolvedValue({ candidates: [] }),
  }),
}));

// Stable object references across mock calls, matching real react-query's structural
// sharing of unchanged query results — a mock that allocates fresh literals per call
// defeats effects that depend on `data` identity (e.g. the deviceCenter auto-select
// effect in useWhereFieldViewModel) and produces a spurious render loop in tests only.
const BROWSE_TWO_THEATRES_DATA = {
  theatres: [
    {
      id: "amc:theatre:1",
      providerId: "amc",
      name: "AMC Metreon 16",
      city: "San Francisco",
      distanceKm: 1.2,
      location: { lat: 0, lng: 0 },
      timezone: "America/Los_Angeles",
      address: null,
      slugs: null,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "amc:theatre:2",
      providerId: "amc",
      name: "AMC Kabuki 8",
      city: "San Francisco",
      distanceKm: 2.5,
      location: { lat: 0, lng: 0 },
      timezone: "America/Los_Angeles",
      address: null,
      slugs: null,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  ],
};
const MET_QUERY_THEATRES_DATA = {
  theatres: [
    {
      id: "amc:theatre:1",
      providerId: "amc",
      name: "AMC Metreon 16",
      city: "San Francisco",
      distanceKm: 1.2,
      location: { lat: 0, lng: 0 },
      timezone: "America/Los_Angeles",
      address: null,
      slugs: null,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  ],
};
const EMPTY_THEATRES_DATA = { theatres: [] };

function resetStore() {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
    ...flowInitialState,
    bootstrapReady: true,
    bootstrapLoading: false,
    bootstrapError: null,
    sessionId: "sess_test",
    limits: null,
    selectedTheatre: null,
    selectedTheatreMovies: null,
  });
  // explicitly reset where state
  useSeatfirstStore.setState({
    whereQuery: "",
    whereFocused: false,
    deviceCenter: null,
    wherePlace: null,
    selectedTheatres: [],
    whereRadiusKm: 10,
    whereLimit: DEFAULT_SEARCH_LIMITS.maxTheatres,
  });
}
function jsonString(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  resetStore();
  mockUseTheatreSearch.mockReset();
  // Default: browse with empty q returns 2 theatres, typed q filters
  mockUseTheatreSearch.mockImplementation((opts: { q?: string; browse?: boolean }) => {
    const q = (opts.q ?? "").trim().toLowerCase();
    const browse = (opts as { browse?: boolean }).browse;
    // If browse true and q empty => return 2 theatres (browse mode)
    if (browse && q === "") {
      return { data: BROWSE_TWO_THEATRES_DATA, isFetching: false, error: null };
    }
    if (q === "met") {
      return { data: MET_QUERY_THEATRES_DATA, isFetching: false, error: null };
    }
    if (q === "") {
      // No browse, empty q => no results (old behaviour)
      return { data: EMPTY_THEATRES_DATA, isFetching: false, error: null };
    }
    return { data: EMPTY_THEATRES_DATA, isFetching: false, error: null };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TheaterField Where — browse-on-focus", () => {
  it("focus with empty input shows list (negative test: require q would hide list)", () => {
    // Simulate focused empty input via store
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    // Browse should have returned 2 theatres, so listbox should contain them
    expect(str).toContain("AMC Metreon 16");
    expect(str).toContain("AMC Kabuki 8");
    // Also verify hook was called with browse true
    expect(mockUseTheatreSearch).toHaveBeenCalled();
    const lastCall = mockUseTheatreSearch.mock.calls[
      mockUseTheatreSearch.mock.calls.length - 1
    ]?.[0] as { browse?: boolean; q?: string } | undefined;
    expect(lastCall?.browse).toBe(true);
    expect(lastCall?.q).toBe("");
  });

  it("typing filters (debounced q)", () => {
    useSeatfirstStore.setState({ whereQuery: "met", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("AMC Metreon 16");
    expect(str).not.toContain("AMC Kabuki 8");
    const lastCall = mockUseTheatreSearch.mock.calls[
      mockUseTheatreSearch.mock.calls.length - 1
    ]?.[0] as { q?: string };
    expect(lastCall?.q).toBe("met");
  });

  it("combobox/listbox ARIA roles", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    // Should have combobox and listbox roles in output
    expect(str).toContain("combobox");
    expect(str).toContain("listbox");
    // listbox options should have aria-selected
    expect(str).toContain("aria-selected");
    // Input should have aria-expanded true when focused
    expect(str).toContain("aria-expanded");
  });

  it("ArrowDown then Enter selects the active option through the web key event", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Where — place or theatre",
    );
    const onKeyPress = (
      input.props as unknown as {
        onKeyPress: (event: { nativeEvent: { key: string }; preventDefault: () => void }) => void;
      }
    ).onKeyPress;
    const preventDefault = vi.fn();
    act(() => {
      onKeyPress({ nativeEvent: { key: "ArrowDown" }, preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(jsonString(renderer)).toContain("where-option-theatre-amc:theatre:1");
    const enterOnKeyPress = (
      renderer.root.find((node) => node.props.accessibilityLabel === "Where — place or theatre")
        .props as unknown as {
        onKeyPress: (event: { nativeEvent: { key: string }; preventDefault: () => void }) => void;
      }
    ).onKeyPress;
    act(() => {
      enterOnKeyPress({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    });
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([
      {
        id: "amc:theatre:1",
        providerId: "amc",
        name: "AMC Metreon 16",
        city: "San Francisco",
        distanceKm: 1.2,
      },
    ]);
    expect(useSeatfirstStore.getState().whereQuery).toBe("");
    // Theatre remains visible as a removable chip and as a checked option in the
    // theatre-first listbox. The old `not.toContain("amc:theatre:1")` asserted the
    // pre-UI20 numeric option id; the approved UI20 contract keeps the
    // theatre-scoped id and renders the selection as a chip.
    expect(jsonString(renderer)).toContain("AMC Metreon 16");
    expect(jsonString(renderer)).toContain("Remove AMC Metreon 16");
    expect(jsonString(renderer)).toContain("where-option-theatre-amc:theatre:1");
  });
});

describe("TheaterField Where — chips-in-field & backspace", () => {
  it("shows place chip with user typed string + radius label (never Mapbox name)", () => {
    useSeatfirstStore.setState({
      wherePlace: { query: "Sunnyvale", label: "Sunnyvale · 10 mi", radiusKm: 10, limit: 25 },
      selectedTheatres: [
        { id: "amc:theatre:1", providerId: "amc" },
        { id: "amc:theatre:2", providerId: "amc" },
      ],
      whereRadiusKm: 10,
      whereQuery: "",
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("Sunnyvale · 6 mi");
    // Should not contain Mapbox name; our label is user query only
    expect(str).not.toContain("Mapbox");
  });

  it("renders the resolved place set as a read-only panel list", () => {
    useSeatfirstStore.setState({
      wherePlace: { query: "Sunnyvale", label: "Sunnyvale · 10 mi", radiusKm: 10, limit: 25 },
      selectedTheatres: [
        {
          id: "amc:theatre:1",
          providerId: "amc",
          name: "AMC Sunnyvale 12",
          city: "Sunnyvale",
          distanceKm: 1.234,
        },
        {
          id: "amc:theatre:2",
          providerId: "amc",
          name: "AMC Valley Fair 16",
          city: "Santa Clara",
          distanceKm: 5.678,
        },
      ],
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("Place search and radius");
    expect(str).toContain("Sunnyvale");
    expect(str).toContain("AMC Sunnyvale 12");
    expect(str).toContain("AMC Valley Fair 16");
    expect(str).toContain("0.8 mi");
    expect(str).toContain("3.5 mi");
    expect(str).not.toContain("listbox");
    expect(
      renderer.root.findAll((node) => node.props.accessibilityRole === "checkbox"),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll((node) => {
        const label = (node.props as { accessibilityLabel?: unknown }).accessibilityLabel;
        return typeof label === "string" && label.includes("AMC Sunnyvale 12");
      }),
    ).toHaveLength(0);
  });

  it("chips-in-field: one place chip while matches radius, theatre chips after hand-edit", () => {
    // Whole place -> one place chip
    useSeatfirstStore.setState({
      wherePlace: { query: "Sunnyvale", label: "Sunnyvale · 10 mi", radiusKm: 10, limit: 25 },
      selectedTheatres: [
        { id: "amc:theatre:1", providerId: "amc", name: "AMC Sunnyvale 12" },
        { id: "amc:theatre:2", providerId: "amc", name: "AMC Valley Fair 16" },
      ],
      whereQuery: "",
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    let str = jsonString(renderer);
    expect(str).toContain("Sunnyvale · 6 mi");
    // Hand-edited (clear wherePlace) -> theatre chips
    useSeatfirstStore.setState({
      wherePlace: null,
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc", name: "AMC Sunnyvale 12" }],
    });
    act(() => {
      renderer.update(React.createElement(TheaterField, { isLocked: false }));
    });
    str = jsonString(renderer);
    expect(str).toContain("AMC Sunnyvale 12");
    expect(str).not.toContain("Sunnyvale ·");
  });

  it("backspace on empty input removes last chip", () => {
    useSeatfirstStore.setState({
      selectedTheatres: [
        { id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" },
        { id: "amc:theatre:2", providerId: "amc", name: "AMC Kabuki 8" },
      ],
      whereQuery: "",
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    let str = jsonString(renderer);
    expect(str).toContain("AMC Metreon 16");
    expect(str).toContain("AMC Kabuki 8");
    // Simulate backspace via store action (removeLastChip)
    act(() => {
      useSeatfirstStore.getState().removeLastChip();
    });
    act(() => {
      renderer.update(React.createElement(TheaterField, { isLocked: false }));
    });
    str = jsonString(renderer);
    expect(str).toContain("AMC Metreon 16");
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([
      { id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" },
    ]);
  });
});

describe("TheaterField Where — radius and geolocation", () => {
  it("renders no radius control outside the place panel", () => {
    useSeatfirstStore.setState({
      whereFocused: true,
      whereQuery: "",
      wherePlace: null,
      deviceCenter: null,
      selectedTheatres: [],
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const radiusNodes = renderer.root.findAll((node) => {
      const props = (node.props ?? {}) as Record<string, unknown>;
      return (
        typeof props.accessibilityLabel === "string" && props.accessibilityLabel.includes("radius")
      );
    });
    expect(radiusNodes).toHaveLength(0);
  });

  it("re-resolves a place when a panel radius is changed", async () => {
    const resolvePlace = vi.fn().mockResolvedValue({
      theatres: [
        {
          theatreId: "amc:theatre:2",
          distanceKm: 2.5,
          name: "AMC Kabuki 8",
          city: "San Francisco",
        },
      ],
      label: "Sunnyvale · 25 mi",
      resolvedPlaceName: "Sunnyvale, California, United States",
      excluded: { outsideArea: 0, byLimit: 0 },
    });
    useSeatfirstStore.setState({
      wherePlace: {
        query: "Sunnyvale",
        label: "Sunnyvale · 10 mi",
        radiusKm: 10,
        limit: DEFAULT_SEARCH_LIMITS.maxTheatres,
      },
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc" }],
      whereRadiusKm: 10,
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, { isLocked: false, geocodeResolver: { resolvePlace } }),
      );
    });
    const radius = renderer.root.find((node) => node.props.accessibilityLabel === "25 mi radius");
    await act(async () => {
      (radius.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });
    expect(resolvePlace).toHaveBeenCalledWith(
      "Sunnyvale",
      DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm,
      DEFAULT_SEARCH_LIMITS.maxTheatres,
    );
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([
      {
        id: "amc:theatre:2",
        providerId: "amc",
        name: "AMC Kabuki 8",
        city: "San Francisco",
        distanceKm: 2.5,
      },
    ]);
  });

  it("Use my location button shows Current location when active, never reverse-geocoded", () => {
    useSeatfirstStore.setState({ deviceCenter: null, whereFocused: true, whereQuery: "" });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    let str = jsonString(renderer);
    expect(str).toContain("Use my location");
    expect(str).not.toContain("Neighborhood");
    useSeatfirstStore.setState({
      deviceCenter: { lat: 37, lng: -122 },
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc" }],
      whereFocused: true,
    });
    act(() => {
      renderer.update(React.createElement(TheaterField, { isLocked: false }));
    });
    str = jsonString(renderer);
    expect(str).toContain("Current location");
    expect(str).not.toContain("Sunnyvale");
    expect(str).not.toContain("Mapbox");
  });

  it("device location populates nearby theatres instead of showing 0 in range (regression)", () => {
    // Regression: deviceCenter previously never enabled the radius-filtered
    // useTheatreSearch query (browse was forced false for every "place" whereFieldMode,
    // which device location shares with typed places), so "Use my location" always
    // rendered "No theatres found in range" regardless of real proximity.
    useSeatfirstStore.setState({
      deviceCenter: { lat: 37.7749, lng: -122.4194 },
      wherePlace: null,
      selectedTheatres: [],
      whereFocused: true,
      whereQuery: "",
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const browseCall = mockUseTheatreSearch.mock.calls.find((call) => {
      const arg = call[0] as { lat?: number; lng?: number } | undefined;
      return arg?.lat === 37.7749 && arg?.lng === -122.4194;
    });
    const browseArg = browseCall?.[0] as { browse?: boolean } | undefined;
    expect(browseArg?.browse).toBe(true);
    const str = jsonString(renderer);
    expect(str).toContain("2 theatres in range");
    expect(str).toContain("AMC Metreon 16");
    expect(str).toContain("AMC Kabuki 8");
    expect(str).not.toContain("No theatres found in range");
    expect(useSeatfirstStore.getState().selectedTheatres.length).toBe(2);
  });

  it("inline error distinct for PLACE_NOT_FOUND vs UNAVAILABLE and geolocation denial/timeout/insecure", () => {
    // We test that geolocation insecure context shows inline error and doesn't call navigator.geolocation
    const originalNavigator = globalThis.navigator;
    // Insecure context
    (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext = false;
    // Mock geolocation unavailable
    // Ensure button triggers insecure error
    useSeatfirstStore.setState({ deviceCenter: null, whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    // Find Use my location button and press it
    const geoButtons = renderer.root.findAll((n) => {
      const p = (n.props ?? {}) as Record<string, unknown>;
      return p.accessibilityLabel === "Use my location";
    });
    expect(geoButtons.length).toBeGreaterThan(0);
    const geoButton = geoButtons[0]!;
    act(() => {
      (geoButton.props as { onPress?: () => void }).onPress?.();
    });
    const str = jsonString(renderer);
    expect(str).toContain("Location is unavailable in this context");
    // Restore
    (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext = true;
    if (originalNavigator)
      (globalThis as unknown as { navigator?: unknown }).navigator = originalNavigator;
  });
});

describe("TheaterField Where — geolocation tap-only negative (UI18.3)", () => {
  const mockGetCurrentPosition = vi.fn<Geolocation["getCurrentPosition"]>();
  beforeEach(() => {
    mockGetCurrentPosition.mockClear();
    (globalThis as unknown as { navigator?: unknown }).navigator = {
      geolocation: { getCurrentPosition: mockGetCurrentPosition },
    };
    (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext = true;
    useSeatfirstStore.setState({
      deviceCenter: null,
      wherePlace: null,
      selectedTheatres: [],
      whereQuery: "",
      whereFocused: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call getCurrentPosition on mount", () => {
    act(() => {
      TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it("does not call getCurrentPosition on Where input focus", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    mockGetCurrentPosition.mockClear();
    const inputs = renderer.root.findAllByType(TextInput);
    // The Where input is the first TextInput with placeholder "Search or browse"
    const whereInput = inputs.find((n) => {
      const p = n.props as Record<string, unknown>;
      return typeof p.placeholder === "string" && p.placeholder.includes("Search");
    });
    if (whereInput) {
      act(() => {
        (whereInput.props as { onFocus?: () => void }).onFocus?.();
      });
    }
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it("does not call getCurrentPosition on typing in Where input", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    mockGetCurrentPosition.mockClear();
    const inputs = renderer.root.findAllByType(TextInput);
    const whereInput = inputs.find((n) => {
      const p = n.props as Record<string, unknown>;
      return typeof p.placeholder === "string" && p.placeholder.includes("Search");
    });
    if (whereInput) {
      act(() => {
        (whereInput.props as { onChangeText?: (t: string) => void }).onChangeText?.("Sunny");
      });
    }
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it("calls getCurrentPosition only when Use my location button is pressed", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    mockGetCurrentPosition.mockClear();
    const btns = renderer.root.findAll((n) => {
      const p = n.props as Record<string, unknown>;
      return p.accessibilityLabel === "Use my location";
    });
    expect(btns.length).toBeGreaterThan(0);
    act(() => {
      (btns[0]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("reports inline on denial and does not leave busy (fallback to typed path)", () => {
    // Make getCurrentPosition invoke error callback with PERMISSION_DENIED
    mockGetCurrentPosition.mockImplementation((_success, errorCb) => {
      const err: GeolocationPositionError = {
        code: 1,
        message: "denied",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      };
      errorCb?.(err);
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const btns = renderer.root.findAll((n) => {
      const p = n.props as Record<string, unknown>;
      return p.accessibilityLabel === "Use my location";
    });
    act(() => {
      (btns[0]!.props as { onPress?: () => void }).onPress?.();
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Location permission denied");
    expect(str).not.toContain("Current location");
  });
});

describe("TheaterField Where — place suggestions (UI20)", () => {
  it("gates at three trimmed characters, debounces once, and renders one grouped listbox", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: "San Francisco, CA, United States" }],
    });
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    type WhereInputProps = { onChangeText: (t: string) => void; "aria-activedescendant"?: string };
    const getInput = () => {
      const node = renderer.root.find(
        (n) => n.props.accessibilityLabel === "Where — place or theatre",
      );
      return node.props as WhereInputProps;
    };

    // Rapid sub-three-char edits must not reach the seam, even after the debounce window.
    act(() => {
      getInput().onChangeText("s");
    });
    act(() => {
      getInput().onChangeText("su");
    });
    act(() => {
      getInput().onChangeText("  su  ");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(suggestPlace).not.toHaveBeenCalled();

    // Exactly three trimmed characters debounces once at 300ms.
    act(() => {
      getInput().onChangeText("san");
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(suggestPlace).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Flush the mocked suggestion promise microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(suggestPlace).toHaveBeenCalledOnce();
    expect(suggestPlace).toHaveBeenCalledWith("san");
    const output = jsonString(renderer);
    expect(output).toContain("Places and theatres");
    expect(output).toContain("AMC theaters");
    expect(output).toContain("Places");
    expect(output).toContain("Selects every AMC within 6 mi");
    expect(output).toContain("San Francisco, CA");
    expect(output).not.toContain("United States");
    const candidate = renderer.root.find(
      (node) => node.props.accessibilityLabel === "San Francisco, CA",
    );
    const candidateProps = candidate.props as { role: string; accessibilityRole: string };
    expect(candidateProps.role).toBe("option");
    expect(candidateProps.accessibilityRole).not.toBe("checkbox");
    expect(getInput()["aria-activedescendant"]).toBeUndefined();
  });
  it("candidate press resolves the exact label and commits the resolved display name", async () => {
    vi.useFakeTimers();
    const candidateLabel = "San Francisco, California, United States";
    const compactLabel = "San Francisco, CA";
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: candidateLabel }],
    });
    const resolvePlace = vi.fn().mockResolvedValue({
      theatres: [
        {
          theatreId: "amc:theatre:1",
          distanceKm: 1.2,
          name: "AMC Metreon 16",
          city: "San Francisco",
        },
      ],
      label: `${candidateLabel} · 10 km`,
      resolvedPlaceName: candidateLabel,
      excluded: { outsideArea: 0, byLimit: 0 },
    });
    useSeatfirstStore.setState({ whereQuery: "san", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
          geocodeResolver: { resolvePlace },
        }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    // Visible candidate is compact, but raw label is preserved for selection.
    expect(jsonString(renderer)).toContain(compactLabel);
    expect(jsonString(renderer)).not.toContain("United States");
    expect(jsonString(renderer)).not.toContain("California, United States");
    const candidate = renderer.root.find((node) => node.props.accessibilityLabel === compactLabel);
    const candidateProps = candidate.props as { onPress: () => void };
    await act(async () => {
      candidateProps.onPress();
      await Promise.resolve();
    });

    expect(resolvePlace).toHaveBeenCalledWith(
      candidateLabel,
      10,
      DEFAULT_SEARCH_LIMITS.maxTheatres,
    );
    expect(useSeatfirstStore.getState().wherePlace).toMatchObject({
      query: candidateLabel,
      resolvedPlaceName: candidateLabel,
    });
    expect(jsonString(renderer)).toContain(`${compactLabel} · 6 mi`);
    expect(jsonString(renderer)).toContain(`Remove place ${compactLabel}, within 6 miles`);
  });

  it("resolved place rows show catalogue names, never raw ids, when the ambient search is empty", async () => {
    vi.useFakeTimers();
    const candidateLabel = "Berkeley, California, United States";
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: candidateLabel }],
    });
    const resolvePlace = vi.fn().mockResolvedValue({
      theatres: [
        {
          theatreId: "amc:theatre:9",
          distanceKm: 3.1,
          name: "AMC Bay Street 16",
          city: "Emeryville",
        },
      ],
      label: `${candidateLabel} · 10 km`,
      resolvedPlaceName: candidateLabel,
      excluded: { outsideArea: 0, byLimit: 0 },
    });
    // "ber" matches no ambient theatre in the mocked search, so the only
    // name source is the resolve response itself (ambient search is disabled
    // in place mode per ADR 0045 §1).
    useSeatfirstStore.setState({ whereQuery: "ber", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
          geocodeResolver: { resolvePlace },
        }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    const candidate = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Berkeley, CA",
    );
    await act(async () => {
      (candidate.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([
      {
        id: "amc:theatre:9",
        providerId: "amc",
        name: "AMC Bay Street 16",
        city: "Emeryville",
        distanceKm: 3.1,
      },
    ]);
    const str = jsonString(renderer);
    expect(str).toContain("AMC Bay Street 16");
    expect(str).toContain("Emeryville");
    expect(str).not.toContain("amc:theatre:9");
  });
});

describe("TheaterField Where — empty-state ordering (theatre-name matches surface first)", () => {
  it("renders AMC theaters before Places when the query substring-matches a theatre name", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: "Metropolis, California, United States" }],
    });
    // Empty mode: no place, no selected theatres, focused, query "met" yields a theatre hit via mock + a place candidate via suggest.
    useSeatfirstStore.setState({ whereQuery: "met", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const str = jsonString(renderer);
    expect(str).toContain("Places");
    expect(str).toContain("AMC theaters");
    expect(str).toContain("Metropolis, CA");
    expect(str).toContain("AMC Metreon 16");
    // Client-side relevance: "met" substring-matches "AMC Metreon 16", so the
    // matching theatre surfaces ahead of the unrelated place candidate.
    expect(str.indexOf("where-group-theatres")).toBeLessThan(str.indexOf("where-group-places"));
    expect(str.indexOf("AMC Metreon 16")).toBeLessThan(str.indexOf("Metropolis, CA"));
  });

  it("keeps Places before AMC theaters when the query matches no theatre name", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: "Sunnyvale, California, United States" }],
    });
    // Force nearby theatres that do NOT substring-match the query: relevance
    // must not reorder, preserving the long-standing Places-first layout.
    mockUseTheatreSearch.mockReturnValue({
      data: BROWSE_TWO_THEATRES_DATA,
      isFetching: false,
      error: null,
    });
    useSeatfirstStore.setState({ whereQuery: "xyz", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const str = jsonString(renderer);
    expect(str).toContain("Sunnyvale, CA");
    expect(str).toContain("AMC Metreon 16");
    expect(str.indexOf("where-group-places")).toBeLessThan(str.indexOf("where-group-theatres"));
  });

  it("moves keyboard focus to the matching theatre before place candidates", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: "Metropolis, California, United States" }],
    });
    useSeatfirstStore.setState({ whereQuery: "met", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = renderer.root.find(
      (n) => n.props.accessibilityLabel === "Where — place or theatre",
    );
    act(() => {
      (input.props as { onKeyPress?: (e: unknown) => void }).onKeyPress?.({
        nativeEvent: { key: "ArrowDown" },
        preventDefault: () => {},
      });
    });
    const after = renderer.root.find(
      (n) => n.props.accessibilityLabel === "Where — place or theatre",
    );
    const props = after.props as { "aria-activedescendant"?: string };
    expect(props["aria-activedescendant"]).toBe("where-option-theatre-amc:theatre:1");
  });
});

describe("TheaterField Where — audit fixes (empty state, error copy, input attrs)", () => {
  it("shows a no-matching-locations row when a query matches nothing", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({ candidates: [] });
    // "zzzz" matches no theatre in the mocked search and yields no place
    // candidates: the dropdown must explain instead of showing only location.
    useSeatfirstStore.setState({ whereQuery: "zzzz", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const str = jsonString(renderer);
    expect(str).toContain("No matching locations found");
    expect(str).toContain("Use my location");
    expect(str).toContain("No theatre matches “zzzz”");
  });

  it("renders the place-not-found hint exactly once for seeded store errors", () => {
    // Mirrors fixtures/scenarios.ts `where-place-not-found`: the store keeps
    // only the core sentence and the component appends the hint once.
    useSeatfirstStore.setState({
      whereQuery: "Atlantis",
      whereFocused: true,
      wherePlaceError: "We couldn't find that place.",
      wherePlaceErrorKind: "PLACE_NOT_FOUND",
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("We couldn't find that place.");
    const hintCount = str.split("Try a different address, neighborhood, or city.").length - 1;
    expect(hintCount).toBe(1);
  });

  it("stores the short core sentence on live PLACE_NOT_FOUND and renders the hint once", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({ candidates: [] });
    // The default mocked geocode resolver maps "notfound" to PLACE_NOT_FOUND.
    useSeatfirstStore.setState({ whereQuery: "notfound nowhere", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    const input = renderer.root.find(
      (n) => n.props.accessibilityLabel === "Where — place or theatre",
    );
    await act(async () => {
      (input.props as { onKeyPress?: (e: unknown) => void }).onKeyPress?.({
        nativeEvent: { key: "Enter" },
        preventDefault: () => {},
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const str = jsonString(renderer);
    expect(str).toContain("We couldn't find that place.");
    const hintCount = str.split("Try a different address, neighborhood, or city.").length - 1;
    expect(hintCount).toBe(1);
  });

  it("exposes id and name on the WHERE input", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const input = renderer.root
      .findAllByType(TextInput)
      .find((n) => typeof n.props.placeholder === "string" && n.props.placeholder.length > 0);
    expect(input).toBeDefined();
    expect(input!.props.nativeID).toBe("seatfirst-where");
    const webProps = input!.props as Record<string, unknown>;
    if (webProps.id !== undefined || webProps.name !== undefined) {
      expect(webProps.id).toBe("seatfirst-where");
      expect(webProps.name).toBe("where");
    }
  });
});

describe("TheaterField Where — UI21 place panel actions", () => {
  it("renders the formatted place, radius control, resolved list, and both footer actions", () => {
    useSeatfirstStore.setState({
      wherePlace: {
        query: "San Francisco, California, United States",
        label: "San Francisco, California, United States · 10 km",
        resolvedPlaceName: "San Francisco, California, United States",
        radiusKm: 10,
        limit: 25,
      },
      selectedTheatres: [
        { id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16", distanceKm: 1.2 },
        { id: "amc:theatre:2", providerId: "amc", name: "AMC Kabuki 8", distanceKm: 2.1 },
      ],
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("San Francisco, CA");
    expect(str).not.toContain("California, United States");
    expect(str).toContain("2 theatres in range");
    expect(str).toContain("Use my location instead");
    expect(str).toContain("Pick theatres instead");
  });

  it("shows selectable replacement places, not theatres, while typing in the panel", async () => {
    vi.useFakeTimers();
    const candidateLabel = "Oakland, California, United States";
    const suggestPlace = vi.fn().mockResolvedValue({ candidates: [{ label: candidateLabel }] });
    const resolvePlace = vi.fn().mockResolvedValue({
      theatres: [
        {
          theatreId: "amc:theatre:2",
          distanceKm: 2.5,
          name: "AMC Kabuki 8",
          city: "San Francisco",
        },
      ],
      label: "Oakland · 10 mi",
      resolvedPlaceName: candidateLabel,
      excluded: { outsideArea: 0, byLimit: 0 },
    });
    useSeatfirstStore.setState({
      wherePlace: {
        query: "San Francisco",
        label: "San Francisco · 10 mi",
        radiusKm: 10,
        limit: 25,
      },
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" }],
      whereQuery: "oak",
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
          geocodeResolver: { resolvePlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const candidate = renderer.root.find((node) => node.props.accessibilityLabel === "Oakland, CA");
    expect(candidate.props.role).toBeUndefined();
    expect(candidate.props.onPress).toBeTypeOf("function");
    await act(async () => {
      (candidate.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });
    expect(resolvePlace).toHaveBeenCalledWith(
      candidateLabel,
      10,
      DEFAULT_SEARCH_LIMITS.maxTheatres,
    );
    expect(useSeatfirstStore.getState().wherePlace).toMatchObject({ query: candidateLabel });
  });

  it("converts exactly the resolved refs into hand-picked theatres", () => {
    const refs = [
      { id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16", distanceKm: 1.2 },
      { id: "amc:theatre:2", providerId: "amc", name: "AMC Kabuki 8", distanceKm: 2.1 },
    ];
    useSeatfirstStore.setState({
      wherePlace: {
        query: "San Francisco",
        label: "San Francisco · 10 mi",
        radiusKm: 10,
        limit: 25,
      },
      selectedTheatres: refs,
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const convert = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Pick theatres instead",
    );
    act(() => {
      (convert.props as { onPress: () => void }).onPress();
    });
    expect(useSeatfirstStore.getState().wherePlace).toBeNull();
    expect(useSeatfirstStore.getState().deviceCenter).toBeNull();
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual(refs);
    expect(jsonString(renderer)).toContain("+ Add theatre");
  });

  it("clears the selected mode from the labelled control", () => {
    useSeatfirstStore.setState({
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" }],
      whereQuery: "met",
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const clear = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Clear the Where field",
    );
    expect(clear.props.accessibilityHint).toBe("Removes the place or theatres you selected");
    act(() => {
      (clear.props as { onPress: () => void }).onPress();
    });
    expect(useSeatfirstStore.getState()).toMatchObject({
      wherePlace: null,
      deviceCenter: null,
      selectedTheatres: [],
      whereQuery: "",
    });
    expect(jsonString(renderer)).not.toContain("Clear the Where field");
  });
});

describe("TheaterField Where — UI21 mode gating and signpost", () => {
  it("keeps the Places group present in the empty field with its location-or-type subhead", () => {
    useSeatfirstStore.setState({ whereFocused: true, whereQuery: "" });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("AMC theaters");
    expect(str).toContain("Places");
    act(() => {
      useSeatfirstStore.setState({ whereQuery: "zzzx" });
    });
    expect(jsonString(renderer)).toContain("No places match “zzzx”");
    expect(str).toContain("Use your location, or type a city, neighborhood, or address");
    expect(str).toContain("Use my location");
  });

  it("does not search theatres for typed place text and only probes places after a theatre miss", async () => {
    vi.useFakeTimers();
    const suggestPlace = vi.fn().mockResolvedValue({
      candidates: [{ label: "Sunnyvale, California, United States" }],
    });

    useSeatfirstStore.setState({
      wherePlace: { query: "San Jose", label: "San Jose · 10 mi", radiusKm: 10, limit: 25 },
      whereQuery: "sun",
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const placeCall = mockUseTheatreSearch.mock.calls[
      mockUseTheatreSearch.mock.calls.length - 1
    ]?.[0] as { q?: string; browse?: boolean } | undefined;
    expect(placeCall).toMatchObject({ q: "", browse: false });
    expect(suggestPlace).toHaveBeenCalledWith("sun");

    renderer.unmount();
    suggestPlace.mockClear();
    resetStore();
    useSeatfirstStore.setState({
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" }],
      whereQuery: "met",
      whereFocused: true,
    });
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const theatreHitCall = mockUseTheatreSearch.mock.calls[
      mockUseTheatreSearch.mock.calls.length - 1
    ]?.[0] as { q?: string } | undefined;
    expect(theatreHitCall?.q).toBe("met");
    expect(suggestPlace).not.toHaveBeenCalled();

    renderer.unmount();
    useSeatfirstStore.setState({ whereQuery: "zzzx" });
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(suggestPlace).toHaveBeenCalledWith("zzzx");
  });

  it("uses the hidden place probe only to signpost and preserves text when it clears theatres", async () => {
    vi.useFakeTimers();
    const candidateLabel = "1200 Elm Street, San Francisco, California, United States";
    const suggestPlace = vi.fn().mockResolvedValue({ candidates: [{ label: candidateLabel }] });
    useSeatfirstStore.setState({
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc", name: "AMC Metreon 16" }],
      whereQuery: "1200 elm",
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, {
          isLocked: false,
          suggestPlaceResolver: { suggestPlace },
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(jsonString(renderer)).toContain("Looking for a place?");
    expect(
      renderer.root.findAll(
        (node) => node.props.accessibilityLabel === "1200 Elm Street, San Francisco, CA",
      ),
    ).toHaveLength(0);
    const signpost = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Looking for a place?",
    );
    act(() => {
      (signpost.props as { onPress: () => void }).onPress();
    });
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([]);
    expect(useSeatfirstStore.getState().whereQuery).toBe("1200 elm");
    expect(jsonString(renderer)).toContain("Places");
    expect(jsonString(renderer)).toContain("1200 Elm Street, San Francisco, CA");
  });

  it("swaps a place for device location without changing the radius", () => {
    const originalNavigator = globalThis.navigator;
    const getCurrentPosition = vi.fn<Geolocation["getCurrentPosition"]>();
    getCurrentPosition.mockImplementation((success) => {
      success?.({
        coords: {
          latitude: 37.3318,
          longitude: -122.0312,
        },
      } as GeolocationPosition);
    });
    (globalThis as unknown as { navigator?: unknown }).navigator = {
      geolocation: { getCurrentPosition },
    };
    (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext = true;
    useSeatfirstStore.setState({
      wherePlace: { query: "Cupertino", label: "Cupertino · 10 mi", radiusKm: 10, limit: 25 },
      selectedTheatres: [{ id: "amc:theatre:1", providerId: "amc" }],
      whereRadiusKm: 10,
      whereFocused: true,
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const swap = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Use my location instead",
    );
    act(() => {
      (swap.props as { onPress: () => void }).onPress();
    });
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(useSeatfirstStore.getState()).toMatchObject({
      wherePlace: null,
      deviceCenter: { lat: 37.3318, lng: -122.0312 },
      whereRadiusKm: 10,
    });
    if (originalNavigator) {
      (globalThis as unknown as { navigator?: unknown }).navigator = originalNavigator;
    }
  });
});

describe("TheaterField mobile bottom sheet (P1 audit fix)", () => {
  it("desktop renders the unchanged inline popover (no sheet chrome)", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    const str = jsonString(renderer);
    expect(str).toContain("AMC Metreon 16");
    // No bottom-sheet chrome on desktop: no dialog label, scrim, or Close button.
    expect(str).not.toContain("dialog");
    expect(str).not.toContain("rgba(0,0,0,0.4)");
    expect(str).not.toContain("Close Places and theatres");
    renderer.unmount();
  });

  it("mobile renders the suggestion list as a bottom-sheet modal", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, { isLocked: false, isMobile: true }),
      );
    });
    const str = jsonString(renderer);
    expect(str).toContain("AMC Metreon 16");
    // Sheet chrome: dialog label, fixed overlay, scrim, and close affordance.
    expect(str).toContain("Places and theatres dialog");
    expect(str).toContain("fixed");
    expect(str).toContain("rgba(0,0,0,0.4)");
    expect(str).toContain("Close Places and theatres");
    renderer.unmount();
  });

  it("selection still works through the sheet", () => {
    useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(TheaterField, { isLocked: false, isMobile: true }),
      );
    });
    const option = renderer.root.find(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.startsWith("AMC Metreon 16") &&
        typeof node.props.onPress === "function",
    );
    act(() => {
      (option.props as { onPress: () => void }).onPress();
    });
    expect(useSeatfirstStore.getState().selectedTheatres).toEqual([
      {
        id: "amc:theatre:1",
        providerId: "amc",
        name: "AMC Metreon 16",
        city: "San Francisco",
        distanceKm: 1.2,
      },
    ]);
    renderer.unmount();
  });

  it("sheet Close button blurs and dismisses the dropdown", () => {
    // Store blur is debounced 150ms (lets option presses win the race).
    vi.useFakeTimers();
    try {
      useSeatfirstStore.setState({ whereQuery: "", whereFocused: true });
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(TheaterField, { isLocked: false, isMobile: true }),
        );
      });
      expect(jsonString(renderer)).toContain("Close Places and theatres");
      const closeButtons = renderer.root.findAll(
        (node) => node.props.accessibilityLabel === "Close Places and theatres",
      );
      expect(closeButtons.length).toBeGreaterThanOrEqual(1);
      act(() => {
        (closeButtons[0]!.props as { onPress: () => void }).onPress();
      });
      // Blur closes the dropdown after the debounce: the sheet unmounts.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(useSeatfirstStore.getState().whereFocused).toBe(false);
      expect(jsonString(renderer)).not.toContain("Close Places and theatres");
      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TheaterField Where — long chip label keeps input usable (chip-overflow fix)", () => {
  const LONG_PLACE = "1234 Very Long Street Name Extended, Brooklyn, New York, United States";

  function renderWithLongPlaceChip(): TestRenderer.ReactTestRenderer {
    useSeatfirstStore.setState({
      wherePlace: { query: LONG_PLACE, label: `${LONG_PLACE} · 10 mi`, radiusKm: 10, limit: 25 },
      selectedTheatres: [],
      whereRadiusKm: 10,
      whereQuery: "",
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(TheaterField, { isLocked: false }));
    });
    return renderer;
  }

  it("keeps the full input placeholder readable beside a very long place chip", () => {
    const renderer = renderWithLongPlaceChip();
    try {
      const str = jsonString(renderer);
      // The long chip label itself renders (sanity: this is the squeeze setup).
      expect(str).toContain("Very Long Street Name Extended");
      const whereInput = renderer.root
        .findAllByType(TextInput)
        .find((n) => typeof n.props.placeholder === "string" && n.props.placeholder.length > 0);
      expect(whereInput).toBeDefined();
      // Placeholder must survive at full length — the old minWidth: 0 collapse
      // clipped it to a few characters ("Search fo") beside a long chip.
      const placeholder = whereInput!.props.placeholder as string;
      expect(placeholder).toBe("Search for a different place");
      expect(placeholder.length).toBeGreaterThanOrEqual(10);
    } finally {
      renderer.unmount();
    }
  });

  it("gives the input row a minWidth floor so it wraps instead of collapsing", () => {
    const renderer = renderWithLongPlaceChip();
    try {
      // react-test-renderer cannot measure pixels, so assert the style contract
      // directly: inputRow carries a usable-width floor (tokenfield flexWrap
      // then wraps it onto its own line instead of crushing the placeholder).
      const inputRows = renderer.root.findAll(
        (node) =>
          !!node.props &&
          typeof node.props.style === "object" &&
          node.props.style !== null &&
          !Array.isArray(node.props.style) &&
          (node.props.style as { minWidth?: unknown }).minWidth === 120,
      );
      expect(inputRows.length).toBeGreaterThanOrEqual(1);
      // The TextInput itself keeps minWidth: 0 so text truncates *inside* the
      // row's floor rather than forcing the row wider.
      const whereInput = renderer.root
        .findAllByType(TextInput)
        .find((n) => typeof n.props.placeholder === "string" && n.props.placeholder.length > 0);
      const flatStyles = Array.isArray(whereInput!.props.style)
        ? whereInput!.props.style
        : [whereInput!.props.style];
      expect(
        flatStyles.some(
          (s) => !!s && typeof s === "object" && (s as { minWidth?: unknown }).minWidth === 0,
        ),
      ).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it("caps each chip label width with single-line ellipsis", () => {
    const renderer = renderWithLongPlaceChip();
    try {
      const chipTexts = renderer.root.findAll(
        (node) =>
          !!node.props &&
          typeof node.props.style === "object" &&
          node.props.style !== null &&
          !Array.isArray(node.props.style) &&
          (node.props.style as { maxWidth?: unknown }).maxWidth === 220,
      );
      expect(chipTexts.length).toBeGreaterThanOrEqual(1);
      for (const node of chipTexts) {
        expect(node.props.numberOfLines).toBe(1);
        expect(node.props.ellipsizeMode).toBe("tail");
      }
    } finally {
      renderer.unmount();
    }
  });
});
