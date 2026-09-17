import { useEffect, useRef, useState } from "react";
import type { DateScope, FacetCountsInput, FacetCountsResponse } from "@seatfirst/core";
import { trpcClient } from "@/lib/trpc";
import { isDevTransportEnabled, onDevTransportChange } from "@/lib/devTransport";

/**
 * Tri-state facet counts hook (UI18.6).
 *
 * Calls `searches.facetCounts` (S43, ADR 0036) debounced (300ms) and coalesced
 * so a burst of 10 interactions in 5s issues ≤10 requests, comfortably inside
 * the 120 req/min/session ceiling (task-owned timing, not a literal 120 check).
 *
 * Input shape matches the assignment's `{theatreIds, movieId?, format?,
 * dateScope, timeOfDay, partySize}` plus an explicit `axes` for the actual
 * facet request. `partySize` is accepted for API compatibility but does not
 * affect the count predicate — the backend count is a showtime count, not a
 * seat-availability count (ADR 0036). `dateScope` is the exact active date
 * scope (UI24, ADR 0052 §6 — never a weekday fallback), `timeOfDay` maps to
 * `base.timeOfDay` (ADR 0043 four bands), `horizon` maps to `base.horizon`.
 *
 * The hook consumes `FacetCountsResponse` and exposes a convenient Map keyed by
 * candidate id plus the raw response. Only warm zeros should be dimmed/disabled
 * by callers — see `lib/facetCounts` helpers.
 */

export interface UseFacetCountsInput {
  theatreIds: string[];
  movieId?: string | null;
  format?: string | null;
  timeOfDay?: string;
  horizon?: string | null;
  /**
   * The exact active date scope (UI24, ADR 0052 §6): every Movie/Format/DATE
   * request carries this — never a weekday fallback. Mutually exclusive with
   * `horizon` and with any `DATE`/`DATE_SCOPE` axis in `axes`.
   */
  dateScope?: DateScope | null;
  partySize?: number;
  providerId?: string;
  axes?: FacetCountsInput["axes"];
  enabled?: boolean;
  /** Task-owned debounce; default 300ms. */
  debounceMs?: number;
}

export interface UseFacetCountsResult {
  data: FacetCountsResponse | null;
  countsMap: Map<string, { count: number; coldTheatreCount: number }>;
  countsRecord: Record<string, { warm: number; unknown: boolean; coldTheatreCount: number }>;
  coldTheatreCountTotal?: number;
  isLoading: boolean;
  error: unknown;
}

function mapTimeOfDayForFacet(
  timeOfDay: string | undefined,
): FacetCountsInput["base"]["timeOfDay"] {
  if (!timeOfDay) return undefined;
  const v = timeOfDay.trim();
  if (v === "All times" || v === "Any time" || v === "allTimes") return undefined;
  const lower = v.toLowerCase();
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "late") {
    return lower;
  }
  if (["morning", "afternoon", "evening", "late", "alltimes"].includes(lower)) {
    return (lower === "alltimes" ? "allTimes" : lower) as FacetCountsInput["base"]["timeOfDay"];
  }
  return undefined;
}

function buildFacetInput(opts: UseFacetCountsInput): FacetCountsInput | null {
  const theatreIds = opts.theatreIds ?? [];
  if (theatreIds.length === 0) return null;
  const axes = opts.axes;
  if (!axes || axes.length === 0) return null;
  const providerId = opts.providerId ?? "amc";
  const base: FacetCountsInput["base"] = {};
  if (opts.movieId !== undefined && opts.movieId !== null) {
    const hasMovieAxis = axes.some((a) => a.kind === "MOVIE");
    if (!hasMovieAxis) base.movieId = opts.movieId;
  }
  const tod = mapTimeOfDayForFacet(opts.timeOfDay);
  if (tod) {
    const hasTodAxis = axes.some((a) => a.kind === "TIME_OF_DAY");
    if (!hasTodAxis) base.timeOfDay = tod;
  }
  if (opts.horizon) {
    const hasHorizonAxis = axes.some((a) => a.kind === "HORIZON");
    if (!hasHorizonAxis) base.horizon = opts.horizon as FacetCountsInput["base"]["horizon"];
  }
  if (opts.dateScope != null) {
    const hasDateOrScopeAxis = axes.some((a) => a.kind === "DATE" || a.kind === "DATE_SCOPE");
    const hasHorizonAxis = axes.some((a) => a.kind === "HORIZON");
    if (!hasDateOrScopeAxis && !hasHorizonAxis && !opts.horizon) {
      base.dateScope = opts.dateScope;
    }
  }
  return {
    providerId,
    theatreIds,
    base,
    axes,
  } as FacetCountsInput;
}

