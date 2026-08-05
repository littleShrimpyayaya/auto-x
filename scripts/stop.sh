#!/usr/bin/env bash
# Gracefully stop compose services (SIGTERM so worker can drain).
# Does not remove containers/volumes — use `make down` / docker compose down for that.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Stopping auto-x stack (compose stop)..."
docker compose stop "$@"
echo "Stopped."
