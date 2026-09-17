/**
 * The typed handler seam (S11.6/S11.9). Three dispatch branches, each with its own
 * context shape; the registry (`./handlers.ts`) is a TypeScript-enforced exhaustive map
 * over the two job/run kinds plus the single AGGREGATE slot — a kind added to the schema's
 * CHECK constraint later fails to compile here until a handler (real or placeholder) is
 * registered for it, rather than silently falling through to a default (S11.6).
 */
import type { SqlClient } from "@seatfirst/durability";

import type { JobKind, JobRow, RunKeyKind, RunKeyRow, RunRow, SearchRow } from "./queries.js";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

export interface JobHandlerContext {
  readonly job: JobRow;
  readonly search: SearchRow;
  readonly runKey: RunKeyRow;
  readonly sqlClient: SqlClient;
  /** Child of the consumer's `DispatchDeps.logger`, pre-merged with this target's ids
   * (O6.3) — handlers log through it so every line carries job/run/search identity. */
  readonly logger: SeatfirstLogger;
}

export interface RunHandlerContext {
  readonly run: RunRow;
  /** Best-effort — see `./queries.ts`'s `findRunContext` doc comment. */
  readonly search: SearchRow | null;
  readonly runKey: RunKeyRow;
  readonly sqlClient: SqlClient;
  /** Child of the consumer's `DispatchDeps.logger`, pre-merged with this target's ids
   * (O6.3) — handlers log through it so every line carries job/run/search identity. */
  readonly logger: SeatfirstLogger;
}

export interface AggregateHandlerContext {
  readonly search: SearchRow;
  /** From B7_CLAIM's `RETURNING` — authoritative even though `search.aggGeneration` may be
   * the pre-claim value (the claim is what just bumped it). */
  readonly aggGeneration: number;
  /** From B7_CLAIM's `RETURNING` (bigint, surfaced as a string by pg). */
  readonly aggRequestedRev: string;
  readonly sqlClient: SqlClient;
  /** Child of the consumer's `DispatchDeps.logger`, pre-merged with this target's ids
   * (O6.3) — handlers log through it so every line carries search/claim identity. */
  readonly logger: SeatfirstLogger;
}

export type JobHandlerFn = (context: JobHandlerContext) => void | Promise<void>;
export type RunHandlerFn = (context: RunHandlerContext) => void | Promise<void>;
export type AggregateHandlerFn = (context: AggregateHandlerContext) => void | Promise<void>;

/**
 * One registry slot. `implemented: false` is what S11.3/S11.4 check BEFORE leasing or
 * claiming — the harness never invokes `handler` in that case, it logs `reason` and acks.
 * `handler` still throws `reason` verbatim when invoked directly (S11.7): a unit test can
 * call a placeholder's `handler` in isolation and observe the named, non-guessed failure,
 * while the harness itself short-circuits earlier and never reaches that throw.
 */
export type HandlerEntry<Fn> =
  | { readonly implemented: true; readonly handler: Fn }
  | { readonly implemented: false; readonly reason: string; readonly handler: Fn };

export interface DispatchRegistry {
  readonly job: Readonly<Record<JobKind, HandlerEntry<JobHandlerFn>>>;
  readonly run: Readonly<Record<RunKeyKind, HandlerEntry<RunHandlerFn>>>;
  readonly aggregate: HandlerEntry<AggregateHandlerFn>;
}
