-- ADR 0104 / S65: a movie-first schedule key is a distinct route and identity.
-- It carries the AMC movie slug plus an anchor theatre/date; requested theatre membership
-- belongs to each subscriber because the same cluster run may serve different searches.

ALTER TABLE run_key ADD COLUMN IF NOT EXISTS movie_slug text;

ALTER TABLE run_key DROP CONSTRAINT IF EXISTS run_key_kind_check;
ALTER TABLE run_key ADD CONSTRAINT run_key_kind_check
  CHECK (kind IN ('SHOWTIME_FETCH','SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION','RECHECK'));

ALTER TABLE run_key DROP CONSTRAINT IF EXISTS run_key_route_class_check;
ALTER TABLE run_key ADD CONSTRAINT run_key_route_class_check
  CHECK (route_class IN ('seat','schedule','movie-schedule'));

ALTER TABLE run_key DROP CONSTRAINT IF EXISTS run_key_check;
ALTER TABLE run_key ADD CONSTRAINT run_key_check
  CHECK (
    (kind IN ('SHOWTIME_FETCH','RECHECK') AND route_class = 'seat')
    OR (kind = 'SCHEDULE_RESOLUTION' AND route_class = 'schedule')
    OR (kind = 'MOVIE_SCHEDULE_RESOLUTION' AND route_class = 'movie-schedule')
  );

ALTER TABLE run_key DROP CONSTRAINT IF EXISTS run_key_check2;
ALTER TABLE run_key ADD CONSTRAINT run_key_check2
  CHECK (
    (kind = 'SHOWTIME_FETCH'
       AND showtime_id IS NOT NULL AND theatre_id IS NULL AND local_date IS NULL AND movie_slug IS NULL)
    OR
    (kind = 'SCHEDULE_RESOLUTION'
       AND showtime_id IS NULL AND theatre_id IS NOT NULL AND local_date IS NOT NULL AND movie_slug IS NULL)
    OR
    (kind = 'MOVIE_SCHEDULE_RESOLUTION'
       AND showtime_id IS NULL AND theatre_id IS NOT NULL AND local_date IS NOT NULL AND movie_slug IS NOT NULL)
    OR
    (kind = 'RECHECK'
       AND showtime_id IS NOT NULL AND theatre_id IS NULL AND local_date IS NULL AND movie_slug IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS run_key_movie_schedule
  ON run_key (provider_id, movie_slug, theatre_id, local_date)
  WHERE kind = 'MOVIE_SCHEDULE_RESOLUTION';

ALTER TABLE search_job DROP CONSTRAINT IF EXISTS search_job_kind_check;
ALTER TABLE search_job ADD CONSTRAINT search_job_kind_check
  CHECK (kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION','SHOWTIME_FETCH'));

ALTER TABLE run_subscription ADD COLUMN IF NOT EXISTS movie_candidate_theatre_ids jsonb;
ALTER TABLE run_subscription DROP CONSTRAINT IF EXISTS run_subscription_movie_candidate_theatre_ids_check;
ALTER TABLE run_subscription ADD CONSTRAINT run_subscription_movie_candidate_theatre_ids_check
  CHECK (movie_candidate_theatre_ids IS NULL OR jsonb_typeof(movie_candidate_theatre_ids) = 'array');
