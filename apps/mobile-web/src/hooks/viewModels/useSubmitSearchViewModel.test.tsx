import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { DEFAULT_SEARCH_LIMITS, specHash, type SearchSpec } from "@seatfirst/core";
import { buildSearchSpec } from "@/lib/buildSearchSpec";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import {
  useSubmitSearchViewModel,
  type MovieSuggestion,
  type SubmitSearchStart,
  type SubmitSearchViewModel,
} from "./useSubmitSearchViewModel";
import { clearTheatreMovieCache, useTheatreMovieSet } from "../useTheatreMovieSet";
import { useFacetCounts, type UseFacetCountsInput } from "../useFacetCounts";

const { mockRefreshMutate, mockQueryClientClear } = vi.hoisted(() => ({
  // The view model now auto-checks exactly one selected theatre on mount.
  // Keep unrelated view-model tests deterministic while dedicated cases
  // below replace this with pending/rejected responses as needed.
  mockRefreshMutate: vi.fn<(...args: unknown[]) => unknown>(() =>
    Promise.resolve({ status: "RESOLVED" }),
  ),
  mockQueryClientClear: vi.fn<(...args: unknown[]) => unknown>(),
}));
vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    theatres: {
      refreshSchedule: { mutate: (...args: unknown[]) => mockRefreshMutate(...args) },
    },
  },
  queryClient: { clear: (...args: unknown[]) => mockQueryClientClear(...args) },
}));
vi.mock("../useTheatreMovieSet", () => ({
  useTheatreMovieSet: vi.fn(),
  clearTheatreMovieCache: vi.fn(),
}));
const { mockMovieSearch } = vi.hoisted(() => ({
  mockMovieSearch: vi.fn<
    (input?: unknown) => {
      data: undefined;
      error: null;
      isLoading: boolean;
      isFetching: boolean;
      refetch: () => void;
      suggestions: MovieSuggestion[];
    }
  >(() => ({
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    suggestions: [] as MovieSuggestion[],
  })),
}));
vi.mock("../useMovieSearch", () => ({
  useMovieSearch: (input?: unknown) => mockMovieSearch(input),
}));
vi.mock("../useFacetCounts", () => ({
  useFacetCounts: vi.fn(() => ({
    data: null,
    countsMap: new Map(),
    countsRecord: {},
    isLoading: false,
    error: null,
  })),
}));

const mountedRenderers: Array<{ unmount: () => void }> = [];

function resetRefreshMutate(): void {
  mockRefreshMutate.mockReset();
  mockRefreshMutate.mockResolvedValue({ status: "RESOLVED" });
}

afterEach(() => {
  TestRenderer.act(() => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
  });
});

const mockMovieSet = vi.mocked(useTheatreMovieSet);
const mockFacetCounts = vi.mocked(useFacetCounts);

interface StubShowtime {
  showDateTimeUtc: string;
  formatCode: string | null;
}

function showtimeInTwoDays(): string {
  return new Date(Date.now() + 2 * 86_400_000).toISOString();
}

