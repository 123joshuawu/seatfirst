import { TRPCError } from "@trpc/server";

import type { Queryable } from "./queries.js";
import { readSearchSession } from "./queries.js";

/**
 * The mandatory pre-stream ownership check (S12.2; architecture §6.7 names it explicitly:
 * every result-bearing route verifies the caller's session owns the search — a `searchId`
 * is unguessable, but capability-by-obscurity is defense-in-depth, not the control).
 *
 * Run as tRPC middleware BEFORE the subscription resolver so a mismatch surfaces as a
 * UNAUTHORIZED error before the stream opens — not as the first streamed event.
 *
 * A missing search row is also UNAUTHORIZED, not NOT_FOUND: fail closed, and do not leak
 * which search ids exist to a caller who cannot own them.
 */
export async function assertCallerOwnsSearch(
  db: Queryable,
  searchId: string,
  callerSessionId: string | undefined,
): Promise<void> {
  const owner = await readSearchSession(db, searchId);
  if (owner === null || owner !== callerSessionId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "The caller's session does not own this search",
    });
  }
}
