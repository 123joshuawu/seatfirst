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

export function clearTheatreMovieCache(): void {
  responseCache.clear();
}

function cacheKey(theatreId: string, from: string, to: string): string {
  return `${theatreId}\u0000${from}\u0000${to}`;
}

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
  const [devVersion, setDevVersion] = useState(0);

  useEffect(() => {
    if (!isDevTransportEnabled()) return;
    return onDevTransportChange(() => {
      clearTheatreMovieCache();
      setResponses([]);
      setDevVersion((v) => v + 1);
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
    void Promise.all(
      missing.map((theatreId) =>
        movieQuery({ theatreId, from: options.from, to: options.to }).then((response) => {
          responseCache.set(cacheKey(theatreId, options.from, options.to), response);
          return response;
        }),
      ),
    )
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
    devVersion,
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
