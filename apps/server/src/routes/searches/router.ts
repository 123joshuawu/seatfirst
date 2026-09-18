import { cancel } from "./cancel.js";
import { create, t } from "./create.js";
import { facetCounts } from "./facetCounts.js";
import { capacityPreview } from "./capacityPreview.js";
import { resolvePlace } from "./resolvePlace.js";
import { suggestPlace } from "./suggestPlace.js";
import { status } from "./status.js";
import { get } from "./get.js";
import { onProgress } from "./onProgress.js";
import { sessionRouter } from "../session/bootstrap.js";
import { moviesRouter } from "../movies/router.js";
import { theatresRouter } from "../theatres/router.js";
import { showtimesRouter } from "../showtimes/router.js";
/**
 * The tRPC router for this package. `searches.onProgress` (S12), `searches.create`
 * (S15), `searches.cancel` (S23), `searches.get` (S19), and `session.bootstrap` (S16.11)
 * attach here, and the `theatres` sub-router (S20) is mounted on its own context-typed
 * instance (`theatres/router.ts`).
 *
 * `t` comes from `create.ts` — the route whose context the router must satisfy. The
 * procedures build against DIFFERENT context-typed tRPC instances (`SearchStreamContext`
 * for the SSE transport, `SearchCreateContext` for the create mutation,
 * `SessionBootstrapContext` for bootstrap, `SearchGetContext` for get — no shared context
 * carries what all of them need), so the router's context (`inferRouterContext<AppRouter>`)
 * is the create route's. `onProgress`, `session.bootstrap`, `showtimes.recheck`, and
 * `searches.get` are therefore served ONLY through their own bespoke registrations
 * (`sse.ts` / `bootstrap.ts` / `register.ts` / `get.ts`), each passing its own context at
 * call time — they are mounted here so the router resolves their paths; the catch-all
 * would fail loudly (context mismatch) rather than silently misbehave.
 */
export const appRouter = t.router({
  searches: t.router({
    onProgress,
    create,
    cancel,
    status,
    get,
    facetCounts,
    capacityPreview,
    resolvePlace,
    suggestPlace,
  }),
  session: sessionRouter,
  showtimes: showtimesRouter,
  theatres: theatresRouter,
  movies: moviesRouter,
});

export type AppRouter = typeof appRouter;
