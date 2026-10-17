#!/bin/sh
# Build the dashboard (dashboards/fastapi-sse), push it to the local registry and restart it in k3s.
# Usage: deploy/push-dashboards.sh
set -eu
cd "$(dirname "$0")/.."

image=localhost:5000/home_state-dash-fastapi-sse
docker build -t "$image:latest" dashboards/fastapi-sse
docker push "$image:latest"
kubectl -n home-state rollout restart deployment/dash-fastapi-sse
kubectl -n home-state rollout status deployment/dash-fastapi-sse --timeout=180s
