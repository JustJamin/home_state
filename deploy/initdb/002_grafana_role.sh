#!/bin/sh
# Read-only login for Grafana. Runs once, on a fresh data volume.
# The entrypoint may source this file, so it uses an if-block, never `exit`.
if [ -n "${GRAFANA_DB_PASSWORD:-}" ]; then
    psql -v ON_ERROR_STOP=1 -v pw="$GRAFANA_DB_PASSWORD" \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE grafana LOGIN PASSWORD :'pw';
GRANT SELECT ON readings TO grafana;
EOSQL
else
    echo "GRAFANA_DB_PASSWORD not set; skipping grafana role"
fi
