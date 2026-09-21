/**
 * Search lifecycle subscription hook.
 * Spec UI3.3–UI3.7: get-before-subscribe, SSE with lastEventId cursor,
 * polling fallback, reconnect reconciliation, and AppState foreground-resume.
 */
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import type {
  PerformancePredicate,
  RankedAnswer,
  ResultGroup,
  ScheduleSkeletonEntry,
  SearchSpec,
  SearchStatus,
} from "@seatfirst/core";
import { specHash } from "@seatfirst/core";
import type { SearchPhase } from "@/store/searchSlice";
import type { GetSearchResult } from "@/api/search";

import { createSearch, getSearch } from "@/api/search";
import { getOrCreatePendingKey } from "@/lib/idempotency";
import { startPolling } from "@/lib/polling";
import { setStopSubscription } from "@/lib/searchSubscriptionController";
import {
  isRecord,
  readProgressCount,
  readRankedAnswer,
  readResultGroups,
  readScheduleSkeleton,
  readSearchStatus,
  readTerminalCause,
  readTrpcErrorCode,
  readTrpcErrorExtras,
} from "@/lib/errorEnvelope";
import { trpcClient } from "@/lib/trpc";
import { useSeatfirstStore } from "@/store/seatfirstStore";
/** Terminal statuses that close the subscription. */
const TERMINAL_STATUSES: ReadonlySet<SearchStatus> = new Set<SearchStatus>([
  "COMPLETE",
  "PARTIAL",
  "HALTED",
  "CANCELLED",
]);

function isTerminalStatus(status: string | null | undefined): status is SearchStatus {
  return typeof status === "string" && (TERMINAL_STATUSES as ReadonlySet<string>).has(status);
}

/**
 * Extract `lastEventId` style string from an envelope or event.
 * The server sends `id: "${seq}-0"` per tracked envelope.
 */
function extractId(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  if (typeof envelope.id === "string" && envelope.id.length > 0) return envelope.id;
  // Some transports unwrap to `data` directly with `seq`
  if (isRecord(envelope.data)) {
    const d = envelope.data;
    if (typeof d.seq === "number" && Number.isInteger(d.seq) && d.seq > 0) {
      return `${d.seq}-0`;
    }
  }
  if (typeof envelope.seq === "number") {
    const seq = envelope.seq;
    if (Number.isInteger(seq) && seq > 0) return `${seq}-0`;
  }
  return null;
}

function extractData(envelope: unknown): unknown {
  if (isRecord(envelope) && "data" in envelope && envelope.data !== undefined) {
    return envelope.data;
  }
  return envelope;
}
function getAppStateModule(): {
  addEventListener: (type: string, handler: (state: string) => void) => { remove: () => void };
} | null {
  if (typeof AppState?.addEventListener === "function")
    return AppState as unknown as {
      addEventListener: (type: string, handler: (state: string) => void) => { remove: () => void };
    };
  return null;
}
/**
 * ADR 0064 subject gate (in-situ retention boundary): row retention is only for
 * refinements of the SAME underlying search subject — party size, dates, format,
 * time band, seat prefs, and theatre add/remove refinements within the same
 * selection. A materially different search (different movie predicate, or a
 * wholesale theatre-set replacement) must take the full-reset branch instead of
 * appending stale rows under the new search.
 */
function collectMovieIds(node: PerformancePredicate, into: Set<string>): void {
  if (node.kind === "MOVIE") {
    for (const id of node.ids) into.add(id);
    return;
  }
  if (node.kind === "AND" || node.kind === "OR") {
    for (const child of node.of) collectMovieIds(child, into);
    return;
  }
  if (node.kind === "NOT") {
    collectMovieIds(node.of, into);
  }
}

function movieIdKey(spec: SearchSpec): string | null {
  const ids = new Set<string>();
  collectMovieIds(spec.where, ids);
  if (ids.size === 0) return null;
  return [...ids].sort().join("\u0000");
}

