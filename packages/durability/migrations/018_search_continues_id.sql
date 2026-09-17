-- ADR 0037 decision 3 — continuation chain link for batch continuation.
-- Stores the parent search_id when a search is a continuation (continuesSearchId).
-- FK-less per existing convention for soft references (e.g. search_job.run_key_id
-- has FK to run_key, but this is intentionally FK-less to avoid circular FK and
-- to keep the chain walk application-level, bounded by 200/20 hops).
-- Nullable: most searches are not continuations. Set once at creation in the
-- same transaction as B1_CREATE_SEARCH.
ALTER TABLE search ADD COLUMN continues_search_id text;
