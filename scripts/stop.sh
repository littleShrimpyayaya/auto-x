#!/usr/bin/env bash
# Stop compose services (SIGTERM so worker can drain later).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Stopping auto-x stack..."
docker compose stop "$@"
echo "Stopped."
