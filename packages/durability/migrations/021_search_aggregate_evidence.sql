-- Search aggregate evidence column (S60, ADR 0066 §2).
--
-- Adds `evidence` beside the existing `search_aggregate.payload`, so a
-- nonterminal aggregation pass can persist the `assembleAnswerEvidence`
-- output (geometric masks and candidate seat coordinates) atomically with
-- the ranked payload. The column is nullable: pre-migration rows and the
-- revision-0 admission seed legitimately carry no evidence yet.
--
-- Deliberate deviations from source prose: none.
--
-- Postgres 16. Text namespaced IDs, timestamptz throughout, no frozen partition month.
-- No COMMIT mid-file (applyMigrations owns the transaction).

ALTER TABLE search_aggregate
  ADD COLUMN evidence jsonb NULL;
