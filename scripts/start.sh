#!/usr/bin/env bash
# Start postgres + migrate (one-shot) + api + worker via docker compose.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env missing — copy .env.example and set ADMIN_TOKEN / POSTGRES_PASSWORD" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

if [[ -z "${ADMIN_TOKEN:-}" || "${#ADMIN_TOKEN}" -lt 16 || "${ADMIN_TOKEN}" == "change-me-to-long-random" ]]; then
  echo "error: ADMIN_TOKEN must be set, length >= 16, and not the weak placeholder" >&2
  exit 1
fi

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "error: POSTGRES_PASSWORD must be set in .env" >&2
  exit 1
fi

echo "Starting auto-x stack (postgres → migrate → api + worker)..."
docker compose up -d --build "$@"
echo "Done. API: http://localhost:${PORT:-3000}/health"