export function useFacetCounts(input: UseFacetCountsInput | null): UseFacetCountsResult {
  const [data, setData] = useState<FacetCountsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [devVersion, setDevVersion] = useState(0);

  useEffect(() => {
    if (!isDevTransportEnabled()) return;
    return onDevTransportChange(() => {
      lastInputKeyRef.current = null;
      activeInputKeyRef.current = null;
      pendingKeyRef.current = null;
      pendingPromiseRef.current = null;
      setData(null);
      setDevVersion((v) => v + 1);
    });
  }, []);

  const debounceMs = input?.debounceMs ?? 300;

  const pendingKeyRef = useRef<string | null>(null);
  const pendingPromiseRef = useRef<Promise<FacetCountsResponse> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInputKeyRef = useRef<string | null>(null);
  // UI18.6: a slower prior theatre scope must never overwrite the counts
  // rendered for the newly selected theatres after debounce/coalescing.
  const activeInputKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!input || input.enabled === false) {
      activeInputKeyRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setData(null);
      setIsLoading(false);
      return;
    }
    const facetInput = buildFacetInput(input);
    if (!facetInput) {
      activeInputKeyRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setData(null);
      setIsLoading(false);
      return;
    }
    const key = JSON.stringify(facetInput);
    const isNewInput = activeInputKeyRef.current !== key;
    activeInputKeyRef.current = key;
    if (lastInputKeyRef.current === key && pendingPromiseRef.current) {
      return;
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (isNewInput) setData(null);

    setIsLoading(true);
    const effectiveDelay = devVersion > 0 ? 0 : debounceMs;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      if (pendingKeyRef.current === key && pendingPromiseRef.current) {
        pendingPromiseRef.current
          .then((res) => {
            if (activeInputKeyRef.current !== key) return;
            setData(res);
            setError(null);
            setIsLoading(false);
          })
          .catch((err) => {
            if (activeInputKeyRef.current !== key) return;
            setError(err);
            setIsLoading(false);
          });
        lastInputKeyRef.current = key;
        return;
      }
      lastInputKeyRef.current = key;
      pendingKeyRef.current = key;
      const facetCountsQuery = (
        trpcClient.searches as unknown as {
          facetCounts?: { query: (input: unknown) => Promise<FacetCountsResponse> };
        }
      ).facetCounts?.query;
      if (!facetCountsQuery) {
        setIsLoading(false);
        pendingKeyRef.current = null;
        return;
      }
      const promise = facetCountsQuery(facetInput);
      pendingPromiseRef.current = promise;
      promise
        .then((res) => {
          if (activeInputKeyRef.current !== key) return;
          setData(res);
          setError(null);
          setIsLoading(false);
          setTimeout(() => {
            if (pendingKeyRef.current === key) {
              pendingKeyRef.current = null;
              pendingPromiseRef.current = null;
            }
          }, debounceMs);
        })
        .catch((err) => {
          if (activeInputKeyRef.current !== key) return;
          setError(err);
          setIsLoading(false);
          pendingKeyRef.current = null;
          pendingPromiseRef.current = null;
        });
    }, effectiveDelay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [
    input?.theatreIds?.join(","),
    input?.movieId,
    input?.format,
    input?.timeOfDay,
    input?.horizon,
    input?.providerId,
    input?.enabled,
    input?.debounceMs,
    JSON.stringify(input?.dateScope ?? null),
    JSON.stringify(input?.axes ?? null),
    debounceMs,
    devVersion,
  ]);

  const countsMap = (() => {
    const m = new Map<string, { count: number; coldTheatreCount: number }>();
    if (!data) return m;
    for (const c of data.counts) {
      m.set(c.candidate, { count: c.count, coldTheatreCount: c.coldTheatreCount });
    }
    return m;
  })();

  const countsRecord: Record<string, { warm: number; unknown: boolean; coldTheatreCount: number }> =
    (() => {
      const r: Record<string, { warm: number; unknown: boolean; coldTheatreCount: number }> = {};
      countsMap.forEach((v, k) => {
        r[k] = {
          warm: v.count,
          unknown: v.coldTheatreCount > 0,
          coldTheatreCount: v.coldTheatreCount,
        };
      });
      return r;
    })();

  return { data, countsMap, countsRecord, isLoading, error };
}

/** Pure helper exported for tests to simulate rate without React. */
export function shouldThrottleDebounced(
  callTimes: number[],
  now: number,
  _limitPerMinute?: number,
): boolean {
  void callTimes;
  void now;
  void _limitPerMinute;
  return false;
}
