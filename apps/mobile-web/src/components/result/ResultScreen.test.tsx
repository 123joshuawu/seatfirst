import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { ResultScreen } from "./ResultScreen";
import { makeMockVm, setMockVm, type MockViewModel } from "../../../test/mockViewModels";
import { PreferBar } from "./PreferBar";

import type { ResultGroup, ScheduleSkeletonEntry } from "@seatfirst/core";

vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

function mkEntry(
  over: { showtimeId: string } & Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>,
): ScheduleSkeletonEntry {
  return {
    theatreId: "th_amc_metreon",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: over.rank ?? 0,
    admitted: over.admitted ?? true,
    resolved: over.resolved ?? false,
    ...over,
  } as unknown as ScheduleSkeletonEntry;
}

function mkHitGroup(showtimeId: string): ResultGroup {
  return {
    theatreId: "th_amc_metreon",
    layoutId: "lay_1",
    columns: 20,
    rows: 10,
    seatKinds: new Array(200).fill(1),
    seatNames: {},
    seatScores: new Array(200).fill(0),
    showtimes: [{ showtimeId, resolved: true } as unknown as never],
    freeCount: new Array(200).fill(0),
    groupHits: [{ showtimeIndices: [0], row: 4, startCol: 9, rowSpan: 1, runScore: 0 }],
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: "Aud 1",
    attributes: [],
  } as unknown as ResultGroup;
}

function renderScreen(vm: MockViewModel): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create((setMockVm(vm), React.createElement(ResultScreen, null)));
  });
  return JSON.stringify(renderer.toJSON());
}

