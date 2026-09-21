import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Linking } from "react-native";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import { ShowtimeList } from "@/components/search/ShowtimeList";
import type {
  RankedAnswer,
  RecheckInput,
  RecoveryOption,
  ResultGroup,
  ScheduleSkeletonEntry,
} from "@seatfirst/core";

const mockRecheckShowtime = vi.fn<(input: RecheckInput) => Promise<unknown>>();
const mockOpenHandoff = vi.fn<(url: string) => Promise<boolean>>();

vi.mock("@/api/search", () => ({
  cancelSearch: vi.fn(),
  createSearch: vi.fn(),
  getSearch: vi.fn(),
}));

import type * as HandoffLib from "@/lib/handoff";

vi.mock("@/api/showtimes", () => ({
  recheckShowtime: (input: RecheckInput) => mockRecheckShowtime(input),
}));

// Row-level opens (success link, recovery options) import openHandoff directly,
// so they land on the mock. The view model's AVAILABLE auto-handoff goes through
// the real completeHandoffWithPopup, whose intra-module openHandoff call is not
// observable through a module mock — it lands on the Linking spy instead.
vi.mock("@/lib/handoff", async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffLib>();
  return { ...actual, openHandoff: (url: string) => mockOpenHandoff(url) };
});

vi.mock("@/hooks/useTheatreMovies", () => ({
  useTheatreMovies: () => ({ data: undefined, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useTheatreSearch", () => ({
  useTheatreSearch: () => ({ data: { theatres: [] }, isFetching: false, error: null }),
}));
vi.mock("@/hooks/useSearchSubscription", () => ({
  useSearchSubscription: () => ({ startSearch: vi.fn() }),
}));

import { useSeatfirstDemo } from "./useSeatfirstDemo";

const openUrlSpy = vi.spyOn(Linking, "openURL");

const SHOWTIME_ID = "sh_e2e";
const DEEP_LINK = "https://www.amctheatres.com/showtimes/sh_e2e/seats";
const ALT_URL_1 = "https://www.amctheatres.com/showtimes/e2e_111/seats";
const ALT_URL_4 = "https://www.amctheatres.com/showtimes/e2e_444/seats";

function seedSurface(): void {
  const showtimes = [
    {
      showtimeId: SHOWTIME_ID,
      resolved: true,
      deepLinkUrl: DEEP_LINK,
      showDateTimeUtc: "2026-08-31T02:00:00Z",
      timezone: "America/Los_Angeles",
    },
    {
      showtimeId: "st_e2e1",
      resolved: true,
      deepLinkUrl: ALT_URL_1,
      showDateTimeUtc: "2026-08-31T02:30:00Z",
      timezone: "America/Los_Angeles",
    },
    {
      showtimeId: "st_e2e4",
      resolved: true,
      deepLinkUrl: ALT_URL_4,
      showDateTimeUtc: "2026-08-31T03:00:00Z",
      timezone: "America/Los_Angeles",
    },
  ];
  act(() => {
    useSeatfirstStore.getState().setSearchTerminal({
      status: "COMPLETE",
      answer: {
        mode: "CONFIDENT",
        otherFormats: [],
        primary: {
          placement: { placementKey: "e2e_key" },
          showtimes: [{ showtimeId: SHOWTIME_ID, nonce: "nonce_sh_e2e", deepLinkUrl: DEEP_LINK }],
        },
      } as unknown as RankedAnswer,
      // Single group doubles as the display geometry and the AVAILABLE path's
      // deep-link lookup. Its layoutId matches no recommendation placement, so
      // placement-card resolution stays on its empty-groups path.
      groups: [
        {
          theatreId: "th_amc_metreon",
          layoutId: "lay_e2e",
          columns: 20,
          showtimes,
          groupHits: [{ showtimeIndices: [0], row: 4, startCol: 9 }],
        },
      ] as unknown as ResultGroup[],
      resolved: 1,
      total: 1,
    });
    useSeatfirstStore.setState({
      searchId: "search_e2e",
      scheduleSkeleton: [
        {
          theatreId: "th_amc_metreon",
          showDateTimeLocal: "2026-08-30T19:00",
          formatCode: "STANDARD",
          distanceKm: null,
          rank: 0,
          admitted: true,
          resolved: true,
          showtimeId: SHOWTIME_ID,
        },
      ] as unknown as ScheduleSkeletonEntry[],
    });
  });
}

/** Live ResultsSurface: real useSearchResultsViewModel wired into ShowtimeList exactly as ResultScreen wires it. */
function ResultsSurface(): React.JSX.Element {
  const vm = useSeatfirstDemo();
  return React.createElement(ShowtimeList, {
    skeleton: vm.scheduleSkeleton,
    groups: vm.groups,
    partySize: vm.partySize,
    resolved: vm.checkedCount,
    total: vm.totalShowtimes,
    terminalCause: vm.terminalCause,
    searchStatus: vm.searchStatus,
    onCheckMore: vm.canCheckMore ? vm.actions.checkMore : undefined,
    onHandoff: vm.actions.startHandoff,
    handoffEligible: vm.handoffEligibleShowtimeIds,
    recheckingShowtimeId: vm.recheckingShowtimeId,
    recheckSelectedShowtimeId: vm.recheckTargetShowtimeId,
    recheckResult: vm.recheckResult,
    recheckError: vm.recheckInlineError,
    onClearRecheck: vm.actions.clearRecheck,
    takenShowtimeIds: vm.takenShowtimeIds,
  });
}

function renderSurface(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ResultsSurface));
  });
  return renderer;
}

