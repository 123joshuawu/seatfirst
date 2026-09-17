-- O7 (ADR 0031, approved 2026-08-22) — cross-process trace propagation: the outbox
-- carries the W3C `traceparent` captured at the HTTP boundary so the worker side of a
-- delivery continues the caller's trace instead of starting a disconnected one.
--
-- Deliberate choices:
--   1. Nullable `text` with no CHECK — rows written by the sweeper's re-arm/reclaim
--      statements and the searchless TMDB dispatch have no HTTP origin; they write NULL
--      explicitly, because a fabricated parent would graft a retry onto a stale trace
--      (ADR 0031). NULL means "no request span was active", not an empty string.
--   2. No backfill — existing PENDING rows keep NULL; only deliveries created after this
--      migration can carry a parent span.

ALTER TABLE outbox ADD COLUMN traceparent text;