describe("ResultScreen — terminal ranked list (UI15)", () => {
  it("renders the ranked hit/deferred rows and honestly discloses collapsed misses (UI17.5)", () => {
    const str = renderScreen(
      makeMockVm({
        groups: [mkHitGroup("sh_hit")],
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true }),
          mkEntry({ showtimeId: "sh_miss", rank: 1, admitted: true, resolved: true }),
          mkEntry({ showtimeId: "sh_def", rank: 2, admitted: false, resolved: false }),
        ],
        handoffEligibleShowtimeIds: ["sh_hit"],
        totalShowtimes: 2,
        checkedCount: 2,
        searchStatus: "COMPLETE",
      }),
    );
    const hit = str.indexOf("sh_hit");
    const miss = str.indexOf("sh_miss");
    const def = str.indexOf("sh_def");
    expect(hit).toBeGreaterThan(-1);
    expect(miss).toBe(-1);
    expect(str).toContain("1 didn't fit · show them");
    expect(def).toBeGreaterThan(hit);
    expect(str).toContain("Go to AMC");
    expect(str).toContain("Deferred");
  });

  it("renders the Go to AMC affordance only on hit rows whose offer is in the canonical answer (UI15.5 / UI17.3)", () => {
    const vm = makeMockVm({
      groups: [mkHitGroup("sh_elig"), mkHitGroup("sh_inelig")],
      scheduleSkeleton: [
        mkEntry({ showtimeId: "sh_elig", rank: 0, admitted: true, resolved: true }),
        mkEntry({ showtimeId: "sh_inelig", rank: 1, admitted: true, resolved: true }),
      ],
      handoffEligibleShowtimeIds: ["sh_elig"],
      totalShowtimes: 2,
      checkedCount: 2,
      searchStatus: "COMPLETE",
    });
    const str = renderScreen(vm);
    expect(str).toContain("Confirms seat availability and opens showtime on AMC");
    // One eligible hit => one Go to AMC button; string contains label twice (accessibilityLabel + text) = 2 matches
    const holdCount = (str.match(/Go to AMC/g) ?? []).length;
    expect(holdCount).toBe(2);
    const eligRow = str.indexOf("showtime-row-sh_elig");
    const ineligRow = str.indexOf("showtime-row-sh_inelig");
    const hint = str.indexOf("Confirms seat availability");
    expect(hint).toBeGreaterThan(eligRow);
    expect(ineligRow).toBeGreaterThan(-1);
    expect(hint).toBeLessThan(ineligRow);
  });

  it("renders no placement hero or grouped result cards (UI15.2)", () => {
    const str = renderScreen(
      makeMockVm({
        scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
        answerMode: "CONFIDENT",
      }),
    );
    expect(str).not.toContain("Seatfirst recommends");
    expect(str).not.toContain("Seat location");
    expect(str).not.toContain("No exact match placement matches");
  });

  it("loading stays on the results surface via the row list states (UI15.3)", () => {
    const str = renderScreen(
      makeMockVm({
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_a", rank: 0 }),
          mkEntry({ showtimeId: "sh_b", rank: 1 }),
        ],
        totalShowtimes: 2,
        checkedCount: 0,
      }),
    );
    expect(str).toContain("Checking seats");
  });

  it("renders ProgressBar and phase detail on the results surface while checking (UI15.3)", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        (setMockVm(
          makeMockVm({
            isChecking: true,
            scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
            totalShowtimes: 21,
            checkedCount: 3,
            phaseDetail: "4 together · batched in waves of 20",
          }),
        ),
        React.createElement(ResultScreen, null)),
      );
    });
    const json = renderer.toJSON() as { props?: Record<string, unknown> }[];
    const flat = JSON.stringify(json);
    expect(flat).toContain("progressbar");
    expect(flat).toContain("Checking 3 of 21 showtimes");
    expect(flat).toContain("4 together · batched in waves of 20");
  });

  it("shows Checked when all rows resolved even before terminal (RUNNING 20/20) — E2E all-resolved fix", () => {
    const skeleton = Array.from({ length: 20 }, (_, i) =>
      mkEntry({ showtimeId: `sh_${i}`, rank: i }),
    );
    const str = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: skeleton,
        totalShowtimes: 20,
        checkedCount: 20,
        liveResolved: 20,
        liveTotal: 20,
      }),
    );
    expect(str).toContain("Checked 20 of 20 showtimes");
    expect(str).not.toContain("Checking 20 of 20 showtimes");
    // Incomplete RUNNING still shows the scanning stage copy (UI28), never the terminal copy
    const incomplete = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: skeleton,
        totalShowtimes: 20,
        checkedCount: 12,
      }),
    );
    expect(incomplete).toContain("Scanning seating charts across 20 showtimes…");
    expect(incomplete).not.toContain("Checked 12 of 20");
  });

  it("Check 8 more renders only when terminalCause is BATCH_DEFERRED (UI15.7 / UI17.7)", () => {
    const base = {
      scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
      canCheckMore: true,
      checkedCount: 12,
      totalShowtimes: 20,
    };
    const deferred = renderScreen(makeMockVm({ ...base, terminalCause: "BATCH_DEFERRED" }));
    expect(deferred).toContain("Check 8 more");
    const plainPartial = renderScreen(
      makeMockVm({
        ...base,
        canCheckMore: false,
        terminalCause: "PARTIAL_SCHEDULE",
        terminalStatus: "PARTIAL",
      }),
    );
    expect(plainPartial).not.toContain("Check 8 more");
  });

  it("EMPTY keeps its cause heading and suggestion actions without a card hierarchy (UI15.6)", () => {
    const str = renderScreen(
      makeMockVm({
        answerMode: "EMPTY",
        emptyCauseLabel: "No seats match this window",
        noValidActions: [{ label: "Widen window", onPress: () => {} }],
      }),
    );
    expect(str).toContain("No seats match this window");
    expect(str).toContain("Widen window");
  });

  it("HEDGED keeps its mode note (UI15.6)", () => {
    const str = renderScreen(
      makeMockVm({
        answerMode: "HEDGED",
        scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
      }),
    );
    expect(str).toContain("No exact match");
  });
});

