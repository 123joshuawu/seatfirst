#!/bin/sh
set -eu

# Runs only while the Postgres image creates a new data directory.
# Creates the dedicated unprivileged application role (ADR 0081 §9 / SEC-03).
# The app, worker, sweeper, and tmdb containers connect using this role,
# restricting runtime execution strictly to DML operations on schema public.
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"

DB_NAME="${POSTGRES_DB:-postgres}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" \
  --set=database_name="$DB_NAME" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'EOSQL'
SELECT format(
  'CREATE ROLE seatfirst_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'app_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'seatfirst_app'
);
\gexec

SELECT format(
  'ALTER ROLE seatfirst_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'app_password'
);
\gexec

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO seatfirst_app',
  :'database_name'
);
\gexec

GRANT USAGE ON SCHEMA public TO seatfirst_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO seatfirst_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO seatfirst_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seatfirst_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO seatfirst_app;

-- Function EXECUTE is granted to PUBLIC by default, so the runtime role's ability to
-- call anything in public/ currently rests on that default rather than on intent.
-- Make it explicit: revoke the blanket grant, then name what the runtime actually calls.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
-- The REVOKE above only reaches functions that exist NOW. Functions created by later
-- migrations are granted to PUBLIC again by PostgreSQL's default, so the default itself
-- must be changed or the revoke decays to nothing on the first migration that adds one.
-- NOTE: no IN SCHEMA clause. PostgreSQL's built-in EXECUTE-to-PUBLIC grant on functions
-- is a global default, not a schema-scoped one, so an `IN SCHEMA public` variant parses
-- and succeeds while revoking nothing. This is the pitfall called out in the
-- ALTER DEFAULT PRIVILEGES documentation.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- Explicit EXECUTE allowlist for seatfirst_app (ADR 0081 §9): the runtime tier calls no
-- stored function. Every read and write goes through the boundary statements in
-- packages/durability (plain SELECT/INSERT/UPDATE/DELETE; gen_random_uuid() lives in
-- pg_catalog, outside this default). The empty list is intentional, not an omission:
-- granting EXECUTE by rule would hand the application the retention and maintenance
-- routines retention_worker exists to own, and on a SECURITY DEFINER function such a
-- grant is a privilege-escalation path through the role boundary. A future migration
-- that adds a function the application actually calls must grant it here AND ship a
-- migration or ops script applying the same grant — this file runs only on first init.
EOSQL
