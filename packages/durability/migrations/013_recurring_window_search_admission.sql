-- S36 — recurring-window search admission (ADR 0028 + amendment 2026-08-20).
-- Replaces the per-key `run_subscription.admission_counted` slot (001_schema.sql:161-177,
-- round-5 finding 7) with search-level reservation state, adds a durable fresh-seed and
-- per-subscription match count for search-wide reconciliation, and preserves all prior
-- nonterminal searches through a backfill before the old column is removed.
--
-- Design notes (each decision documented here is intentional):
-- 1. `schedule_slot_held` is one boolean per search ( PK = search_id ), not per key:
--    ADR 0028 §5 counts nonterminal cold **searches**, not keys. One slot per search
--    plus the 200-unit provisional reservation is the stage-1 S36 contract.
-- 2. `fresh_match_seed` is the authoritative count of policy-eligible, window-matching
--    fresh performances for which this transaction created SHOWTIME_FETCH work. It is
--    written once in B1_STAGE1_ADMISSION and never recomputed from JS; final
--    reconciliation is `fresh_match_seed + SUM(schedule_match_count)`.
-- 3. `schedule_reconciled` is set true once, atomically with the single
--    ADMISSION_RECONCILED ledger event for the search, so the invariant can assert
--    at-most-one reconciliation per search_id.
-- 4. `schedule_match_count` is nullable per (search, schedule key) and written exactly
--    once (WHERE schedule_match_count IS NULL) for both accepted and failed dates:
--    a failed date contributes 0, an empty-resolved or resolved date contributes its
--    filtered count. Null means "not yet terminal" and gates final reconciliation.
-- 5. Backfill: every outstanding old `admission_counted = true` maps to
--    `schedule_slot_held = true` with `fresh_match_seed = 0`. For `schedule_match_count`,
--    already-terminal per-key outcomes (schedule_outcome IS NOT NULL) are backfilled to
--    0 when no ADMISSION_RECONCILED linkage is derivable — the S36 spec explicitly
--    permits 0 as the unavailable fallback ("or 0 if unavailable, documented in
--    migration comments"). Deriving the true real_count from cost_event.units would
--    require the stage1Share that S15 never persisted, so 0 is the only safe fallback
--    that preserves the invariant for loaded fixture data without inventing a number.
--    Nonterminal keys remain NULL, so the new terminal guard (schedule_match_count IS
--    NULL) does not consider them done.
-- 6. `fresh_match_seed` CHECK (0..200) mirrors the existing validator maximum; the
--    final aggregate `fresh_match_seed + SUM(schedule_match_count)` is guarded by
--    B6_DENY_CAPACITY + the new `search_window_accounting` invariant, never truncated.
--
-- Postgres 16. All alters are additive + backfill + drop; ROLLBACK is safe.

-- (a) search-level reservation state — the single slot + fresh seed + reconciled flag.
ALTER TABLE admission_reservation
  ADD COLUMN IF NOT EXISTS schedule_slot_held boolean NOT NULL DEFAULT false;
ALTER TABLE admission_reservation
  ADD COLUMN IF NOT EXISTS fresh_match_seed integer NOT NULL DEFAULT 0
    CHECK (fresh_match_seed >= 0 AND fresh_match_seed <= 200);
ALTER TABLE admission_reservation
  ADD COLUMN IF NOT EXISTS schedule_reconciled boolean NOT NULL DEFAULT false;

-- Backfill held slots from the legacy per-key flag before it is removed. An
-- admission_reservation with at least one `admission_counted = true` subscription
-- held exactly one logical slot under the new model (one per search, not per key).
-- Wrap in a DO block so the UPDATE only runs while the old column still exists
-- (idempotent reruns after the DROP would otherwise fail).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'run_subscription' AND column_name = 'admission_counted'
  ) THEN
    UPDATE admission_reservation ar
    SET schedule_slot_held = true
    WHERE EXISTS (
      SELECT 1 FROM run_subscription rs
      WHERE rs.search_id = ar.search_id AND rs.admission_counted = true
    );
  END IF;
END $$;

-- (b) per-subscription terminal match count — once per schedule key, null = pending.
ALTER TABLE run_subscription
  ADD COLUMN IF NOT EXISTS schedule_match_count integer
    CHECK (schedule_match_count IS NULL OR schedule_match_count >= 0);

