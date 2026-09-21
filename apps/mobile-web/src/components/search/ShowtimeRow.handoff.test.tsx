import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ShowtimeRow } from "./ShowtimeRow";
import type {
  Placement,
  RecoveryOption,
  RecheckResult,
  ResultGroup,
  ScheduleSkeletonEntry,
} from "@seatfirst/core";
import type * as HandoffLib from "@/lib/handoff";

const mockOpenHandoff = vi.fn<(url: string) => Promise<boolean>>();

vi.mock("@/lib/handoff", async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffLib>();
  return { ...actual, openHandoff: (url: string) => mockOpenHandoff(url) };
});

function mkEntry(
  over: { showtimeId: string } & Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>,
): ScheduleSkeletonEntry {
  return {
    theatreId: "th_amc_metreon",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: true,
    resolved: false,
    ...over,
  } as unknown as ScheduleSkeletonEntry;
}

function mkHitGroup(
  showtimeId: string,
  deepLinkUrl = "https://www.amctheatres.com/showtimes/146027740/seats",
): ResultGroup {
  return {
    theatreId: "th_amc_metreon",
    layoutId: "lay_1",
    columns: 20,
    showtimes: [
      {
        showtimeId,
        resolved: true,
        deepLinkUrl,
        showDateTimeUtc: "2026-08-31T02:00:00Z",
        timezone: "America/Los_Angeles",
      },
    ],
    groupHits: [{ showtimeIndices: [0], row: 4, startCol: 9 }],
  } as unknown as ResultGroup;
}

function fakePlacement(overrides: Partial<Placement> = {}): Placement {
  return {
    layoutId: "layout_1",
    row: 6,
    startCol: 7,
    rowSpan: 1,
    count: 4,
    seatNames: ["G8", "G9", "G10", "G11"],
    placementKey: "placement_1",
    ...overrides,
  };
}

const HANDOFF_HINT = "Confirms seat availability and opens showtime on AMC";

function renderRow(props: Parameters<typeof ShowtimeRow>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ShowtimeRow, props));
  });
  return renderer;
}

/**
 * The react-native mock renders each Pressable twice (composite + host with
 * identical props) — composites alone give one instance per logical button.
 */
function compositeButtons(
  renderer: TestRenderer.ReactTestRenderer,
  props: Record<string, unknown>,
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByProps(props).filter((n) => typeof n.type !== "string");
}

describe("ShowtimeRow handoff affordance (UI30.1)", () => {
  it("resolved hit row exposes the Go to AMC control and invokes it with its showtimeId", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
    });
    const controls = renderer.root.findAllByProps({ accessibilityHint: HANDOFF_HINT });
    expect(controls.length).toBeGreaterThanOrEqual(1);
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Go to AMC");
    expect(str).not.toContain("Hold seats");
    expect(str).toContain("Row E, Seats 10-11");
    expect(str).toContain("centered");
    const onPress = controls[0]?.props.onPress as (() => void) | undefined;
    expect(typeof onPress).toBe("function");
    act(() => {
      if (onPress) onPress();
    });
    expect(onHandoff).toHaveBeenCalledWith("sh_hit");
  });

  it("renders a single solid Go to AMC control and the row itself is no longer an interactive toggle", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
    });
    // UI35: PrimaryButton's style is now an interaction-state callback; resolve
    // it in the idle state before reading the normal fill.
    const backgroundsOf = (style: unknown): unknown[] => {
      const resolved =
        typeof style === "function"
          ? (style as (s: { pressed: boolean; hovered?: boolean }) => unknown)({
              pressed: false,
            })
          : style;
      return (Array.isArray(resolved) ? resolved : [resolved])
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => s["backgroundColor"]);
    };
    const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
    expect(buttons.length).toBe(1);
    expect(backgroundsOf(buttons[0]?.props.style)).toContain("#a95e1c");
    // The row no longer has a click-to-expand toggle: the only clickable control is the CTA.
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Expand details" }).length).toBe(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Collapse details" }).length).toBe(0);
  });

  it("miss rows expose no handoff control but keep their miss copy visible", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_miss", rank: 1, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: [],
    });
    expect(renderer.root.findAllByProps({ accessibilityHint: HANDOFF_HINT }).length).toBe(0);
    expect(JSON.stringify(renderer.toJSON())).toContain("No 2 together");
  });

  it("deferred and unresolved rows expose no handoff control", () => {
    const onHandoff = vi.fn();
    const deferred = renderRow({
      entry: mkEntry({ showtimeId: "sh_def", rank: 2, admitted: false, resolved: false }),
      groups: [],
      partySize: 2,
      resolvedCount: 0,
      onHandoff,
    });
    expect(deferred.root.findAllByProps({ accessibilityHint: HANDOFF_HINT }).length).toBe(0);

    const queued = renderRow({
      entry: mkEntry({ showtimeId: "sh_q", rank: 3, admitted: true, resolved: false }),
      groups: [],
      partySize: 2,
      resolvedCount: 0,
      onHandoff,
    });
    expect(queued.root.findAllByProps({ accessibilityHint: HANDOFF_HINT }).length).toBe(0);
  });

  it("no handoff control without an onHandoff handler", () => {
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
    });
    expect(renderer.root.findAllByProps({ accessibilityHint: HANDOFF_HINT }).length).toBe(0);
  });
});

