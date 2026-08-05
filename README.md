# auto-x

X（Twitter）关系网络自动化：**真实 API 落地**（OAuth 1.0a）— follow-back、观察期 unfollow、可选 FOAF 扩张。

| 组件 | 技术 |
|------|------|
| DB | PostgreSQL 16 |
| API | Hono + **WebSocket** + `LISTEN/NOTIFY` |
| Worker | 同步图谱 / 入队 / 执行关注取关 |
| 客户端 | 官方 **[@xdevplatform/xdk](https://docs.x.com/xdks/typescript/overview)** Live（OAuth 1.0a；mock 仅无密钥时回退） |

> **风险**：自动化关注/取关可能违反 X 政策。请用小号、保守配额，并确认开发者套餐具备 follows 读/写权限。

---

## 1. 配置真实 X 密钥（必须）

官方 SDK 文档：[TypeScript XDK Overview](https://docs.x.com/xdks/typescript/overview) · [Authentication](https://docs.x.com/xdks/typescript/authentication)

本项目 Live 路径使用：

```ts
import { Client, OAuth1 } from '@xdevplatform/xdk';
// client.users.getMe / getFollowers / getFollowing / followUser / unfollowUser
```

1. 打开 [X Developer Portal](https://developer.x.com/) → 创建 App  
2. 权限：**Read and write**（至少能 follow）  
3. 生成 **OAuth 1.0a** 的 API Key/Secret + Access Token/Secret  
4. 写入 `.env`：

```bash
cp .env.example .env

# 填入真实值
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...

# 推荐显式 live
X_CLIENT_MODE=live

ADMIN_TOKEN=你的超长随机管理令牌
POSTGRES_PASSWORD=...
```

`X_CLIENT_MODE=auto` 时：四元组齐全 → **自动 live**；缺密钥 → 才退回 mock。

---

## 2. 启动

```bash
./scripts/start.sh
# 或 make up
```

服务：`postgres` + **唯一** `migrate` + `api` + `worker`

- 管理页：http://localhost:3000/  
- Health：`/health`  
- REST：`/api/v1/*`  
- WS：`ws://localhost:3000/api/v1/ws`（首帧 `{ "type":"auth","token":"..." }`）

---

## 3. 验证真实 API（不写关注）

```bash
set -a && source .env && set +a
pnpm install
pnpm live:probe
```

成功会打印 `getMe` 的 `@username` 与 capability（是否能读 followers/following）。

或：

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/v1/control/probe | jq
```

---

## 4. 跑自动化

1. 管理页登录（`ADMIN_TOKEN`）  
2. 点 **启动自动化** → worker 会：
   - `getMe` 写入 `accounts` + `x_users`（含 **@username**）  
   - full sync followers/following → 本地 PG  
   - 新粉丝 follow-back 入队 → 按 `WRITE_MIN_INTERVAL_MS` 真实 follow  
   - 观察期后非互关 unfollow  
3. **立即同步** 可强制重新 full sync  

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:3000/api/v1/control/start
```

---

## 5. 能力与门禁

| 探测项 | 失败时行为 |
|--------|------------|
| `getMe` | worker 报错，不跑业务 |
| 读 followers | 跳过粉丝同步 / follow-back 受限 |
| 读 following | 跳过关注同步 / 观察逻辑受限 |
| 写 follow | follow 任务标记 dead |

`X_ENABLE_WRITES=0`：只同步图谱，不发 follow/unfollow。

---

## 6. 备份

```bash
./scripts/backup-db.sh
```

---

## 7. 设计文档

`docs/design-auto-x.md`

## 8. 保留

`nginx/tools/**` 证书工具勿删。可选反代见 `nginx/docker-compose.yml`。