export function isSameSearchSubject(prev: SearchSpec, next: SearchSpec): boolean {
  if (prev.providerId !== next.providerId) return false;
  // A different movie predicate (not the same movie refined) is a new subject.
  const prevMovie = movieIdKey(prev);
  const nextMovie = movieIdKey(next);
  if (prevMovie === null || nextMovie === null || prevMovie !== nextMovie) return false;
  const prevTheatres = prev.theatres;
  const nextTheatres = next.theatres;
  if (prevTheatres.kind === "LIST" && nextTheatres.kind === "LIST") {
    if (prevTheatres.refs.length === 0 || nextTheatres.refs.length === 0) return false;
    const prevIds = new Set(prevTheatres.refs.map((r) => r.id));
    // Zero overlap is unambiguously a wholesale replacement; any overlap
    // (add/remove within the same selection) is a refinement.
    return nextTheatres.refs.some((r) => prevIds.has(r.id));
  }
  if (prevTheatres.kind === "AREA" && nextTheatres.kind === "AREA") {
    return (
      prevTheatres.center.lat === nextTheatres.center.lat &&
      prevTheatres.center.lng === nextTheatres.center.lng &&
      prevTheatres.radiusKm === nextTheatres.radiusKm &&
      prevTheatres.limit === nextTheatres.limit
    );
  }
  // Mixed AREA↔LIST: the ADR 0064 §4 hand-prune (AREA→LIST after unchecking a
  // discovered theatre) and its inverse broaden-back are refinements within the
  // same area — retain.
  return true;
}

