import { describe, expect, it, beforeEach } from "vitest";
import type { ResultGroup, SearchSpec } from "@seatfirst/core";
import { useSeatfirstStore } from "./seatfirstStore";
import { searchInitialState } from "./searchSlice";
import { searchFormInitialState } from "./searchFormSlice";
import { flowInitialState } from "./flowSlice";
import { bootstrapInitialState } from "./bootstrapSlice";
import { layoutInitialState } from "./layoutSlice";
import { recheckInitialState } from "./recheckSlice";

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

function fakeSpec(tag: string): SearchSpec {
  return {
    specVersion: 2,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: `theatre:${tag}` }] },
    where: { kind: "MOVIE", ids: ["movie:1"] },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
  } as unknown as SearchSpec;
}

function fakeGroup(theatreId: string, showtimeId: string): ResultGroup {
  return {
    theatreId,
    showtimes: [{ showtimeId }],
  } as unknown as ResultGroup;
}

describe("searchSlice in-situ diff-merge (UI31 / ADR 0064)", () => {
  beforeEach(reset);

  it("incrementOperationGeneration returns the new value and persists it, consecutively", () => {
    const store = useSeatfirstStore.getState();
    expect(store.operationGeneration).toBe(0);
    const first = store.incrementOperationGeneration();
    expect(first).toBe(1);
    // The returned value must read back — a stale-callback fence that re-reads
    // the store has to observe the bump this call just made.
    expect(useSeatfirstStore.getState().operationGeneration).toBe(first);
    const second = useSeatfirstStore.getState().incrementOperationGeneration();
    expect(second).toBe(first + 1);
    expect(useSeatfirstStore.getState().operationGeneration).toBe(second);
  });

  it("beginInSituUpdate snapshots ids and a copy of groups (later mutation is not observed)", () => {
    const groups = [fakeGroup("th_1", "sh_1")];
    useSeatfirstStore.getState().beginInSituUpdate(["sh_1", "sh_2"], groups);
    // Mutating the caller's array after the call must not leak into the store:
    // the implementation spreads it, so the snapshot is frozen at call time.
    groups.push(fakeGroup("th_2", "sh_9"));
    const st = useSeatfirstStore.getState();
    expect(st.retainedRowIds).toBeInstanceOf(Set);
    expect([...(st.retainedRowIds as Set<string>)]).toEqual(["sh_1", "sh_2"]);
    expect(st.retainedGroups).toHaveLength(1);
    expect(st.retainedGroups[0]?.theatreId).toBe("th_1");
  });

  it("resolveRetainedRow removes exactly one id and leaves the rest", () => {
    useSeatfirstStore.getState().beginInSituUpdate(["sh_1", "sh_2"], []);
    useSeatfirstStore.getState().resolveRetainedRow("sh_1");
    const retained = useSeatfirstStore.getState().retainedRowIds;
    expect(retained).toBeInstanceOf(Set);
    expect([...(retained as Set<string>)]).toEqual(["sh_2"]);
  });

  it("resolveRetainedRow is a no-op when retainedRowIds is null", () => {
    expect(useSeatfirstStore.getState().retainedRowIds).toBeNull();
    const before = useSeatfirstStore.getState();
    useSeatfirstStore.getState().resolveRetainedRow("sh_ghost");
    const after = useSeatfirstStore.getState();
    expect(after.retainedRowIds).toBeNull();
    // Returning the previous state untouched keeps the field (and store) stable.
    expect(after.retainedRowIds).toBe(before.retainedRowIds);
  });

  it("resolveRetainedRow is a no-op when the id is absent from a non-empty set", () => {
    useSeatfirstStore.getState().beginInSituUpdate(["sh_1"], []);
    const before = useSeatfirstStore.getState().retainedRowIds;
    useSeatfirstStore.getState().resolveRetainedRow("sh_ghost");
    const after = useSeatfirstStore.getState().retainedRowIds;
    expect(after).toBe(before);
    expect([...(after as Set<string>)]).toEqual(["sh_1"]);
  });

  it("resolveRetainedRow does NOT auto-null the set when the last id resolves", () => {
    useSeatfirstStore.getState().beginInSituUpdate(["sh_only"], []);
    useSeatfirstStore.getState().resolveRetainedRow("sh_only");
    const retained = useSeatfirstStore.getState().retainedRowIds;
    // An empty-but-present set still means "update in flight, everything
    // promoted"; null means "no update". Collapsing the two would flip
    // deriveProvenance's PENDING_UPDATE branch back to RESOLVED_CURRENT early.
    expect(retained).not.toBeNull();
    expect(retained).toBeInstanceOf(Set);
    expect((retained as Set<string>).size).toBe(0);
  });

  it("clearRetainedRows clears from a populated starting state", () => {
    useSeatfirstStore.getState().beginInSituUpdate(["sh_1"], [fakeGroup("th_1", "sh_1")]);
    useSeatfirstStore.getState().clearRetainedRows();
    const st = useSeatfirstStore.getState();
    expect(st.retainedRowIds).toBeNull();
    expect(st.retainedGroups).toEqual([]);
  });

  it("clearRetainedRows is idempotent from an already-empty starting state", () => {
    useSeatfirstStore.getState().clearRetainedRows();
    const st = useSeatfirstStore.getState();
    expect(st.retainedRowIds).toBeNull();
    expect(st.retainedGroups).toEqual([]);
  });

  it("resetSearch restores all six diff-merge fields to their initial values", () => {
    const s = useSeatfirstStore.getState();
    s.setServerCoverageSpec(fakeSpec("a"));
    s.setPendingSpec(fakeSpec("b"));
    s.setEffectiveViewSpec(fakeSpec("c"));
    s.incrementOperationGeneration();
    s.incrementOperationGeneration();
    s.beginInSituUpdate(["sh_1"], [fakeGroup("th_1", "sh_1")]);
    // Sanity: every field is actually off-default before the reset.
    const dirty = useSeatfirstStore.getState();
    expect(dirty.serverCoverageSpec).not.toBeNull();
    expect(dirty.pendingSpec).not.toBeNull();
    expect(dirty.effectiveViewSpec).not.toBeNull();
    expect(dirty.operationGeneration).toBe(2);
    expect(dirty.retainedRowIds).not.toBeNull();
    expect(dirty.retainedGroups).toHaveLength(1);

    useSeatfirstStore.getState().resetSearch();

    const st = useSeatfirstStore.getState();
    expect(st.serverCoverageSpec).toEqual(searchInitialState.serverCoverageSpec);
    expect(st.pendingSpec).toEqual(searchInitialState.pendingSpec);
    expect(st.effectiveViewSpec).toEqual(searchInitialState.effectiveViewSpec);
    expect(st.operationGeneration).toBe(searchInitialState.operationGeneration);
    expect(st.retainedRowIds).toBe(searchInitialState.retainedRowIds);
    expect(st.retainedGroups).toEqual(searchInitialState.retainedGroups);
  });
});
