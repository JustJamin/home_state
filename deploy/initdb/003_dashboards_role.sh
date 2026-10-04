#!/bin/sh
# Read-only login for the demo dashboards in dashboards/. Runs once, on a fresh data volume.
# The entrypoint may source this file, so it uses an if-block, never `exit`.
if [ -n "${DASHBOARDS_DB_PASSWORD:-}" ]; then
    psql -v ON_ERROR_STOP=1 -v pw="$DASHBOARDS_DB_PASSWORD" \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE dashboards LOGIN PASSWORD :'pw';
GRANT SELECT ON readings TO dashboards;
EOSQL
else
    echo "DASHBOARDS_DB_PASSWORD not set; skipping dashboards role"
fi
