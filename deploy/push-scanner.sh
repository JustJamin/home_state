#!/bin/sh
# Build the scanner image, push it to the local registry and restart it in k3s.
set -eu
cd "$(dirname "$0")/.."

IMAGE=localhost:5000/home_state-scanner
docker build -t "$IMAGE:latest" scanner
docker push "$IMAGE:latest"
kubectl -n home-state rollout restart deployment/scanner
kubectl -n home-state rollout status deployment/scanner --timeout=120s
