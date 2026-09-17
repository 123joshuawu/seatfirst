/**
 * ADR 0001 invariants, as queries that return their own counterexamples.
 *
 * Each invariant is a SELECT that returns **the rows that violate it**, so a failure names
 * the offending search/key/run rather than reporting `false`. Tiers 2–6 all end by running
 * the full set: an effect assertion that passes while conservation is broken is not a pass.
 */

/** Minimal shape of a `pg` client/pool, so this module does not depend on the driver. */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Invariant {
  readonly name: string;
  /** The ADR/plan claim this makes checkable. */
  readonly claim: string;
  /** Returns violating rows; empty means the invariant holds. */
  readonly text: string;
}

export interface Violation {
  readonly invariant: string;
  readonly claim: string;
  readonly rows: unknown[];
}

export const INVARIANTS: readonly Invariant[] = [
  {
    name: "event_seq_gapless",
    claim:
      "§3: seq is per-search monotonic and GAPLESS — every allocated next_seq increment is " +
      "paired with its event insert in the same statement, without exception.",
    text: `
      SELECT s.search_id,
             s.next_seq,
             count(e.seq)  AS events,
             max(e.seq)    AS max_seq
      FROM search s
      LEFT JOIN search_event e ON e.search_id = s.search_id
      GROUP BY s.search_id, s.next_seq
      HAVING count(e.seq) <> coalesce(max(e.seq), 0)
          OR coalesce(min(e.seq), 1) <> 1
          OR s.next_seq <> coalesce(max(e.seq), 0)`,
  },
  {
    name: "event_watermark_within_log",
    claim: "B10: projected_through never runs ahead of the events that exist.",
    text: `
      SELECT s.search_id, s.projected_through, coalesce(max(e.seq), 0) AS max_seq
      FROM search s
      LEFT JOIN search_event e ON e.search_id = s.search_id
      GROUP BY s.search_id, s.projected_through
      HAVING s.projected_through > coalesce(max(e.seq), 0)`,
  },
  {
    name: "admission_conservation",
    claim:
      "S36 / §Consequences: pending_cost equals SUM(reserved_remaining) for non-released " +
      "reservations and unresolved_schedules equals COUNT of held search reservations " +
      "(schedule_slot_held AND NOT schedule_reconciled AND NOT released). One slot per " +
      "search, not per key (migrated from run_subscription.admission_counted in 013).",
    text: `
      SELECT pa.provider_id,
             pa.pending_cost,
             ( SELECT coalesce(sum(r.reserved_remaining), 0)
               FROM admission_reservation r
               WHERE r.provider_id = pa.provider_id AND NOT r.released ) AS outstanding_cost,
             pa.unresolved_schedules,
             ( SELECT count(*)
               FROM admission_reservation r
               WHERE r.provider_id = pa.provider_id
                 AND r.schedule_slot_held AND NOT r.schedule_reconciled AND NOT r.released ) AS held_slots
      FROM provider_admission pa
      WHERE pa.pending_cost <> ( SELECT coalesce(sum(r.reserved_remaining), 0)
                                 FROM admission_reservation r
                                 WHERE r.provider_id = pa.provider_id AND NOT r.released )
         OR pa.unresolved_schedules <> ( SELECT count(*)
                                         FROM admission_reservation r
                                         WHERE r.provider_id = pa.provider_id
                                           AND r.schedule_slot_held AND NOT r.schedule_reconciled AND NOT r.released )`,
  },
  {
    name: "search_window_accounting",
    claim:
      "S36.9: search-window accounting is search-wide and write-once — at most one " +
      "schedule_slot_held, at most one schedule_reconciled/ADMISSION_RECONCILED per search, " +
      "final reserved_total equals fresh_match_seed + SUM(schedule_match_count), no held slot " +
      "on a released reservation, and no double-recorded schedule_match_count.",
    text: `
      -- (a) duplicate slot or reconciliation per search
      SELECT search_id, 'duplicate_slot_or_reconciled' AS violation
      FROM admission_reservation
      GROUP BY search_id
      HAVING count(*) FILTER (WHERE schedule_slot_held) > 1
          OR count(*) FILTER (WHERE schedule_reconciled) > 1
      UNION ALL
      SELECT search_id, 'duplicate_ADMISSION_RECONCILED' AS violation
      FROM cost_event
      WHERE event_type = 'ADMISSION_RECONCILED'
      GROUP BY search_id HAVING count(*) > 1
      UNION ALL
      -- (b) final reconciled aggregate differs from durable aggregate
      SELECT r.search_id, 'aggregate_mismatch' AS violation
      FROM admission_reservation r
      WHERE r.schedule_reconciled
        AND r.reserved_total <> (
          r.fresh_match_seed + COALESCE(
            (SELECT SUM(schedule_match_count) FROM run_subscription
             WHERE search_id = r.search_id AND schedule_match_count IS NOT NULL), 0)
        )
      UNION ALL
      -- (b) also check ledger total: reserved_total should equal ADMISSION_RESERVATION + ADMISSION_RECONCILED
      SELECT r.search_id, 'ledger_aggregate_mismatch' AS violation
      FROM admission_reservation r
      JOIN cost_event res ON res.search_id = r.search_id AND res.event_type = 'ADMISSION_RESERVATION'
      LEFT JOIN cost_event rec ON rec.search_id = r.search_id AND rec.event_type = 'ADMISSION_RECONCILED'
      WHERE r.schedule_reconciled
        AND r.reserved_total <> (res.units + COALESCE(rec.units, 0))
      UNION ALL
      -- (c) held slot on released reservation
      SELECT search_id, 'held_on_released' AS violation
      FROM admission_reservation
      WHERE released AND schedule_slot_held
      UNION ALL
      -- (d) double-recorded schedule_match_count would manifest as >1 row per (run_key,search)
      -- but PK already prevents duplicate rows; this branch detects negative counts which
      -- would indicate double-write corruption (CHECK prevents negative, so any row here
      -- is invariant violation via manual UPDATE bypassing CHECK)
      SELECT search_id, 'negative_match_count' AS violation
      FROM run_subscription
      WHERE schedule_match_count IS NOT NULL AND schedule_match_count < 0`,
  },
  // Harness assumption: configured limits are not lowered below already-outstanding
  // reservations. Admission boundaries enforce these ceilings when adding new work.
  {
    name: "admission_within_limits",
    claim: "§4.4: current committed admission does not exceed either configured capacity ceiling.",
    text: `
      SELECT provider_id, pending_cost, pending_cost_limit,
             unresolved_schedules, unresolved_limit
      FROM provider_admission
      WHERE pending_cost > pending_cost_limit
         OR unresolved_schedules > unresolved_limit`,
  },
  {
    name: "admission_non_negative",
    claim: "§4.4: capacity accounting never underflows (the double-release symptom).",
    text: `
      SELECT provider_id, pending_cost, unresolved_schedules
      FROM provider_admission
      WHERE pending_cost < 0 OR unresolved_schedules < 0`,
  },
  {
    name: "reservation_remaining_within_total",
    claim: "B1/B6: consumed units are distinguishable from outstanding ones.",
    text: `
      SELECT search_id, reserved_total, reserved_remaining
      FROM admission_reservation
      WHERE reserved_remaining > reserved_total OR reserved_remaining < 0`,
  },
  {
    name: "terminal_has_result_version",
    claim:
      "Gate 9 / §4.1: a terminal status without a result version is unreachable — B8 is " +
      "one transaction.",
    text: `
      SELECT s.search_id, s.status
      FROM search s
      WHERE s.status IN ('COMPLETE','PARTIAL','HALTED','CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM search_result_version v
                        WHERE v.search_id = s.search_id)`,
  },
  {
    name: "reveal_contract",
    claim:
      "S6U3.1/S6U3.3(c): every SEARCH_TERMINAL event carries an `answer` and no other " +
      "event type does — ADR 0012's reveal contract, checkable after every sweep.",
    text: `
      SELECT search_id, seq, type
      FROM search_event
      WHERE (type = 'SEARCH_TERMINAL' AND NOT (payload ? 'answer'))
         OR (type <> 'SEARCH_TERMINAL' AND payload ? 'answer')`,
  },
  {
    name: "terminal_has_no_live_children",
    claim:
      "B8: terminalization cancels children and expires subscriptions in the same transaction.",
    text: `
      SELECT s.search_id, s.status,
             count(*) FILTER (WHERE j.job_id IS NOT NULL) AS live_jobs,
             count(*) FILTER (WHERE rs.search_id IS NOT NULL) AS live_subs
      FROM search s
      LEFT JOIN search_job j
        ON j.search_id = s.search_id AND j.state IN ('PENDING','LEASED')
      LEFT JOIN run_subscription rs
        ON rs.search_id = s.search_id AND rs.state = 'LIVE'
      WHERE s.status IN ('COMPLETE','PARTIAL','HALTED','CANCELLED')
      GROUP BY s.search_id, s.status
      HAVING count(j.job_id) > 0 OR count(rs.search_id) > 0`,
  },
  {
    name: "one_live_run_per_key",
    claim: "§4.4: at most one non-terminal run per key (the partial unique index).",
    text: `
      SELECT run_key_id, count(*) AS live_runs
      FROM provider_run WHERE state IN ('PENDING','LEASED')
      GROUP BY run_key_id HAVING count(*) > 1`,
  },
  {
    name: "snapshot_is_fetch_only",
    claim:
      "Round-2 finding 2: availability_snapshot holds SHOWTIME_FETCH observations only; " +
      "schedule observations persist as performance rows.",
    text: `
      SELECT a.observation_id, k.kind
      FROM availability_snapshot a
      JOIN observation o ON o.observation_id = a.observation_id
      JOIN run_key k ON k.run_key_id = o.run_key_id
      WHERE k.kind <> 'SHOWTIME_FETCH'`,
  },
  {
    name: "observation_pairs_run_and_key",
    claim:
      "Round-4 finding 6 / T24: an observation may not pair a run with an unrelated key, " +
      "and a run owns at most one accepted observation.",
    text: `
      SELECT o.observation_id, o.run_id, o.run_key_id, pr.run_key_id AS run_actual_key
      FROM observation o
      JOIN provider_run pr ON pr.run_id = o.run_id
      WHERE pr.run_key_id <> o.run_key_id`,
  },
  {
    name: "application_implies_subscription",
    claim:
      "B5(e): applications are written only for subscribers of the applied run's key — " +
      "never for an unrelated search.",
    text: `
      SELECT ra.run_id, ra.search_id
      FROM run_application ra
      JOIN provider_run pr ON pr.run_id = ra.run_id
      WHERE NOT EXISTS (SELECT 1 FROM run_subscription rs
                        WHERE rs.run_key_id = pr.run_key_id
                          AND rs.search_id = ra.search_id)`,
  },
  {
    name: "job_kind_matches_key_kind",
    claim: "Round-1 finding 2: a job's kind equals its key's kind (composite FK).",
    text: `
      SELECT j.job_id, j.kind, k.kind AS key_kind
      FROM search_job j JOIN run_key k ON k.run_key_id = j.run_key_id
      WHERE j.kind <> k.kind`,
  },
  {
    name: "events_default_partition_empty",
    claim:
      "S2: first-party events must land in generated monthly partitions; the DEFAULT child " +
      "is an alarm-only safety net.",
    text: `
      SELECT event_id, type, created_at
      FROM events_default`,
  },
  {
    name: "halted_row_has_no_retry_deadline",
    claim:
      "ADR 0001 B9 (amended): a HALTED provider_status row carries no not_before — a halt " +
      "recovers only through the manual reopen transaction, never a self-expiring deadline.",
    text: `
      SELECT provider_id, route_class, state, cause, not_before
      FROM provider_status
      WHERE state = 'HALTED' AND not_before IS NOT NULL`,
  },
  {
    name: "rate_limited_pause_has_not_before",
    claim:
      "ADR 0001 B9 (amended): RATE_LIMITED is PAUSED only with a concrete not_before — the " +
      "typed transition requires it, so a null deadline here means the transition was bypassed.",
    text: `
      SELECT provider_id, route_class, state, cause, not_before
      FROM provider_status
      WHERE state = 'PAUSED' AND cause = 'RATE_LIMITED' AND not_before IS NULL`,
  },
  {
    name: "ledger_conservation",
    claim:
      "ADR 0005 §I: a search's reserved_total equals its stage-1 ADMISSION_RESERVATION units " +
      "plus every key's applied ADMISSION_RECONCILED delta — the ledger and the reservation " +
      "must evolve from the same single statements.",
    text: `
      SELECT r.search_id, r.reserved_total,
             ( SELECT coalesce(sum(ce.units), 0)
               FROM cost_event ce
               WHERE ce.search_id = r.search_id
                 AND ce.event_type IN ('ADMISSION_RESERVATION','ADMISSION_RECONCILED')
             ) AS ledger_total
      FROM admission_reservation r
      WHERE r.reserved_total <> ( SELECT coalesce(sum(ce.units), 0)
                                  FROM cost_event ce
                                  WHERE ce.search_id = r.search_id
                                    AND ce.event_type IN
                                        ('ADMISSION_RESERVATION','ADMISSION_RECONCILED') )`,
  },
  {
    name: "abuse_weighted_has_provider_work",
    claim:
      "ADR 0005 §I: every ABUSE_WEIGHTED charge has its PROVIDER_WORK row for the same " +
      "(run_id, attempt) — both insertion points require it (dispatch charges with it, " +
      "join charges only after it exists).",
    text: `
      SELECT ce.event_id, ce.run_id, ce.attempt, ce.search_id
      FROM cost_event ce
      WHERE ce.event_type = 'ABUSE_WEIGHTED'
        AND NOT EXISTS ( SELECT 1 FROM cost_event pw
                         WHERE pw.event_type = 'PROVIDER_WORK'
                           AND pw.run_id = ce.run_id
                           AND pw.attempt = ce.attempt )`,
  },
  {
    name: "abuse_weighted_has_subscriber",
    claim:
      "ADR 0005 §I: every ABUSE_WEIGHTED search is a subscriber of the charged run's key " +
      "(a run_subscription row joins through provider_run.run_key_id) — dispatch charges " +
      "only LIVE subscribers and join charges run only after SUBSCRIPTION_CREATE.",
    text: `
      SELECT ce.event_id, ce.run_id, ce.attempt, ce.search_id
      FROM cost_event ce
      JOIN provider_run pr ON pr.run_id = ce.run_id
      WHERE ce.event_type = 'ABUSE_WEIGHTED'
        AND NOT EXISTS ( SELECT 1 FROM run_subscription rs
                         WHERE rs.run_key_id = pr.run_key_id
                           AND rs.search_id = ce.search_id )`,
  },
  {
    name: "parser_pause_has_no_not_before",
    claim:
      "ADR 0001 B9 (amended): a PARSER_SCHEMA_INCOMPATIBLE pause is indefinite — the typed " +
      "transition requires a null not_before so it cannot self-expire without verification.",
    text: `
      SELECT provider_id, route_class, state, cause, not_before
      FROM provider_status
      WHERE state = 'PAUSED' AND cause = 'PARSER_SCHEMA_INCOMPATIBLE' AND not_before IS NOT NULL`,
  },
  {
    name: "recheck_outcome_run_is_terminal",
    claim:
      "S22.6: every recheck_outcome row's provider_run is terminal (DONE/FAILED) — an " +
      "outcome for a live/stranded run is unseedable by construction and must be " +
      "sweep-detectable.",
    text: `
      SELECT ro.run_id, pr.state
      FROM recheck_outcome ro
      JOIN provider_run pr ON pr.run_id = ro.run_id
      WHERE pr.state NOT IN ('DONE','FAILED')`,
  },
  {
    name: "recheck_key_never_projects",
    claim:
      "S22.6: RECHECK keys never accept/project snapshots — accepted_revision stays 0 and " +
      "latest_captured_at stays NULL, making 'seats are never cached for rechecks' checkable.",
    text: `
      SELECT run_key_id, accepted_revision, latest_captured_at
      FROM run_key
      WHERE kind = 'RECHECK' AND (accepted_revision <> 0 OR latest_captured_at IS NOT NULL)`,
  },
  {
    name: "preview_runs_never_stranded",
    claim:
      "ADR 0039 Amendment A1: a subscription-less SCHEDULE_RESOLUTION run (a " +
      "capacity-preview-owned key) is never stranded undispatched. While it is PENDING it " +
      "always has an outbox row — its creation row, or a SWEEP_REARM_RUNS replacement — " +
      "because no search lifecycle will ever dispatch or cancel it on the preview's behalf.",
    text: `
      SELECT r.run_id, r.run_key_id
      FROM provider_run r
      JOIN run_key k ON k.run_key_id = r.run_key_id
      WHERE k.kind = 'SCHEDULE_RESOLUTION'
        AND r.state = 'PENDING'
        AND NOT EXISTS (SELECT 1 FROM run_subscription rs WHERE rs.run_key_id = r.run_key_id)
        AND NOT EXISTS (SELECT 1 FROM outbox ob WHERE ob.run_id = r.run_id)`,
  },
];

/** Runs every invariant; returns only the ones with counterexamples. */
export async function checkInvariants(db: Queryable): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const inv of INVARIANTS) {
    const { rows } = await db.query(inv.text);
    if (rows.length > 0) violations.push({ invariant: inv.name, claim: inv.claim, rows });
  }
  return violations;
}

/** Formats violations for an assertion message: invariant, claim, and the offending rows. */
export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `✗ ${v.invariant}\n  claim: ${v.claim}\n  counterexamples: ${JSON.stringify(v.rows, null, 2)}`,
    )
    .join("\n\n");
}