/** Theatre-local (America/Los_Angeles) calendar date of a UTC instant. */
function laDateOf(utcIso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcIso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function setMovieSet(showtimes: StubShowtime[]): void {
  mockMovieSet.mockReturnValue({
    responses: [],
    movies: [
      {
        movieId: "mv_dune",
        title: "Dune",
        posterPath: null,
        showtimeCount: showtimes.length,
        entries: [
          {
            theatreId: "th_1",
            timezone: "America/Los_Angeles",
            group: { showtimes },
          },
        ],
      },
    ],
    isFetching: false,
    isComplete: true,
    error: null,
  } as unknown as ReturnType<typeof useTheatreMovieSet>);
}

function setFormState(): void {
  // UI24: the single committed selectedDates set covers the stub showtime's
  // theatre-local date, so counts exercise only the code under test.
  const utc = new Date(Date.now() + 2 * 86_400_000).toISOString();
  useSeatfirstStore.setState({
    selectedTheatres: [
      { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
    ],
    movie: "Dune",
    selectedMovieId: "mv_dune",
    selectedDates: [laDateOf(utc)],
    timeOfDay: "All times",
    selectedBands: [],
    isCustom: true,
    whenPreset: "Custom",
    formatPref: "any",
  });
}
function mountVm(options?: { startSearch?: SubmitSearchStart }): {
  getVm: () => SubmitSearchViewModel;
} {
  let captured!: SubmitSearchViewModel;
  function Harness(): null {
    captured = useSubmitSearchViewModel(
      options?.startSearch ? { startSearch: options.startSearch } : undefined,
    );
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  mountedRenderers.push(renderer);
  return { getVm: () => captured };
}

function captureVm(options?: { startSearch?: SubmitSearchStart }): SubmitSearchViewModel {
  return mountVm(options).getVm();
}

describe("useSubmitSearchViewModel CTA label and format chips (UX audit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFormState();
  });

  it("zero-match CTA reads 'No showtimes match' and stays disabled (never 'Search 0 showtimes')", () => {
    setMovieSet([]);
    const vm = captureVm();
    expect(vm.matchingShowtimeCount).toBe(0);
    expect(vm.submitButtonLabel).toBe("No showtimes match");
    expect(vm.submitButtonLabel).not.toContain("Search 0");
    expect(vm.searchDisabled).toBe(true);
  });

  it("non-zero CTA branches keep the existing 'Search N showtimes across M theatres' wording", () => {
    const utc = showtimeInTwoDays();
    setMovieSet([
      { showDateTimeUtc: utc, formatCode: "imax" },
      { showDateTimeUtc: utc, formatCode: null },
    ]);
    const vm = captureVm();
    expect(vm.matchingShowtimeCount).toBe(2);
    expect(vm.submitButtonLabel).toBe("Search 2 showtimes across 1 theatre");
    expect(vm.searchDisabled).toBe(false);
  });

  it("'Any format' chip carries the summed total-pool count", () => {
    const utc = showtimeInTwoDays();
    setMovieSet([
      { showDateTimeUtc: utc, formatCode: "imax" },
      { showDateTimeUtc: utc, formatCode: null },
    ]);
    const vm = captureVm();
    expect(vm.formatOptions[0]?.label).toBe("Any format (2)");
  });

  it("'Any format' chip renders bare while the window is not ready", () => {
    const utc = showtimeInTwoDays();
    setMovieSet([{ showDateTimeUtc: utc, formatCode: "imax" }]);
    useSeatfirstStore.setState({ movie: "", selectedMovieId: null });
    const vm = captureVm();
    expect(vm.formatOptions[0]?.label).toBe("Any format");
  });
});

describe("useSubmitSearchViewModel facet cross-axis bases (ADR 0036 + ADR 0052 §6)", () => {
  /** Latest four useFacetCounts inputs in hook-call order: MOVIE, FORMAT, DATE, TIME_OF_DAY. */
  function facetInputs(): {
    movie: UseFacetCountsInput | null;
    format: UseFacetCountsInput | null;
    date: UseFacetCountsInput | null;
    time: UseFacetCountsInput | null;
  } {
    const calls = mockFacetCounts.mock.calls.slice(-4);
    expect(calls).toHaveLength(4);
    const [movieCall, formatCall, dateCall, timeCall] = calls;
    return {
      movie: movieCall?.[0] ?? null,
      format: formatCall?.[0] ?? null,
      date: dateCall?.[0] ?? null,
      time: timeCall?.[0] ?? null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // UI42.8: every selected date carries a cached midday-Pacific showtime, so
    // the whole scope is warm and facet inputs keep their exact-date scoping.
    // (A dateless group reads as cold scope and disables the facet hooks.)
    setMovieSet(
      ["2026-09-05", "2026-09-06", "2026-09-12"].map((date) => ({
        showDateTimeUtc: `${date}T19:00:00.000Z`,
        formatCode: null,
      })),
    );
    useSeatfirstStore.setState({
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      movie: "Dune",
      selectedMovieId: "mv_dune",
      selectedDates: ["2026-09-12", "2026-09-05", "2026-09-06"],
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      isCustom: true,
      whenPreset: "Custom",
      formatPref: "any",
    });
  });

  it("scopes MOVIE/FORMAT/TIME_OF_DAY to the exact sparse date scope, DATE to movie + time", () => {
    captureVm();
    const { movie, format, date, time } = facetInputs();
    // Sparse custom set resolves to two runs; the gap date must stay excluded,
    // so non-date axes carry this exact scope rather than weekday flags.
    const sparseScope = {
      kind: "OR",
      of: [
        { kind: "DATE_RANGE", from: "2026-09-05", to: "2026-09-06" },
        { kind: "DATE_RANGE", from: "2026-09-12", to: "2026-09-12" },
      ],
    };
    // MOVIE is varied: exact dateScope + timeOfDay, no movieId, and no weekday threading.
    expect(movie?.axes).toEqual([{ kind: "MOVIE", candidates: ["mv_dune"] }]);
    expect(movie?.dateScope).toEqual(sparseScope);
    expect(movie?.timeOfDay).toBe("Evening");
    expect("days" in (movie ?? {})).toBe(false);
    expect(movie?.movieId ?? null).toBeNull();
    // FORMAT is varied: movieId + exact dateScope + timeOfDay (no format base exists).
    expect(format?.axes?.[0]?.kind).toBe("FORMAT");
    expect(format?.movieId).toBe("mv_dune");
    expect(format?.dateScope).toEqual(sparseScope);
    expect(format?.timeOfDay).toBe("Evening");
    expect("days" in (format ?? {})).toBe(false);
    expect(format?.format ?? null).toBeNull();
    // DATE is varied: movieId + timeOfDay, no dateScope.
    expect(date?.axes).toEqual([
      { kind: "DATE", candidates: ["2026-09-05", "2026-09-06", "2026-09-12"] },
    ]);
    expect(date?.movieId).toBe("mv_dune");
    expect(date?.timeOfDay).toBe("Evening");
    expect(date?.dateScope ?? null).toBeNull();
    expect("days" in (date ?? {})).toBe(false);
    // TIME_OF_DAY is varied: movieId + exact dateScope, no timeOfDay.
    expect(time?.axes).toEqual([
      { kind: "TIME_OF_DAY", candidates: ["morning", "afternoon", "evening", "late"] },
    ]);
    expect(time?.movieId).toBe("mv_dune");
    expect(time?.dateScope).toEqual(sparseScope);
    expect(time?.timeOfDay ?? null).toBeNull();
    expect("days" in (time ?? {})).toBe(false);
  });

  it("always sends the exact date scope for MOVIE/FORMAT/TIME_OF_DAY, even for unknown presets", () => {
    useSeatfirstStore.setState({
      isCustom: false,
      selectedDates: ["2026-09-05", "2026-09-06"],
      whenPreset: "No-such-preset",
    });
    captureVm();
    const { movie, format, time } = facetInputs();
    const expectedScope = {
      kind: "DATE_RANGE",
      from: "2026-09-05",
      to: "2026-09-06",
    };
    expect(movie?.dateScope).toEqual(expectedScope);
    expect("days" in (movie ?? {})).toBe(false);
    expect(movie?.timeOfDay).toBe("Evening");
    expect(movie?.movieId ?? null).toBeNull();
    expect(format?.dateScope).toEqual(expectedScope);
    expect(format?.movieId).toBe("mv_dune");
    expect(time?.dateScope).toEqual(expectedScope);
  });
});

