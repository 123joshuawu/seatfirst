import type {
  RankedAnswer,
  ResultGroup,
  ScheduleSkeletonEntry,
  SearchSpec,
  SearchStatus,
} from "@seatfirst/core";
import type { StateCreator } from "zustand";
import type { SeatfirstStore } from "./seatfirstStore";

/**
 * Search lifecycle slice — owns the search session state written by
 * the UI3 lifecycle (create → get → SSE with polling fallback).
 * See docs/tasks/UI3-search-lifecycle-streaming/spec.md UI3.10 and
 * ADR 0025 Decision 2.
 */

export type SearchPhase =
  "idle" | "creating" | "reconciling" | "streaming" | "polling" | "terminal";

export interface SearchError {
  message: string;
  code?: string | undefined;
  searchId?: string | undefined;
  retryAfterSeconds?: number | undefined;
  matchedCount?: number | undefined;
  limit?: number | undefined;
}

export interface SearchState {
  searchId: string | null;
  status: SearchStatus | null;
  resolved: number;
  total: number;
  groups: ResultGroup[];
  answer: RankedAnswer | null;
  error: SearchError | null;
  lastEventId: string | null;
  phase: SearchPhase;
  pendingIdempotencyKey: string | null;
  pendingSpecHash: string | null;
  isCanceling: boolean;
  cancelError: string | null;
  scheduleSkeleton: ScheduleSkeletonEntry[];
  terminalCause: string | null;
  serverCoverageSpec: SearchSpec | null;
  previewPlaceholderCount: number | null;
  estimatedMs: number | null;
  pendingSpec: SearchSpec | null;
  effectiveViewSpec: SearchSpec | null;
  operationGeneration: number;
  retainedRowIds: ReadonlySet<string> | null;
  retainedGroups: ResultGroup[];
}
/** True iff the current search is still in-flight (non-terminal). */
export function isScanRunning(status: SearchStatus | null): boolean {
  return status === "PENDING_SCHEDULE" || status === "RUNNING";
}

/** Alias — UI5 naming prefers isLocked for form controls. */
export const isLockedForStatus = isScanRunning;
export interface SearchActions {
  setSearchCreating: (opts: { pendingKey: string; pendingHash: string }) => void;
  setSearchId: (searchId: string, status: SearchStatus) => void;
  setSearchReconciling: () => void;
  setSearchStreaming: () => void;
  setSearchPolling: () => void;
  setSearchTerminal: (opts: {
    status: SearchStatus;
    answer: RankedAnswer | null;
    groups?: ResultGroup[] | undefined;
    resolved?: number | undefined;
    total?: number | undefined;
    terminalCause?: string | null | undefined;
  }) => void;
  setSearchError: (error: SearchError) => void;
  clearSearchError: () => void;
  setProgress: (opts: {
    resolved: number;
    total: number;
    groups?: ResultGroup[] | undefined;
  }) => void;
  setLastEventId: (id: string) => void;
  setAnswer: (answer: RankedAnswer | null) => void;
  setPendingKey: (key: string, hash: string) => void;
  clearPendingKey: () => void;
  resetSearch: () => void;
  setIsCanceling: (v: boolean) => void;
  setCancelError: (msg: string | null) => void;
  setScheduleSkeleton: (skeleton: ScheduleSkeletonEntry[]) => void;
  patchScheduleSkeleton: (entries: ScheduleSkeletonEntry[]) => void;
  appendScheduleSkeleton: (entries: ScheduleSkeletonEntry[]) => void;
  setTerminalCause: (cause: string | null) => void;
  setServerCoverageSpec: (spec: SearchSpec | null) => void;
  setPreviewPlaceholderCount: (count: number | null) => void;
  setEstimatedMs: (ms: number | null) => void;
  setPendingSpec: (spec: SearchSpec | null) => void;
  setEffectiveViewSpec: (spec: SearchSpec | null) => void;
  // This counter is bumped ONLY by `startSearch` and `cancelSearch` call sites
  // (owned by `useSearchSubscription.ts` and `lib/cancelSearch.ts`, wired in a later
  // sub-step of this same backlog task) — never by pure client-side view-filter edits,
  // because only async round trips need fencing against stale callbacks.
  incrementOperationGeneration: () => number;
  beginInSituUpdate: (retainedIds: readonly string[], retainedGroups: ResultGroup[]) => void;
  resolveRetainedRow: (showtimeId: string) => void;
  clearRetainedRows: () => void;
}
export type SearchSlice = SearchState & SearchActions;

