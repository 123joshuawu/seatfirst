import { search, t } from "./search.js";

/**
 * The tRPC router for the `movies` namespace (S63.4). One route (`movies.search`,
 * unified TMDB + AMC discovery for Cold Mode) lives in its own file and mounts
 * here — the same per-area pattern as `theatres/router.ts`.
 *
 * `t` comes from `search.ts` — the route whose context this router's `t` is
 * typed to (`MoviesSearchContext { db, tmdbClient }`). Mounted on the top-level
 * `appRouter` (`routes/searches/router.ts`) alongside the `SearchCreateContext`-
 * typed areas; like `theatres`, this router's context is a structural subset of
 * what the Fastify plugin's `createContext` provides at request time (the pool
 * plus the injected TMDB client).
 */
export const moviesRouter = t.router({ search });
