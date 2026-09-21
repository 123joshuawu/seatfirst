/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ShowtimeList, BATCH_SIZE } from "./ShowtimeList";
import type { ScheduleSkeletonEntry, ResultGroup } from "@seatfirst/core";

function mkEntry(
  over: Partial<Omit<ScheduleSkeletonEntry, "showtimeId" | "theatreId">> & {
    showtimeId: string;
    theatreId?: string;
  },
): ScheduleSkeletonEntry {
  return {
    showtimeId: over.showtimeId as unknown as never,
    theatreId: (over.theatreId ?? "th_amc_metreon") as unknown as never,
    showDateTimeLocal: over.showDateTimeLocal ?? "2026-08-30T19:00",
    formatCode: over.formatCode ?? "STANDARD",
    distanceKm: over.distanceKm ?? null,
    rank: over.rank ?? 0,
    admitted: over.admitted ?? true,
    resolved: over.resolved ?? false,
    ...(over.fetchStatus !== undefined ? { fetchStatus: over.fetchStatus } : null),
  } as unknown as ScheduleSkeletonEntry;
}

function mkHitGroup(showtimeId: string, _rank: number, formatCode = "STANDARD"): ResultGroup {
  return {
    theatreId: "th_amc_metreon",
    layoutId: "lay_1",
    distanceKm: null,
    formatCode,
    auditorium: "Auditorium 1",
    attributes: [],
    rows: 10,
    columns: 20,
    seatKinds: new Array(200).fill(1),
    seatNames: {},
    seatScores: new Array(200).fill(0),
    showtimes: [
      {
        showtimeId: showtimeId as unknown as never,
        theatreId: "th_amc_metreon" as unknown as never,
        distanceKm: null,
        showDateTimeUtc: "2026-08-30T19:00:00Z",
        timezone: "America/Los_Angeles",
        minPrice: null,
        status: "AVAILABLE" as unknown as never,
        deepLinkUrl: "https://www.amctheatres.com/showtimes/123",
        capturedAt: new Date().toISOString(),
        staleAfter: new Date(Date.now() + 3600000).toISOString(),
        resolved: true as const,
        openCount: 10,
      } as unknown as ResultGroup["showtimes"][number],
    ],
    freeCount: new Array(200).fill(0),
    freeIn: new Array(200).fill(0).map(() => [0]),
    groupHits: [{ row: 4, startCol: 9, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
  } as unknown as ResultGroup;
}

function renderList(props: Parameters<typeof ShowtimeList>[0]): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ShowtimeList, props));
  });
  return renderer;
}

function renderToString(props: Parameters<typeof ShowtimeList>[0]): string {
  return JSON.stringify(renderList(props).toJSON());
}

