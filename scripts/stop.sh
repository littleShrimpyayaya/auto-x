#!/usr/bin/env bash
# Gracefully stop main stack + nginx.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Stopping nginx (if running)..."
docker compose -f nginx/docker-compose.yml stop 2>/dev/null || true

echo "Stopping auto-x stack (compose stop)..."
docker compose stop "$@"
echo "Stopped."
