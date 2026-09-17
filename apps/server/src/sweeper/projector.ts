/**
 * S33 — the S10.10 snapshot-projection compute step (ADR 0001 §5 duty 5; the revision-
 * fenced Redis CAS at `docs/adr/0001-durability-search-lifecycle.md:1283-1299`).
 *
 * `createSnapshotProjector` builds the `compute: (claim) => Promise<void>` the sweeper
 * injects between `B10_CLAIM_SNAPSHOT_PROJECTION` and `B10_ADVANCE_SNAPSHOT_WATERMARK`
 * (`apps/server/src/sweeper/duties.ts:279-322`). It does NOT advance the watermark — the
 * orchestrator does, only after `compute` returns (`duties.ts:305-313`) — so a normal
 * return is the ONLY success path, and every kind this task is not authorized to project
 * must throw rather than return silently (S33.7): a silent return would let the
 * orchestrator advance `projected_revision` and certify a projection that was never
 * written.
 *
 * SHOWTIME_FETCH is the only writable kind: it is the only kind whose payload shape is
 * pinned by an accepted document (the ADR's "revision alongside the bitmap", plus the
 * `availability_snapshot` columns), so its projection is a mechanical serialization, not
 * a design decision. SCHEDULE_RESOLUTION ("Redis schedule hot copy (TTL, §5)" is the
 * entire spec, `docs/adr/0001-durability-search-lifecycle.md:534`) and RECHECK (writes
 * `recheck_outcome`, never `availability_snapshot`/`performance`, and never advances
 * `accepted_revision`) have no pinned payload shape; writing either would invent a data
 * contract nobody signed off on, so both throw.
 *
 * Value shape (decided here, golden-tested in `apps/server/test/snapshot-projector.test.ts`):
 * the `bitmap` cache field carries the accepted `availability_snapshot` serialized as JSON
 * `{"bitmap":"<hex>","free_count":<int>,"captured_at":"<ISO-8601>"}` — the bytea bitmap
 * hex-encoded (lossless, deterministic) and the timestamptz as its UTC ISO-8601 string.
 * These are data, not policy: they are read from Postgres verbatim and carry no TTL or
 * freshness value (S33.6 — a TTL would be a gate-14 number and is deliberately absent).
 * The cache key is `bitmap:${runKeyId}`, the same convention the durability tier already
 * races at `packages/durability/test/tier5.race.test.ts:366-420`.
 *
 * A `SNAPSHOT_CAS` return of `0` (the concurrent winner already wrote `>=` this revision)
 * is NOT an error and is deliberately ignored: the orchestrator's
 * `B10_ADVANCE_SNAPSHOT_WATERMARK` handles that catch-up with its own conditional update,
 * exactly as `packages/durability/test/tier5.race.test.ts:407` proves.
 */
import { SNAPSHOT_CAS, SNAPSHOT_READ_FOR_PROJECTION, runStatement } from "@seatfirst/durability";
import type { RedisScriptExecutor, SqlClient } from "@seatfirst/durability";

import type { SnapshotProjectionClaim } from "./duties.js";

/** The `SNAPSHOT_READ_FOR_PROJECTION` row shape the producer consumes. */
interface SnapshotProjectionRow {
  readonly kind: string;
  readonly showtime_id: string | null;
  readonly bitmap: Buffer | null;
  readonly free_count: number | null;
  readonly captured_at: Date | null;
}

/**
 * A `run_key.kind` the producer has no pinned payload shape for. Throwing is the fail-loud
 * contract: `compute` is `(claim) => Promise<void>` with no return-value channel, so a
 * silent return would let the orchestrator advance the watermark and certify a projection
 * that was never written (S33.7).
 */
export class UnprojectableRunKeyKindError extends Error {
  readonly kind: string;
  readonly reason: string;

  constructor(kind: string, reason: string) {
    super(`cannot project run_key kind ${JSON.stringify(kind)}: ${reason}`);
    this.name = "UnprojectableRunKeyKindError";
    this.kind = kind;
    this.reason = reason;
  }
}

/** Serializes the accepted snapshot into the `bitmap` cache field (see module header). */
function serializeSnapshot(bitmap: Buffer, freeCount: number, capturedAt: Date): string {
  return JSON.stringify({
    bitmap: bitmap.toString("hex"),
    free_count: freeCount,
    captured_at: capturedAt.toISOString(),
  });
}

export function createSnapshotProjector(
  db: SqlClient,
  redis: RedisScriptExecutor,
): (claim: SnapshotProjectionClaim) => Promise<void> {
  return async (claim) => {
    const rows = await runStatement<SnapshotProjectionRow>(db, SNAPSHOT_READ_FOR_PROJECTION, [
      claim.runKeyId,
      claim.latestObservationId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `${SNAPSHOT_READ_FOR_PROJECTION.name} returned no run_key for ${claim.runKeyId}; ` +
          `the key vanished mid-claim — abort rather than certify a missing projection.`,
      );
    }

    switch (row.kind) {
      case "SHOWTIME_FETCH": {
        const { bitmap, free_count, captured_at } = row;
        if (bitmap === null || free_count === null || captured_at === null) {
          throw new Error(
            `run_key ${claim.runKeyId} is SHOWTIME_FETCH but observation ` +
              `${claim.latestObservationId ?? "(null)"} has no accepted availability_snapshot; ` +
              `abort rather than certify a missing projection.`,
          );
        }
        await redis.eval(
          SNAPSHOT_CAS,
          [`bitmap:${claim.runKeyId}`],
          [claim.acceptedRevision, serializeSnapshot(bitmap, free_count, captured_at)],
        );
        return;
      }
      case "SCHEDULE_RESOLUTION":
        throw new UnprojectableRunKeyKindError(
          row.kind,
          'no pinned payload shape exists (the ADR specifies only "Redis schedule hot copy ' +
            '(TTL, §5)"); writing it would invent an entire data contract nobody signed off on',
        );
      case "RECHECK":
        throw new UnprojectableRunKeyKindError(
          row.kind,
          "RECHECK writes recheck_outcome, never availability_snapshot/performance, and " +
            "never advances accepted_revision — it cannot reach this state in practice",
        );
      default:
        throw new UnprojectableRunKeyKindError(
          row.kind,
          "unrecognized run_key kind — exhaustiveness",
        );
    }
  };
}