describe("useSubmitSearchViewModel matchingShowtimeCount honors the active whenPreset (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 26, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("committed This-weekend dates only count showtimes inside the resolved weekend", async () => {
    const { resolveWhenPreset, expandIsos } = await import("@/lib/whenPresets");
    useSeatfirstStore.setState({
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      movie: "Dune",
      selectedMovieId: "mv_dune",
      selectedDates: expandIsos(
        resolveWhenPreset("This weekend", new Date())!.from,
        resolveWhenPreset("This weekend", new Date())!.to,
      ),
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      isCustom: false,
      whenPreset: "This weekend",
      formatPref: "any",
    });
    const resolved = resolveWhenPreset("This weekend", new Date())!;
    // Inside the resolved weekend: Friday 7pm Pacific.
    const insideWeekend = new Date(`${resolved.from}T19:00:00-07:00`);
    // Same weekday/time two weeks later — outside "This weekend" but still inside the
    // pre-fix MOVIE_BROWSE_SPAN_DAYS (30-day) fallback, so this catches the exact
    // regression: the fallback wrongly counted it too.
    const farFuture = new Date(insideWeekend.getTime() + 14 * 86_400_000);
    setMovieSet([
      { showDateTimeUtc: insideWeekend.toISOString(), formatCode: null },
      { showDateTimeUtc: farFuture.toISOString(), formatCode: null },
    ]);
    const vm = captureVm();
    expect(vm.matchingShowtimeCount).toBe(1);
    expect(vm.submitButtonLabel).toBe("Search 1 showtime across 1 theatre");
  });
});

