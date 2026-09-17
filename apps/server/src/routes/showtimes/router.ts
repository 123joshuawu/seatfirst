import { recheck, t } from "./recheck.js";

/**
 * The tRPC router for the `showtimes` namespace. S22 mounts `recheck`
 * (`showtimes.recheck`, the single-flight recheck mutation). `t` comes from
 * `recheck.ts` — the route whose context this router's `t` is typed to
 * (`RecheckContext { db, limiter, nonceSecret, deadlineMs, recovery }`), the same
 * nested-context pattern `theatres` and `session.bootstrap` use (each route builds its
 * own context-typed instance; `appRouter` supplies the request-time context).
 */
export const showtimesRouter = t.router({ recheck });
