#!/usr/bin/env bash
# Smoke test against running stack (mock mode).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && source "$ROOT/.env" && set +a
TOKEN="${ADMIN_TOKEN:?ADMIN_TOKEN required}"
BASE="${API_BASE:-http://127.0.0.1:3000}"
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "== health =="
curl -sf "$BASE/health" | tee /dev/stderr | grep -q '"ok":true'

echo "== start automation =="
curl -sf -X POST "${auth[@]}" "$BASE/api/v1/control/start" >/dev/null

echo "== wait bootstrap+sync (up to 60s) =="
for i in $(seq 1 30); do
  me=$(curl -sf "${auth[@]}" "$BASE/api/v1/me" || true)
  if echo "$me" | grep -q '"username"'; then
    echo "account ready: $me"
    break
  fi
  sleep 2
done

echo "== wait graph_consistent =="
for i in $(seq 1 30); do
  me=$(curl -sf "${auth[@]}" "$BASE/api/v1/me")
  if echo "$me" | grep -q '"graph_consistent":true\|"graph_consistent": true'; then
    echo "graph ok"
    break
  fi
  sleep 2
done

echo "== stats =="
curl -sf "${auth[@]}" "$BASE/api/v1/stats"
echo
echo "== followers (must show username) =="
curl -sf "${auth[@]}" "$BASE/api/v1/followers"
echo
echo "== jobs =="
curl -sf "${auth[@]}" "$BASE/api/v1/jobs?limit=20"
echo
echo "SMOKE OK"
