import { useCallback, useEffect } from "react";
import type {
  EmptyCause,
  Placement,
  RankedAnswer,
  RecheckResult,
  RecommendationReason,
  ResultGroup,
  SearchStatus,
  ScheduleSkeletonEntry,
} from "@seatfirst/core";
import type { LabeledAction } from "@/types/ui";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { useSearchSubscription } from "../useSearchSubscription";
import { clearTheatreMovieCache } from "../useTheatreMovieSet";
import {
  emptyCauseLabel,
  haltedBannerLabel,
  otherFormatsLabelForAnswer,
  partialBannerLabel,
  recheckErrorLabel,
  resolveHandoffTarget,
  suggestionLabel,
  unavailableCauseLabel,
} from "@/lib/presentation";
import {
  closeHandoffWindow,
  completeHandoffWithPopup,
  preopenHandoffWindow,
  resolveDeepLinkForShowtime,
  type HandoffPopupWindow,
} from "@/lib/handoff";

export const SHOW_PLAYING_HERE_LABEL = "Show what's playing here";

/**
 * UI42.9 (ADR 0100 §5 "Automated Discovery on NO_SCHEDULE_MATCH"): the spec
 * names the trigger outcome `EMPTY: NO_SCHEDULE_MATCH`, but no such member
 * exists on the wire — `EmptyCauseSchema` (core result-contracts.ts) and
 * durability's `deriveRankedAnswer` have no NO_SCHEDULE_MATCH variant, and the
 * S63 server emits nothing new here. A cold title search whose
 * SCHEDULE_RESOLUTION completes with empty schedules terminalizes as
 * `EMPTY: TOO_FEW_SHOWTIMES` (COMPLETE + EMPTY_RESOLVED schedule outcome), so
 * that is the outcome that drives the "Show what's playing here" flow.
 */
const NO_SCHEDULE_MATCH_WIRE_CAUSE: EmptyCause = "TOO_FEW_SHOWTIMES";

function isNoScheduleMatchOutcome(cause: EmptyCause): boolean {
  return cause === NO_SCHEDULE_MATCH_WIRE_CAUSE;
}

export type RowProvenance = "RESOLVED_CURRENT" | "RETAINED_DISPLAY_ONLY" | "PENDING_UPDATE";
export interface DisplayShowtimeRow {
  readonly showtimeId: string;
  readonly provenance: RowProvenance;
  readonly entry: ScheduleSkeletonEntry;
  readonly group?: ResultGroup;
  readonly isTopPick?: boolean;
  readonly canHandoff: boolean;
}

function deriveProvenance(
  showtimeId: string,
  resolved: boolean,
  retainedRowIds: ReadonlySet<string> | null,
): RowProvenance {
  if (retainedRowIds?.has(showtimeId)) return "RETAINED_DISPLAY_ONLY";
  if (retainedRowIds !== null && !resolved) return "PENDING_UPDATE";
  return "RESOLVED_CURRENT";
}

export interface SearchResultsViewModel {
  answer: RankedAnswer | null;
  answerMode: RankedAnswer["mode"] | null;
  groups: ResultGroup[];
  searchStatus: SearchStatus | null;
  terminalStatus: "PARTIAL" | "HALTED" | null;
  isTerminal: boolean;
  otherFormatsLabel: string | null;
  emptyCause: EmptyCause | null;
  emptyCauseLabel: string | null;
  terminalBannerLabel: string | null;
  liveResolved: number;
  liveTotal: number;
  scheduleSkeleton: ScheduleSkeletonEntry[];
  previewPlaceholderCount?: number | null;
  terminalCause: string | null;
  partySize: number;
  canCheckMore: boolean;
  handoffEligibleShowtimeIds: string[];
  /** This fix: canonical answer-level placement per showtimeId for DISPLAY. For
   *  every showtime covered by the ranked answer this carries the answer's own
   *  `Recommendation.placement` + `reasons` — the exact placement bound to the
   *  real nonce/recheck/deep-link — so rows never render a possibly-stale
   *  retained group's own top `groupHits[0]` pick instead (ADR 0064 in-situ
   *  merge keeps predecessor groups in `groups` for visual continuity, and
   *  `findGroupForShowtime` can resolve to one of those for a showtime whose
   *  own group snapshot is no longer live). Plain object keyed by showtimeId,
   *  not a Map, for simple prop-passing/serialization down to `ShowtimeRow`. */
  answerPlacementByShowtimeId: Record<
    string,
    { placement: Placement; reasons: RecommendationReason[] }
  >;
  noValidActions: LabeledAction[];
  /** UI30 (ADR 0063 §2-3): showtime with a recheck in flight, if any. Drives inline row states. */
  recheckingShowtimeId: string | null;
  /** Showtime the latest recheck result/error belongs to (stays set after flight ends). */
  recheckTargetShowtimeId: string | null;
  recheckResult: RecheckResult | null;
  /** Row-ready inline error copy (canonical `unavailableCauseLabel`/`recheckErrorLabel`), if any. */
  recheckInlineError: string | null;
  /** UI31 (ADR 0064): per-showtime provenance for the in-situ diff-merge window. */
  provenanceByShowtimeId: Map<string, RowProvenance>;
  /** UI31 (ADR 0064): skeleton-derived display rows with provenance + handoff gating. */
  displayRows: DisplayShowtimeRow[];
  actions: {
    backToSearch: () => void;
    changeFormat: () => void;
    widenWindow: () => void;
    seeOtherOptions: () => void;
    restart: () => void;
    startHandoff: (showtimeId: string) => void;
    checkMore: () => void;
    clearRecheck: () => void;
  };
}

