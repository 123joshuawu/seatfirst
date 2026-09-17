import { describe, expect, it, beforeEach } from "vitest";
import { useSeatfirstStore } from "./seatfirstStore";
import { isScanRunning, searchInitialState } from "./searchSlice";
import { bootstrapInitialState } from "./bootstrapSlice";
import { flowInitialState } from "./flowSlice";
import { searchFormInitialState } from "./searchFormSlice";

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
  });
}

describe("UI5.1 derived lock flag — isScanRunning / isLocked", () => {
  beforeEach(resetStore);

  it("isScanRunning true for PENDING_SCHEDULE", () => {
    expect(isScanRunning("PENDING_SCHEDULE")).toBe(true);
  });

  it("isScanRunning true for RUNNING", () => {
    expect(isScanRunning("RUNNING")).toBe(true);
  });

  it("isScanRunning false for terminal statuses", () => {
    const terminals = ["COMPLETE", "PARTIAL", "HALTED", "CANCELLED"] as const;
    for (const s of terminals) {
      expect(isScanRunning(s)).toBe(false);
    }
  });

  it("store status drives isLocked via isScanRunning", () => {
    const s = useSeatfirstStore.getState();
    s.setSearchId("srch_1", "PENDING_SCHEDULE");
    expect(isScanRunning(useSeatfirstStore.getState().status)).toBe(true);
    s.setSearchTerminal({ status: "COMPLETE", answer: null });
    expect(isScanRunning(useSeatfirstStore.getState().status)).toBe(false);
    s.setSearchId("srch_2", "RUNNING");
    expect(isScanRunning(useSeatfirstStore.getState().status)).toBe(true);
    s.setSearchTerminal({ status: "CANCELLED", answer: null });
    expect(isScanRunning(useSeatfirstStore.getState().status)).toBe(false);
  });

  it("searchSlice has isCanceling and cancelError with initial false/null", () => {
    const s = useSeatfirstStore.getState();
    expect(s.isCanceling).toBe(false);
    expect(s.cancelError).toBeNull();
  });

  it("setIsCanceling and setCancelError mutate correctly", () => {
    const s = useSeatfirstStore.getState();
    s.setIsCanceling(true);
    expect(useSeatfirstStore.getState().isCanceling).toBe(true);
    s.setCancelError("Cancel failed");
    expect(useSeatfirstStore.getState().cancelError).toBe("Cancel failed");
    s.setCancelError(null);
    expect(useSeatfirstStore.getState().cancelError).toBeNull();
  });

  it("setSearchTerminal clears isCanceling and cancelError", () => {
    const s = useSeatfirstStore.getState();
    s.setIsCanceling(true);
    s.setCancelError("oops");
    s.setSearchTerminal({ status: "CANCELLED", answer: null });
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
    expect(useSeatfirstStore.getState().cancelError).toBeNull();
  });
});