describe("useSubmitSearchViewModel create-direct submit (UI27 / ADR 0054)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSeatfirstStore.setState({
      screen: "search",
      error: null,
      phase: "idle",
      searchId: null,
      status: null,
      previewPlaceholderCount: null,
      selectedShowtimeIdx: null,
    });
  });

  function seedSubmitForm(selectedDates: string[]): void {
    useSeatfirstStore.setState({
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      movie: "Dune",
      selectedMovieId: "mv_dune",
      selectedDates,
      timeOfDay: "Evening",
      selectedBands: ["Evening"],
      isCustom: true,
      whenPreset: "Custom",
      formatPref: "any",
    });
    setMovieSet([]);
  }

  async function startAndCapture(
    selectedDates: string[],
    startSearch: SubmitSearchStart,
  ): Promise<{ created: unknown[] }> {
    seedSubmitForm(selectedDates);
    const created: unknown[] = [];
    const vm = captureVm({
      startSearch: async (spec) => {
        created.push(spec);
        await startSearch(spec);
      },
    });
    await TestRenderer.act(async () => {
      vm.actions.startSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    return { created };
  }

  it("sparse selection: create receives the v2 spec directly with no screen flip", async () => {
    const { created } = await startAndCapture(["2026-09-12", "2026-09-05", "2026-09-06"], () =>
      Promise.resolve(),
    );
    expect(created).toHaveLength(1);
    const spec = created[0] as { specVersion: unknown; where: unknown };
    expect(spec.specVersion).toBe(2);
    // The injected create is a no-op mock, so nothing flips the screen — the form
    // stays put until a real setSearchId success transition arrives.
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });

  it("preset selection: create receives the v2 spec directly with no screen flip", async () => {
    const { created } = await startAndCapture(["2026-09-04", "2026-09-05", "2026-09-06"], () =>
      Promise.resolve(),
    );
    expect(created).toHaveLength(1);
    const spec = created[0] as { specVersion: unknown; where: unknown };
    expect(spec.specVersion).toBe(2);
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });

  it("CAPACITY_CEILING_EXCEEDED rejection renders the banner, stays on search, clears busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startSearch = async (): Promise<void> => {
      // Mirror useSearchSubscription: creating phase, then the structured rejection.
      useSeatfirstStore.getState().setSearchCreating({ pendingKey: "k-cap", pendingHash: "h-cap" });
      await gate;
      useSeatfirstStore.getState().setSearchError({
        message: "ceiling",
        code: "CAPACITY_CEILING_EXCEEDED",
        matchedCount: 337,
        limit: DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes,
      });
    };
    seedSubmitForm(["2026-09-04", "2026-09-05", "2026-09-06"]);
    const vm = captureVm({ startSearch });
    TestRenderer.act(() => {
      vm.actions.startSearch();
    });
    // In-flight create: busy derives from phase, screen still on the form.
    expect(captureVm().capacityGateBusy).toBe(true);
    expect(useSeatfirstStore.getState().screen).toBe("search");
    await TestRenderer.act(async () => {
      release();
      await gate;
      await Promise.resolve();
    });
    const after = captureVm();
    expect(after.capacityGateBusy).toBe(false);
    expect(after.capacityBlockLabel).toBe(
      `337 showtimes match — above the ${DEFAULT_SEARCH_LIMITS.maxResolvedShowtimes} limit. Narrow your filters to continue.`,
    );
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });

  it("non-capacity rejection (ADMISSION_REJECTED) leaves the capacity banner empty", async () => {
    const startSearch = (): Promise<void> => {
      useSeatfirstStore.getState().setSearchCreating({ pendingKey: "k-adm", pendingHash: "h-adm" });
      useSeatfirstStore.getState().setSearchError({
        message: "admission",
        code: "ADMISSION_REJECTED",
        retryAfterSeconds: 30,
      });
      return Promise.resolve();
    };
    const { created } = await startAndCapture(
      ["2026-09-04", "2026-09-05", "2026-09-06"],
      startSearch,
    );
    expect(created).toHaveLength(1);
    const after = captureVm();
    expect(after.capacityBlockLabel).toBeNull();
    expect(after.capacityGateBusy).toBe(false);
    expect(after.admissionRejected).toEqual({ retryAfterSeconds: 30 });
    expect(after.admissionRejectedLabel).not.toBeNull();
    expect(useSeatfirstStore.getState().screen).toBe("search");
  });
});

