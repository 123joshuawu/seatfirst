import { beforeEach, describe, expect, it } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import {
  useSearchProgressViewModel,
  type SearchProgressViewModel,
} from "./useSearchProgressViewModel";

function captureVm(): SearchProgressViewModel {
  let captured!: SearchProgressViewModel;
  function Harness(): null {
    captured = useSearchProgressViewModel();
    return null;
  }
  TestRenderer.act(() => {
    TestRenderer.create(React.createElement(Harness));
  });
  return captured;
}

beforeEach(() => {
  useSeatfirstStore.setState({
    searchId: null,
    status: null,
    resolved: 0,
    total: 0,
    scheduleSkeleton: [],
    phase: "idle",
    screen: "search",
    isCanceling: false,
    cancelError: null,
    estimatedMs: null,
  });
});

describe("useSearchProgressViewModel isChecking (UI27 / Rec 2.1)", () => {
  it("is false on the idle form before submit", () => {
    expect(captureVm().isChecking).toBe(false);
  });

  it("is true during the creating phase before the first live status arrives", () => {
    // ADR 0054: tap-to-first-signal window — create is in flight, no liveStatus yet.
    useSeatfirstStore.setState({ status: null, phase: "creating", screen: "search" });
    expect(captureVm().isChecking).toBe(true);
  });

  it("is true while screen is checking even with no live status", () => {
    useSeatfirstStore.setState({ status: null, phase: "streaming", screen: "checking" });
    expect(captureVm().isChecking).toBe(true);
  });

  it("stays true for live PENDING_SCHEDULE / RUNNING statuses (unchanged)", () => {
    useSeatfirstStore.setState({ status: "PENDING_SCHEDULE", phase: "streaming" });
    expect(captureVm().isChecking).toBe(true);
    useSeatfirstStore.setState({ status: "RUNNING", phase: "streaming" });
    expect(captureVm().isChecking).toBe(true);
  });

  it("is false once the search reaches a terminal status", () => {
    useSeatfirstStore.setState({ status: "COMPLETE", phase: "terminal", screen: "result" });
    expect(captureVm().isChecking).toBe(false);
  });
});

describe("useSearchProgressViewModel etaLabel (UI28)", () => {
  it("is null when estimatedMs is null", () => {
    useSeatfirstStore.setState({ status: "RUNNING", phase: "streaming", estimatedMs: null });
    expect(captureVm().etaLabel).toBeNull();
  });

  it("is null when not checking even with estimatedMs set", () => {
    useSeatfirstStore.setState({
      status: "COMPLETE",
      phase: "terminal",
      screen: "result",
      estimatedMs: 20000,
    });
    expect(captureVm().etaLabel).toBeNull();
  });

  it("shows the short-wait bucket at or below 5000ms", () => {
    useSeatfirstStore.setState({ status: "RUNNING", phase: "streaming", estimatedMs: 2000 });
    expect(captureVm().etaLabel).toBe("This may take a few more seconds…");
    useSeatfirstStore.setState({ status: "RUNNING", phase: "streaming", estimatedMs: 5000 });
    expect(captureVm().etaLabel).toBe("This may take a few more seconds…");
  });

  it("shows the larger-search bucket above 5000ms", () => {
    useSeatfirstStore.setState({ status: "RUNNING", phase: "streaming", estimatedMs: 20000 });
    expect(captureVm().etaLabel).toBe("Larger search — this may take a bit…");
  });
});
