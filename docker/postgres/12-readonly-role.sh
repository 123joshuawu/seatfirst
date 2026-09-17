#!/bin/bash
set -e

# This script runs during the initial database creation.
# It creates a read-only role for the AI agent / ops troubleshooting.
: "${POSTGRES_READONLY_PASSWORD:?POSTGRES_READONLY_PASSWORD is required (see .env.secrets.example)}"
DB_NAME="${POSTGRES_DB:-postgres}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" -v readonly_pass="$POSTGRES_READONLY_PASSWORD" <<-EOSQL
    CREATE ROLE agent_readonly WITH LOGIN PASSWORD :'readonly_pass';
    GRANT CONNECT ON DATABASE ${DB_NAME} TO agent_readonly;
    GRANT USAGE ON SCHEMA public TO agent_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO agent_readonly;
EOSQL