export function useSearchSubscription(): {
  startSearch: (spec: SearchSpec, continuesSearchId?: string) => Promise<void>;
  phase: SearchPhase;
  searchId: string | null;
  stopSubscription: () => void;
} {
  const phase = useSeatfirstStore((s) => s.phase);
  const searchId = useSeatfirstStore((s) => s.searchId);

  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);
  const pollingStopRef = useRef<(() => void) | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const foregroundHandlerRef = useRef<(() => void) | null>(null);

  // Keep lastEventIdRef in sync with store (store is source of truth, ref is for closures)
  const storeLastEventId = useSeatfirstStore((s) => s.lastEventId);
  useEffect(() => {
    lastEventIdRef.current = storeLastEventId;
  }, [storeLastEventId]);

  const cleanupSubscription = useCallback(() => {
    if (subscriptionRef.current) {
      try {
        subscriptionRef.current.unsubscribe();
      } catch {
        // ignore
      }
      subscriptionRef.current = null;
    }
  }, []);

  const cleanupPolling = useCallback(() => {
    if (pollingStopRef.current) {
      pollingStopRef.current();
      pollingStopRef.current = null;
    }
  }, []);

  const cleanupReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    cleanupSubscription();
    cleanupPolling();
    cleanupReconnectTimer();
  }, [cleanupSubscription, cleanupPolling, cleanupReconnectTimer]);

  const stopSubscription = useCallback(() => {
    teardown();
  }, [teardown]);
  // In-situ update (ADR 0064): promote a retained row to RESOLVED_CURRENT as
  // soon as it resolves under the successor search. No-op once the retained
  // set is empty, so double-calling on overlapping paths is harmless.
  const pruneResolvedRetainedRows = useCallback(() => {
    const st = useSeatfirstStore.getState();
    const retained = st.retainedRowIds;
    if (retained === null || retained.size === 0) return;
    for (const entry of st.scheduleSkeleton) {
      if (entry.resolved === true && retained.has(entry.showtimeId)) {
        st.resolveRetainedRow(entry.showtimeId);
      }
    }
  }, []);

  // Register teardown for UI5 cancel orchestration (lib/cancelSearch -> getStopSubscription)
  useEffect(() => {
    setStopSubscription(stopSubscription);
    return () => setStopSubscription(null);
  }, [stopSubscription]);

  // Track mounted to avoid state updates after unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  const handleTerminal = useCallback(
    (opts: {
      status: SearchStatus;
      answer: RankedAnswer | null;
      groups?: ResultGroup[] | undefined;
      resolved?: number | undefined;
      total?: number | undefined;
      terminalCause?: string | null | undefined;
    }) => {
      // Fence stale terminal continuations: a newer startSearch/cancelSearch
      // since this callback was created means its finish() must not run.
      const gen = useSeatfirstStore.getState().operationGeneration;
      const finish = (terminal: {
        status: SearchStatus;
        answer: RankedAnswer | null;
        groups?: ResultGroup[] | undefined;
        resolved?: number | undefined;
        total?: number | undefined;
        terminalCause?: string | null | undefined;
      }): void => {
        if (useSeatfirstStore.getState().operationGeneration !== gen) return;
        useSeatfirstStore.getState().setSearchTerminal(terminal);
        if (terminal.terminalCause !== undefined) {
          useSeatfirstStore.getState().setTerminalCause(terminal.terminalCause ?? null);
        }
        // Successor-search terminal: any still-retained anchor (never resolved
        // under the successor search) falls out of the retained set here.
        if (useSeatfirstStore.getState().retainedRowIds !== null) {
          useSeatfirstStore.getState().clearRetainedRows();
        }
      };

      // SEARCH_TERMINAL events contain only status/cause/answer. Re-read the
      // immutable terminal result before rendering so resolved, total, and groups
      // cannot remain at the last nonterminal aggregate values.
      teardown();
      if (opts.groups !== undefined && opts.resolved !== undefined && opts.total !== undefined) {
        finish(opts);
        return;
      }
      const sid = useSeatfirstStore.getState().searchId;
      if (sid === null) {
        finish(opts);
        return;
      }
      void getSearch(sid)
        .then((result) => {
          if (!isTerminalStatus(result.status)) {
            finish(opts);
            return;
          }
          finish({
            status: result.status,
            answer: result.answer,
            groups: result.groups,
            resolved: result.resolved,
            total: result.total,
            terminalCause:
              (result as { terminalCause?: string | null }).terminalCause ??
              (result as { cause?: string | null }).cause ??
              opts.terminalCause ??
              null,
          });
        })
        .catch(() => {
          // The terminal event is still authoritative if reconciliation is
          // temporarily unavailable. Preserve its status and answer.
          finish(opts);
        });
    },
    [teardown],
  );

  const handleProgressFromResult = useCallback(
    (result: GetSearchResult) => {
      const { status, answer, groups, resolved, total } = result as GetSearchResult & {
        terminalCause?: string | null;
      };
      const terminalCause = (result as { terminalCause?: string | null }).terminalCause ?? null;

      if (isTerminalStatus(status)) {
        handleTerminal({
          status,
          answer,
          groups,
          resolved,
          total,
          terminalCause,
        });
        return;
      }
      // Non-terminal: update progress
      const store = useSeatfirstStore.getState();
      store.setProgress({
        resolved,
        total,
        groups,
      });
      // Also update status and clear terminal cause
      useSeatfirstStore.setState({ status, terminalCause: null });
      pruneResolvedRetainedRows();
    },
    [handleTerminal, pruneResolvedRetainedRows],
  );
  const handleProgressEvent = useCallback(
    (envelope: unknown) => {
      const id = extractId(envelope);
      if (id !== null) {
        lastEventIdRef.current = id;
        useSeatfirstStore.getState().setLastEventId(id);
      }
      const rawData: unknown = extractData(envelope);
      if (!isRecord(rawData)) return;
      const data = rawData;

      // Terminal reveal: type === "SEARCH_TERMINAL" with payload { status, answer }
      if (data.type === "SEARCH_TERMINAL") {
        if (isRecord(data.payload)) {
          const payload = data.payload;
          const rawStatus = readSearchStatus(payload.status);
          const answer = readRankedAnswer(payload.answer);
          const cause = readTerminalCause(payload.cause ?? payload.terminalCause);
          if (isTerminalStatus(rawStatus)) {
            handleTerminal({ status: rawStatus, answer, terminalCause: cause ?? null });
            return;
          }
        }
        // Fallback: data itself may carry status/answer at top level
        const fallbackPayload = isRecord(data.payload) ? data.payload : null;
        const fallbackStatus = readSearchStatus(fallbackPayload?.status);
        if (isTerminalStatus(fallbackStatus)) {
          const cause2 = readTerminalCause(
            fallbackPayload?.cause ?? fallbackPayload?.terminalCause,
          );
          handleTerminal({
            status: fallbackStatus,
            answer: readRankedAnswer(fallbackPayload?.answer),
            terminalCause: cause2 ?? null,
          });
          return;
        }
      }
      // Also handle case where payload itself is the terminal reveal
      const maybeStatus = readSearchStatus(data.status);
      if (isTerminalStatus(maybeStatus) && data.answer !== undefined) {
        const cause = readTerminalCause(data.cause ?? data.terminalCause);
        handleTerminal({
          status: maybeStatus,
          answer: readRankedAnswer(data.answer),
          terminalCause: cause ?? null,
        });
        return;
      }

      // Skeleton event — S46: { type: "skeleton", payload: { scheduleSkeleton: [...] } }
      // Payload may be nested under data.payload or directly on data; handle both.
      const skeletonPayload =
        isRecord(data.payload) && data.payload.scheduleSkeleton !== undefined ? data.payload : data;
      const isSkeletonType =
        data.type === "skeleton" || (isRecord(data.payload) && data.payload.type === "skeleton");
      if (isSkeletonType || skeletonPayload.scheduleSkeleton !== undefined) {
        const sk = readScheduleSkeleton(skeletonPayload.scheduleSkeleton);
        if (sk !== undefined) {
          // Extract resolved/total if co-emitted on same payload (S46.6 re-emission cadence)
          const coResolved = readProgressCount(skeletonPayload.resolved);
          const coTotal = readProgressCount(skeletonPayload.total);
          const coGroups = readResultGroups(skeletonPayload.groups);
          if (coResolved !== undefined || coTotal !== undefined || coGroups !== undefined) {
            const s = useSeatfirstStore.getState();
            s.setProgress({
              resolved: coResolved ?? s.resolved,
              total: coTotal ?? s.total,
              groups: coGroups,
            });
          }
          const store = useSeatfirstStore.getState();
          if (store.scheduleSkeleton.length === 0) {
            store.setScheduleSkeleton(sk);
          } else {
            const existingIds = new Set(store.scheduleSkeleton.map((e) => e.showtimeId));
            const newEntries = sk.filter((e) => !existingIds.has(e.showtimeId));
            const patchEntries = sk.filter((e) => existingIds.has(e.showtimeId));
            if (newEntries.length > 0) store.appendScheduleSkeleton(newEntries);
            if (patchEntries.length > 0) store.patchScheduleSkeleton(patchEntries);
            // If payload was full skeleton with all ids (reconnect wholesale), patch already updated all.
            // If payload contains only new deferred ids (continuation), append handled above.
            // Fallback: if no ids matched at all and store not empty, treat as wholesale replace
            // (e.g., server truth on reconnect that somehow has different ordering)
            if (newEntries.length === 0 && patchEntries.length === 0 && sk.length > 0) {
              store.setScheduleSkeleton(sk);
            }
          }
          // Any skeleton mutation above may have flipped entry.resolved flags —
          // promote newly-resolved retained rows before either early return.
          pruneResolvedRetainedRows();
          // Skeleton event may also carry nothing else — return after handling to avoid double progress
          // but allow fall-through if it also carried progress counts (handled above)
          if (
            sk.length > 0 &&
            coResolved === undefined &&
            coTotal === undefined &&
            coGroups === undefined
          ) {
            return;
          }
          if (sk.length > 0) return;
        }
      }

      // Regular progress: payload may contain resolved/total/groups
      const payload =
        data.payload === null || data.payload === undefined
          ? data
          : isRecord(data.payload)
            ? data.payload
            : null;
      if (payload !== null) {
        const resolved = readProgressCount(payload.resolved);
        const total = readProgressCount(payload.total);
        const groups = readResultGroups(payload.groups);
        if (resolved !== undefined || total !== undefined || groups !== undefined) {
          const store = useSeatfirstStore.getState();
          store.setProgress({
            resolved: resolved ?? store.resolved,
            total: total ?? store.total,
            groups,
          });
          pruneResolvedRetainedRows();
        }
      }
    },
    [handleTerminal, pruneResolvedRetainedRows],
  );

  const openSubscription = useCallback(
    (sid: string, lastEventId: string | null) => {
      // Fence stale SSE callbacks: a poll started under generation N is fenced
      // by N, matching the subscription attempt that spawned it.
      const gen = useSeatfirstStore.getState().operationGeneration;
      const store = useSeatfirstStore.getState();
      store.setSearchStreaming();
      cleanupPolling();

      const input: { searchId: string; lastEventId?: string } = { searchId: sid };
      if (lastEventId !== null) input.lastEventId = lastEventId;

      let hasReceivedData = false;
      const sub = trpcClient.searches.onProgress.subscribe(input, {
        onData: (envelope: unknown) => {
          if (useSeatfirstStore.getState().operationGeneration !== gen) return;
          hasReceivedData = true;
          handleProgressEvent(envelope);
        },
        onError: (err: unknown) => {
          if (useSeatfirstStore.getState().operationGeneration !== gen) return;
          if (!mountedRef.current) return;
          // If we never connected (error before `connected`), fall back to polling
          if (!hasReceivedData) {
            // Check if error is not a terminal client error that should surface
            const code = readTrpcErrorCode(err);
            if (code === "UNAUTHORIZED" || code === "BAD_REQUEST" || code === "NOT_FOUND") {
              const message = err instanceof Error ? err.message : String(err);
              useSeatfirstStore.getState().setSearchError({ message, code });
              teardown();
              return;
            }
            // Polling fallback
            const s = useSeatfirstStore.getState();
            if (!isTerminalStatus(s.status)) {
              s.setSearchPolling();
              pollingStopRef.current = startPolling(sid, {
                onResult: (result) => {
                  if (useSeatfirstStore.getState().operationGeneration !== gen) return;
                  handleProgressFromResult(result);
                },
                onError: (pollErr, exhausted) => {
                  if (useSeatfirstStore.getState().operationGeneration !== gen) return;
                  // Transient poll blips keep retrying silently — only a genuinely
                  // terminal failure (exhausted budget) surfaces store.error.
                  if (!exhausted) return;
                  const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
                  const code = readTrpcErrorCode(pollErr) ?? undefined;
                  useSeatfirstStore.getState().setSearchError({ message: msg, code });
                },
              });
            }
            return;
          }
          // After connected, treat as disconnect — reconnect with get + lastEventId
          void reconcileAndResubscribe(sid);
        },
        onComplete: () => {
          // Server closed stream (terminal). No action — terminal already handled via onData.
        },
      });

      // tRPC subscription returns an object with `unsubscribe`
      subscriptionRef.current = sub;
    },
    [cleanupPolling, handleProgressEvent, handleProgressFromResult, teardown],
  );

  const reconcileAndResubscribe = useCallback(
    async (sid: string) => {
      if (!mountedRef.current) return;
      const store = useSeatfirstStore.getState();
      if (isTerminalStatus(store.status) && store.phase === "terminal") return;
      const gen = useSeatfirstStore.getState().operationGeneration;
      store.setSearchReconciling();
      cleanupSubscription();
      try {
        const result = await getSearch(sid);
        if (useSeatfirstStore.getState().operationGeneration !== gen) return;
        if (!mountedRef.current) return;
        handleProgressFromResult(result);
        const cur = useSeatfirstStore.getState();
        if (isTerminalStatus(cur.status) || cur.phase === "terminal") return;
        // Still non-terminal — resubscribe with current lastEventId
        openSubscription(sid, lastEventIdRef.current);
      } catch (err) {
        if (useSeatfirstStore.getState().operationGeneration !== gen) return;
        if (!mountedRef.current) return;
        const code = readTrpcErrorCode(err);
        if (code === "UNAUTHORIZED" || code === "NOT_FOUND") {
          const message = err instanceof Error ? err.message : String(err);
          useSeatfirstStore.getState().setSearchError({ message, code });
          teardown();
          return;
        }
        // Retry reconciliation briefly, otherwise polling fallback
        // For test determinism, try polling after a short delay if still failing
        const cur = useSeatfirstStore.getState();
        if (!isTerminalStatus(cur.status)) {
          cur.setSearchPolling();
          pollingStopRef.current = startPolling(sid, {
            onResult: (result) => {
              if (useSeatfirstStore.getState().operationGeneration !== gen) return;
              handleProgressFromResult(result);
            },
            onError: (pollErr, exhausted) => {
              if (useSeatfirstStore.getState().operationGeneration !== gen) return;
              // Transient poll blips keep retrying silently — only a genuinely
              // terminal failure (exhausted budget) surfaces store.error.
              if (!exhausted) return;
              const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
              const code = readTrpcErrorCode(pollErr) ?? undefined;
              useSeatfirstStore.getState().setSearchError({ message: msg, code });
            },
          });
        }
      }
    },
    [cleanupSubscription, handleProgressFromResult, openSubscription, teardown],
  );

  const reconcileAndSubscribe = useCallback(
    async (sid: string) => {
      const gen = useSeatfirstStore.getState().operationGeneration;
      const store = useSeatfirstStore.getState();
      store.setSearchReconciling();
      try {
        const result = await getSearch(sid);
        if (useSeatfirstStore.getState().operationGeneration !== gen) return;
        if (!mountedRef.current) return;
        handleProgressFromResult(result);
        const cur = useSeatfirstStore.getState();
        if (isTerminalStatus(result.status) || cur.phase === "terminal") {
          return;
        }
        // Non-terminal — open SSE with current lastEventId (omit on first connect)
        openSubscription(sid, lastEventIdRef.current);
      } catch (err) {
        if (useSeatfirstStore.getState().operationGeneration !== gen) return;
        if (!mountedRef.current) return;
        const code = readTrpcErrorCode(err);
        const message = err instanceof Error ? err.message : String(err);
        // UNAUTHORIZED/BAD_REQUEST are not retried — surface error
        if (code === "UNAUTHORIZED" || code === "BAD_REQUEST" || code === "NOT_FOUND") {
          useSeatfirstStore.getState().setSearchError({ message, code });
          return;
        }
        // For other errors, still propagate error and allow retry via polling
        useSeatfirstStore.getState().setSearchError({ message, code: code ?? undefined });
      }
    },
    [handleProgressFromResult, openSubscription],
  );

  const startSearch = useCallback(
    async (spec: SearchSpec, continuesSearchId?: string) => {
      // This call establishes the new authoritative generation; its own
      // createSearch(...) continuation below is fenced by it.
      const capturedGen = useSeatfirstStore.getState().incrementOperationGeneration();
      const hash = specHash(spec);
      const pendingKey = getOrCreatePendingKey(hash);
      const store = useSeatfirstStore.getState();
      const isContinuationHint =
        typeof continuesSearchId === "string" && continuesSearchId.length > 0;
      // S45/ADR-0037 gate (UI31 fix): the backend only accepts continuesSearchId
      // when the referenced search terminalized with BATCH_DEFERRED. An in-situ
      // diff-merge update submitted while the live search is still RUNNING must
      // NOT chain through that mechanism — ADR 0064 Search B is an independent
      // search with purely client-side retained-row anchors. Gate the forwarded
      // id here, where store.terminalCause is read at call time; the caller's
      // hint stays a plain "logically continues from" search id.
      const forwardedContinuesSearchId =
        typeof continuesSearchId === "string" &&
        continuesSearchId.length > 0 &&
        store.terminalCause === "BATCH_DEFERRED"
          ? continuesSearchId
          : undefined;
      // Client-side diff-merge treatment keys on spec divergence from the active
      // server-covered spec (ADR 0064) — independent of the continuation hint
      // above. Distinct from the checkMore/BATCH_DEFERRED continuation, which
      // resubmits the IDENTICAL spec and keeps working as before.
      const prevCoverageSpec = store.serverCoverageSpec;
      const specChanged =
        prevCoverageSpec !== null && specHash(prevCoverageSpec) !== hash;
      // In-situ retention is only for refinements of the SAME search subject
      // (party size, dates, format, time band, theatre add/remove within the same
      // selection — see isSameSearchSubject). A materially different movie or a
      // wholesale theatre replacement takes the full-reset else-branch below so no
      // stale rows survive under the new search.
      const isUpdate =
        specChanged &&
        prevCoverageSpec !== null &&
        isSameSearchSubject(prevCoverageSpec, spec);
      // Either an in-situ update or a same-spec continuation keeps skeleton/groups
      // as retained anchors and resets only the progress fields (UI14.12); a
      // genuinely fresh search — or a changed spec carrying a stale continuation
      // hint (e.g. a movie switch submitted via "Update search") — resets everything.
      const retainsRows = isUpdate || (isContinuationHint && !specChanged);
      // Rollback bookkeeping for the optimistic in-situ reset below.
      let rollbackProgress: {
        answer: typeof store.answer;
        resolved: number;
        total: number;
        terminalCause: typeof store.terminalCause;
      } | null = null;
      store.setSearchCreating({ pendingKey, pendingHash: hash });
      // Reset prior search state except pending key
      // Continuation keeps skeleton/groups so rows append rather than disappear (UI14.12)
      if (isUpdate) {
        const retainedIds = store.scheduleSkeleton.map((e) => e.showtimeId);
        const retainedGroupsSnapshot = [...store.groups];
        rollbackProgress = {
          answer: store.answer,
          resolved: store.resolved,
          total: store.total,
          terminalCause: store.terminalCause,
        };
        store.beginInSituUpdate(retainedIds, retainedGroupsSnapshot);
      }
      if (retainsRows) {
        useSeatfirstStore.setState({
          lastEventId: null,
          answer: null,
          resolved: 0,
          total: 0,
          terminalCause: null,
        });
      } else {
        useSeatfirstStore.setState({
          lastEventId: null,
          answer: null,
          groups: [],
          resolved: 0,
          total: 0,
          scheduleSkeleton: [],
          terminalCause: null,
          serverCoverageSpec: spec,
          retainedRowIds: null,
          retainedGroups: [],
        });
        // For fresh search, also store spec immediately; continuation overwrites after create
        useSeatfirstStore.getState().setServerCoverageSpec(spec);
      }
      lastEventIdRef.current = null;
      teardown();

      try {
        const res = await createSearch(spec, pendingKey, forwardedContinuesSearchId);
        if (useSeatfirstStore.getState().operationGeneration !== capturedGen) return;
        if (!mountedRef.current) return;
        const sid = res.searchId;
        const status = res.status;
        const s = useSeatfirstStore.getState();
        s.setSearchId(sid, status);
        s.clearPendingKey();
        // Persist spec for continuation reuse (UI14.12 — re-read from store, never re-derive)
        s.setServerCoverageSpec(spec);
        s.setEffectiveViewSpec(spec);
        const skeleton = (res as unknown as { scheduleSkeleton?: ScheduleSkeletonEntry[] })
          .scheduleSkeleton;
        if (Array.isArray(skeleton)) {
          if (retainsRows) {
            // In-situ merge: mirror the SSE skeleton handler's split — showtimes
            // already present patch in place (never duplicate on same-subject
            // updates like party size), while genuinely-new ids (added theatre,
            // deferred tail) append. appendScheduleSkeleton is itself dedupe-safe,
            // so the continuation path below stays a pure append.
            const live = useSeatfirstStore.getState();
            const existingIds = new Set(live.scheduleSkeleton.map((e) => e.showtimeId));
            const newEntries = skeleton.filter((e) => !existingIds.has(e.showtimeId));
            const patchEntries = skeleton.filter((e) => existingIds.has(e.showtimeId));
            if (newEntries.length > 0) s.appendScheduleSkeleton(newEntries);
            if (patchEntries.length > 0) s.patchScheduleSkeleton(patchEntries);
          } else s.setScheduleSkeleton(skeleton);
          // Seed total from skeleton length if server total not yet known
          if (skeleton.length > 0 && s.total === 0) {
            useSeatfirstStore.setState({ total: skeleton.length });
          }
        }
        if (typeof res.estimatedMs === "number") s.setEstimatedMs(res.estimatedMs);
        // get-before-subscribe race fix (ADR 0025 item 3)
        await reconcileAndSubscribe(sid);
      } catch (err) {
        if (useSeatfirstStore.getState().operationGeneration !== capturedGen) return;
        if (!mountedRef.current) return;
        // In-situ update attempt failed: undo the optimistic progress-field
        // reset and discard the retained-row bookkeeping. searchId/status/
        // groups/scheduleSkeleton were never mutated by the continuation reset
        // branch, so Search A's own display data is already intact.
        if (isUpdate && rollbackProgress !== null) {
          useSeatfirstStore.setState({
            answer: rollbackProgress.answer,
            resolved: rollbackProgress.resolved,
            total: rollbackProgress.total,
            terminalCause: rollbackProgress.terminalCause,
          });
          useSeatfirstStore.getState().clearRetainedRows();
        }
        const code = readTrpcErrorCode(err);
        const message = err instanceof Error ? err.message : String(err);
        const extras = readTrpcErrorExtras(err);
        const searchIdFromErr = extras.searchId;
        const retryAfterSeconds = extras.retryAfterSeconds;
        // IDEMPOTENCY_KEY_CONFLICT, ADMISSION_REJECTED, RATE_LIMITED,
        // CAPACITY_CEILING_EXCEEDED, etc.
        useSeatfirstStore.getState().setSearchError({
          message,
          code: code ?? undefined,
          searchId: searchIdFromErr,
          retryAfterSeconds,
          matchedCount: extras.matchedCount,
          limit: extras.limit,
        });
        // If conflict carried a searchId, we could reconcile it
        if (code === "IDEMPOTENCY_KEY_CONFLICT" && typeof searchIdFromErr === "string") {
          try {
            await reconcileAndSubscribe(searchIdFromErr);
          } catch {
            // ignore — error already surfaced
          }
        }
      }
    },
    [reconcileAndSubscribe, teardown],
  );

  // AppState foreground-resume (UI3.7)
  useEffect(() => {
    const mod = getAppStateModule();
    if (mod === null) return;
    let prev = "active";
    if (typeof AppState?.currentState === "string") prev = AppState.currentState;
    const sub = mod.addEventListener("change", (nextState: string) => {
      const wasBackground = prev !== "active";
      prev = nextState;
      if (nextState !== "active" || !wasBackground) return;
      const cur = useSeatfirstStore.getState();
      const sid = cur.searchId;
      const status = cur.status;
      if (sid === null) return;
      if (status !== "PENDING_SCHEDULE" && status !== "RUNNING") return;
      if (cur.phase === "terminal") return;
      void reconcileAndResubscribe(sid);
    });
    foregroundHandlerRef.current = () => sub.remove();
    return () => {
      sub.remove();
      foregroundHandlerRef.current = null;
    };
  }, [reconcileAndResubscribe]);
  // Cleanup on unmount / navigation away
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return { startSearch, phase, searchId, stopSubscription };
}