describe("useSubmitSearchViewModel in-situ update (UI31 / ADR 0064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFormState();
    useSeatfirstStore.setState({
      partySize: 4,
      serverCoverageSpec: null,
      pendingSpec: null,
      effectiveViewSpec: null,
      searchId: null,
      status: null,
      phase: "idle",
      error: null,
    });
    const utc = showtimeInTwoDays();
    setMovieSet([
      { showDateTimeUtc: utc, formatCode: "imax" },
      { showDateTimeUtc: utc, formatCode: null },
    ]);
  });

  function expectedDraftSpec(): SearchSpec {
    const s = useSeatfirstStore.getState();
    const spec = buildSearchSpec({
      where: {
        deviceCenter: s.deviceCenter,
        wherePlace: s.wherePlace,
        selectedTheatres: s.selectedTheatres,
        whereRadiusKm: s.whereRadiusKm,
        whereLimit: s.whereLimit,
        isHandEdited: s.theatreListHandPruned,
      },
      movieId: s.selectedMovieId,
      selectedDates: s.selectedDates,
      timeOfDay: s.timeOfDay,
      selectedBands: s.selectedBands,
      seatPrefs: s.seatPrefs,
      partySize: s.partySize,
      formatPref: s.formatPref,
    });
    if (spec === null) throw new Error("draft spec unexpectedly null");
    return spec;
  }

  it('labels the CTA "Update search" only when the draft hash differs from serverCoverageSpec', () => {
    // Populate pendingSpec from the live draft, then pin the server coverage
    // to that exact draft: resubmitting it unchanged is a continuation, not
    // an update (the checkMore same-spec case must never read "Update search").
    captureVm();
    const base = useSeatfirstStore.getState().pendingSpec;
    if (base === null) throw new Error("pendingSpec not populated");
    useSeatfirstStore.setState({ serverCoverageSpec: base, searchId: "srch_live" });
    expect(captureVm().submitButtonLabel).toBe("Search 2 showtimes across 1 theatre");

    // A real draft edit (party size) changes the candidate hash: now the CTA
    // offers an in-situ update of the live search.
    useSeatfirstStore.setState({ partySize: 2 });
    const vm = captureVm();
    expect(specHash(useSeatfirstStore.getState().pendingSpec)).not.toBe(specHash(base));
    expect(vm.submitButtonLabel).toBe("Update search");
  });

  it("disables the CTA while editing a live search until the draft actually changes", () => {
    // Same unedited-draft setup as the label test above: pin serverCoverageSpec
    // to the exact current draft, simulating "Edit search" before any change.
    captureVm();
    const base = useSeatfirstStore.getState().pendingSpec;
    if (base === null) throw new Error("pendingSpec not populated");
    useSeatfirstStore.setState({ serverCoverageSpec: base, searchId: "srch_live" });
    expect(captureVm().searchDisabled).toBe(true);

    // Editing the form (party size) diverges the draft from the live search:
    // the CTA re-enables as an in-situ update.
    useSeatfirstStore.setState({ partySize: 2 });
    const vm = captureVm();
    expect(specHash(useSeatfirstStore.getState().pendingSpec)).not.toBe(specHash(base));
    expect(vm.searchDisabled).toBe(false);
  });

  it("threads searchId as continuesSearchId for updates, omits it for fresh submissions", async () => {
    captureVm();
    const base = useSeatfirstStore.getState().pendingSpec;
    if (base === null) throw new Error("pendingSpec not populated");
    useSeatfirstStore.setState({ serverCoverageSpec: base, searchId: "srch_live" });
    useSeatfirstStore.setState({ partySize: 5 });

    const updateCalls: Array<{ spec: SearchSpec; continues?: string }> = [];
    const updateVm = captureVm({
      startSearch: (spec, continuesSearchId) => {
        updateCalls.push(
          continuesSearchId === undefined ? { spec } : { spec, continues: continuesSearchId },
        );
        return Promise.resolve();
      },
    });
    await TestRenderer.act(() => {
      updateVm.actions.startSearch();
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.continues).toBe("srch_live");
    // The submitted spec is the live draft, not the stale server coverage.
    expect(specHash(updateCalls[0]?.spec)).toBe(specHash(useSeatfirstStore.getState().pendingSpec));

    // Fresh submission (no server coverage): no continuation id.
    useSeatfirstStore.setState({ serverCoverageSpec: null, searchId: null });
    const freshCalls: Array<{ spec: SearchSpec; continues?: string }> = [];
    const freshVm = captureVm({
      startSearch: (spec, continuesSearchId) => {
        freshCalls.push(
          continuesSearchId === undefined ? { spec } : { spec, continues: continuesSearchId },
        );
        return Promise.resolve();
      },
    });
    await TestRenderer.act(() => {
      freshVm.actions.startSearch();
    });
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]).not.toHaveProperty("continues");
  });

  it("mirrors the live draft into pendingSpec on every render (hash equality)", () => {
    captureVm();
    expect(specHash(useSeatfirstStore.getState().pendingSpec)).toBe(specHash(expectedDraftSpec()));
    // A draft edit re-mirrors: the hash tracks the new draft, not the old one.
    const before = specHash(useSeatfirstStore.getState().pendingSpec);
    const s = useSeatfirstStore.getState();
    useSeatfirstStore.setState({ partySize: s.partySize === 2 ? 3 : 2 });
    captureVm();
    expect(specHash(useSeatfirstStore.getState().pendingSpec)).not.toBe(before);
    expect(specHash(useSeatfirstStore.getState().pendingSpec)).toBe(specHash(expectedDraftSpec()));
  });
});

