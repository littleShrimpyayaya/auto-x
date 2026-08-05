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

# Align with packages/config isAdminTokenWeak: trim, reject empty/placeholder/short.
ADMIN_TOKEN_TRIMMED="$(printf '%s' "${ADMIN_TOKEN:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ -z "${ADMIN_TOKEN_TRIMMED}" || "${#ADMIN_TOKEN_TRIMMED}" -lt 16 || "${ADMIN_TOKEN_TRIMMED}" == "change-me-to-long-random" ]]; then
  echo "error: ADMIN_TOKEN must be set (after trim), length >= 16, and not the weak placeholder" >&2
  exit 1
fi

POSTGRES_PASSWORD_TRIMMED="$(printf '%s' "${POSTGRES_PASSWORD:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ -z "${POSTGRES_PASSWORD_TRIMMED}" ]]; then
  echo "error: POSTGRES_PASSWORD must be set in .env" >&2
  exit 1
fi

echo "Starting auto-x stack (postgres → migrate → api + worker)..."
docker compose up -d --build "$@"
# Compose publishes host 3000:3000 (PORT in .env is for local non-compose runs).
echo "Done. API: http://localhost:3000/health"
