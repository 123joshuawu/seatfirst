import { vi } from "vitest";
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
import { describe, it, expect } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { ResultScreen } from "@/components/result/ResultScreen";
import type { ScheduleSkeletonEntry } from "@seatfirst/core";
import type { MockViewModel } from "./mockViewModels";
import { makeMockVm, setMockVm } from "./mockViewModels";

function mkEntry(
  over: { showtimeId: string } & Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>,
): ScheduleSkeletonEntry {
  const { showtimeId, ...rest } = over as { showtimeId: string } & Record<string, unknown>;
  return {
    actions: {},
    theatreId: "amc:theatre:2325" as unknown as ScheduleSkeletonEntry["theatreId"],
    showDateTimeLocal: "2026-08-26T19:00:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: true,
    resolved: true,
    ...(rest as Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>),
    showtimeId: showtimeId as unknown as ScheduleSkeletonEntry["showtimeId"],
  } as unknown as ScheduleSkeletonEntry;
}

void mkEntry;

function render(vm: MockViewModel): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create((setMockVm(vm), React.createElement(ResultScreen, null)));
  });
  return JSON.stringify(renderer.toJSON());
}

describe("ResultScreen terminal wording — Checking vs Checked", () => {
  it("while checking (non-terminal) renders the scanning stage copy, not the terminal copy", () => {
    const vm = makeMockVm({
      isChecking: true,
      isTerminal: false,
      checkedCount: 3,
      totalShowtimes: 11,
      searchStatus: "RUNNING",
      phase: "streaming",
    });
    const str = render(vm);
    expect(str).toContain("Scanning seating charts across 11 showtimes…");
    expect(str).not.toContain("Checked 3 of 11 showtimes");
  });

  it("after terminal renders 'Checked N of M showtimes' not 'Checking'", () => {
    const vm = makeMockVm({
      isChecking: false,
      isTerminal: true,
      checkedCount: 11,
      totalShowtimes: 11,
      searchStatus: "COMPLETE",
      phase: "terminal",
    });
    const str = render(vm);
    expect(str).toContain("Checked 11 of 11 showtimes");
    expect(str).not.toContain("Checking 11 of 11 showtimes");
  });

  it("terminal indeterminate (total 0) renders 'Checked showtimes' not 'Checking showtimes…'", () => {
    const vm = makeMockVm({
      isChecking: false,
      isTerminal: true,
      checkedCount: 0,
      totalShowtimes: 0,
      searchStatus: "COMPLETE",
      phase: "terminal",
    });
    const str = render(vm);
    expect(str).toContain("Checked showtimes");
    expect(str).not.toContain("Checking showtimes");
  });

  it("terminal with empty skeleton but canonical total 11 still shows progress without inventing rows", () => {
    const vm = makeMockVm({
      isChecking: false,
      isTerminal: true,
      checkedCount: 0,
      totalShowtimes: 11,
      searchStatus: "COMPLETE",
      phase: "terminal",
      scheduleSkeleton: [],
    });
    const str = render(vm);
    // Progress must be visible even with empty skeleton at terminal, preserving canonical total
    expect(str).toContain("Checked 0 of 11 showtimes");
    expect(str).toContain("progressbar");
    // No rows invented — showtime rows are absent but progress communicates terminal state
    expect(str).not.toContain("showtime-row");
  });

  it("terminal with empty skeleton and canonical total 200 displays 200 (only nonterminal suppresses)", () => {
    const vm = makeMockVm({
      isChecking: false,
      isTerminal: true,
      checkedCount: 200,
      totalShowtimes: 200,
      searchStatus: "COMPLETE",
      phase: "terminal",
      scheduleSkeleton: [],
    });
    const str = render(vm);
    expect(str).toContain("Checked 200 of 200 showtimes");
    expect(str).toContain("progressbar");
    expect(str).not.toContain("showtime-row");
  });
});