describe("useSubmitSearchViewModel Cold/Hot mode (UI42.1/42.2/42.3)", () => {
  function setColdMovieSet(): void {
    mockMovieSet.mockReturnValue({
      responses: [],
      movies: [],
      isFetching: false,
      isComplete: true,
      error: null,
    });
  }

  function setColdForm(movieState: {
    movie: string;
    selectedMovieId: string | null;
    movieSelectionSource: "library" | "custom" | null;
  }): void {
    useSeatfirstStore.setState({
      screen: "search",
      error: null,
      phase: "idle",
      searchId: null,
      status: null,
      serverCoverageSpec: null,
      pendingSpec: null,
      previewPlaceholderCount: null,
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      selectedDates: ["2026-09-05"],
      timeOfDay: "All times",
      selectedBands: [],
      isCustom: true,
      whenPreset: "Custom",
      formatPref: "any",
      movieFocused: false,
      movieClearedNotice: null,
      isCheckingLiveSchedule: false,
      liveScheduleError: null,
      ...movieState,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRefreshMutate();
    mockQueryClientClear.mockClear();
    setColdMovieSet();
  });

  it("derives isWarm from cached movie groups (Cold when empty, Hot otherwise)", () => {
    setColdForm({ movie: "", selectedMovieId: null, movieSelectionSource: null });
    expect(captureVm().isWarm).toBe(false);
    setMovieSet([]);
    expect(captureVm().isWarm).toBe(true);
  });

  it("Cold Mode unblocks the CTA for a confirmed custom title, bypassing the zero-match gate", () => {
    setColdForm({ movie: "Met Opera Live", selectedMovieId: null, movieSelectionSource: "custom" });
    const vm = captureVm();
    expect(vm.matchingShowtimeCount).toBeNull();
    expect(vm.searchDisabled).toBe(false);
    expect(vm.submitButtonLabel).toBe("Find my seats");
  });

  it("Cold Mode unblocks the CTA for a universal-search hit id", () => {
    setColdForm({
      movie: "Nosferatu",
      selectedMovieId: "tmdb:movie:917496",
      movieSelectionSource: "custom",
    });
    expect(captureVm().searchDisabled).toBe(false);
  });

  it("Cold Mode keeps the CTA blocked while typing (confirmed nothing yet)", () => {
    setColdForm({ movie: "Met", selectedMovieId: null, movieSelectionSource: null });
    const vm = captureVm();
    expect(vm.searchDisabled).toBe(true);
    expect(vm.submitButtonLabel).toBe("Choose a movie");
  });

  it("Hot Mode keeps the zero-match gate and filters confirmed schedule movies", () => {
    setMovieSet([]);
    setColdForm({ movie: "dUn", selectedMovieId: "mv_dune", movieSelectionSource: "library" });
    mockMovieSearch.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      suggestions: [{ label: "Dune (general release)", onPress: () => {}, posterUrl: null }],
    });
    const vm = captureVm();
    expect(vm.isWarm).toBe(true);
    expect(vm.matchingShowtimeCount).toBe(0);
    expect(vm.searchDisabled).toBe(true);
    expect(vm.submitButtonLabel).toBe("No showtimes match");
    expect(vm.liveScheduleHeader).toBe("Now playing at AMC One");
    expect(vm.liveScheduleMovies.map((suggestion) => suggestion.label)).toEqual(["Dune"]);
    expect(vm.nowPlayingSuggestions.map((suggestion) => suggestion.label)).toEqual([
      "Dune (general release)",
    ]);
  });

  it("exposes generic universal-search suggestions separately from confirmed schedules", () => {
    setColdForm({ movie: "nos", selectedMovieId: null, movieSelectionSource: null });
    mockMovieSearch.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      suggestions: [
        {
          label: "Nosferatu (2024)",
          onPress: () => {},
          posterUrl: null,
          releaseYear: 2024,
          badge: null,
          seenAtAmc: false,
        },
        {
          label: "Met Opera Live",
          onPress: () => {},
          posterUrl: null,
          releaseYear: null,
          badge: "AMC Event",
          seenAtAmc: true,
        },
      ],
    });
    const vm = captureVm();
    expect(vm.isWarm).toBe(false);
    expect(vm.liveScheduleMovies).toEqual([]);
    expect(vm.nowPlayingHeader).toBe("Now Playing (general release)");
    expect(vm.nowPlayingSuggestions.map((s) => s.label)).toEqual([
      "Nosferatu (2024)",
      "Met Opera Live",
    ]);
    expect(vm.nowPlayingSuggestions[1]?.badge).toBe("AMC Event");
    expect(mockMovieSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "nos", browse: false }),
    );
  });

  it("onSelectCustomEvent confirms the free-typed title as a custom selection", () => {
    setColdForm({
      movie: "My Mystery Screening",
      selectedMovieId: null,
      movieSelectionSource: null,
    });
    const vm = captureVm();
    TestRenderer.act(() => {
      vm.actions.onSelectCustomEvent("My Mystery Screening");
    });
    const s = useSeatfirstStore.getState();
    expect(s.movie).toBe("My Mystery Screening");
    expect(s.selectedMovieId).toBeNull();
    expect(s.movieSelectionSource).toBe("custom");
    // A confirmed custom title unblocks the CTA.
    expect(captureVm().searchDisabled).toBe(false);
  });

  it("submitting a confirmed custom title emits ids + titles (UI42.7)", async () => {
    setColdForm({
      movie: "Met Opera Live",
      selectedMovieId: null,
      movieSelectionSource: "custom",
    });
    const created: unknown[] = [];
    const vm = captureVm({
      startSearch: (spec) => {
        created.push(spec);
        return Promise.resolve();
      },
    });
    await TestRenderer.act(async () => {
      vm.actions.startSearch();
      await Promise.resolve();
    });
    expect(created).toHaveLength(1);
    const spec = created[0] as SearchSpec;
    if (spec.where.kind !== "AND") throw new Error("expected AND spec");
    const movie = spec.where.of.find((p) => p.kind === "MOVIE");
    expect(movie).toEqual({
      kind: "MOVIE",
      ids: ["custom:event:met-opera-live"],
      titles: ["Met Opera Live"],
    });
  });

  it("typing without confirming submits nothing (fail-closed)", async () => {
    setColdForm({ movie: "Met", selectedMovieId: null, movieSelectionSource: null });
    const created: unknown[] = [];
    const vm = captureVm({
      startSearch: (spec) => {
        created.push(spec);
        return Promise.resolve();
      },
    });
    await TestRenderer.act(async () => {
      vm.actions.startSearch();
      await Promise.resolve();
    });
    expect(created).toHaveLength(0);
  });
});