describe("ShowtimeList (UI14.8-14.14)", () => {
  it("renders every skeleton entry at t=0 in server rank order (UI14.9)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0 }),
      mkEntry({ showtimeId: "sh_b", rank: 1, theatreId: "th_other" }),
      mkEntry({ showtimeId: "sh_c", rank: 2 }),
    ];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 3,
    });
    const idxA = str.indexOf("sh_a");
    const idxB = str.indexOf("sh_b");
    const idxC = str.indexOf("sh_c");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it("resolves each row's own theatre name from theatreNameById in a multi-theatre search (regression)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, theatreId: "th_amc_metreon" }),
      mkEntry({ showtimeId: "sh_b", rank: 1, theatreId: "th_amc_kabuki" }),
    ];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 2,
      theaterName: "2 theatres",
      theatreNameById: new Map([
        ["th_amc_metreon", "AMC Metreon 16"],
        ["th_amc_kabuki", "AMC Kabuki 8"],
      ]),
    });
    expect(str).toContain("AMC Metreon 16");
    expect(str).toContain("AMC Kabuki 8");
    expect(str).not.toContain("2 theatres");
  });

  it("rows never reorder on resolved flip (UI14 verification 3)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, resolved: false }),
      mkEntry({ showtimeId: "sh_b", rank: 1, resolved: false }),
      mkEntry({ showtimeId: "sh_c", rank: 2, resolved: false }),
    ];
    const flipped = skeleton.map((e) => (e.showtimeId === "sh_c" ? { ...e, resolved: true } : e));
    const str1 = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 3,
    });
    const str2 = renderToString({
      skeleton: flipped,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 3,
    });
    expect(str1.indexOf("sh_a") < str1.indexOf("sh_b")).toBe(true);
    expect(str2.indexOf("sh_a") < str2.indexOf("sh_b")).toBe(true);
    expect(str2.indexOf("sh_b") < str2.indexOf("sh_c")).toBe(true);
  });

  it("Check 2 more renders only when terminalCause BATCH_DEFERRED (UI14.11 / UI17.7)", () => {
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, resolved: true })];
    const withBatch = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 3,
      terminalCause: "BATCH_DEFERRED",
      onCheckMore: vi.fn(),
    });
    expect(withBatch).toContain("Check 2 more");
    expect(withBatch).toContain("2 showtimes in this search are still unchecked");

    const withoutBatch = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 3,
      terminalCause: "PARTIAL_SCHEDULE",
      onCheckMore: vi.fn(),
    });
    expect(withoutBatch).not.toContain("Check 2 more");

    const noCause = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 3,
      terminalCause: null,
      onCheckMore: vi.fn(),
    });
    expect(noCause).not.toContain("Check 2 more");
  });

  it("banner uses BATCH_SIZE constant and shows unchecked count (UI17.7)", () => {
    expect(BATCH_SIZE).toBe(20);
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, resolved: true })];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 5,
      terminalCause: "BATCH_DEFERRED",
      onCheckMore: vi.fn(),
    });
    expect(str).toContain("4 showtimes in this search are still unchecked");
  });

  it("deferred group distinct from miss (admitted false)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: false }),
      mkEntry({ showtimeId: "sh_b", rank: 1, admitted: false, resolved: false }),
    ];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 2,
    });
    expect(str).toContain("Deferred");
  });

  it("failed fetch renders Seating chart unavailable, not Checking seats/Queued (UI28)", () => {
    const str = renderToString({
      skeleton: [
        mkEntry({
          showtimeId: "sh_fail",
          rank: 0,
          admitted: true,
          resolved: false,
          fetchStatus: "FAILED",
        }),
      ],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 1,
    });
    expect(str).toContain("Seating chart unavailable");
    expect(str).not.toContain("Checking seats");
    expect(str).not.toContain("Queued");
  });

  it("nothing fits renders EmptyState when no hits and nothing deferred (UI14.13 / UI38)", () => {
    const skeleton = [
      mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: true }),
      mkEntry({ showtimeId: "sh_b", rank: 1, admitted: true, resolved: true }),
    ];
    const onEditSearch = vi.fn();
    const renderer = renderList({
      skeleton,
      groups: [] as ResultGroup[],
      partySize: 2,
      resolved: 2,
      total: 2,
      terminalCause: null,
      onEditSearch,
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("No showtimes match your criteria");
    expect(str).toContain("None of the checked showtimes had space for your party");
    expect(str).toContain("empty-state-filters");
    const actions = renderer.root.findAll(
      (node) => node.props?.accessibilityLabel === "Edit search",
    );
    expect(actions.length).toBeGreaterThan(0);
    act(() => {
      actions[0]!.props.onPress();
    });
    expect(onEditSearch).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("nothing fits renders no action when onEditSearch is absent (UI38)", () => {
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: true })];
    const renderer = renderList({
      skeleton,
      groups: [] as ResultGroup[],
      partySize: 2,
      resolved: 1,
      total: 1,
      terminalCause: null,
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("No showtimes match your criteria");
    expect(str).toContain("empty-state-filters");
    expect(
      renderer.root.findAll((node) => node.props?.accessibilityRole === "button"),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it("adds no extra affordance beyond the EmptyState action (UI38)", () => {
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: true })];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 1,
      terminalCause: null,
    });
    expect(str).not.toMatch(/Save.*button/i);
  });
});

