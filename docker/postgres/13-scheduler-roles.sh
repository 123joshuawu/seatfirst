#!/bin/sh
set -eu

# Runs only while the Postgres image creates a new data directory. The retention
# scheduler needs no table privileges: migration 022 confines its work to the
# owner-bound SECURITY DEFINER retention wrappers.
: "${POSTGRES_RETENTION_PASSWORD:?POSTGRES_RETENTION_PASSWORD is required}"
: "${POSTGRES_REPLICATION_USER:?POSTGRES_REPLICATION_USER is required}"
: "${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"

DB_NAME="${POSTGRES_DB:-postgres}"

# Use psql variables as SQL literals, then format identifiers and passwords in
# PostgreSQL. This preserves arbitrary valid replication role names/passwords
# without interpolating them into SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" \
  --set=database_name="$DB_NAME" \
  --set=retention_password="$POSTGRES_RETENTION_PASSWORD" \
  --set=replication_user="$POSTGRES_REPLICATION_USER" \
  --set=replication_password="$POSTGRES_REPLICATION_PASSWORD" <<'EOSQL'
SELECT format(
  'CREATE ROLE retention_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'retention_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker'
);
\gexec

SELECT format(
  'ALTER ROLE retention_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'retention_password'
);
\gexec

SELECT format(
  'CREATE ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'replication_user',
  :'replication_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'replication_user'
);
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'replication_user',
  :'replication_password'
);
\gexec

SELECT format(
  'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM retention_worker',
  :'database_name'
);
\gexec

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO retention_worker',
  :'database_name'
);
\gexec

SELECT format(
  'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I',
  :'database_name',
  :'replication_user'
);
\gexec

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  :'database_name',
  :'replication_user'
);
\gexec
EOSQL
