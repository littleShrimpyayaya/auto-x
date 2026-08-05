# auto-x

X (Twitter) 关系网络自动化：**follow-back**、观察期后 **unfollow**、可选 FOAF 扩张。  
栈：**PostgreSQL 16** + Node (Hono API + Worker) + **WebSocket** 实时 + 简易管理页。

> **风险**：自动化关注/取关可能违反 X 政策并导致账号限制。默认 **mock** 模式可离线演练。

## 一键启动（mock）

```bash
cp .env.example .env
# 已填好开发用 ADMIN_TOKEN / POSTGRES_PASSWORD；生产请改强密码

./scripts/start.sh
# 或: make up

# 等待 api healthy 后
./scripts/e2e-smoke.sh
```

- 管理页：http://localhost:3000/ （Bearer token = `ADMIN_TOKEN`）
- Health：http://localhost:3000/health  
- REST：`/api/v1/*`  
- WS：`ws://localhost:3000/api/v1/ws`（首帧 `{ "type":"auth", "token":"..." }`）

停止：`./scripts/stop.sh` 或 `make down`

## Compose 服务

| 服务 | 作用 |
|------|------|
| `postgres` | SoT |
| `migrate` | **唯一** schema 迁移（api/worker 不 migrate） |
| `api` | REST + WS + LISTEN/NOTIFY |
| `worker` | sync / follow-back / observer / executor |

**保留** `nginx/tools/**` 证书工具。可选独立 nginx：见 `nginx/docker-compose.yml`。

## Live X API

`.env` 设置：

```bash
X_CLIENT_MODE=live
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
WRITE_MIN_INTERVAL_MS=45000
```

并确认租户具备 follows 读写权限。

## 备份

```bash
./scripts/backup-db.sh
```

## 设计文档

见 `docs/design-auto-x.md`。
