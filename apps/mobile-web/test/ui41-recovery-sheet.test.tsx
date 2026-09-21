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

// Row/sheet-level opens import openHandoff directly, so they land on the mock.
// The view model's AVAILABLE auto-handoff goes through the real
// completeHandoffWithPopup, whose intra-module openHandoff call is not
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

const SHOWTIME_A = "sh_ui41a";
const SHOWTIME_B = "sh_ui41b";
const DEEP_LINK_A = "https://www.amctheatres.com/showtimes/sh_ui41a/seats";
const DEEP_LINK_B = "https://www.amctheatres.com/showtimes/sh_ui41b/seats";
const ALT_URL_1 = "https://www.amctheatres.com/showtimes/ui41_111/seats";
const ALT_URL_4 = "https://www.amctheatres.com/showtimes/ui41_444/seats";

const CONSENT_LABEL = "I understand this is a different showtime and seat";

function goneResult(): unknown {
  return {
    status: "GONE",
    recovery: [
      {
        level: 1,
        placement: {
          layoutId: "lay_ui41",
          row: 6,
          startCol: 7,
          rowSpan: 1,
          count: 2,
          seatNames: ["G8", "G9"],
          placementKey: "ui41_alt1",
        },
        showtimeId: "st_ui41_1",
        relaxed: [],
        requiresConsent: false,
      },
      {
        level: 4,
        placement: {
          layoutId: "lay_ui41",
          row: 2,
          startCol: 3,
          rowSpan: 1,
          count: 2,
          seatNames: ["C4", "C5"],
          placementKey: "ui41_alt4",
        },
        showtimeId: "st_ui41_4",
        relaxed: [{ kind: "LATER_THAN_PREFERRED" }],
        requiresConsent: true,
      },
    ] as unknown as RecoveryOption[],
  };
}