describe("ResultScreen search-progress transparency (UI28)", () => {
  it("PENDING_SCHEDULE shows Finding showtimes for the theatre", () => {
    const str = renderScreen(
      makeMockVm({
        searchStatus: "PENDING_SCHEDULE" as const,
        isChecking: true,
        theaterName: "AMC Metreon",
        scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
        totalShowtimes: 5,
        checkedCount: 0,
      }),
    );
    expect(str).toContain("Finding showtimes for AMC Metreon…");
  });

  it("RUNNING mid-scan shows the scanning stage copy", () => {
    const str = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_a", rank: 0 }),
          mkEntry({ showtimeId: "sh_b", rank: 1 }),
        ],
        totalShowtimes: 21,
        checkedCount: 3,
      }),
    );
    expect(str).toContain("Scanning seating charts across 21 showtimes…");
  });

  it("RUNNING with nothing left to scan shows the evaluating stage copy", () => {
    const str = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: [],
        totalShowtimes: 0,
        checkedCount: 0,
        partySize: 2,
      }),
    );
    expect(str).toContain("Evaluating adjacent seats for party of 2…");
  });

  it("discovery milestone appears once a match exists mid-scan", () => {
    const str = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_hit", rank: 0, admitted: true, resolved: true }),
          mkEntry({ showtimeId: "sh_b", rank: 1, admitted: true, resolved: false }),
        ],
        groups: [mkHitGroup("sh_hit")],
        totalShowtimes: 2,
        checkedCount: 1,
      }),
    );
    expect(str).toContain("Found 1 so far.");
  });

  it("discovery milestone stays hidden while no match exists", () => {
    const str = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isTerminal: false,
        isChecking: true,
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: false }),
          mkEntry({ showtimeId: "sh_b", rank: 1, admitted: true, resolved: false }),
        ],
        groups: [],
        totalShowtimes: 2,
        checkedCount: 1,
      }),
    );
    expect(str).not.toContain("so far.");
  });

  it("theatre chips render only when the search spans more than one theatre", () => {
    const multi = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isChecking: true,
        scheduleSkeleton: [
          mkEntry({
            showtimeId: "sh_a",
            rank: 0,
            theatreId: "th_a" as ScheduleSkeletonEntry["theatreId"],
            resolved: true,
          }),
          mkEntry({
            showtimeId: "sh_b",
            rank: 1,
            theatreId: "th_b" as ScheduleSkeletonEntry["theatreId"],
            resolved: false,
          }),
        ],
        theatreNameById: new Map([
          ["th_a", "AMC Metreon"],
          ["th_b", "Cinemark"],
        ]),
        totalShowtimes: 2,
        checkedCount: 1,
      }),
    );
    expect(multi).toContain("AMC Metreon: 1/1");
    expect(multi).toContain("Cinemark: 0/1");
    expect(multi).toContain("✓");

    const single = renderScreen(
      makeMockVm({
        searchStatus: "RUNNING" as const,
        isChecking: true,
        scheduleSkeleton: [
          mkEntry({
            showtimeId: "sh_a",
            rank: 0,
            theatreId: "th_a" as ScheduleSkeletonEntry["theatreId"],
            resolved: true,
          }),
          mkEntry({
            showtimeId: "sh_b",
            rank: 1,
            theatreId: "th_a" as ScheduleSkeletonEntry["theatreId"],
            resolved: false,
          }),
        ],
        theatreNameById: new Map([["th_a", "AMC Metreon"]]),
        totalShowtimes: 2,
        checkedCount: 1,
      }),
    );
    expect(single).not.toContain("✓");
    expect(single).not.toContain("AMC Metreon: 1/2");
  });
});