export const searchInitialState: SearchState = {
  searchId: null,
  status: null,
  resolved: 0,
  total: 0,
  groups: [],
  answer: null,
  error: null,
  lastEventId: null,
  phase: "idle",
  pendingIdempotencyKey: null,
  pendingSpecHash: null,
  isCanceling: false,
  cancelError: null,
  scheduleSkeleton: [],
  terminalCause: null,
  serverCoverageSpec: null,
  previewPlaceholderCount: null,
  estimatedMs: null,
  pendingSpec: null,
  effectiveViewSpec: null,
  operationGeneration: 0,
  retainedRowIds: null,
  retainedGroups: [],
};
function markResolvedSkeletonEntries(
  skeleton: ScheduleSkeletonEntry[],
  groups: ResultGroup[] | undefined,
): ScheduleSkeletonEntry[] {
  if (skeleton.length === 0 || groups === undefined || groups.length === 0) return skeleton;

  const resolvedShowtimeIds = new Set<string>();
  for (const group of groups) {
    for (const showtime of group.showtimes) {
      if (showtime.resolved) resolvedShowtimeIds.add(showtime.showtimeId);
    }
  }
  if (resolvedShowtimeIds.size === 0) return skeleton;

  let patched: ScheduleSkeletonEntry[] | undefined;
  for (let index = 0; index < skeleton.length; index += 1) {
    const entry = skeleton[index];
    if (entry !== undefined && !entry.resolved && resolvedShowtimeIds.has(entry.showtimeId)) {
      patched ??= [...skeleton];
      patched[index] = { ...entry, resolved: true };
    }
  }
  return patched ?? skeleton;
}

