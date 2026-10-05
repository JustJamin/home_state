#!/bin/bash
# Run the server tests against a throwaway postgres:17 (127.0.0.1:55432) with deploy/initdb applied.
#   dashboards/fastapi-sse/tests/run.sh [pytest args]
# Needs docker (and a python with requirements.txt + pytest); PYTHON overrides the interpreter.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
name=hs-test-pg-$$

docker run -d --rm --name "$name" -p 127.0.0.1:55432:5432 \
    -e POSTGRES_DB=home_state -e POSTGRES_USER=home_state -e POSTGRES_PASSWORD=test \
    -e GRAFANA_DB_PASSWORD=test -e DASHBOARDS_DB_PASSWORD=test -e PROVISIONING_DB_PASSWORD=test \
    -v "$repo/deploy/initdb:/docker-entrypoint-initdb.d:ro" postgres:17 >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT
for _ in $(seq 60); do
    docker exec "$name" pg_isready -U home_state -d home_state -h 127.0.0.1 >/dev/null 2>&1 && break
    sleep 1
done

cd "$here/.."
TEST_PG_URL=postgresql://home_state:test@127.0.0.1:55432/home_state \
    "${PYTHON:-python3}" -m pytest -q tests "$@"