function seedSurface(): void {
  const showtimes = [
    {
      showtimeId: SHOWTIME_A,
      resolved: true,
      deepLinkUrl: DEEP_LINK_A,
      showDateTimeUtc: "2026-08-31T02:00:00Z",
      timezone: "America/Los_Angeles",
    },
    {
      showtimeId: SHOWTIME_B,
      resolved: true,
      deepLinkUrl: DEEP_LINK_B,
      showDateTimeUtc: "2026-08-31T05:00:00Z",
      timezone: "America/Los_Angeles",
    },
    {
      showtimeId: "st_ui41_1",
      resolved: true,
      deepLinkUrl: ALT_URL_1,
      showDateTimeUtc: "2026-08-31T02:30:00Z",
      timezone: "America/Los_Angeles",
    },
    {
      showtimeId: "st_ui41_4",
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
          placement: { placementKey: "ui41_key" },
          showtimes: [
            { showtimeId: SHOWTIME_A, nonce: "nonce_ui41a", deepLinkUrl: DEEP_LINK_A },
            { showtimeId: SHOWTIME_B, nonce: "nonce_ui41b", deepLinkUrl: DEEP_LINK_B },
          ],
        },
      } as unknown as RankedAnswer,
      groups: [
        {
          theatreId: "th_amc_metreon",
          layoutId: "lay_ui41",
          columns: 20,
          showtimes,
          groupHits: [
            { showtimeIndices: [0], row: 4, startCol: 9 },
            { showtimeIndices: [1], row: 4, startCol: 9 },
          ],
        },
      ] as unknown as ResultGroup[],
      resolved: 2,
      total: 2,
    });
    useSeatfirstStore.setState({
      searchId: "search_ui41",
      movie: "Dune: Part Three",
      scheduleSkeleton: [
        {
          theatreId: "th_amc_metreon",
          showDateTimeLocal: "2026-08-30T19:00",
          formatCode: "STANDARD",
          distanceKm: null,
          rank: 0,
          admitted: true,
          resolved: true,
          showtimeId: SHOWTIME_A,
        },
        {
          theatreId: "th_amc_metreon",
          showDateTimeLocal: "2026-08-30T22:00",
          formatCode: "STANDARD",
          distanceKm: null,
          rank: 1,
          admitted: true,
          resolved: true,
          showtimeId: SHOWTIME_B,
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
function compositeNodes(
  root: TestRenderer.ReactTestInstance,
  props: Record<string, unknown>,
): TestRenderer.ReactTestInstance[] {
  return root.findAllByProps(props).filter((n) => typeof n.type !== "string");
}

/** The enabled/disabled "Go to AMC" CTA(s) scoped to one row's subtree. */
function rowCtas(
  renderer: TestRenderer.ReactTestRenderer,
  showtimeId: string,
): TestRenderer.ReactTestInstance[] {
  const rows = compositeNodes(renderer.root, { testID: `showtime-row-${showtimeId}` });
  expect(rows.length).toBe(1);
  return compositeNodes(rows[0]!, { accessibilityLabel: "Go to AMC" });
}

function pressRowCta(renderer: TestRenderer.ReactTestRenderer, showtimeId: string): void {
  const ctas = rowCtas(renderer, showtimeId);
  expect(ctas.length).toBe(1);
  act(() => {
    (ctas[0]?.props.onPress as () => void)();
  });
}

/** Flush the recheck round-trip (RPC → result store → sheet render → handoff open). */
async function flushRecheck(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {});
}

async function takeRowA(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  mockRecheckShowtime.mockResolvedValue(goneResult());
  pressRowCta(renderer, SHOWTIME_A);
  await flushRecheck();
}

describe("UI41 recovery sheet end to end (ADR 0071 Verification)", () => {
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

  it("AVAILABLE path: confirming spinner, direct openHandoff, zero modals/sheets", async () => {
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
    seedSurface();
    const screenBefore = useSeatfirstStore.getState().screen;
    const renderer = renderSurface();
    pressRowCta(renderer, SHOWTIME_A);
    await flushRecheck();

    // Direct 1-click handoff ran through the real chain to the offer deep link…
    expect(openUrlSpy).toHaveBeenCalledWith(DEEP_LINK_A);
    // …the screen never moved…
    expect(useSeatfirstStore.getState().screen).toBe(screenBefore);
    expect(useSeatfirstStore.getState().recheckingShowtimeId).toBeNull();
    // …and no recovery overlay appeared.
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Those seats were just taken");
  });

  it("GONE path: taken row with disabled CTA and no inline expansion; sheet lists L1 + L4", async () => {
    seedSurface();
    const screenBefore = useSeatfirstStore.getState().screen;
    const renderer = renderSurface();
    await takeRowA(renderer);

    // No auto-handoff on a taken row; the screen never moved.
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(useSeatfirstStore.getState().screen).toBe(screenBefore);
    // The clicked row is marked taken with a disabled CTA…
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Seats just taken");
    const ctas = rowCtas(renderer, SHOWTIME_A);
    expect(ctas.length).toBe(1);
    expect(ctas[0]?.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(ctas[0]?.props.onPress).toBeUndefined();
    // …and does NOT expand inline — the old accordion is gone.
    expect(compositeNodes(renderer.root, { testID: `recovery-panel-${SHOWTIME_A}` }).length).toBe(
      0,
    );
    // The RecoverySheet owns the alternatives now.
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(1);
    expect(str).toContain("Those seats were just taken");
    expect(str).toContain("Closest alternatives for Dune: Part Three");
    expect(compositeNodes(renderer.root, { testID: "recovery-option-1" }).length).toBe(1);
    expect(compositeNodes(renderer.root, { testID: "recovery-option-4" }).length).toBe(1);
    expect(str).toContain("Closest seats nearby");
    expect(str).toContain("A different showtime");
  });

  it("Level 4 consent gate: CTA disabled until checked, re-disabled on uncheck", async () => {
    seedSurface();
    const renderer = renderSurface();
    await takeRowA(renderer);

    const l4 = compositeNodes(renderer.root, { testID: "recovery-option-4" });
    expect(l4.length).toBe(1);
    const l4Button = (): TestRenderer.ReactTestInstance =>
      compositeNodes(l4[0]!, { accessibilityLabel: "Go to AMC" })[0]!;
    expect(l4Button().props.accessibilityState).toEqual({ disabled: true, busy: false });

    // The shared Checkbox carries the label on both its composite node and its
    // inner Pressable — scope to the checkbox-role node (the real tap target).
    const consentCheckbox = (): TestRenderer.ReactTestInstance[] =>
      compositeNodes(renderer.root, { accessibilityLabel: CONSENT_LABEL }).filter(
        (n) => n.props.accessibilityRole === "checkbox",
      );
    const checkbox = consentCheckbox();
    expect(checkbox.length).toBe(1);
    expect(checkbox[0]?.props.accessibilityState).toMatchObject({ checked: false });
    act(() => {
      (checkbox[0]?.props.onPress as () => void)();
    });
    expect(l4Button().props.accessibilityState).toEqual({ disabled: false, busy: false });
    act(() => {
      (consentCheckbox()[0]?.props.onPress as () => void)();
    });
    expect(l4Button().props.accessibilityState).toEqual({ disabled: true, busy: false });
  });

  it("Alternative handoff: Level 1 Go to AMC opens its deep link and closes the sheet", async () => {
    seedSurface();
    const renderer = renderSurface();
    await takeRowA(renderer);

    const l1 = compositeNodes(renderer.root, { testID: "recovery-option-1" });
    expect(l1.length).toBe(1);
    const l1Buttons = compositeNodes(l1[0]!, { accessibilityLabel: "Go to AMC" });
    expect(l1Buttons.length).toBe(1);
    await act(async () => {
      (l1Buttons[0]?.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(mockOpenHandoff).toHaveBeenCalledWith(ALT_URL_1);
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(0);
  });

  it("Back to results dismisses the sheet; the taken row stays marked", async () => {
    seedSurface();
    const renderer = renderSurface();
    await takeRowA(renderer);
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(1);

    const back = compositeNodes(renderer.root, { accessibilityLabel: "Back to results" });
    expect(back.length).toBe(1);
    act(() => {
      (back[0]?.props.onPress as () => void)();
    });
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("Seats just taken");
    const ctas = rowCtas(renderer, SHOWTIME_A);
    expect(ctas[0]?.props.onPress).toBeUndefined();
  });

  it("Backdrop tap dismisses the sheet; the taken row stays marked", async () => {
    seedSurface();
    const renderer = renderSurface();
    await takeRowA(renderer);
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(1);

    const backdrop = compositeNodes(renderer.root, { testID: "recovery-sheet-backdrop" });
    expect(backdrop.length).toBe(1);
    act(() => {
      (backdrop[0]?.props.onPress as () => void)();
    });
    expect(compositeNodes(renderer.root, { testID: "recovery-sheet" }).length).toBe(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("Seats just taken");
  });

  it("Subsequent recheck persistence: a second showtime recheck keeps the first row taken", async () => {
    seedSurface();
    const renderer = renderSurface();
    await takeRowA(renderer);

    // Dismiss the sheet, then recheck the second showtime to AVAILABLE.
    const back = compositeNodes(renderer.root, { accessibilityLabel: "Back to results" });
    act(() => {
      (back[0]?.props.onPress as () => void)();
    });
    mockRecheckShowtime.mockResolvedValue({ status: "AVAILABLE" });
    pressRowCta(renderer, SHOWTIME_B);
    await flushRecheck();

    // The second showtime handed off directly…
    expect(openUrlSpy).toHaveBeenCalledWith(DEEP_LINK_B);
    // …while the first row is still marked taken — never reverted to Hit.
    expect(JSON.stringify(renderer.toJSON())).toContain("Seats just taken");
    expect(rowCtas(renderer, SHOWTIME_A)[0]?.props.onPress).toBeUndefined();
    expect(useSeatfirstStore.getState().takenShowtimeIds).toContain(SHOWTIME_A);
  });
});