// The terminal result is authoritative when the final skeleton delta races terminalization.
// Carry resolved group state into the fixed-order skeleton so every row reaches hit or miss.
export const createSearchSlice: StateCreator<SeatfirstStore, [], [], SearchSlice> = (set, get) => ({
  ...searchInitialState,

  setSearchCreating: ({ pendingKey, pendingHash }) =>
    set({
      phase: "creating",
      pendingIdempotencyKey: pendingKey,
      pendingSpecHash: pendingHash,
      error: null,
    }),

  setSearchId: (searchId, status) =>
    set({
      searchId,
      status,
      error: null,
      cancelError: null,
      ...(status === "PENDING_SCHEDULE" || status === "RUNNING"
        ? { screen: "checking" as const }
        : {}),
    }),

  setSearchReconciling: () =>
    set({
      phase: "reconciling",
      error: null,
    }),

  setSearchStreaming: () =>
    set({
      phase: "streaming",
      error: null,
    }),

  setSearchPolling: () =>
    set({
      phase: "polling",
      error: null,
    }),

  setSearchTerminal: ({ status, answer, groups, resolved, total, terminalCause }) =>
    set((prev) => ({
      // CANCELLED returns control to the form so a new search can start
      // (docs/ux-spec-search-initial-experience.md:69, ADR 0025 item 4, ADR 0013).
      // Every CANCELLED transition funnels through here — SSE SEARCH_TERMINAL,
      // polling fallback, reconcile, and searches.cancel via lib/cancelSearch.
      ...(status === "CANCELLED" ? { screen: "search" as const } : {}),
      ...(status === "PARTIAL" ? { screen: "partial" as const } : {}),
      ...(status === "HALTED" ? { screen: "halted" as const } : {}),
      ...(status === "COMPLETE" ? { screen: "result" as const } : {}),
      status,
      answer: answer ?? prev.answer,
      groups: groups ?? prev.groups,
      scheduleSkeleton: markResolvedSkeletonEntries(prev.scheduleSkeleton, groups),
      resolved: resolved ?? prev.resolved,
      total: total ?? prev.total,
      terminalCause: terminalCause !== undefined ? terminalCause : prev.terminalCause,
      phase: "terminal",
      pendingIdempotencyKey: null,
      pendingSpecHash: null,
      isCanceling: false,
      cancelError: null,
    })),

  setSearchError: (error: SearchError) =>
    set({
      error,
      phase: "idle",
      isCanceling: false,
    }),

  clearSearchError: () => set({ error: null }),

  setProgress: ({
    resolved,
    total,
    groups,
  }: {
    resolved: number;
    total: number;
    groups?: ResultGroup[] | undefined;
  }) =>
    set((prev) => ({
      resolved,
      total,
      groups: groups ?? prev.groups,
      scheduleSkeleton: markResolvedSkeletonEntries(prev.scheduleSkeleton, groups ?? prev.groups),
    })),

  setLastEventId: (id: string) => set({ lastEventId: id }),

  setAnswer: (answer: RankedAnswer | null) => set({ answer }),

  setPendingKey: (key: string, hash: string) =>
    set({
      pendingIdempotencyKey: key,
      pendingSpecHash: hash,
    }),

  clearPendingKey: () =>
    set({
      pendingIdempotencyKey: null,
      pendingSpecHash: null,
    }),

  resetSearch: () => set({ ...searchInitialState }),

  setIsCanceling: (v: boolean) => set({ isCanceling: v }),

  setCancelError: (msg: string | null) => set({ cancelError: msg }),

  setScheduleSkeleton: (skeleton: ScheduleSkeletonEntry[]) =>
    set((prev) => ({
      scheduleSkeleton: [...skeleton],
      // Only clear the generic preview placeholder once AUTHORITATIVE non-empty skeleton
      // data has arrived to replace it. An empty array is a valid, expected response while
      // discovery is still cold (t=0) — nulling the placeholder here would blank the loading
      // screen (no skeleton rows, no placeholder rows) until the next update (UI14.8/S46).
      previewPlaceholderCount: skeleton.length > 0 ? null : prev.previewPlaceholderCount,
    })),

  patchScheduleSkeleton: (entries: ScheduleSkeletonEntry[]) =>
    set((prev) => {
      if (entries.length === 0) return prev;
      const patchMap = new Map(entries.map((e) => [e.showtimeId, e]));
      const next = prev.scheduleSkeleton.map((existing) => {
        const patched = patchMap.get(existing.showtimeId);
        return patched ? { ...existing, ...patched } : existing;
      });
      return { scheduleSkeleton: next };
    }),

  appendScheduleSkeleton: (entries: ScheduleSkeletonEntry[]) =>
    set((prev) => {
      if (entries.length === 0) return prev;
      // Dedupe-safe append (ADR 0064 in-situ merge): showtimeIds already present
      // (e.g. a successor search's skeleton re-covering retained rows) are skipped
      // here — overlapping rows patch in place via patchScheduleSkeleton, never
      // duplicate. The BATCH_DEFERRED continuation path carries no overlap, so this
      // is a no-op there, not a behavior change.
      const seen = new Set(prev.scheduleSkeleton.map((e) => e.showtimeId));
      const fresh: ScheduleSkeletonEntry[] = [];
      for (const entry of entries) {
        if (seen.has(entry.showtimeId)) continue;
        seen.add(entry.showtimeId);
        fresh.push(entry);
      }
      if (fresh.length === 0) return prev;
      return {
        scheduleSkeleton: [...prev.scheduleSkeleton, ...fresh],
        // Same guard as before: only non-empty authoritative data replaces the
        // preview placeholder (UI14.12).
        previewPlaceholderCount: null,
      };
    }),

  setTerminalCause: (cause: string | null) => set({ terminalCause: cause }),

  setServerCoverageSpec: (spec: SearchSpec | null) => set({ serverCoverageSpec: spec }),

  setPreviewPlaceholderCount: (count: number | null) => set({ previewPlaceholderCount: count }),
  setEstimatedMs: (ms: number | null) => set({ estimatedMs: ms }),

  setPendingSpec: (spec: SearchSpec | null) => set({ pendingSpec: spec }),
  setEffectiveViewSpec: (spec: SearchSpec | null) => set({ effectiveViewSpec: spec }),

  // This counter is bumped ONLY by `startSearch` and `cancelSearch` call sites
  // (owned by `useSearchSubscription.ts` and `lib/cancelSearch.ts`, wired in a later
  // sub-step of this same backlog task) — never by pure client-side view-filter edits,
  // because only async round trips need fencing against stale callbacks.
  incrementOperationGeneration: () => {
    const next = get().operationGeneration + 1;
    set({ operationGeneration: next });
    return next;
  },

  beginInSituUpdate: (retainedIds: readonly string[], retainedGroups: ResultGroup[]) =>
    set({
      retainedRowIds: new Set(retainedIds),
      retainedGroups: [...retainedGroups],
    }),

  resolveRetainedRow: (showtimeId: string) =>
    set((prev) => {
      if (prev.retainedRowIds === null || !prev.retainedRowIds.has(showtimeId)) return prev;
      const next = new Set(prev.retainedRowIds);
      next.delete(showtimeId);
      return { retainedRowIds: next };
    }),

  clearRetainedRows: () => set({ retainedRowIds: null, retainedGroups: [] }),
});
