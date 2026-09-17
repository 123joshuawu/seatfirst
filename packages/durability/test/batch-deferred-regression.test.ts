import { describe, expect, it } from "vitest";
import { deriveRankedAnswer } from "../src/lifecycle.js";

describe("BATCH_DEFERRED regression", () => {
  it("derives an answer for PARTIAL/BATCH_DEFERRED without throwing", () => {
    const facts = {
      status: "PARTIAL" as const,
      terminalCause: "BATCH_DEFERRED" as const,
      scheduleOutcome: null,
      acceptedFetches: 1,
      freeSeats: 1,
    };
    const evidence = {
      exact: null,
      hedged: null as any,
    };
    const answer = deriveRankedAnswer(facts, evidence);
    expect(answer).not.toBeNull();
    expect(answer!.mode).toBe("EMPTY");
    expect((answer as any).cause).toBe("NO_SHAPE_MATCH");
  });

  it("derives HEDGED for BATCH_DEFERRED when hedged evidence exists", () => {
    const facts = {
      status: "PARTIAL" as const,
      terminalCause: "BATCH_DEFERRED" as const,
      scheduleOutcome: null,
      acceptedFetches: 2,
      freeSeats: 2,
    };
    const hedged = [
      {
        placement: { row: 1, startCol: 1, count: 2 },
        relaxed: [],
      },
      {
        placement: { row: 2, startCol: 1, count: 2 },
        relaxed: [],
      },
    ] as any;
    const evidence = {
      exact: null,
      hedged,
    };
    const answer = deriveRankedAnswer(facts, evidence);
    expect(answer).not.toBeNull();
    expect(answer!.mode).toBe("HEDGED");
  });

  it("derives EMPTY/HALTED for BATCH_DEFERRED when no accepted fetches", () => {
    const facts = {
      status: "PARTIAL" as const,
      terminalCause: "BATCH_DEFERRED" as const,
      scheduleOutcome: null,
      acceptedFetches: 0,
      freeSeats: 0,
    };
    const evidence = {
      exact: null,
      hedged: null as any,
    };
    const answer = deriveRankedAnswer(facts, evidence);
    expect(answer).not.toBeNull();
    expect(answer!.mode).toBe("EMPTY");
    expect((answer as any).cause).toBe("HALTED");
  });
});
