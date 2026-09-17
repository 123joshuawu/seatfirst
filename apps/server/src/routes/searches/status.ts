import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { SearchStatusSchema } from "@seatfirst/core";

import { assertCallerOwnsSearch } from "../../streaming/ownership.js";
import { readSearchStatus } from "../../streaming/queries.js";
import { t } from "./create.js";

/**
 * `searches.status` — S60's dedicated fast status probe for client
 * cancel-timeout recovery (ADR 0066 §5). Returns the search's current status
 * for every status including `CANCELLED`, distinct from `searches.get` which
 * rejects cancelled searches. Mounted on `create`'s `t`
 * (`SearchCreateContext`) — it consumes only `ctx.db` and `ctx.sessionId`.
 */

export const statusInput = z.object({
  searchId: z.string().regex(/^srch_.+$/, "searchId must be a `srch_`-prefixed opaque identifier"),
});
export type StatusInput = z.infer<typeof statusInput>;

export const statusOutput = z.object({
  searchId: z.string(),
  status: SearchStatusSchema,
});

/** S60.8 — ownership before any read; a missing/foreign row is UNAUTHORIZED. */
const ownership = t.middleware(async ({ ctx, input, next }) => {
  const { searchId } = input as StatusInput;
  await assertCallerOwnsSearch(ctx.db, searchId, ctx.sessionId);
  return next();
});

export const status = t.procedure
  .input(statusInput)
  .output(statusOutput)
  .use(ownership)
  .query(async ({ input, ctx }) => {
    const { searchId } = input;
    const status = await readSearchStatus(ctx.db, searchId);
    if (status === null) {
      // Unreachable past ownership (which throws UNAUTHORIZED for a missing
      // row), but fail closed rather than fabricate a status.
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return { searchId, status: SearchStatusSchema.parse(status) };
  });
