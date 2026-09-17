import { describe, expect, it } from "vitest";
import {
  createResultContractSchemas,
  ScheduleSkeletonEntrySchema,
  type SearchStatus,
} from "@seatfirst/core";

import {
  DEV_PROVIDER_HOST_ALLOWLISTS,
  makeConfidentAnswer,
  makeEmptyAnswer,
  makeHedgedAnswer,
  makeHitGroup,
  makeResolvedGroupShowtime,
  makeResultGroup,
  makeScheduleSkeleton,
  makeScheduleSkeletonEntry,
  makeShowtimeOffer,
  makeUnresolvedGroupShowtime,
} from "./contracts";
import { DEV_SCENARIOS } from "./scenarios";

/**
 * The point of this file: fixtures that render in the dev seeder must be the SAME shape
 * the server actually sends. Every builder and every scenario is parsed by the real
 * schemas from `packages/core/src/result-contracts.ts`, so a contract change fails here
 * instead of quietly letting the UI be developed against impossible data.
 */
const contracts = createResultContractSchemas({
  providerHostAllowlists: DEV_PROVIDER_HOST_ALLOWLISTS,
});

const TERMINAL_STATUSES: readonly SearchStatus[] = ["COMPLETE", "PARTIAL", "HALTED", "CANCELLED"];

describe("fixture builders parse against the real result contracts", () => {
  it("builds a valid ShowtimeOffer", () => {
    expect(() => contracts.ShowtimeOfferSchema.parse(makeShowtimeOffer("s1"))).not.toThrow();
  });

  it("builds valid group showtimes in both resolved and unresolved variants", () => {
    expect(() =>
      contracts.GroupShowtimeSchema.parse(makeResolvedGroupShowtime("s1")),
    ).not.toThrow();
    expect(() =>
      contracts.GroupShowtimeSchema.parse(makeUnresolvedGroupShowtime("s2")),
    ).not.toThrow();
  });

  it("builds a valid ResultGroup whose parallel arrays match rows * columns", () => {
    const group = makeResultGroup();
    expect(() => contracts.ResultGroupSchema.parse(group)).not.toThrow();
    const cellCount = group.rows * group.columns;
    expect(group.seatKinds).toHaveLength(cellCount);
    expect(group.seatScores).toHaveLength(cellCount);
    expect(group.freeCount).toHaveLength(cellCount);
    expect(group.freeIn).toHaveLength(cellCount);
  });

  it("builds a multi-showtime ResultGroup whose freeIn indices stay in range", () => {
    const group = makeResultGroup({
      showtimes: [makeResolvedGroupShowtime("s1"), makeResolvedGroupShowtime("s2")],
    });
    expect(() => contracts.ResultGroupSchema.parse(group)).not.toThrow();
  });

  it("builds a valid hit group whose run lands inside the grid", () => {
    expect(() => contracts.ResultGroupSchema.parse(makeHitGroup("s1"))).not.toThrow();
  });

  it("builds valid schedule skeleton entries", () => {
    expect(() => ScheduleSkeletonEntrySchema.parse(makeScheduleSkeletonEntry("s1"))).not.toThrow();
    for (const entry of makeScheduleSkeleton(6, 2)) {
      expect(() => ScheduleSkeletonEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it("builds valid answers in all three modes", () => {
    expect(() => contracts.RankedAnswerSchema.parse(makeConfidentAnswer())).not.toThrow();
    expect(() => contracts.RankedAnswerSchema.parse(makeHedgedAnswer())).not.toThrow();
    expect(() => contracts.RankedAnswerSchema.parse(makeEmptyAnswer("SOLD_OUT"))).not.toThrow();
  });

  it("rejects an invalid override rather than silently accepting it", () => {
    // A deep link off the provider's allowlist must fail — proof the parse is real.
    expect(() =>
      contracts.ShowtimeOfferSchema.parse(
        makeShowtimeOffer("s1", { deepLinkUrl: "https://example.invalid/showtimes/s1" }),
      ),
    ).toThrow();
  });
});

describe("dev scenarios are internally consistent", () => {
  it("has unique ids", () => {
    const ids = DEV_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(DEV_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s produces contract-valid store state",
    (_id, scenario) => {
      const state = scenario.state();

      for (const group of state.groups ?? []) {
        expect(() => contracts.ResultGroupSchema.parse(group)).not.toThrow();
      }
      for (const entry of state.scheduleSkeleton ?? []) {
        expect(() => ScheduleSkeletonEntrySchema.parse(entry)).not.toThrow();
      }

      const resolved = state.resolved ?? 0;
      const total = state.total ?? 0;
      expect(resolved).toBeLessThanOrEqual(total);

      // `RevealPayloadSchema` runs the same status↔answer consistency refinement
      // (ADR 0003 §6, the A8 rule) that `SearchResultSchema` does, so pairing a scenario's
      // status with its answer here catches an impossible combination without this test
      // restating the matrix.
      const status = state.status ?? null;
      const answer = state.answer ?? null;
      if (answer !== null && status !== null && TERMINAL_STATUSES.includes(status)) {
        expect(() =>
          contracts.RevealPayloadSchema.parse({
            status,
            cause: state.terminalCause ?? null,
            answer,
          }),
        ).not.toThrow();
      }
    },
  );
});
