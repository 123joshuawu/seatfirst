import type { SqlClient } from "@seatfirst/durability";

/**
 * Seed-data inserts for the relay suite — scaffolding that creates rows, not a state
 * transition (CONTRIBUTING.md §2's seed-data bucket). The relay's behavior is asserted
 * through the real durability statements (`SWEEP_OVERDUE_OUTBOX`,
 * `OUTBOX_MARK_PUBLISHED`, `OUTBOX_MARK_RETRY`); these helpers only build the FK chains
 * (`search` → `run_key` → `search_job` → `outbox`, and `run_key` → `provider_run` →
 * `outbox`) that the schema demands.
 */

export interface SeededJobOutbox {
  readonly outboxId: string;
  readonly jobId: string;
  readonly searchId: string;
}

export interface OutboxSeedOptions {
  /** Defaults to 'PENDING'. */
  readonly state?: "PENDING" | "PUBLISHED";
  /** Defaults to 0. */
  readonly attempt?: number;
  /** Defaults to a second in the past — deterministically due for the sweep. */
  readonly nextAttemptAt?: Date;
  /** Defaults to a second in the past. */
  readonly createdAt?: Date;
}

export async function seedJobOutbox(
  db: SqlClient,
  tag: string,
  options: OutboxSeedOptions = {},
): Promise<SeededJobOutbox> {
  const searchId = `srch_${tag}`;
  const jobId = `job_${tag}`;
  const runKeyId = `key_${tag}`;
  const outboxId = `obx_${tag}`;

  await db.query(
    `INSERT INTO search (search_id, session_id, idempotency_key, spec, spec_hash, status, deadline_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'PENDING_SCHEDULE', now() + interval '10 minutes')`,
    [searchId, `sess_${tag}`, `idem_${tag}`, `hash_${tag}`],
  );
  await db.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc:seed', 'seat', $2)`,
    [runKeyId, `st_${tag}`],
  );
  await db.query(
    `INSERT INTO search_job (job_id, search_id, kind, run_key_id, deadline_at)
     VALUES ($1, $2, 'SHOWTIME_FETCH', $3, now() + interval '10 minutes')`,
    [jobId, searchId, runKeyId],
  );
  await db.query(
    `INSERT INTO outbox (outbox_id, target_kind, job_id, state, attempt, next_attempt_at, created_at)
     VALUES ($1, 'JOB', $2, $3, $4, $5, $6)`,
    [
      outboxId,
      jobId,
      options.state ?? "PENDING",
      options.attempt ?? 0,
      options.nextAttemptAt ?? new Date(Date.now() - 1000),
      options.createdAt ?? new Date(Date.now() - 1000),
    ],
  );
  return { outboxId, jobId, searchId };
}

export interface SeededRunOutbox {
  readonly outboxId: string;
  readonly runId: string;
}

export async function seedRunOutbox(
  db: SqlClient,
  tag: string,
  options: OutboxSeedOptions = {},
): Promise<SeededRunOutbox> {
  const runKeyId = `key_${tag}`;
  const runId = `run_${tag}`;
  const outboxId = `obx_${tag}`;

  await db.query(
    `INSERT INTO run_key (run_key_id, kind, provider_id, route_class, showtime_id)
     VALUES ($1, 'SHOWTIME_FETCH', 'amc:seed', 'seat', $2)`,
    [runKeyId, `st_${tag}`],
  );
  await db.query(
    `INSERT INTO provider_run (run_id, run_key_id, observation_id, provider_epoch)
     VALUES ($1, $2, $3, 0)`,
    [runId, runKeyId, `obs_${tag}`],
  );
  await db.query(
    `INSERT INTO outbox (outbox_id, target_kind, run_id, state, attempt, next_attempt_at, created_at)
     VALUES ($1, 'RUN', $2, $3, $4, $5, $6)`,
    [
      outboxId,
      runId,
      options.state ?? "PENDING",
      options.attempt ?? 0,
      options.nextAttemptAt ?? new Date(Date.now() - 1000),
      options.createdAt ?? new Date(Date.now() - 1000),
    ],
  );
  return { outboxId, runId };
}
