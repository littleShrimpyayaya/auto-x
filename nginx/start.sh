#!/bin/bash
set -euo pipefail

export DOCKER_API_VERSION=1.44

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ">>> 检查并修正证书权限..."
chmod 755 ./nginx/certs
chmod 644 ./nginx/certs/server.crt ./nginx/certs/server.pem ./nginx/certs/server.key

echo ">>> 准备日志和缓存目录..."
mkdir -p ./logs ./cache/client_temp ./cache/proxy_temp ./cache/fastcgi_temp ./cache/uwsgi_temp ./cache/scgi_temp

echo ">>> 启动 nginx 服务..."
docker compose up -d nginx

echo "----------------------------------------------------"
echo "✅ nginx 服务已启动"
echo "----------------------------------------------------"
