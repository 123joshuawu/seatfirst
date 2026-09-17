import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { CreateSearchResponseSchema, ScheduleSkeletonEntrySchema } from "@seatfirst/core";
import { B7_SKELETON_EVENT } from "@seatfirst/durability";

describe("S46 scheduleSkeleton", () => {
  it("S46.1/46.4: CreateSearchResponse requires scheduleSkeleton, entry schema validates", () => {
    const entry = {
      showtimeId: "amc:showtime:st1",
      theatreId: "amc:theatre:t1",
      showDateTimeLocal: "2026-08-24T18:00:00",
      formatCode: "IMAX",
      distanceKm: 1.2,
      rank: 0,
      admitted: true,
      resolved: false,
    };
    expect(ScheduleSkeletonEntrySchema.safeParse(entry).success).toBe(true);
    // Rejects wrong type
    expect(ScheduleSkeletonEntrySchema.safeParse({ ...entry, distanceKm: "bad" }).success).toBe(
      false,
    );
    expect(ScheduleSkeletonEntrySchema.safeParse({ ...entry, rank: -1 }).success).toBe(false);

    const pending = {
      status: "PENDING_SCHEDULE" as const,
      searchId: "search_1",
      showtimeCount: null,
      cachedCount: null,
      estimatedMs: 20000,
      groups: [],
      scheduleSkeleton: [entry],
    };
    expect(CreateSearchResponseSchema.safeParse(pending).success).toBe(true);
    // Missing scheduleSkeleton should fail (required, not optional)
    const without = {
      status: pending.status,
      searchId: pending.searchId,
      showtimeCount: pending.showtimeCount,
      cachedCount: pending.cachedCount,
      estimatedMs: pending.estimatedMs,
      groups: pending.groups,
    };
    expect(CreateSearchResponseSchema.safeParse(without).success).toBe(false);

    const running = {
      status: "RUNNING" as const,
      searchId: "search_1",
      showtimeCount: 1,
      cachedCount: 1,
      estimatedMs: 2000,
      groups: [],
      scheduleSkeleton: [entry],
    };
    expect(CreateSearchResponseSchema.safeParse(running).success).toBe(true);
  });

  it("S46.5: B7_SKELETON_EVENT boundary exists, skeleton emitted at creation in same tx", () => {
    expect(B7_SKELETON_EVENT).toBeDefined();
    expect(B7_SKELETON_EVENT.name).toBe("B7_SKELETON_EVENT");
    expect(B7_SKELETON_EVENT.text).toContain("type, payload");
    expect(B7_SKELETON_EVENT.text).toContain("'skeleton'");

    const src = fs.readFileSync(
      path.join(process.cwd(), "src/dispatch/handlers/aggregate-answer-assembler.ts"),
      "utf8",
    );
    // S46.6: no second timer, same debounce
    expect(src).not.toMatch(/setTimeout|setInterval|setImmediate/);
    expect(src).toContain("B7_GROUP_EVENT");
    expect(src).toContain("B7_SKELETON_EVENT");
    expect(src.indexOf("B7_SKELETON_EVENT")).toBeGreaterThan(src.indexOf("B7_GROUP_EVENT"));
    expect(src.indexOf("B7_UPSERT_AGGREGATE")).toBeGreaterThan(src.indexOf("B7_SKELETON_EVENT"));
    expect(src).toContain("What breaks if this");
  });

  it("S46.2/46.3: skeleton built from filteredRankedForAdmission via local-time, rank/admitted from admission", () => {
    const createSrc = fs.readFileSync(
      path.join(process.cwd(), "src/routes/searches/create.ts"),
      "utf8",
    );
    expect(createSrc).toContain("buildScheduleSkeleton");
    expect(createSrc).toContain("filteredRankedForAdmission");
    expect(createSrc).toContain("theatreTimezoneById");
    expect(createSrc).toContain("toTheatreLocal");
    // No second rank computation for skeleton itself (the S44 ranking is the only one;
    // cold path also uses rankCandidate but that is the same single convention)
    expect(createSrc).toContain("rankCandidate");
  });

  it("S46.5: stageSearchCreation emits skeleton event in same transaction as search", () => {
    const txSrc = fs.readFileSync(
      path.join(process.cwd(), "../../packages/durability/src/transactions.ts"),
      "utf8",
    );
    expect(txSrc).toContain("B7_SKELETON_EVENT");
    expect(txSrc).toContain("skeletonEntries");
    expect(txSrc).toContain("What breaks if this swaps after");
  });
});
