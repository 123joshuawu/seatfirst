/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";
import { searchInitialState } from "./searchSlice";
import { searchFormInitialState } from "./searchFormSlice";
import { flowInitialState } from "./flowSlice";
import { bootstrapInitialState } from "./bootstrapSlice";
import { layoutInitialState } from "./layoutSlice";
import { recheckInitialState } from "./recheckSlice";
import type { ScheduleSkeletonEntry, SearchSpec } from "@seatfirst/core";

function reset(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
  });
}

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
  } as ScheduleSkeletonEntry;
}

describe("searchSlice scheduleSkeleton (UI14.8)", () => {
  beforeEach(reset);

  it("setScheduleSkeleton stores entries in given order", () => {
    const a = mkEntry({ showtimeId: "sh_a", rank: 0 });
    const b = mkEntry({ showtimeId: "sh_b", rank: 1 });
    useSeatfirstStore.getState().setScheduleSkeleton([a, b]);
    const s = useSeatfirstStore.getState();
    expect(s.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b"]);
  });

  it("patchScheduleSkeleton updates resolved without reordering (UI14.8 rows never reorder)", () => {
    const a = mkEntry({ showtimeId: "sh_a", rank: 0, resolved: false });
    const b = mkEntry({ showtimeId: "sh_b", rank: 1, resolved: false });
    const c = mkEntry({ showtimeId: "sh_c", rank: 2, resolved: false });
    useSeatfirstStore.getState().setScheduleSkeleton([a, b, c]);
    // Resolve lower-ranked b before a (out-of-order)
    useSeatfirstStore
      .getState()
      .patchScheduleSkeleton([mkEntry({ showtimeId: "sh_b", rank: 1, resolved: true })]);
    const s = useSeatfirstStore.getState();
    expect(s.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c"]);
    expect(s.scheduleSkeleton[1]?.resolved).toBe(true);
    expect(s.scheduleSkeleton[0]?.resolved).toBe(false);
  });

  it("appendScheduleSkeleton adds continuation rows without moving existing (UI14.12)", () => {
    const a = mkEntry({ showtimeId: "sh_a", rank: 0 });
    const b = mkEntry({ showtimeId: "sh_b", rank: 1 });
    useSeatfirstStore.getState().setScheduleSkeleton([a, b]);
    const c = mkEntry({ showtimeId: "sh_c", rank: 2 });
    const d = mkEntry({ showtimeId: "sh_d", rank: 3 });
    useSeatfirstStore.getState().appendScheduleSkeleton([c, d]);
    const s = useSeatfirstStore.getState();
    expect(s.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c", "sh_d"]);
  });

  it("setScheduleSkeleton([]) preserves previewPlaceholderCount while cold (t=0 empty)", () => {
    // previewPlaceholderCount is set by useSubmitSearchViewModel before createSearch
    // returns; an empty skeleton at t=0 must not wipe it (UI14.8/S46).
    useSeatfirstStore.getState().setPreviewPlaceholderCount(6);
    useSeatfirstStore.getState().setScheduleSkeleton([]);
    const s = useSeatfirstStore.getState();
    expect(s.previewPlaceholderCount).toBe(6);
    expect(s.scheduleSkeleton).toEqual([]);
  });

  it("setScheduleSkeleton([...]) clears previewPlaceholderCount once authoritative", () => {
    useSeatfirstStore.getState().setPreviewPlaceholderCount(6);
    useSeatfirstStore.getState().setScheduleSkeleton([mkEntry({ showtimeId: "sh_a", rank: 0 })]);
    const s = useSeatfirstStore.getState();
    expect(s.previewPlaceholderCount).toBeNull();
    expect(s.scheduleSkeleton).toHaveLength(1);
  });

  it("appendScheduleSkeleton([]) preserves previewPlaceholderCount", () => {
    useSeatfirstStore.getState().setPreviewPlaceholderCount(4);
    useSeatfirstStore.getState().appendScheduleSkeleton([]);
    const s = useSeatfirstStore.getState();
    expect(s.previewPlaceholderCount).toBe(4);
    expect(s.scheduleSkeleton).toEqual([]);
  });

  it("appendScheduleSkeleton([...]) clears previewPlaceholderCount", () => {
    useSeatfirstStore.getState().setPreviewPlaceholderCount(4);
    useSeatfirstStore.getState().appendScheduleSkeleton([mkEntry({ showtimeId: "sh_x", rank: 0 })]);
    const s = useSeatfirstStore.getState();
    expect(s.previewPlaceholderCount).toBeNull();
    expect(s.scheduleSkeleton).toHaveLength(1);
  });

  it("setTerminalCause stores BATCH_DEFERRED", () => {
    useSeatfirstStore.getState().setTerminalCause("BATCH_DEFERRED");
    expect(useSeatfirstStore.getState().terminalCause).toBe("BATCH_DEFERRED");
    useSeatfirstStore.getState().setTerminalCause(null);
    expect(useSeatfirstStore.getState().terminalCause).toBeNull();
  });

  it("setServerCoverageSpec stores spec for continuation reuse", () => {
    const spec = { specVersion: 1 } as unknown as SearchSpec;
    useSeatfirstStore.getState().setServerCoverageSpec(spec);
    expect(useSeatfirstStore.getState().serverCoverageSpec).toBe(spec);
  });
});
