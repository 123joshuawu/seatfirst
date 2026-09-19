import { useEffect, useMemo, useState } from "react";
import type { TheatreMovieGroup, TheatreMoviesResponse } from "@seatfirst/core";
import { isDevTransportEnabled, onDevTransportChange } from "@/lib/devTransport";
import { trpcClient } from "@/lib/trpc";
import { useSeatfirstStore } from "@/store/seatfirstStore";

export interface TheatreMovieSetEntry {
  theatreId: string;
  timezone: string;
  group: TheatreMovieGroup;
}

export interface TheatreMovieSetGroup {
  movieId: string;
  title: string;
  posterPath: string | null;
  runtimeMinutes: number | null;
  genres: readonly string[];
  showtimeCount: number;
  entries: TheatreMovieSetEntry[];
}

const responseCache = new Map<string, TheatreMoviesResponse>();

// UI42.6: `onCheckLiveSchedule` (the dropdown's "Check today's live
// schedule" CTA) clears this cache on a successful refresh, but a plain
// `Map.clear()` is invisible to React — nothing re-renders, so the movie
// list kept showing the stale Cold Mode snapshot until an unrelated prop
// changed. Cache clears now notify subscribers so every mounted
// `useTheatreMovieSet` instance knows to refetch. The dev-transport-change
// listener below is the pre-existing consumer of this same signal.
const cacheClearListeners = new Set<() => void>();

export function clearTheatreMovieCache(): void {
  responseCache.clear();
  for (const listener of cacheClearListeners) listener();
}

function cacheKey(theatreId: string, from: string, to: string): string {
  return `${theatreId}\u0000${from}\u0000${to}`;
}

// BATCH-414: `trpcClient`'s `httpBatchLink` coalesces every query queued in the
// same tick into one GET, and `responseCache.set(...)` in the effect below only
// ran AFTER the promises resolved — so when the effect re-ran (a new
// `legacyResponse`/store reference, or any dependency change) before the first
// round settled, the same 'missing' theatre ids were queried a second time.
// Live: a 6-theatre place emitted `theatres.movies` 12 times (each id exactly
// twice) and failed with 414. In-flight fetches are tracked by the same
// `cacheKey` and shared until they settle, so a re-run while a fetch is pending
// reuses it instead of firing a duplicate. Entries are deleted on settle
// (success or failure); `clearTheatreMovieCache` intentionally leaves pending
// work alone — the settling promise still populates the cache exactly once.
const inflightRequests = new Map<string, Promise<TheatreMoviesResponse>>();

export function aggregateTheatreMovies(
  responses: readonly TheatreMoviesResponse[],
): TheatreMovieSetGroup[] {
  const byMovie = new Map<string, TheatreMovieSetGroup>();

  for (const response of responses) {
    for (const rawGroup of response.movies) {
      // Defensive: an API replica mid-rolling-deploy (or momentarily behind a schema
      // migration) can omit fields a newer client's TheatreMovieGroup type declares as
      // always-present. Normalize to the schema's own documented "not resolved yet"
      // sentinels (`genres: []`, `runtimeMinutes: null`) instead of crashing on
      // `undefined.length` — never silently drops or renders stale info, only degrades
      // to "unresolved" until a fresher fetch fills it in.
      const group: TheatreMovieGroup = {
        ...rawGroup,
        genres: rawGroup.genres ?? [],
        runtimeMinutes: rawGroup.runtimeMinutes ?? null,
      };
      const existing = byMovie.get(group.movieId);
      const entry: TheatreMovieSetEntry = {
        theatreId: response.theatreId,
        timezone: response.timezone,
        group,
      };
      if (existing) {
        existing.entries.push(entry);
        existing.showtimeCount += group.showtimes.length;
        if (existing.posterPath === null && group.posterPath !== null) {
          existing.posterPath = group.posterPath;
        }
        if (existing.runtimeMinutes === null && group.runtimeMinutes !== null) {
          existing.runtimeMinutes = group.runtimeMinutes;
        }
        if (existing.genres.length === 0 && group.genres.length > 0) {
          existing.genres = group.genres;
        }
      } else {
        byMovie.set(group.movieId, {
          movieId: group.movieId,
          title: group.title,
          posterPath: group.posterPath,
          runtimeMinutes: group.runtimeMinutes,
          genres: group.genres,
          showtimeCount: group.showtimes.length,
          entries: [entry],
        });
      }
    }
  }

  return [...byMovie.values()].sort(
    (a, b) => b.showtimeCount - a.showtimeCount || a.title.localeCompare(b.title),
  );
}

