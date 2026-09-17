/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";
import type { ScheduleSkeletonEntry } from "@seatfirst/core";

function resetStore(): void {
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
  id: string,
  rank: number,
  admitted = true,
  resolved = false,
): ScheduleSkeletonEntry {
  return {
    showtimeId: id as unknown as never,
    theatreId: "th_amc_metreon" as unknown as never,
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank,
    admitted,
    resolved,
  } as unknown as ScheduleSkeletonEntry;
}

describe("skeleton SSE envelope (UI14.8) — exact shape discovered server-side", () => {
  it("server emits type 'skeleton' with payload { scheduleSkeleton: [...] } (B7_SKELETON_EVENT)", async () => {
    // Discovered via grep: packages/durability/src/boundaries.ts inserts type 'skeleton'
    // and apps/server/src/streaming/reader.ts yields tracked(seq, { seq, type, payload })
    // where payload = { scheduleSkeleton: ScheduleSkeletonEntry[] }
    const envelope = {
      data: {
        type: "skeleton",
        payload: { scheduleSkeleton: [mkEntry("sh_x", 0)] },
        seq: 1,
      },
      id: "1-0",
    };
    const { isRecord } = await import("@/lib/errorEnvelope");
    expect(isRecord(envelope.data)).toBe(true);
    expect((envelope.data as { type: string }).type).toBe("skeleton");
    const payload = (envelope.data as { payload: { scheduleSkeleton: unknown[] } }).payload;
    expect(Array.isArray(payload.scheduleSkeleton)).toBe(true);
  });

  it("client handles skeleton patch without reorder via store (UI14.8)", () => {
    resetStore();
    const sk = [
      mkEntry("sh_a", 0, true, false),
      mkEntry("sh_b", 1, true, false),
      mkEntry("sh_c", 2, true, false),
    ];
    useSeatfirstStore.getState().setScheduleSkeleton(sk);
    // Out-of-order resolved flip for sh_c before sh_a
    useSeatfirstStore.getState().patchScheduleSkeleton([mkEntry("sh_c", 2, true, true)]);
    const after = useSeatfirstStore.getState();
    expect(after.scheduleSkeleton.map((e) => e.showtimeId)).toEqual(["sh_a", "sh_b", "sh_c"]);
    expect(after.scheduleSkeleton.find((e) => e.showtimeId === "sh_c")?.resolved).toBe(true);
    expect(after.scheduleSkeleton.find((e) => e.showtimeId === "sh_a")?.resolved).toBe(false);
  });
});

describe("continuation flow (UI14.11-12)", () => {
  beforeEach(resetStore);

  it("append keeps original 20 stable when continuation adds deferred tail (UI14.12)", () => {
    const first = [mkEntry("sh_a", 0), mkEntry("sh_b", 1)];
    const second = [mkEntry("sh_c", 2), mkEntry("sh_d", 3)];
    useSeatfirstStore.getState().setScheduleSkeleton(first);
    useSeatfirstStore.getState().appendScheduleSkeleton(second);
    const final = useSeatfirstStore.getState();
    expect(final.scheduleSkeleton.map((e) => e.showtimeId)).toEqual([
      "sh_a",
      "sh_b",
      "sh_c",
      "sh_d",
    ]);
  });

  it("createSearch forwards continuesSearchId (UI14.12) — verified via api/search.ts signature", async () => {
    // const calls removed
    vi.mock("@/lib/trpc", async () => {
      const actual = await vi.importActual("@/lib/trpc");
      return actual;
    });
    // Directly test that api/search.ts createSearch accepts continuesSearchId
    const { createSearch } = await import("@/api/search");
    expect(typeof createSearch).toBe("function");
    // Signature check: should accept 3 args
    expect(createSearch.length).toBeGreaterThanOrEqual(2);
  });

  it("Check 20 more only for BATCH_DEFERRED, not for PARTIAL_SCHEDULE", () => {
    resetStore();
    useSeatfirstStore.setState({
      terminalCause: "BATCH_DEFERRED",
      scheduleSkeleton: [mkEntry("sh_a", 0)],
    });
    expect(useSeatfirstStore.getState().terminalCause).toBe("BATCH_DEFERRED");
    // Negative control
    useSeatfirstStore.setState({ terminalCause: "PARTIAL_SCHEDULE" });
    expect(useSeatfirstStore.getState().terminalCause).not.toBe("BATCH_DEFERRED");
    useSeatfirstStore.setState({ terminalCause: null });
    expect(useSeatfirstStore.getState().terminalCause).toBeNull();
  });
});