/** The mock renders each Pressable twice (composite + host); composites are the logical buttons. */
function compositeButtons(
  renderer: TestRenderer.ReactTestRenderer,
  props: Record<string, unknown>,
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByProps(props).filter((n) => typeof n.type !== "string");
}

function pressGoToAmc(renderer: TestRenderer.ReactTestRenderer): void {
  const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
  expect(buttons.length).toBe(1);
  act(() => {
    (buttons[0]?.props.onPress as () => void)();
  });
}

/** Flush the recheck round-trip (RPC → result store → inline render → handoff open). */
async function flushRecheck(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {});
}

describe("UI30 inline recheck end to end (ADR 0063 Verification)", () => {
  beforeEach(() => {
    useSeatfirstStore.setState({
      ...searchFormInitialState,
      ...flowInitialState,
      ...bootstrapInitialState,
      ...searchInitialState,
      ...layoutInitialState,
      ...recheckInitialState,
      isFormCollapsed: false,
      isCanceling: false,
      cancelError: null,
    });
    vi.clearAllMocks();
    mockOpenHandoff.mockResolvedValue(true);
  });

  it("AVAILABLE rechecks in place, opens AMC directly, and keeps the Go to AMC CTA", async () => {
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
    seedSurface();
    const screenBefore = useSeatfirstStore.getState().screen;
    const renderer = renderSurface();
    pressGoToAmc(renderer);
    await flushRecheck();

    // Direct 1-click handoff ran through the real chain to the offer deep link…
    expect(openUrlSpy).toHaveBeenCalledWith(DEEP_LINK);
    // …the screen never moved…
    expect(useSeatfirstStore.getState().screen).toBe(screenBefore);
    expect(useSeatfirstStore.getState().recheckingShowtimeId).toBeNull();
    // …and the row keeps the plain Go to AMC button (wired to open directly).
    const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
    expect(buttons.length).toBe(1);
    act(() => {
      (buttons[0]?.props.onPress as () => void)();
    });
    expect(mockOpenHandoff).toHaveBeenCalledWith(DEEP_LINK);
  });

  it("GONE marks the row taken and hands off the Level 1 alternative from the RecoverySheet", async () => {
    mockRecheckShowtime.mockResolvedValue({
      status: "GONE",
      recovery: [
        {
          level: 1,
          placement: {
            layoutId: "lay_e2e",
            row: 6,
            startCol: 7,
            rowSpan: 1,
            count: 2,
            seatNames: ["G8", "G9"],
            placementKey: "e2e_alt1",
          },
          showtimeId: "st_e2e1",
          relaxed: [],
          requiresConsent: false,
        },
        {
          level: 4,
          placement: {
            layoutId: "lay_e2e",
            row: 2,
            startCol: 3,
            rowSpan: 1,
            count: 2,
            seatNames: ["C4", "C5"],
            placementKey: "e2e_alt4",
          },
          showtimeId: "st_e2e4",
          relaxed: [{ kind: "LATER_THAN_PREFERRED" }],
          requiresConsent: true,
        },
      ] as unknown as RecoveryOption[],
    });
    seedSurface();
    const screenBefore = useSeatfirstStore.getState().screen;
    const renderer = renderSurface();
    pressGoToAmc(renderer);
    await flushRecheck();

    // No auto-handoff on a taken row; the screen never moved.
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(useSeatfirstStore.getState().screen).toBe(screenBefore);
    // The taken row renders its badge with a disabled CTA and does NOT expand
    // inline — UI41 moved the alternatives into the RecoverySheet.
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Seats just taken");
    expect(renderer.root.findAllByProps({ testID: `recovery-panel-${SHOWTIME_ID}` }).length).toBe(
      0,
    );
    expect(renderer.root.findByProps({ testID: "recovery-sheet" })).toBeDefined();
    expect(str).toContain("Those seats were just taken");

    // The Level 1 alternative hands off directly to its own deep link.
    const l1 = renderer.root.findByProps({ testID: "recovery-option-1" });
    const l1Buttons = l1
      .findAllByProps({ accessibilityLabel: "Go to AMC" })
      .filter((n) => typeof n.type !== "string");
    expect(l1Buttons.length).toBe(1);
    await act(async () => {
      (l1Buttons[0]?.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(mockOpenHandoff).toHaveBeenCalledWith(ALT_URL_1);
  });

  it("UNAVAILABLE renders the inline error with a working Retry", async () => {
    mockRecheckShowtime.mockResolvedValue({ status: "UNAVAILABLE", cause: "UPSTREAM_UNAVAILABLE" });
    seedSurface();
    const screenBefore = useSeatfirstStore.getState().screen;
    const renderer = renderSurface();
    pressGoToAmc(renderer);
    await flushRecheck();

    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(mockOpenHandoff).not.toHaveBeenCalled();
    expect(useSeatfirstStore.getState().screen).toBe(screenBefore);
    expect(renderer.root.findByProps({ testID: `recheck-error-${SHOWTIME_ID}` })).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Theatre site unavailable — try again");

    // Retry re-arms the row: a second tap issues a second recheck.
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
    const retry = renderer.root.findByProps({ accessibilityLabel: "Retry" });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    await flushRecheck();
    expect(mockRecheckShowtime).toHaveBeenCalledTimes(2);
    expect(openUrlSpy).toHaveBeenCalledWith(DEEP_LINK);
  });
});