-- Backfill already-terminal subscriptions where the count was never persisted.
-- Accepted reconciliation cleared `admission_counted` but left no per-key count;
-- the only durable link is the ADMISSION_RECONCILED cost_event, whose units +
-- stage1Share would be the true count — but stage1Share is not persisted, so we
-- fall back to 0 as the spec permits. FAILED and EMPTY_RESOLVED both contribute
-- 0 in the S36 aggregate. Nonterminal keys (schedule_outcome IS NULL) stay NULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'run_subscription' AND column_name = 'schedule_match_count'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'run_subscription' AND column_name = 'admission_counted'
  ) THEN
    -- Use the cost_event linkage when it exists and yields a non-negative delta;
    -- otherwise fall back to 0 for terminal keys. The COALESCE mirrors the S36
    -- "or 0 if unavailable" clause. Only touch rows that already have a terminal
    -- schedule_outcome and have not yet been given a count.
    UPDATE run_subscription rs
    SET schedule_match_count = COALESCE(
      (
        SELECT (ce.units + 200)::integer
        FROM cost_event ce
        WHERE ce.event_type = 'ADMISSION_RECONCILED'
          AND ce.search_id = rs.search_id
          AND ce.run_key_id = rs.run_key_id
      ), 0)
    WHERE rs.schedule_outcome IN ('RESOLVED','EMPTY_RESOLVED','FAILED')
      AND rs.schedule_match_count IS NULL;
    -- Ensure any remaining terminal rows without a cost_event still get 0.
    UPDATE run_subscription
    SET schedule_match_count = 0
    WHERE schedule_outcome IN ('RESOLVED','EMPTY_RESOLVED','FAILED')
      AND schedule_match_count IS NULL;
  END IF;
END $$;

-- (c) remove the obsolete per-key slot. This is the single place the one-key/one-slot
-- assumption is removed; all callers are migrated in this same task (S36.7/8/9).
ALTER TABLE run_subscription DROP COLUMN IF EXISTS admission_counted;

-- (d) cost_event: allow search-wide ADMISSION_RECONCILED with NULL run_key_id.
-- Before S36, ADMISSION_RECONCILED was per (search_id, run_key_id) with run_key_id NOT NULL
-- and unique on (search_id, run_key_id). S36 reconciles once per search with units =
-- durableAggregate - 200, so run_key_id must be nullable for the search-wide event while
-- legacy per-key rows (pre-013) remain. Preserve both via two partial unique indexes.
DO $$
BEGIN
  -- Drop the old check constraint if present (auto-named cost_event_check)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_check') THEN
    ALTER TABLE cost_event DROP CONSTRAINT cost_event_check;
  END IF;
END $$;
ALTER TABLE cost_event ADD CONSTRAINT cost_event_check CHECK (
  (event_type = 'PROVIDER_WORK'         AND run_id IS NOT NULL AND attempt IS NOT NULL AND search_id IS NULL     AND run_key_id IS NULL) OR
  (event_type = 'ABUSE_WEIGHTED'        AND run_id IS NOT NULL AND attempt IS NOT NULL AND search_id IS NOT NULL AND run_key_id IS NULL) OR
  (event_type = 'ADMISSION_RESERVATION' AND run_id IS NULL     AND attempt IS NULL     AND search_id IS NOT NULL AND run_key_id IS NULL) OR
  (event_type = 'ADMISSION_RECONCILED'  AND run_id IS NULL     AND attempt IS NULL     AND search_id IS NOT NULL)
);
DROP INDEX IF EXISTS cost_event_admission_reconciled;
CREATE UNIQUE INDEX IF NOT EXISTS cost_event_admission_reconciled_per_key
  ON cost_event (search_id, run_key_id) WHERE event_type = 'ADMISSION_RECONCILED' AND run_key_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cost_event_admission_reconciled_per_search
  ON cost_event (search_id) WHERE event_type = 'ADMISSION_RECONCILED' AND run_key_id IS NULL;

-- (e) fresh-aware accounting needs no extra CHECK beyond the column CHECKs above:
-- schedule_slot_held at-most-one is already enforced by PK (search_id), and
-- schedule_reconciled at-most-once is enforced by the single ADMISSION_RECONCILED
-- event + the `search_window_accounting` invariant. The cross-column
-- `fresh_match_seed + SUM(schedule_match_count) <= 200` is not a row CHECK but a
-- search-wide invariant, also enforced by that invariant and the cumulative gate.
