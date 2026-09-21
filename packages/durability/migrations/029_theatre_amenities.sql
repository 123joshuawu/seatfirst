-- Migration 029: add amenities jsonb column to theatre table (ADR 0067)
ALTER TABLE theatre
  ADD COLUMN amenities jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN theatre.amenities IS
  'Array of venue-level amenities ({code, name, sort?}[]) captured from theatre discovery Flight JSON (ADR 0067).';