describe("ResultScreen UI17 (PreferBar, breadcrumb, reset)", () => {
  it("renders breadcrumb with party, window and format when not Any (UI17.9)", () => {
    const str = renderScreen(
      makeMockVm({
        quickPartyLabel: "3 together",
        quickWindowLabel: "Sat · Evenings",
        quickFormatLabel: "IMAX",
        scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
      }),
    );
    expect(str).toContain("3 together · Sat · Evenings · IMAX");
  });

  it("breadcrumb omits format when Any format (UI17.9)", () => {
    const str = renderScreen(
      makeMockVm({
        quickPartyLabel: "2 together",
        quickWindowLabel: "This weekend · All times",
        quickFormatLabel: "Any format",
        scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
      }),
    );
    expect(str).toContain("2 together · This weekend · All times");
    // Breadcrumb should not include " · Any format" suffix; chip row still contains Any format
    expect(str).not.toContain("2 together · This weekend · All times · Any format");
  });
  it("PreferBar renders once skeleton non-empty and shows caption and format chips (UI17.10)", () => {
    const withSkeleton = renderScreen(
      makeMockVm({
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_a", rank: 0, formatCode: "imax" }),
          mkEntry({ showtimeId: "sh_b", rank: 1, formatCode: "STANDARD" }),
        ],
      }),
    );
    expect(withSkeleton).toContain("PREFER");
    expect(withSkeleton).toContain("re-ranks instantly");
    expect(withSkeleton).not.toContain("0 new calls");
    expect(withSkeleton).toContain("no reload");
    expect(withSkeleton).toContain("Any");
    expect(withSkeleton).toContain("IMAX");
    expect(withSkeleton).toContain("Standard");

    const withoutSkeleton = renderScreen(makeMockVm({ scheduleSkeleton: [] }));
    expect(withoutSkeleton).not.toContain("PREFER");
  });
  it("PreferBar reset on searchId change (UI17.10)", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    const vm1 = makeMockVm({
      searchId: "search_1",
      scheduleSkeleton: [
        mkEntry({ showtimeId: "sh_a", rank: 0, formatCode: "imax" }),
        mkEntry({ showtimeId: "sh_b", rank: 1 }),
      ],
    });
    TestRenderer.act(() => {
      renderer = TestRenderer.create((setMockVm(vm1), React.createElement(ResultScreen, null)));
    });
    const preferBar = renderer.root.findByType(PreferBar);
    const onChange = (preferBar.props as unknown as { onChange: (v: unknown) => void }).onChange;
    TestRenderer.act(() => {
      onChange({ format: "imax", centered: true, aisle: false, avoidFront: false });
    });
    const vm2 = makeMockVm({
      searchId: "search_2",
      scheduleSkeleton: [
        mkEntry({ showtimeId: "sh_a", rank: 0, formatCode: "imax" }),
        mkEntry({ showtimeId: "sh_b", rank: 1 }),
      ],
    });
    TestRenderer.act(() => {
      renderer.update((setMockVm(vm2), React.createElement(ResultScreen, null)));
    });
    const newPreferBar = renderer.root.findByType(PreferBar);
    const newVal = (
      newPreferBar.props as unknown as { value: { format: string; centered: boolean } }
    ).value;
    expect(newVal.format).toBe("any");
    expect(newVal.centered).toBe(false);
  });

  it("PreferBar does not trigger fetch on toggle (UI17.10 zero calls)", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    let renderer!: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        (setMockVm(
          makeMockVm({
            scheduleSkeleton: [mkEntry({ showtimeId: "sh_a", rank: 0 })],
          }),
        ),
        React.createElement(ResultScreen, null)),
      );
    });
    const preferBar = renderer.root.findByType(PreferBar);
    const onChange = (preferBar.props as unknown as { onChange: (v: unknown) => void }).onChange;
    TestRenderer.act(() => {
      onChange({ format: "imax", centered: true, aisle: false, avoidFront: false });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("unpriced hit renders Price unavailable fallback and no Save Search (S59, ADR 0062 §5)", () => {
    const str = renderScreen(
      makeMockVm({
        scheduleSkeleton: [
          mkEntry({ showtimeId: "sh_a", rank: 0, admitted: true, resolved: true }),
        ],
        groups: [mkHitGroup("sh_a")],
        handoffEligibleShowtimeIds: ["sh_a"],
        searchStatus: "COMPLETE",
      }),
    );
    // ADR 0062 §5 lifts ADR 0041 decision 1's $-figure prohibition: priced rows now
    // render a priceLabel badge (see ShowtimeRow.card.test.tsx). This fixture carries
    // no minPrice, so the row renders the "Price unavailable" fallback and must not
    // fabricate a $ figure.
    expect(str).toContain("Price unavailable");
    expect(str).not.toMatch(/\$\d/);
    expect(str.toLowerCase()).not.toContain("save search");
    // breadcrumb etc also no fabricated price
  });
});