describe("ShowtimeList UI17 (header, legend, miss disclosure, TOP PICK, PREFER)", () => {
  it("renders EVERY SHOWTIME THAT FITS header and Free/Taken/Your legend once admitted (UI17.6)", () => {
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: false })];
    const str = renderToString({
      skeleton,
      groups: [],
      partySize: 3,
      resolved: 0,
      total: 1,
    });
    expect(str).toContain("EVERY SHOWTIME THAT FITS");
    expect(str).toContain("Free");
    expect(str).toContain("Taken");
    expect(str).toContain("Your 3");

    const emptyStr = renderToString({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
    });
    expect(emptyStr).not.toContain("EVERY SHOWTIME THAT FITS");
  });

  it("miss rows default collapsed when a hit exists and the disclosure reveals and hides them (UI17.5)", () => {
    const shHit = mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true });
    const shMiss1 = mkEntry({ showtimeId: "sh_miss1", rank: 1, admitted: true, resolved: true });
    const shMiss2 = mkEntry({ showtimeId: "sh_miss2", rank: 2, admitted: true, resolved: true });
    const skeleton = [shHit, shMiss1, shMiss2];
    const groups = [mkHitGroup("sh_hit", 0)];
    const renderer = renderList({
      skeleton,
      groups,
      partySize: 2,
      resolved: 3,
      total: 3,
    });
    let str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("sh_hit");
    expect(str).not.toContain("sh_miss1");
    expect(str).not.toContain("sh_miss2");
    expect(str).toContain("2 didn't fit · show them");
    const toggle = renderer.root.findByProps({ testID: "miss-toggle" });
    act(() => {
      (toggle.props.onPress as () => void)();
    });
    str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("sh_miss1");
    expect(str).toContain("sh_miss2");
    expect(str).toContain("Hide the 2 that didn't fit");
    act(() => {
      (toggle.props.onPress as () => void)();
    });
    str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("sh_miss1");
    expect(str).not.toContain("sh_miss2");
  });
  it("when hitCount===0 no collapse and every row visible (UI17.5)", () => {
    const shMiss1 = mkEntry({ showtimeId: "sh_miss1", rank: 0, admitted: true, resolved: true });
    const shMiss2 = mkEntry({ showtimeId: "sh_miss2", rank: 1, admitted: true, resolved: true });
    const str = renderToString({
      skeleton: [shMiss1, shMiss2],
      groups: [],
      partySize: 2,
      resolved: 2,
      total: 2,
    });
    expect(str).toContain("sh_miss1");
    expect(str).toContain("sh_miss2");
    expect(str).not.toContain("didn't fit");
  });

  it("BATCH_DEFERRED banner vs plain PARTIAL (UI17.7)", () => {
    const skeleton = [mkEntry({ showtimeId: "sh_a", rank: 0, resolved: true })];
    const withBanner = renderList({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 3,
      terminalCause: "BATCH_DEFERRED",
      onCheckMore: vi.fn(),
    });
    expect(JSON.stringify(withBanner.toJSON())).toContain("still unchecked");
    expect(JSON.stringify(withBanner.toJSON())).toContain("Check 2 more");
    const banner = withBanner.root.findByProps({ testID: "continuation-banner" });
    expect(banner).toBeDefined();

    const withoutBanner = renderList({
      skeleton,
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 1,
      terminalCause: "PARTIAL_SCHEDULE",
      onCheckMore: vi.fn(),
    });
    expect(JSON.stringify(withoutBanner.toJSON())).not.toContain("still unchecked");
  });

  it("TOP PICK badge on lowest-rank hit row only (UI17.8)", () => {
    const shA = mkEntry({ showtimeId: "sh_a", rank: 5, admitted: true, resolved: true });
    const shB = mkEntry({ showtimeId: "sh_b", rank: 1, admitted: true, resolved: true });
    const shC = mkEntry({ showtimeId: "sh_c", rank: 3, admitted: true, resolved: true });
    const groups = [mkHitGroup("sh_b", 1), mkHitGroup("sh_c", 3), mkHitGroup("sh_a", 5)];
    const str = renderToString({
      skeleton: [shA, shB, shC],
      groups,
      partySize: 2,
      resolved: 3,
      total: 3,
    });
    const topPickCount = (str.match(/TOP PICK/g) ?? []).length;
    expect(topPickCount).toBe(1);
    expect(str).toContain("TOP PICK");
    const noHitStr = renderToString({
      skeleton: [mkEntry({ showtimeId: "sh_x", rank: 0, admitted: true, resolved: true })],
      groups: [],
      partySize: 2,
      resolved: 1,
      total: 1,
    });
    expect(noHitStr).not.toContain("TOP PICK");
  });

  it("PREFER toggles reorder via stable partition and issue zero network requests (UI17.10)", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }) as never);
    const shA = mkEntry({
      showtimeId: "sh_a",
      rank: 0,
      admitted: true,
      resolved: true,
      formatCode: "STANDARD",
    });
    const shB = mkEntry({
      showtimeId: "sh_b",
      rank: 1,
      admitted: true,
      resolved: true,
      formatCode: "imax",
    });
    const shC = mkEntry({
      showtimeId: "sh_c",
      rank: 2,
      admitted: true,
      resolved: true,
      formatCode: "STANDARD",
    });
    const skeleton = [shA, shB, shC];
    const groups = [
      mkHitGroup("sh_a", 0, "STANDARD"),
      mkHitGroup("sh_b", 1, "imax"),
      mkHitGroup("sh_c", 2, "STANDARD"),
    ];
    const str = renderToString({
      skeleton,
      groups,
      partySize: 2,
      resolved: 3,
      total: 3,
      toggles: { format: "imax", centered: false, aisle: false, avoidFront: false },
    });
    const idxB = str.indexOf("sh_b");
    const idxA = str.indexOf("sh_a");
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);

    const str2 = renderToString({
      skeleton,
      groups,
      partySize: 2,
      resolved: 3,
      total: 3,
      toggles: { format: "any", centered: false, aisle: false, avoidFront: false },
    });
    expect(str2.indexOf("sh_a")).toBeLessThan(str2.indexOf("sh_b"));
    expect(str2.indexOf("sh_b")).toBeLessThan(str2.indexOf("sh_c"));

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("ShowtimeList fallback placeholders (UI27 / Rec 2.2)", () => {
  it("renders 4 fallback placeholder rows when skeleton is empty and placeholderCount is null", () => {
    const str = renderToString({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      placeholderCount: null,
    });
    expect(str).toContain("placeholder-skeleton");
    expect(str.match(/placeholder-row/g) ?? []).toHaveLength(4);
  });

  it("renders 4 fallback rows when placeholderCount is omitted (defaults to null)", () => {
    const str = renderToString({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
    });
    expect(str).toContain("placeholder-skeleton");
    expect(str.match(/placeholder-row/g) ?? []).toHaveLength(4);
  });

  it("keeps the explicit-count branch unchanged (N rows for placeholderCount N)", () => {
    const str = renderToString({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      placeholderCount: 3,
    });
    expect(str).toContain("placeholder-skeleton");
    expect(str.match(/placeholder-row/g) ?? []).toHaveLength(3);
  });
});

