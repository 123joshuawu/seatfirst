import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";
import { bootstrapInitialState } from "./bootstrapSlice";

describe("bootstrapSlice", () => {
  beforeEach(() => {
    // Reset store to initial state (flow + searchForm + bootstrap)
    useSeatfirstStore.setState({
      ...bootstrapInitialState,
      bootstrapReady: false,
      bootstrapLoading: false,
      bootstrapError: null,
      sessionId: null,
      limits: null,
      selectedTheatre: null,
      selectedTheatreMovies: null,
    });
  });

  it("initial state is not ready", () => {
    const s = useSeatfirstStore.getState();
    expect(s.bootstrapReady).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.limits).toBeNull();
  });

  it("setBootstrapSuccess marks ready", () => {
    const limits = {
      searchesPerHour: 60,
      upstreamFetchesPerHour: 120,
      concurrentSearches: 3,
      recheckCallsPerMinute: 10,
      facetCountsPerMinute: 120,
      resolvePlacePerMinute: 10,
      suggestPlacePerMinute: 10,
    };
    useSeatfirstStore.getState().setBootstrapSuccess("sess-123", limits);
    const s = useSeatfirstStore.getState();
    expect(s.bootstrapReady).toBe(true);
    expect(s.sessionId).toBe("sess-123");
    expect(s.limits).toEqual(limits);
    expect(s.bootstrapError).toBeNull();
    const hit = {
      id: "amc:theatre:2325",
      providerId: "amc",
      name: "AMC Metreon 16",
      location: { lat: 37.7849, lng: -122.4034 },
      timezone: "America/Los_Angeles" as const,
      city: "San Francisco",
      address: "135 4th St",
      slugs: null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      distanceKm: null as number | null,
    };
    useSeatfirstStore.getState().setSelectedTheatre(hit as never);
    expect(useSeatfirstStore.getState().selectedTheatre?.name).toBe("AMC Metreon 16");

    // Setting movies then selecting new theatre clears it
    useSeatfirstStore.getState().setTheatreMovies({
      theatreId: "amc:theatre:2325" as never,
      timezone: "America/Los_Angeles",
      from: "2026-08-20",
      to: "2026-08-22",
      movies: [],
    });
    expect(useSeatfirstStore.getState().selectedTheatreMovies).not.toBeNull();

    const hit2 = { ...hit, id: "amc:theatre:2118", name: "AMC Van Ness 14" };
    useSeatfirstStore.getState().setSelectedTheatre(hit2 as never);
    expect(useSeatfirstStore.getState().selectedTheatreMovies).toBeNull();
  });

  it("clearTheatreSelection removes theatre and movies", () => {
    const hit = {
      id: "amc:theatre:2325",
      providerId: "amc",
      name: "AMC Metreon 16",
      location: { lat: 37.7849, lng: -122.4034 },
      timezone: "America/Los_Angeles" as const,
      city: "San Francisco",
      address: null,
      slugs: null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      distanceKm: null as number | null,
    };
    useSeatfirstStore.getState().setSelectedTheatre(hit as never);
    useSeatfirstStore.getState().clearTheatreSelection();
    expect(useSeatfirstStore.getState().selectedTheatre).toBeNull();
    expect(useSeatfirstStore.getState().selectedTheatreMovies).toBeNull();
  });
});
