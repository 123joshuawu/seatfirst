import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

/**
 * `theatres.search` context (S20) — the sibling of S15's `SearchCreateContext`, split
 * because this read-only catalogue lookup needs ONLY the pool: no session, no injected
 * limits, no rate limiter, no ledger. Carrying only the pool (no tunables, no numbers)
 * is deliberate — every injected figure elsewhere in this codebase exists because an
 * accepted document fixed one, and none fixes anything for this route (S20.4).
 * Inventing one would be the gate-14 trap (`docs/gates.md`). Sibling S21
 * (`theatres.movies`) coordinates on this router/context — see `search.ts`/`router.ts`.
 */
export interface TheatreSearchContext {
  readonly db: Pool;
}

export interface TheatreSearchContextOptions {
  readonly db: Pool;
}

/**
 * Builds the per-request context factory. `theatres.search` needs nothing from the
 * request (no session, no headers), so the factory ignores `req` and binds only the
 * injected pool — the same required-no-default convention as every other factory here.
 */
export function createTheatreSearchContextFactory(
  opts: TheatreSearchContextOptions,
): (req: FastifyRequest) => TheatreSearchContext {
  const { db } = opts;
  return () => ({ db });
}