describe("ShowtimeList halted/terminal zero-result empty state (critical fix)", () => {
  it("renders no skeletons and an enabled Adjust search action when HALTED with zero rows", () => {
    const onEditSearch = vi.fn();
    const renderer = renderList({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      searchStatus: "HALTED",
      terminalCause: "CAPACITY",
      isTerminal: true,
      placeholderCount: 3,
      onEditSearch,
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("Checking seats");
    expect(str).not.toContain("placeholder-row");
    expect(str).not.toContain("placeholder-skeleton");
    // UI38: terminal zero-skeleton branch renders EmptyState copy.
    expect(str).toContain("No showtimes found");
    expect(str).toContain("No AMC theatres within your selected radius");
    expect(str).toContain("empty-state-no-results");
    const actions = renderer.root.findAll(
      (node) => node.props?.accessibilityLabel === "Adjust search",
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.props.disabled).toBe(false);
      expect(action.props.accessibilityState).toMatchObject({ disabled: false });
    }
    act(() => {
      actions[0]!.props.onPress();
    });
    expect(onEditSearch).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("suppresses the null-placeholder fallback rows once terminal", () => {
    const renderer = renderList({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      searchStatus: "HALTED",
      isTerminal: true,
      placeholderCount: null,
      onEditSearch: vi.fn(),
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("Checking seats");
    expect(str).toContain("No showtimes found");
    expect(str).toContain("empty-state-no-results");
    renderer.unmount();
  });

  it("terminal zero-result renders no action when onEditSearch is absent (UI38)", () => {
    const renderer = renderList({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      searchStatus: "HALTED",
      isTerminal: true,
      placeholderCount: null,
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("No showtimes found");
    expect(
      renderer.root.findAll((node) => node.props?.accessibilityRole === "button"),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it("keeps skeletons while non-terminal with zero rows", () => {
    const str = renderToString({
      skeleton: [],
      groups: [],
      partySize: 2,
      resolved: 0,
      total: 0,
      searchStatus: "RUNNING",
      isTerminal: false,
      placeholderCount: 2,
    });
    expect(str).toContain("Checking seats");
  });
});
