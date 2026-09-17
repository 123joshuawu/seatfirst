-- Theatre catalog, completed performance product fields, and first-party events.
--
-- Deliberate choices and deviations from product prose:
--   1. Theatre radius search uses a plain btree (lat, lng) index plus a latitude-band
--      prefilter and exact haversine predicate. This avoids a PostGIS deployment dependency;
--      the latitude-only prefilter remains correct at the poles and across the antimeridian.
--   2. `performance` rows are born during schedule acceptance, before product resolution.
--      movie_id, utc_offset, status, and deep_link_url are therefore nullable here even
--      though a fully resolved Performance requires them. `min_price` likewise remains null
--      until the seat fetch resolves.
--   3. show_date_time_utc is the existing starts_at column. show_date_time_local is derived
--      from starts_at plus the theatre's IANA zone and is not persisted as a second copy.
--   4. The existing attributes jsonb column remains authoritative for normalized attribute
--      codes; changing it to text[] would break the accepted schedule write.
--   5. auditorium is nullable text because it is an upstream display hint, not hard layout
--      identity; layout_id is the content-addressed identity and carries the FK.
--   6. Events have no session_id because the session design is still gate-blocked. Their type
--      is deliberately open text, and the DEFAULT partition is an alarm-only safety net.
--
-- Postgres 16. Text namespaced IDs, timestamptz throughout, and no frozen partition month.

CREATE TABLE theatre (
  theatre_id   text PRIMARY KEY
               CHECK (theatre_id ~ '^[^:]+:theatre:.+$'),
  provider_id  text NOT NULL CHECK (btrim(provider_id) <> ''),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  market_slug  text,
  -- A date-specific offset is unsafe across DST; the durable catalogue stores the IANA zone.
  timezone     text NOT NULL CHECK (btrim(timezone) <> ''),
  address      text,
  slugs        jsonb CHECK (slugs IS NULL OR jsonb_typeof(slugs) = 'object'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  CHECK (split_part(theatre_id, ':', 1) = provider_id),
  CHECK (last_seen_at >= first_seen_at)
);

-- The leading latitude column supports the safe latitude-band prefilter; longitude remains
-- available for bbox-style catalogue inspection without requiring a spatial extension.
CREATE INDEX theatre_geo_bbox ON theatre (lat, lng);
CREATE INDEX theatre_by_provider ON theatre (provider_id, theatre_id);

ALTER TABLE performance
  ADD COLUMN movie_id text,
  ADD COLUMN auditorium text,
  ADD COLUMN utc_offset text,
  ADD COLUMN runtime_minutes integer CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0),
  ADD COLUMN status text CHECK (status IN
    ('OPEN','LOW_AVAILABILITY','SOLD_OUT','CANCELED','UNKNOWN')),
  ADD COLUMN format_code text,
  -- Price is absent from schedules and stays null until a seat fetch resolves.
  ADD COLUMN min_price numeric CHECK (min_price IS NULL OR min_price >= 0),
  ADD COLUMN deep_link_url text,
  ADD COLUMN provider_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN layout_id text REFERENCES auditorium_layout (layout_id);

CREATE TABLE events (
  event_id   text NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE FUNCTION ensure_event_partitions(p_months integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', now())::date;
  v_from  date;
  v_to    date;
  v_name  text;
  v_made  integer := 0;
BEGIN
  IF p_months < 1 THEN
    RAISE EXCEPTION 'p_months must be >= 1, got %', p_months;
  END IF;

  FOR i IN 0..(p_months - 1) LOOP
    v_from := v_start + make_interval(months => i);
    v_to   := v_start + make_interval(months => i + 1);
    v_name := format('events_%s', to_char(v_from, 'YYYY_MM'));

    IF to_regclass(format('public.%I', v_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
        v_name, v_from, v_to);
      v_made := v_made + 1;
    END IF;
  END LOOP;

  RETURN v_made;
END;
$$;

COMMENT ON FUNCTION ensure_event_partitions(integer) IS
  'Create monthly first-party event partitions ahead of now(); retention/drop policy is '
  'deliberately outside this function and remains gate-blocked.';

CREATE TABLE events_default PARTITION OF events DEFAULT;
COMMENT ON TABLE events_default IS
  'Alarm-only safety net: rows here mean generated monthly event partitions are missing.';

-- Current month plus lookahead, generated from the database clock rather than a literal date.
SELECT ensure_event_partitions(3);
