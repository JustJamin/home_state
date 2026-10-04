#!/bin/sh
# Build the demo dashboards, push them to the local registry and restart them in k3s.
# Usage: deploy/push-dashboards.sh [name...]   (default: all of dashboards/*)
set -eu
cd "$(dirname "$0")/.."

names=${*:-$(ls dashboards)}
for name in $names; do
    image=localhost:5000/home_state-dash-$name
    docker build -t "$image:latest" "dashboards/$name"
    docker push "$image:latest"
done
for name in $names; do
    kubectl -n home-state rollout restart "deployment/dash-$name"
done
for name in $names; do
    kubectl -n home-state rollout status "deployment/dash-$name" --timeout=180s
done
