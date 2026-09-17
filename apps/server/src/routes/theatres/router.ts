import { search, t } from "./search.js";
import { movies } from "./movies.js";

/**
 * The tRPC router for the `theatres` namespace. S20 mounts `search`
 * (`theatres.search`, a synchronous read-only catalogue lookup); S21 adds `movies`
 * (`theatres.movies`, a read-only browse of the cached schedule). Keep each route in its
 * own file (`search.ts`, `movies.ts`) and mount both here so the two land independently.
 *
 * `t` comes from `search.ts` — the route whose context this router's `t` is typed to
 * (`TheatreSearchContext { db: Pool }`). `movies` (S21) builds on the SAME `t` so the
 * router stays context-homogeneous; it reads the injected `freshnessMs` (ADR 0006 §A.1,
 * S21.1) from the runtime `appRouter` context (`SearchCreateContext`), which the fastify
 * plugin supplies at request time — the nested-context coordination S20's router comment
 * records.
 */
export const theatresRouter = t.router({ search, movies });
