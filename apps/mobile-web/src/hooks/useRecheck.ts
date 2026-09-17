/**
 * useRecheck — wraps the tRPC showtimes.recheck mutation.
 * Spec UI6.1, UI6.2, UI6.8, UI6.9.
 */
import { useCallback } from "react";
import { TRPCClientError } from "@trpc/client";
import type { RecheckInput } from "@seatfirst/core";
import { readTrpcErrorCode } from "@/lib/errorEnvelope";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { recheckShowtime } from "@/api/showtimes";
import { resolveHandoffTarget } from "@/lib/presentation";

/**
 * Map a TRPC error to a user-facing recheck error code.
 */
function mapTrpcErrorToCode(err: unknown): { code: string | null; message: string | null } {
  if (err instanceof TRPCClientError) {
    // tRPC types TRPCClientError.data/shape as unknown without a router generic; the
    // shared UI13 guard reads the code off either envelope placement at runtime.
    const resolved = readTrpcErrorCode(err);
    if (resolved) return { code: resolved, message: err.message };
    // Fallback: infer from message string for test mocks that set message to code
    if (typeof err.message === "string" && err.message.length > 0) {
      return { code: err.message, message: err.message };
    }
    return { code: null, message: err.message };
  }
  if (err instanceof Error) {
    // Network / transport-level failure
    return { code: "NETWORK_ERROR", message: err.message };
  }
  return { code: null, message: null };
}

function isTerminalStatus(status: string | null): boolean {
  return status === "COMPLETE" || status === "PARTIAL" || status === "HALTED";
}

export function useRecheck(): {
  recheck: () => Promise<void>;
  isRechecking: boolean;
} {
  const searchId = useSeatfirstStore((s) => s.searchId);
  const status = useSeatfirstStore((s) => s.status);
  const answer = useSeatfirstStore((s) => s.answer);
  const groups = useSeatfirstStore((s) => s.groups);
  const selectedShowtimeIdx = useSeatfirstStore((s) => s.selectedShowtimeIdx);
  const isRechecking = useSeatfirstStore((s) => s.recheckStatus === "rechecking");
  const startRecheck = useSeatfirstStore((s) => s.startRecheck);
  const setRecheckResult = useSeatfirstStore((s) => s.setRecheckResult);
  const setRecheckError = useSeatfirstStore((s) => s.setRecheckError);

  const recheck = useCallback(async () => {
    // Guard: only from terminal answer states (UI6 spec § Design 4)
    if (!isTerminalStatus(status)) return;
    if (searchId === null || searchId.length === 0) return;
    if (answer === null) return;
    // ADR 0017 amendment — resolve the actually-selected showtime generically
    // (primary, every alternative, then best-hit fallback) instead of hardcoding
    // primary/alternatives[0]. Prefer the handoff's own clicked-showtime selection;
    // else resolve the legacy index to its showtimeId before the generic lookup so
    // a non-first HEDGED alternative keeps its own placement/offer/nonce.
    const storeState = useSeatfirstStore.getState();
    const clickedShowtimeId = storeState.recheckSelectedShowtimeId;
    let target: { placementKey: string; showtimeId: string; nonce: string | null } | null;
    if (clickedShowtimeId !== null) {
      target = resolveHandoffTarget(answer, storeState.groups, clickedShowtimeId);
    } else {
      let selectedShowtimeId: string | null = null;
      if (answer.mode === "CONFIDENT") {
        selectedShowtimeId =
          answer.primary.showtimes[selectedShowtimeIdx ?? -1]?.showtimeId ?? null;
      } else if (answer.mode === "HEDGED") {
        for (const alternative of answer.alternatives) {
          const id = alternative.showtimes[selectedShowtimeIdx ?? -1]?.showtimeId;
          if (id !== undefined) {
            selectedShowtimeId = id;
            break;
          }
        }
      } else {
        return;
      }
      if (selectedShowtimeId === null) return;
      target = resolveHandoffTarget(answer, storeState.groups, selectedShowtimeId);
    }
    if (target === null) return;
    const showtimeId = target.showtimeId;
    const nonce = target.nonce;

    if (showtimeId === null) return;
    // Nonce must be non-null at call time; if null, surface "Not ready" via error code
    if (nonce === null || nonce.length === 0) {
      setRecheckError({ code: "NONCE_MISSING", message: "Not ready — return to results" });
      return;
    }

    const input: RecheckInput = {
      searchId,
      showtimeId,
      placementKey: target.placementKey,
      nonce,
    };

    startRecheck(input);

    try {
      const result = await recheckShowtime(input);
      setRecheckResult(result);
    } catch (err: unknown) {
      const { code, message } = mapTrpcErrorToCode(err);
      // Network-level failure maps to a distinct message per Verification item 3
      if (code === "NETWORK_ERROR") {
        setRecheckError({
          code,
          message: "Couldn't re-verify — check your connection and try again",
        });
        return;
      }
      if (code === "UNAUTHORIZED") {
        setRecheckError({
          code,
          message: "This selection expired — pick the seats again from the answer",
        });
        return;
      }
      if (code === "CONFLICT") {
        setRecheckError({ code, message: "Already checked — pick again" });
        return;
      }
      if (code === "TIMEOUT") {
        // ADR 0024 amendment (2026-09-03): TIMEOUT always shows the canonical reassurance
        // copy via `recheckErrorLabel`'s code branch, never a raw/generic upstream message
        // — `recheckErrorLabel` checks `fallback` before `code`, so this must stay null.
        setRecheckError({ code, message: null });
        return;
      }
      if (code === "TOO_MANY_REQUESTS") {
        setRecheckError({ code, message: message ?? "Too many requests — try again shortly" });
        return;
      }
      // Fallback for other codes (BAD_REQUEST, NOT_FOUND, INTERNAL_SERVER_ERROR, etc.)
      setRecheckError({
        code: code ?? "UNKNOWN",
        message: message ?? "Couldn't re-verify — try again",
      });
    }
  }, [
    searchId,
    status,
    answer,
    groups,
    selectedShowtimeIdx,
    startRecheck,
    setRecheckResult,
    setRecheckError,
  ]);

  // groups is intentionally not used in the closure except for handoff resolution elsewhere;
  // keep it in deps to ensure fresh reads reflect latest groups if hook re-renders.
  void groups;

  return { recheck, isRechecking };
}