describe("ShowtimeRow inline recheck states (UI30.4/6/7)", () => {
  beforeEach(() => {
    mockOpenHandoff.mockReset().mockResolvedValue(true);
  });

  it("isRechecking renders a disabled Confirming seats button with a spinner", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
      isRechecking: true,
    });
    const buttons = compositeButtons(renderer, { accessibilityLabel: "Confirming seats…" });
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(buttons[0]?.props.onPress).toBeUndefined();
    // The rechecking testID now lives on the single loading button itself…
    expect(
      renderer.root.findAllByProps({ testID: "rechecking-collapsed-sh_hit" }).length,
    ).toBeGreaterThanOrEqual(1);
    // …and the spinner renders inside that button, not as a sibling element.
    expect(
      renderer.root.findAllByProps({ testID: "recheck-spinner-collapsed-sh_hit" }),
    ).toHaveLength(0);
    const spinners = renderer.root
      .findAllByProps({ accessibilityRole: "progressbar" })
      .filter((n) => typeof n.type !== "string");
    expect(spinners.length).toBe(1);
    let ancestor = spinners[0]?.parent;
    let insideButton = false;
    while (ancestor) {
      if (ancestor === buttons[0]) {
        insideButton = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    expect(insideButton).toBe(true);
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it("isOtherRechecking disables the row CTA at reduced opacity", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
      isOtherRechecking: true,
    });
    const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(buttons[0]?.props.onPress).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('"opacity":0.5');
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it("recheckError renders an inline banner with Retry and Dismiss", () => {
    const onHandoff = vi.fn();
    const onClearRecheck = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
      recheckError: "Couldn't re-verify — check your connection and try again",
      onClearRecheck,
    });
    expect(renderer.root.findByProps({ testID: "recheck-error-sh_hit" })).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Couldn't re-verify — check your connection and try again",
    );
    const retry = renderer.root.findByProps({ accessibilityLabel: "Retry" });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(onHandoff).toHaveBeenCalledWith("sh_hit");
    const dismiss = renderer.root.findByProps({ accessibilityLabel: "Dismiss" });
    act(() => {
      (dismiss.props.onPress as () => void)();
    });
    expect(onClearRecheck).toHaveBeenCalledTimes(1);
  });

  it("AVAILABLE result keeps the plain Go to AMC button, wired to open the deep link directly", () => {
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const result: RecheckResult = {
      status: "AVAILABLE",
      placement: fakePlacement(),
      checkedAt: "2026-09-05T12:00:00Z",
    } as unknown as RecheckResult;
    const renderer = renderRow({
      entry,
      groups: [mkHitGroup("sh_hit")],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: ["sh_hit"],
      recheckResult: result,
    });
    // Availability is already stated by the status text elsewhere in the row —
    // no separate success-labeled button, and no duplicate CTA.
    const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
    expect(buttons.length).toBe(1);
    act(() => {
      (buttons[0]?.props.onPress as () => void)();
    });
    expect(mockOpenHandoff).toHaveBeenCalledWith(
      "https://www.amctheatres.com/showtimes/146027740/seats",
    );
    // Clicking it skips straight to the direct open — it must not re-trigger a recheck.
    expect(onHandoff).not.toHaveBeenCalled();
  });

  describe("GONE taken row (UI41: alternatives live in the RecoverySheet, not the row)", () => {
    const altUrl1 = "https://www.amctheatres.com/showtimes/111/seats";
    const altUrl4 = "https://www.amctheatres.com/showtimes/444/seats";
    const goneResult: RecheckResult = {
      status: "GONE",
      recovery: [
        {
          level: 1,
          placement: fakePlacement({ placementKey: "placement_1" }),
          showtimeId: "st_alt1",
          relaxed: [],
          requiresConsent: false,
        },
        {
          level: 4,
          placement: fakePlacement({ placementKey: "placement_4" }),
          showtimeId: "st_alt4",
          relaxed: [{ kind: "LATER_THAN_PREFERRED" }],
          requiresConsent: true,
        },
      ] as unknown as RecoveryOption[],
    } as unknown as RecheckResult;

    function renderGoneRow() {
      const onHandoff = vi.fn();
      const onClearRecheck = vi.fn();
      const entry = mkEntry({ showtimeId: "sh_gone", rank: 0, admitted: true, resolved: true });
      const renderer = renderRow({
        entry,
        groups: [
          mkHitGroup("sh_gone"),
          mkHitGroup("st_alt1", altUrl1),
          mkHitGroup("st_alt4", altUrl4),
        ],
        partySize: 2,
        resolvedCount: 3,
        onHandoff,
        handoffEligible: ["sh_gone"],
        recheckResult: goneResult,
        onClearRecheck,
      });
      return { renderer, onHandoff, onClearRecheck };
    }

    it("marks the row taken with a single disabled CTA and no inline recovery panel", () => {
      const { renderer } = renderGoneRow();
      const str = JSON.stringify(renderer.toJSON());
      expect(str).toContain("Seats just taken");
      expect(renderer.root.findAllByProps({ testID: "recovery-panel-sh_gone" }).length).toBe(0);
      // The taken seats keep one disabled Go to AMC CTA — alternatives live in
      // the RecoverySheet, so the row never renders option buttons inline.
      const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.props.accessibilityState).toEqual({ disabled: true, busy: false });
      expect(buttons[0]?.props.onPress).toBeUndefined();
    });

    it("isTaken alone marks the row taken — no flight-scoped result required", () => {
      const onHandoff = vi.fn();
      const entry = mkEntry({ showtimeId: "sh_taken", rank: 0, admitted: true, resolved: true });
      const renderer = renderRow({
        entry,
        groups: [mkHitGroup("sh_taken")],
        partySize: 2,
        resolvedCount: 1,
        onHandoff,
        handoffEligible: ["sh_taken"],
        isTaken: true,
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Seats just taken");
      const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.props.onPress).toBeUndefined();
      expect(onHandoff).not.toHaveBeenCalled();
    });

    it("renders no consent UI — consent lives in the RecoverySheet", () => {
      const { renderer } = renderGoneRow();
      expect(
        renderer.root.findAllByProps({
          accessibilityLabel: "I understand this is a different showtime and seat",
        }).length,
      ).toBe(0);
    });

    it("never hands off an alternative from the row — the taken CTA is inert", () => {
      const { renderer, onHandoff } = renderGoneRow();
      const buttons = compositeButtons(renderer, { accessibilityLabel: "Go to AMC" });
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.props.onPress).toBeUndefined();
      expect(mockOpenHandoff).not.toHaveBeenCalled();
      expect(onHandoff).not.toHaveBeenCalled();
    });
  });
});
