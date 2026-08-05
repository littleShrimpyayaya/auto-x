#!/usr/bin/env bash
# Start postgres + migrate + api + worker, then optional nginx (80/443 HTTPS).
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

# Keep nginx static admin in sync with API-served UI
if [[ -f apps/api/public/index.html ]]; then
  mkdir -p nginx/web
  cp -f apps/api/public/index.html nginx/web/index.html
fi
mkdir -p nginx/logs

echo "Starting auto-x stack (postgres → migrate → api + worker)..."
docker compose up -d --build "$@"

# Nginx reverse proxy: 80 → 443 HTTPS, /api → api:3000 (WebSocket upgrade)
# Set START_NGINX=0 to skip
if [[ "${START_NGINX:-1}" != "0" ]]; then
  if [[ ! -f nginx/conf/certs/server.crt || ! -f nginx/conf/certs/server.key ]]; then
    echo "warn: nginx/conf/certs/server.crt|key missing — skip nginx (use :3000 only)" >&2
  else
    echo "Starting nginx on 80/443 (HTTP→HTTPS, reverse proxy to api)..."
    # Ensure main network exists (compose project creates `autox`)
    docker network inspect autox >/dev/null 2>&1 || docker network create autox
    docker compose -f nginx/docker-compose.yml up -d
    echo "Done."
    echo "  HTTPS UI:  https://<host>/   (port 80 redirects here)"
    echo "  API:       https://<host>/api/v1/..."
    echo "  WS:        wss://<host>/api/v1/ws"
    echo "  Direct:    http://localhost:3000/health  (bypass nginx)"
    exit 0
  fi
fi

echo "Done. API (direct): http://localhost:3000/health"
