#!/usr/bin/env bash
# Tail compose logs (default: all services, follow).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

docker compose logs -f --tail=200 "$@"
