#!/bin/bash
set -euo pipefail

export DOCKER_API_VERSION=1.44

echo ">>> 停止 nginx 服务..."
docker compose stop nginx

echo ">>> 移除 nginx 容器..."
docker compose rm -f nginx

echo "----------------------------------------------------"
echo "✅ nginx 服务已停止"
echo "----------------------------------------------------"
