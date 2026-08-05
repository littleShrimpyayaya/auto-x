#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && source "$ROOT/.env" && set +a
OUT_DIR="${ROOT}/backups"
mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/autox-${STAMP}.dump"
echo "pg_dump -> $FILE"
docker compose -f "$ROOT/docker-compose.yml" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-autox}" -d "${POSTGRES_DB:-autox}" -Fc > "$FILE"
echo "done: $FILE"
