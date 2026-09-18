import { useCallback, useEffect, useMemo, useState } from "react";

import { trpcClient } from "@/lib/trpc";
import { tmdbPosterUrl } from "@/lib/presentation";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import type { MovieSuggestion } from "./viewModels/useSubmitSearchViewModel";

export interface UseMovieSearchOptions {
  query?: string;
  limit?: number;
  browse?: boolean;
  debounceMs?: number;
  enabled?: boolean;
}

/** Minimal structural view of a `movies.search` hit (only mapped fields). */
interface MovieSearchHitView {
  id: string;
  title: string;
  releaseYear: number | null;
  posterPath: string | null;
  badge: string | null;
  seenAtAmc: boolean;
}

interface MovieSearchResponseView {
  movies: MovieSearchHitView[];
}

export interface UseMovieSearchResult {
  data: MovieSearchResponseView | undefined;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
  suggestions: MovieSuggestion[];
}

/**
 * Debounced universal movie & event search (UI42, ADR 0100 Cold Mode).
 * Queries `trpcClient.movies.search` imperatively (the viewmodel-layer
 * pattern from `useTheatreMovieSet`), with `useTheatreSearch`'s
 * debounce/browse semantics:
 * - Empty/short queries (fewer than 2 trimmed chars — the server's
 *   `MIN_TYPED_QUERY_LENGTH` slate-browse threshold) fire immediately with no
 *   `query` param so the pre-warmed theatrical slate populates instantly.
 * - Typed queries debounce by >=250ms (default 250).
 * - `browse` is the explicit browse-on-focus flag: caller passes
 *   `isFocused && query.trim() === ""`. Enabled when
 *   `bootstrapReady && (hasQuery || browse)`.
 *
 * When the `movies.search` surface is absent (e.g. store-level suites with a
 * partial trpc mock) the hook degrades to empty instead of crashing during
 * render — same graceful-degradation contract as `useTheatreMovieSet`.
 *
 * Hits map into the shared `MovieSuggestion` shape; picking one confirms a
 * custom (non-catalog) selection via `selectCustomMovieTitle`, so
 * `buildSearchSpec` emits the `ids` + `titles` legs for cold resolution.
 */
export function useMovieSearch(options: UseMovieSearchOptions = {}): UseMovieSearchResult {
  const {
    query = "",
    limit,
    browse = false,
    debounceMs = 250,
    enabled: enabledOpt = true,
  } = options;
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);

  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    // Browse (empty/short query) must populate instantly on focus — no debounce.
    if (query.trim().length < 2) {
      setDebouncedQuery(query);
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs]);

  const hasQuery = debouncedQuery.trim().length >= 2;
  const enabled = enabledOpt && bootstrapReady && (hasQuery || browse);
  const effectiveQuery = hasQuery ? debouncedQuery.trim() : undefined;

  const [data, setData] = useState<MovieSearchResponseView | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [refetchNonce, setRefetchNonce] = useState(0);
  const refetch = useCallback(() => setRefetchNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setIsFetching(false);
      return;
    }
    const searchQuery = (
      trpcClient as unknown as {
        movies?: {
          search?: {
            query: (input: { query?: string; limit?: number }) => Promise<MovieSearchResponseView>;
          };
        };
      }
    ).movies?.search?.query;
    if (!searchQuery) {
      setData(undefined);
      setError(null);
      setIsFetching(false);
      return;
    }
    // Build input omitting short queries (server treats them as slate-browse).
    const input: { query?: string; limit?: number } = {};
    if (effectiveQuery !== undefined) input.query = effectiveQuery;
    if (limit !== undefined) input.limit = limit;
    let cancelled = false;
    setIsFetching(true);
    setError(null);
    void searchQuery(input).then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setIsFetching(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause);
        setIsFetching(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, effectiveQuery, limit, refetchNonce]);

  const suggestions = useMemo<MovieSuggestion[]>(
    () =>
      (data?.movies ?? []).map((hit) => ({
        label: hit.releaseYear == null ? hit.title : `${hit.title} (${hit.releaseYear})`,
        onPress: () => {
          useSeatfirstStore.getState().selectCustomMovieTitle(hit.title, hit.id);
        },
        posterUrl: tmdbPosterUrl(hit.posterPath),
        releaseYear: hit.releaseYear,
        badge: hit.badge,
        seenAtAmc: hit.seenAtAmc,
      })),
    [data],
  );

  return {
    data,
    error,
    isLoading: isFetching && data === undefined,
    isFetching,
    refetch,
    suggestions,
  };
}