describe("useSubmitSearchViewModel live schedule check (UI42.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefreshMutate();
    mockQueryClientClear.mockClear();
    mockMovieSet.mockReturnValue({
      responses: [],
      movies: [],
      isFetching: false,
      isComplete: true,
      error: null,
    });
    useSeatfirstStore.setState({
      screen: "search",
      error: null,
      phase: "idle",
      searchId: null,
      status: null,
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      movie: "",
      selectedMovieId: null,
      movieSelectionSource: null,
      isCheckingLiveSchedule: false,
      liveScheduleError: null,
      selectedDates: ["2026-09-05"],
      timeOfDay: "All times",
      selectedBands: [],
      isCustom: true,
      whenPreset: "Custom",
      formatPref: "any",
    });
  });

  it("RESOLVED invalidates caches and still allows a manual retry after auto-check", async () => {
    mockRefreshMutate.mockResolvedValue({ status: "RESOLVED", localDate: "2026-09-05" });
    const mockClearCache = vi.mocked(clearTheatreMovieCache);
    const harness = mountVm();
    await TestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      harness.getVm().onCheckLiveSchedule();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshMutate).toHaveBeenCalledTimes(2);
    expect(harness.getVm().isCheckingLiveSchedule).toBe(false);
    expect(harness.getVm().liveScheduleError).toBeNull();
    expect(mockClearCache).toHaveBeenCalledTimes(2);
    expect(mockQueryClientClear).toHaveBeenCalledTimes(2);
  });
  it("auto-checks a failed zero-to-one transition once and never rechecks that theatre", async () => {
    mockRefreshMutate.mockResolvedValue({ status: "FAILED", localDate: "2026-09-05" });
    useSeatfirstStore.setState({ selectedTheatres: [] });
    mountVm();
    expect(mockRefreshMutate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      useSeatfirstStore.setState({
        selectedTheatres: [
          { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      useSeatfirstStore.setState({ selectedTheatres: [] });
      useSeatfirstStore.setState({
        selectedTheatres: [
          { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
  });

  it("does not auto-check two theatres, then checks exactly once after a two-to-one transition", async () => {
    useSeatfirstStore.setState({
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
        { id: "th_2", providerId: "amc", name: "AMC Two", city: "SF", distanceKm: 2.2 },
      ],
    });
    mountVm();
    expect(mockRefreshMutate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      useSeatfirstStore.setState({
        selectedTheatres: [
          { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
  });

  it("FAILED surfaces a generic error and keeps the cache", async () => {
    mockRefreshMutate.mockResolvedValue({ status: "FAILED", localDate: "2026-09-05" });
    const mockClearCache = vi.mocked(clearTheatreMovieCache);
    const harness = mountVm();
    await TestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.getVm().liveScheduleError).not.toBeNull();
    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockQueryClientClear).not.toHaveBeenCalled();
  });

  it("rejection surfaces a generic error", async () => {
    mockRefreshMutate.mockRejectedValue(new Error("timeout"));
    const harness = mountVm();
    await TestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.getVm().liveScheduleError).not.toBeNull();
    expect(harness.getVm().isCheckingLiveSchedule).toBe(false);
  });

  it("holds the loading state while the mutation is in flight", async () => {
    let release!: (value: unknown) => void;
    mockRefreshMutate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const harness = mountVm();
    expect(harness.getVm().isCheckingLiveSchedule).toBe(true);
    await TestRenderer.act(async () => {
      release({ status: "RESOLVED", localDate: "2026-09-05" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.getVm().isCheckingLiveSchedule).toBe(false);
  });

  it("no-ops without a confirmed theatre", () => {
    useSeatfirstStore.setState({ selectedTheatres: [] });
    captureVm().onCheckLiveSchedule();
    expect(mockRefreshMutate).not.toHaveBeenCalled();
  });
});

describe("useSubmitSearchViewModel facet suppression on cold dates (UI42.8)", () => {
  function facetInputs(): {
    movie: UseFacetCountsInput | null;
    format: UseFacetCountsInput | null;
    date: UseFacetCountsInput | null;
    time: UseFacetCountsInput | null;
  } {
    const calls = mockFacetCounts.mock.calls.slice(-4);
    expect(calls).toHaveLength(4);
    const [movieCall, formatCall, dateCall, timeCall] = calls;
    return {
      movie: movieCall?.[0] ?? null,
      format: formatCall?.[0] ?? null,
      date: dateCall?.[0] ?? null,
      time: timeCall?.[0] ?? null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useSeatfirstStore.setState({
      screen: "search",
      error: null,
      phase: "idle",
      searchId: null,
      status: null,
      serverCoverageSpec: null,
      selectedTheatres: [
        { id: "th_1", providerId: "amc", name: "AMC One", city: "SF", distanceKm: 1.1 },
      ],
      movie: "Nosferatu",
      selectedMovieId: "tmdb:movie:917496",
      movieSelectionSource: "custom",
      timeOfDay: "All times",
      selectedBands: [],
      isCustom: true,
      whenPreset: "Custom",
      formatPref: "any",
    });
  });

  it("fully cold scope disables all four facet hooks", () => {
    mockMovieSet.mockReturnValue({
      responses: [],
      movies: [],
      isFetching: false,
      isComplete: true,
      error: null,
    });
    useSeatfirstStore.setState({ selectedDates: ["2026-09-05", "2026-09-06"] });
    captureVm();
    const { movie, format, date, time } = facetInputs();
    expect(movie).toBeNull();
    expect(format).toBeNull();
    expect(date).toBeNull();
    expect(time).toBeNull();
  });

  it("partially cold scope restricts dateScope and DATE candidates to warm dates", () => {
    // Only D+0 carries a cached showtime; D+2 is cold within the same scope.
    setMovieSet([{ showDateTimeUtc: "2026-09-05T19:00:00.000Z", formatCode: null }]);
    useSeatfirstStore.setState({ selectedDates: ["2026-09-05", "2026-09-06"] });
    captureVm();
    const { movie, date, time } = facetInputs();
    const warmOnlyScope = { kind: "DATE_RANGE", from: "2026-09-05", to: "2026-09-05" };
    expect(movie?.dateScope).toEqual(warmOnlyScope);
    expect(date?.axes).toEqual([{ kind: "DATE", candidates: ["2026-09-05"] }]);
    expect(time?.dateScope).toEqual(warmOnlyScope);
  });

  it("fully warm scope keeps the exact full date scope (no suppression)", () => {
    setMovieSet(
      ["2026-09-05", "2026-09-06"].map((d) => ({
        showDateTimeUtc: `${d}T19:00:00.000Z`,
        formatCode: null,
      })),
    );
    useSeatfirstStore.setState({ selectedDates: ["2026-09-05", "2026-09-06"] });
    captureVm();
    const { movie, date } = facetInputs();
    expect(movie?.dateScope).toEqual({
      kind: "DATE_RANGE",
      from: "2026-09-05",
      to: "2026-09-06",
    });
    expect(date?.axes).toEqual([{ kind: "DATE", candidates: ["2026-09-05", "2026-09-06"] }]);
  });
});