function screenForTerminalStatus(status: SearchStatus | null): string | null {
  switch (status) {
    case "PARTIAL":
      return "partial";
    case "HALTED":
      return "halted";
    case "CANCELLED":
    case null:
    case "PENDING_SCHEDULE":
    case "RUNNING":
    case "COMPLETE":
      return null;
  }
}

export function useSearchResultsViewModel(): SearchResultsViewModel {
  const store = useSeatfirstStore();
  const {
    backToSearch,
    changeFormat,
    widenWindow,
    showPlayingHere,
    seeOtherOptions,
    restart,
    partySize,
    clearRecheck,
    setFormCollapsed,
  } = store;

  const liveAnswer = store.answer;
  const liveGroups = store.groups;
  const liveStatus = store.status;
  const liveResolved = store.resolved;
  const liveTotal = store.total;

  const answerMode = liveAnswer?.mode ?? null;
  const otherFormatsLabel = otherFormatsLabelForAnswer(liveAnswer);

  let terminalStatus: "PARTIAL" | "HALTED" | null = null;
  let terminalBannerLabel: string | null = null;
  let isTerminal = false;
  const terminalScreen = screenForTerminalStatus(liveStatus);
  if (terminalScreen !== null) {
    terminalStatus = liveStatus as "PARTIAL" | "HALTED";
    isTerminal = true;
    if (liveStatus === "PARTIAL") {
      terminalBannerLabel = partialBannerLabel(liveResolved, liveTotal);
    } else if (liveStatus === "HALTED") {
      const cause: EmptyCause = liveAnswer?.mode === "EMPTY" ? liveAnswer.cause : "HALTED";
      terminalBannerLabel = haltedBannerLabel(cause);
    }
  } else if (liveStatus === "COMPLETE") {
    isTerminal = true;
  } else if (liveStatus === "PENDING_SCHEDULE" || liveStatus === "RUNNING") {
    isTerminal = false;
  }

  let noValidActions: LabeledAction[] = [];
  let emptyCause: EmptyCause | null = null;
  let emptyCauseLabelStr: string | null = null;

  // UI15.6: an EMPTY answer means "no valid placement" regardless of whether any
  // groups were ever evaluated — a HALTED/CAPACITY cause can fire before a single
  // showtime resolves into a group, so this must not require liveGroups.length > 0
  // (that gate silently dropped the cause heading and suggestions to the generic
  // ResultScreen fallback whenever a search halted with zero groups discovered).
  if (liveAnswer !== null) {
    if (liveAnswer.mode === "EMPTY") {
      emptyCause = liveAnswer.cause;
      emptyCauseLabelStr = emptyCauseLabel(liveAnswer.cause);
      noValidActions = liveAnswer.suggestions.map((s) => ({
        label: suggestionLabel(s),
        onPress: () => {
          if (s.kind === "WIDEN_WINDOW") widenWindow();
          else if (s.kind === "OTHER_FORMAT") changeFormat();
        },
      }));
      // UI42.9: the no-schedule-match outcome leads with the 1-click discovery
      // CTA — the suggestion actions (widen/format) follow unchanged.
      if (isNoScheduleMatchOutcome(liveAnswer.cause)) {
        noValidActions = [
          { label: SHOW_PLAYING_HERE_LABEL, onPress: () => showPlayingHere() },
          ...noValidActions,
        ];
      }
    }
  }

  // UI42.9: the cold search warmed the theatre schedule server-side
  // (SCHEDULE_RESOLUTION completes even when nothing matches), so drop the
  // client movie cache as soon as this outcome is observed — returning to the
  // form via the CTA above refetches the now-warm schedule into Hot Mode.
  // Keyed on the search identity so a re-render never re-invalidates.
  const noScheduleMatchKey =
    liveAnswer !== null &&
    liveAnswer.mode === "EMPTY" &&
    isNoScheduleMatchOutcome(liveAnswer.cause) &&
    store.searchId !== null
      ? `${store.searchId}:${liveAnswer.cause}`
      : null;
  useEffect(() => {
    if (noScheduleMatchKey === null) return;
    clearTheatreMovieCache();
  }, [noScheduleMatchKey]);

  // ADR 0041 §6: the Top Pick badge "never affects row order or eligibility for
  // anything else" — every resolved hit row gets the handoff action, not just the
  // primary's showtimes. ADR 0017 amendment: every hit now carries an issued nonce
  // (best hit per showtime), so startHandoff below resolves these rows for real.
  const handoffEligibleShowtimeIds: string[] = (() => {
    if (liveAnswer === null) return [];
    if (liveAnswer.mode === "CONFIDENT") {
      const primaryIds = liveAnswer.primary?.showtimes.map((o) => o.showtimeId) ?? [];
      const hitIds = liveGroups.flatMap((g) =>
        g.showtimes.flatMap((s, idx) =>
          s.resolved && (g.groupHits ?? []).some((h) => h.showtimeIndices.includes(idx))
            ? [s.showtimeId]
            : [],
        ),
      );
      return [...new Set([...primaryIds, ...hitIds])];
    }
    if (liveAnswer.mode === "HEDGED") {
      return liveAnswer.alternatives?.flatMap((a) => a.showtimes.map((o) => o.showtimeId)) ?? [];
    }
    return [];
  })();
  // This fix (client display consistency): the canonical per-showtime placement
  // for DISPLAY, derived from the ranked answer alone — never from groups. When
  // `liveAnswer.mode === "CONFIDENT"` every `primary.showtimes[].showtimeId`
  // maps to the primary's own `placement`/`reasons`; when `"HEDGED"` each
  // alternative's own showtimes map to that alternative's `placement`/`reasons`
  // (iterating each alternative separately, so a non-first alternative never
  // inherits `alternatives[0]`'s seats); `null` or `"EMPTY"` yields `{}`. This
  // is the placement actually bound to the real nonce/recheck/deep-link, so a
  // row covered here must display it even when `combinedGroups` below resolves
  // that showtime to a stale retained predecessor snapshot (ADR 0064 in-situ
  // merge) whose own top `groupHits[0]` pick disagrees. Rows with no entry here
  // keep today's `group.groupHits`-derived display (ADR 0041 §6: every resolved
  // hit row gets the handoff action, not just the primary's showtimes).
  const answerPlacementByShowtimeId: Record<
    string,
    { placement: Placement; reasons: RecommendationReason[] }
  > = (() => {
    if (liveAnswer === null) return {};
    if (liveAnswer.mode === "CONFIDENT") {
      const out: Record<string, { placement: Placement; reasons: RecommendationReason[] }> = {};
      const primary = liveAnswer.primary;
      if (primary === undefined) return out;
      for (const o of primary.showtimes) {
        out[o.showtimeId] = {
          placement: primary.placement,
          reasons: primary.reasons,
        };
      }
      return out;
    }
    if (liveAnswer.mode === "HEDGED") {
      const out: Record<string, { placement: Placement; reasons: RecommendationReason[] }> = {};
      for (const alternative of liveAnswer.alternatives) {
        for (const o of alternative.showtimes) {
          out[o.showtimeId] = {
            placement: alternative.placement,
            reasons: alternative.reasons,
          };
        }
      }
      return out;
    }
    return {};
  })();

  const { startSearch: startRealSearch } = useSearchSubscription();
  const checkMore = useCallback(() => {
    const s = useSeatfirstStore.getState();
    const lastSpec = s.serverCoverageSpec;
    const curId = s.searchId;
    const cause = s.terminalCause;
    if (lastSpec === null || curId === null || cause !== "BATCH_DEFERRED") return;
    void startRealSearch(lastSpec, curId);
    if (s.screen !== "checking") {
      useSeatfirstStore.setState({ screen: "checking" as const });
    }
  }, [startRealSearch]);

  const wrappedRestart = useCallback(() => {
    clearRecheck();
    setFormCollapsed(false);
    restart();
  }, [clearRecheck, restart, setFormCollapsed]);

  // UI30 (ADR 0063 §4): direct 1-click handoff. `startRecheck` runs synchronously
  // on the tap (before any await) so the row enters "Confirming seats…" immediately;
  // the popup tab is pre-opened by `startHandoff` in the same gesture and threaded
  // through as `popup`.
  // `placementKey`-only: the recheck input binds just the key (plus showtimeId/nonce),
  // so hit-fallback targets (which carry no full Placement) can handoff directly.
  const executeRecheck = useCallback(
    async (
      placement: Pick<Placement, "placementKey">,
      targetShowtimeId: string,
      nonce: string | null,
      popup: HandoffPopupWindow | null,
    ) => {
      const s = useSeatfirstStore.getState();
      const currentSearchId = s.searchId;
      if (currentSearchId === null || currentSearchId.length === 0) {
        closeHandoffWindow(popup);
        return;
      }
      if (nonce === null || nonce.length === 0) {
        s.setRecheckError({ code: "NONCE_MISSING", message: "Not ready — return to results" });
        closeHandoffWindow(popup);
        return;
      }
      const input = {
        searchId: currentSearchId,
        showtimeId: targetShowtimeId,
        placementKey: placement.placementKey,
        nonce,
      };
      s.startRecheck(input);
      const { recheckShowtime } = await import("@/api/showtimes");
      const { isRecord, readTrpcErrorCode } = await import("@/lib/errorEnvelope");
      try {
        const result = await recheckShowtime(input);
        const live = useSeatfirstStore.getState();
        live.setRecheckResult(result);
        if (result.status === "AVAILABLE") {
          const deepLinkUrl = resolveDeepLinkForShowtime(targetShowtimeId, live.groups);
          if (deepLinkUrl !== null) {
            await completeHandoffWithPopup(deepLinkUrl, popup);
          } else {
            closeHandoffWindow(popup);
          }
        } else {
          // GONE / UNAVAILABLE render in-situ beneath the row — drop the held tab.
          closeHandoffWindow(popup);
        }
      } catch (err: unknown) {
        closeHandoffWindow(popup);
        const live = useSeatfirstStore.getState();
        const setError = live.setRecheckError;
        let code: string | null = readTrpcErrorCode(err);
        let message: string | null =
          isRecord(err) && typeof err.message === "string" ? err.message : null;
        if (code === null && err instanceof Error) {
          if (
            err.message === "UNAUTHORIZED" ||
            err.message === "CONFLICT" ||
            err.message === "TIMEOUT" ||
            err.message === "TOO_MANY_REQUESTS" ||
            err.message === "NETWORK_ERROR"
          ) {
            code = err.message;
          } else if (
            err.message.includes("Network") ||
            err.message.includes("fetch") ||
            err.message.includes("Failed to fetch")
          ) {
            code = "NETWORK_ERROR";
            message = "Couldn't re-verify — check your connection and try again";
          } else {
            code = "UNKNOWN";
          }
        }
        if (code === "NETWORK_ERROR") {
          setError({ code, message: "Couldn't re-verify — check your connection and try again" });
          return;
        }
        if (code === "UNAUTHORIZED") {
          setError({
            code,
            message: "This selection expired — pick the seats again from the answer",
          });
          return;
        }
        if (code === "CONFLICT") {
          setError({ code, message: "Already checked — pick again" });
          return;
        }
        if (code === "TIMEOUT") {
          // ADR 0024 amendment (2026-09-03): TIMEOUT always shows the canonical reassurance
          // copy via `recheckErrorLabel`'s code branch, never a raw/generic upstream message
          // — `recheckErrorLabel` checks `fallback` before `code`, so this must stay null.
          setError({ code, message: null });
          return;
        }
        if (code === "TOO_MANY_REQUESTS") {
          setError({ code, message: message ?? "Too many requests — try again shortly" });
          return;
        }
        setError({ code: code ?? "UNKNOWN", message: message ?? "Couldn't re-verify — try again" });
      }
    },
    [],
  );

  const startHandoff = useCallback(
    (showtimeId: string) => {
      // ADR 0063 §4: pre-open the handoff tab synchronously in the tap gesture —
      // anything awaited first would let the browser block it as an untrusted popup.
      const popup = preopenHandoffWindow();
      void (async () => {
        const s = useSeatfirstStore.getState();
        const answer = s.answer;
        const status = s.status;
        const isTerminal = status === "COMPLETE" || status === "PARTIAL" || status === "HALTED";
        if (!isTerminal || answer === null) {
          closeHandoffWindow(popup);
          return;
        }
        if (s.searchId === null || s.searchId.length === 0) {
          closeHandoffWindow(popup);
          return;
        }
        // ADR 0017 amendment — generic showtimeId lookup: primary/every alternative
        // first, then the best-hit fallback (also fixes non-first HEDGED alternatives
        // resolving to alternatives[0], and unlocks non-primary hit rows now that every
        // hit carries an issued nonce).
        const target = resolveHandoffTarget(answer, s.groups, showtimeId);
        if (target === null) {
          closeHandoffWindow(popup);
          return;
        }
        await executeRecheck(
          { placementKey: target.placementKey },
          target.showtimeId,
          target.nonce,
          popup,
        );
      })();
    },
    [executeRecheck],
  );

  // UI31 (ADR 0064): in-situ diff-merge derivation. `combinedGroups` unions the
  // active search's live groups with the frozen predecessor snapshot so retained
  // rows keep their visual anchors; live groups come first so `find` prefers a
  // live match once a retained row resolves under the successor search.
  const combinedGroups: ResultGroup[] = [...liveGroups, ...store.retainedGroups];
  const provenanceByShowtimeId = new Map<string, RowProvenance>(
    store.scheduleSkeleton.map((e) => [
      e.showtimeId,
      deriveProvenance(e.showtimeId, e.resolved, store.retainedRowIds),
    ]),
  );
  const displayRows: DisplayShowtimeRow[] = store.scheduleSkeleton.map((e) => {
    const provenance = provenanceByShowtimeId.get(e.showtimeId) ?? "RESOLVED_CURRENT";
    const group = combinedGroups.find((g) =>
      g.showtimes.some((s) => s.showtimeId === e.showtimeId),
    );
    return {
      showtimeId: e.showtimeId,
      provenance,
      entry: e,
      ...(group !== undefined ? { group } : null),
      canHandoff:
        provenance === "RESOLVED_CURRENT" &&
        e.resolved &&
        handoffEligibleShowtimeIds.includes(e.showtimeId),
    };
  });
  const filteredHandoffEligibleShowtimeIds =
    store.retainedRowIds !== null
      ? handoffEligibleShowtimeIds.filter((id) => !store.retainedRowIds!.has(id))
      : handoffEligibleShowtimeIds;
  // UI30 (ADR 0063 §2/§6): inline recheck state for the results surface. The error
  // copy reuses the canonical helpers (`unavailableCauseLabel` for a stored
  // UNAVAILABLE result, `recheckErrorLabel` for transport/nonce failures) — the row
  // renders this string verbatim and never invents its own.
  const recheckResult = store.recheckResult;
  const recheckInlineError: string | null = (() => {
    if (recheckResult !== null) {
      if (recheckResult.status === "UNAVAILABLE") {
        return unavailableCauseLabel(recheckResult.cause);
      }
      return null;
    }
    if (store.recheckStatus === "unavailable") {
      return recheckErrorLabel(store.recheckErrorCode, store.recheckErrorMessage);
    }
    return null;
  })();

  return {
    answer: liveAnswer,
    answerMode,
    groups: combinedGroups,
    searchStatus: liveStatus,
    terminalStatus,
    isTerminal,
    otherFormatsLabel,
    emptyCause,
    emptyCauseLabel: emptyCauseLabelStr,
    terminalBannerLabel,
    liveResolved,
    liveTotal,
    scheduleSkeleton: store.scheduleSkeleton,
    previewPlaceholderCount: store.previewPlaceholderCount,
    terminalCause: store.terminalCause,
    partySize,
    canCheckMore: store.terminalCause === "BATCH_DEFERRED",
    handoffEligibleShowtimeIds: filteredHandoffEligibleShowtimeIds,
    answerPlacementByShowtimeId,
    noValidActions,
    recheckingShowtimeId: store.recheckingShowtimeId,
    recheckTargetShowtimeId: store.recheckSelectedShowtimeId,
    recheckResult,
    recheckInlineError,
    provenanceByShowtimeId,
    displayRows,
    actions: {
      backToSearch,
      changeFormat,
      widenWindow,
      seeOtherOptions,
      restart: wrappedRestart,
      startHandoff,
      checkMore,
      clearRecheck,
    },
  };
}