export function useTheatreMovieSet(options: {
  theatreIds: readonly string[];
  from: string;
  to: string;
}) {
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);
  const legacyResponse = useSeatfirstStore((s) => s.selectedTheatreMovies);
  const theatreIdsKey = options.theatreIds.join("\u0000");
  const theatreIds = useMemo(
    () => [...new Set(options.theatreIds.filter((id) => id.length > 0))],
    [theatreIdsKey],
  );
  const [responses, setResponses] = useState<TheatreMoviesResponse[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const listener = (): void => setCacheVersion((v) => v + 1);
    cacheClearListeners.add(listener);
    return () => {
      cacheClearListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!isDevTransportEnabled()) return;
    return onDevTransportChange(() => {
      clearTheatreMovieCache();
      setResponses([]);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!bootstrapReady || theatreIds.length === 0) {
      setResponses([]);
      setIsFetching(false);
      setError(null);
      return;
    }

    if (
      legacyResponse &&
      theatreIds.includes(legacyResponse.theatreId) &&
      legacyResponse.from === options.from &&
      legacyResponse.to === options.to
    ) {
      responseCache.set(
        cacheKey(legacyResponse.theatreId, options.from, options.to),
        legacyResponse,
      );
    }

    const cached = theatreIds.flatMap((theatreId) => {
      const response = responseCache.get(cacheKey(theatreId, options.from, options.to));
      return response ? [response] : [];
    });
    setResponses(cached);

    const missing = theatreIds.filter(
      (theatreId) => !responseCache.has(cacheKey(theatreId, options.from, options.to)),
    );
    const movieQuery = (
      trpcClient.theatres as unknown as {
        movies?: {
          query: (input: {
            theatreId: string;
            from: string;
            to: string;
          }) => Promise<TheatreMoviesResponse>;
        };
      }
    ).movies?.query;
    if (missing.length === 0 || !movieQuery) {
      setIsFetching(false);
      setError(null);
      return;
    }

    setIsFetching(true);
    setError(null);
    // BATCH-414 dedup: a cache key with a pending (unresolved) fetch for this
    // same range is shared, never re-queried — a re-run before the first round
    // settles (the live 6-theatre → 12-query duplication) attaches to the same
    // promise instead of emitting a second `theatres.movies` per theatre.
    const pending = missing.map((theatreId) => {
      const key = cacheKey(theatreId, options.from, options.to);
      const inflight = inflightRequests.get(key);
      if (inflight) return inflight;
      const request = movieQuery({ theatreId, from: options.from, to: options.to }).then(
        (response) => {
          responseCache.set(key, response);
          return response;
        },
      );
      inflightRequests.set(key, request);
      const forget = (): void => {
        if (inflightRequests.get(key) === request) inflightRequests.delete(key);
      };
      request.then(forget, forget);
      return request;
    });
    void Promise.all(pending)
      .then((loaded) => {
        if (cancelled) return;
        setResponses([...cached, ...loaded]);
        setIsFetching(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause);
        setIsFetching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    bootstrapReady,
    legacyResponse,
    options.from,
    options.to,
    theatreIds,
    theatreIdsKey,
    cacheVersion,
  ]);

  // Keep the existing single-theatre response usable while callers migrate to the
  // structured Where model. Fresh multi-theatre selections still use the range-keyed
  // cache and queries above.
  const effectiveResponses =
    responses.length > 0
      ? responses
      : legacyResponse && theatreIds.includes(legacyResponse.theatreId)
        ? [legacyResponse]
        : [];
  const isLegacyBridge =
    effectiveResponses.length === 1 && effectiveResponses[0] === legacyResponse;

  return {
    responses: effectiveResponses,
    movies: aggregateTheatreMovies(effectiveResponses),
    isFetching,
    isComplete:
      (bootstrapReady || isLegacyBridge) &&
      theatreIds.length > 0 &&
      effectiveResponses.length === theatreIds.length &&
      !isFetching &&
      !error,
    error,
  };
}
