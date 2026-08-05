# auto-x — X (Twitter) 平台自动化系统设计文档

| 字段 | 值 |
|------|-----|
| **文档标题** | auto-x X Platform Automation System — Architecture Design |
| **作者** | TBD |
| **日期** | 2026-08-05 |
| **状态** | Draft (rev 4.1 — migrate ownership + x_users handle) |
| **工作区** | `/home/lighthouse/auto-x` |
| **读者** | 高级工程师 / 实现负责人 |

---

## Overview / 概述

**auto-x** 是一套面向**单账号运维**的 X（Twitter）关系网络自动化系统：拉取并本地缓存 followers/following 图谱，按规则执行 **follow-back**、**观察期后 unfollow**、以及基于粉丝邻域重叠的 **网络扩张 follow**。系统采用 **Producer–Consumer + 队列三明治（Queue Sandwich）** 架构——所有 X 读数据先落 **PostgreSQL**，所有写动作经 DB 任务表（`FOR UPDATE SKIP LOCKED` lease）与内存 WriteBuffer 双重层，在全局令牌桶 + 最小写间隔限流下执行；**写成功后同步更新本地图谱**，避免扫描器与 UI 依赖下一次全量同步。

**实时面**：管理端经 **WebSocket**（`/api/v1/ws`）接收 stats / jobs / sync 进度 / runtime / config / event_log 推送；命令仍走 REST。Worker 与 API 并发写 PG；跨进程 UI 推送经 **Postgres `LISTEN`/`NOTIFY`**（频道 `auto_x_events`），**不引入 Redis**。

当前仓库几乎是遗留 “massage” Drogon/C++ 项目的空壳：`docker-compose.yml` 引用不存在的 `drogon`、错误的 `postgres(massage)`/`redis`，nginx 路径与端口映射错误。本设计**从零建立** TypeScript 后端（api + worker）+ **PostgreSQL 16**（主 compose 编排）+ Flutter 管理端 + 精简 Docker 编排，**保留** `nginx/tools/` 证书工具与现有 nginx 静态/TLS 资产；主 compose **包含** `postgres` + **`migrate`（一次性）** + `api` + `worker`，nginx 仍可选独立。

---

## Background & Motivation / 背景与动机

### 当前仓库现状（已核实）

| 路径 | 状态 | 问题 |
|------|------|------|
| `/home/lighthouse/auto-x/docker-compose.yml` | 存在 | 依赖 `drogon`（`backend-builder:latest`）、`postgres`（db/user=`massage`）、`redis`；注释掉的 paddleocr；network `webpage_backend` |
| 根 compose nginx 卷路径 | **错误** | 写 `./nginx/nginx/nginx.conf`，实际为 `nginx/conf/nginx.conf` |
| 根 compose `nginx/depends_on` | 错误 | 依赖不存在的 `drogon` |
| `nginx/conf/nginx.conf` | 可用（需改 upstream） | Flutter 静态 + `/api/` `/ws/` 反代；`listen 80/443`；upstream 指向 `drogon:8080` |
| `nginx/docker-compose.yml` | **独立启动也坏** | 卷：`./nginx/nginx.conf`、`./nginx/certs`（相对 `nginx/` 目录 → 解析为不存在的 `nginx/nginx/nginx.conf`）；实际应为 `./conf/nginx.conf`、`./conf/certs`。端口：`80:8080`、`443:8443`，但 conf **listen 80/443**，映射错误导致 standalone 无法工作 |
| `nginx/tools/` | **必须保留** | 自签证书脚本 `self_sign_server_client_crt_now` + `self_sign.cnf`；**任何 PR 禁止删除或改写工具逻辑**（除非用户明确要求） |
| `nginx/web/` | 空目录 | Flutter 构建产物目标 |
| `nginx/conf/certs/` client.* | 存在 | mTLS 客户端证书资产；**v1 不启用 mTLS**（见 K15） |
| 应用代码 | **无** | 无 backend、无 Flutter app、无 worker |

### 痛点

1. **遗留配置无法启动**：compose 引用不存在镜像与错误路径/端口。
2. **X API 限流严苛**：followers/following 分页与 follow/unfollow 写操作必须本地缓存 + pacing。
3. **业务规则有状态**：观察队列、候选表、去重清洗、写后本地图一致性需要可靠持久化。
4. **运维目标**：任意平台一键 start/stop，非“企业多副本”复杂度。

### 产品风险（先声明）

> **Critical**：X API 商业条款与能力随时间变化。公开信息显示 Follows lookup 曾限制为 Enterprise；2026-04 后部分 self-serve 层级 reportedly 移除 follow/like 等写操作。本系统**假定运维者持有具备所需 endpoints 的有效 API 访问**，并内建 **MockXClient**。自动化关注/取关可能违反 X 自动化政策并导致账号限制——默认保守速率，UI 醒目标注风险。

---

## Goals & Non-Goals

### Goals

1. 获取当前认证用户信息（`/2/users/me` 等）；**首启 bootstrap** 写入 `accounts`。
2. 分页拉取 **followers / following** 全量落库；支持 **full sync**（完整遍历后 soft-delete）与 **cheap refresh**（仅前 N 页发现新边，**禁止** soft-delete）。X pagination token **不是** since-watermark。
3. **Follow-back**：新粉丝自动入 follow 任务队列（v1 **不**同步 block 列表）。
4. **观察 / Unfollow**：完整状态机 + 写路径副作用；可配置窗口（默认 7 天）。
5. **邻域扩张（FOAF-overlap）**：从粉丝的 following 样本发现候选，入 `follow_candidates`（默认关闭 + 人工审批）。
6. 全链路去重、清洗、保留策略、unfollow 冷却（基于 `jobs` 历史）。
7. Producer/Consumer、**PostgreSQL** jobs（lease/reclaim + `SKIP LOCKED`）+ 内存 WriteBuffer（非耐久边界）、全局限流；api 与 worker **并发**安全访问 DB。
8. Flutter 管理 UI：配置、队列、统计、启停、日志、token 录入；**WebSocket 实时推送**（非仅轮询）。
9. Docker Compose：`postgres` + **`migrate`** + `api` + `worker`；`scripts/start.sh|stop.sh`；`.env` 密钥；弱 token 启动失败。
10. 清理 massage 遗留；nginx 可选独立且路径/端口/**WebSocket upgrade** 修正；**保留 tools/**。
11. **用户身份缓存（@username）**：凡从 X API 见到用户，必须 upsert `x_users`（`id` + **username handle（无前导 @）** + display `name` + `verified`）；管理端列表 **必须**显示 handle，禁止仅裸数字 id。

### Non-Goals

- 多租户 SaaS / 多 X 账号并发（schema 预留 `account_id`，首期单账号）。
- 发推、点赞、DM、广告、非官方抓取 / 浏览器自动化。
- Redis/BullMQ（首期；实时用 PG NOTIFY，不用 Redis）。
- SQLite 作为 SoT（**已否决**——并发 writer 需求，见 A1）。
- 主 compose 重度编排 nginx；v1 **mTLS**（证书资产保留不用）。
- 同步 X **blocks/mutes** 列表（v1 明确不做，避免额外 rate 成本）。
- 移动端商店发布。

---

## Key Decisions

| # | 决策 | 选择 | 简要理由 |
|---|------|------|----------|
| K1 | 数据库 | **PostgreSQL 16**（Docker Compose 服务 `postgres`；驱动 `pg` + **Drizzle ORM** 迁移/schema） | 用户要求 **api+worker 并发写**；行锁 / `SKIP LOCKED`；备份 `pg_dump`。 |
| K2 | 队列 | **PG `jobs`（SoT）+ lease/reclaim + 内存 WriteBuffer/pace channel** | 崩溃可恢复 running；内存层仅批写优化与写 pacing，**非耐久边界**。 |
| K3 | X SDK | **`twitter-api-v2`** + `XClient` 接口 | 成熟分页与 rate 插件；官方 SDK 可替换。 |
| K4 | HTTP | **Hono** on Node 20+ | 轻量、TS 优先；WS 挂同一进程（`@hono/node-server` + `ws`）。 |
| K5 | 进程 | **postgres + migrate + api + worker**（主 compose） | 故障隔离；**仅 `migrate` 跑 schema**；api/worker `depends_on: migrate` completed；二者**永不** migrate on boot。 |
| K6 | 管理鉴权 | **Bearer `ADMIN_TOKEN`**；弱默认值 **拒绝启动** | REST header；WS 见 K23。 |
| K7 | OAuth | **OAuth 1.0a User Context** | 四元组 env。 |
| K8 | Nginx | **可选独立**；修路径+端口+**WS upgrade**；主 compose 不强制 nginx | 保留 `tools/**`；mTLS 见 K15。 |
| K9 | 前端 | **Flutter Web** → `nginx/web/`；REST 命令 + **WS 推送** | 对齐现有缓存规则。 |
| K10 | Monorepo | **pnpm workspace** | 共享 schema/类型（含 WS envelope zod）。 |
| K11 | 限流 | **Token bucket + 端点预算 + 写最小间隔 + 日/时配额 + 429 退避** | 对齐真实窗口；header 覆盖。 |
| K12 | 遗留清理 | 删除 drogon/massage/redis/paddleocr；**替换**旧 massage postgres 为 autox 专用库 | — |
| K13 | 写后本地图 | **Executor 成功事务内更新** following/observations/candidates/counters | 避免 follow-back 重入与观察滞后。 |
| K14 | Job lease | **`locked_at`/`locked_by` + `FOR UPDATE SKIP LOCKED` claim + 超时 reclaim** | v1 单 worker 进程；SQL 仍多安全（预留水平扩展）。 |
| K15 | mTLS | **v1 out of scope** | 保留 cert 文件；不强制 client verify。 |
| K16 | PG 并发与连接 | **共享 `DATABASE_URL`；每进程 `pg.Pool`**（api max≈10，worker max≈10）；短 TX；Worker 负责图谱/jobs 大事务，API 短事务（config/control/cancel） | 无 SQLite 单写者假设；用行级锁 + 合理隔离级别 `READ COMMITTED`。 |
| K17 | Worker←控制面 | **Worker 轮询** `runtime_state`/`app_config`（≤2s） | 保持简单；不依赖 API 在线。UI 实时见 K23。 |
| K18 | Blocks | **v1 不同步 block/mute** | 规则中移除 `blocked`；冷却用 jobs 历史。 |
| K19 | 日界 | **`daily_counters.day` = UTC 日历日** | v1 固定 UTC；UI 可本地展示。 |
| K20 | 同步语义 | **Full sync 才 soft-delete；cheap refresh 只加边** | Pagination token ≠ since cursor。 |
| K21 | Soft-delete 标记 | **`sync_gen` + 并发盖章规则** | 仅 full **start** 可 `walk_gen++`；完成 walk 后 `sync_gen < walk_gen` 才 mark lost。**当 stream `phase=full_in_progress` 时，该 stream 上所有边 upsert（full 页 / cheap / executor）必须 `sync_gen=walk_gen`**。Idle 时 cheap/executor **不**写 `sync_gen`。 |
| K22 | 计数幂等 | **Follow charge（v1 冻结）**：`chargeStats = NOT wasLocalActive`（写前无 `lost_at IS NULL` 边）；含 new pending/confirmed；已 active 不计。Unfollow：写前 active 才 charge。 | 防 at-least-once 与 pending 双计。 |
| K23 | UI 实时 | **WebSocket** `/api/v1/ws`；**REST 命令 + WS 推送** | 见 §11.1；Flutter 重连退避。 |
| K24 | 跨进程事件 | **Postgres `LISTEN`/`NOTIFY` 频道 `auto_x_events`** | Worker（及 API 写路径）COMMIT 后 `pg_notify`；API 专用连接 LISTEN 后 fan-out 到 WS 客户端。**禁止 Redis**（v1）。 |
| K25 | Schema 迁移 | **唯一 migrator = compose 服务 `migrate`**（`pnpm db:migrate` / drizzle-kit；`restart: "no"`） | api/worker **禁止** boot migrate；二者 `depends_on: migrate: condition: service_completed_successfully`。 |
| K26 | 用户身份 / @handle | **`x_users` 为身份 SoT**；边表仅 `user_id` | 每次 API 用户对象 → upsert `id`+`username`(无前导 @)+`name`+`verified`；UI/REST/WS **必须**带 handle，禁止裸 id 列表。 |

---

## Proposed Design / 详细设计

### 1. 目标仓库结构

```
auto-x/
├── apps/
│   ├── api/                 # Hono HTTP + WebSocket hub + LISTEN fan-out
│   │   └── src/
│   │       ├── index.ts
│   │       ├── bootstrap.ts # getMe / seed account（也可由 worker 执行）
│   │       ├── routes/
│   │       ├── ws/          # WS server, auth, hub
│   │       └── middleware/
│   └── worker/
│       └── src/
│           ├── index.ts     # SIGTERM drain + reclaim loop
│           ├── loops/       # sync, followBack, observer, expander, promoter, executor, reclaim
│           ├── queue/       # WriteBuffer + JobClaimer (SKIP LOCKED)
│           ├── notify.ts    # pg_notify after commits
│           └── rate-limit/
├── packages/
│   ├── db/                  # drizzle schema + migrations + pool factory
│   │                        # migrate CLI only used by compose service `migrate`
│   ├── x-client/
│   ├── domain/
│   ├── shared/              # WS envelope zod types
│   └── config/
├── frontend/                # Flutter 管理端
├── nginx/                   # EXISTING — 保留 tools/
│   ├── conf/
│   ├── tools/               # MUST PRESERVE — do not delete
│   ├── web/
│   └── docker-compose.yml
├── docker/
│   └── Dockerfile.node
├── scripts/
│   ├── start.sh             # compose up (migrate one-shot then api/worker)
│   ├── stop.sh              # compose stop (SIGTERM drain)
│   ├── logs.sh
│   ├── backup-db.sh         # pg_dump → ./backups/
│   └── build-frontend.sh
├── backups/                 # gitignored pg_dump artifacts
├── data/                    # gitignored (optional local artifacts; DB in volume pgdata)
├── docker-compose.yml
├── .env.example
├── pnpm-workspace.yaml
├── package.json
├── Makefile
└── README.md                # PR1 即写 tools 保留 + 风险 + 拓扑
```

### 2. 逻辑架构

```mermaid
flowchart TB
  subgraph UI["Flutter Admin (Web)"]
    Dash[Dashboard]
    Cfg[Config]
    Ctrl[Start/Stop]
    WsClient[WS client reconnect]
  end

  subgraph Edge["Optional Nginx"]
    NGX["Static + /api + WS upgrade"]
  end

  subgraph API["apps/api"]
    REST[REST /api/v1/* commands]
    WSH[WS hub /api/v1/ws]
    LISTEN[PG LISTEN auto_x_events]
    BOOT[Bootstrap getMe]
  end

  subgraph Worker["apps/worker — graph + jobs"]
    P1[SyncProducer full/cheap]
    P2[MutualExpander]
    S1[FollowBackScanner]
    S2[ObserverScanner]
    S3[CandidatePromoter]
    EX[WriteExecutor + graph TX]
    RC[Lease Reclaim SKIP LOCKED]
    MB[WriteBuffer flush-before-cursor]
    RL[RateLimiter]
    NTF[pg_notify after COMMIT]
  end

  subgraph Persist["PostgreSQL 16"]
    DB[(autox DB + volume pgdata)]
  end

  subgraph XAPI["X API v2"]
    R[Read]
    W[Write]
  end

  Dash --> NGX --> REST
  WsClient --> NGX --> WSH
  Dash --> REST
  WsClient --> WSH
  LISTEN --> WSH
  REST --> DB
  LISTEN --> DB
  BOOT --> R
  BOOT --> DB
  P1 --> RL --> R
  P2 --> RL --> R
  P1 --> MB --> DB
  EX --> RL --> W
  EX --> DB
  EX --> NTF --> DB
  RC --> DB
  S1 --> DB
  S2 --> DB
  S3 --> DB
  NTF -.->|NOTIFY| LISTEN
```

### 3. 队列三明治（Queue Sandwich）

| 方向 | 路径 | 耐久性 |
|------|------|--------|
| **图谱写** | Sync/Expand → **Memory WriteBuffer** → flush → DB | Buffer **非 SoT**；崩溃最多丢失未 flush 批；靠 **cursor 仅在 flush 成功后前进** + 页级幂等 upsert 重放 |
| **任务执行** | DB `jobs` → claim（lease）→ 内存 pace slot → X write → **同事务**更新 job+图谱 | Jobs 为 SoT；lease 保证 crash 可 reclaim |

```mermaid
sequenceDiagram
  participant P as SyncProducer
  participant MB as WriteBuffer
  participant DB as PostgreSQL
  participant E as Executor
  participant X as X API
  participant RL as RateLimiter
  participant N as NOTIFY
  participant A as API WS hub

  P->>X: GET followers page (RL)
  X-->>P: users[]
  P->>MB: enqueue upserts
  P->>MB: flush()
  MB->>DB: BEGIN; batch UPSERT; COMMIT
  Note over P,DB: Only after flush OK
  P->>DB: saveCursor(nextToken)
  P->>N: pg_notify sync.progress
  N-->>A: LISTEN fan-out WS

  E->>DB: claim FOR UPDATE SKIP LOCKED
  E->>RL: min spacing + bucket
  RL->>X: POST follow/unfollow
  X-->>E: 200 / already / 429
  E->>DB: BEGIN; job done; graph; counters; COMMIT
  E->>N: pg_notify job.updated + stats.updated
```

**WriteBuffer 规则（Issue 7）**

1. 默认 batch：100 行或 200ms，先到先 flush。
2. **禁止**在对应页的 upsert 未 COMMIT 前 `saveCursor`。
3. 进程崩溃：从 DB 中**最后已提交 cursor** 重走；upsert 幂等 → at-least-once 页处理。
4. Full sync 的 soft-delete 仅在**本轮全部页 flush 完成且无 nextToken** 的同一逻辑阶段执行（可单独事务，但必须 `full_walk_ok=true`）。

**为何不用 Redis**：jobs lease 在 PG；跨进程实时用 **`LISTEN`/`NOTIFY`**（K24）。v1 不引入第二数据面。

### 4. Job claim、lease 与状态机（Issues 2, 5）

#### 4.1 规范状态（唯一真相）

| status | 含义 |
|--------|------|
| `pending` | 可被 claim（且 `next_run_at <= now`） |
| `running` | 已租约；持有 `locked_by` |
| `done` | 成功终态 |
| `cancelled` | 用户/API 取消（仅 pending 或 cooperative） |
| `dead` | `attempts >= max_attempts` 终态 |

**没有** `retry` 或独立 `failed` 状态。可重试错误：`running → pending`，`attempts++`，设 `next_run_at`，清空 lease。  
**Claim 谓词**：`status = 'pending' AND next_run_at <= now()`。

#### 4.2 Schema 字段（jobs 增量）

```sql
-- jobs lease columns (PostgreSQL)
locked_at   TIMESTAMPTZ,     -- UTC
locked_by   TEXT,            -- worker instance id (hostname+pid+uuid)
-- status 仅: pending|running|done|cancelled|dead
```

默认 `lease_ttl_sec = 120`。执行中可每 30s 刷新 `locked_at`（长请求）；X HTTP 通常 <30s，刷新可选。

#### 4.3 原子 Claim SQL（PostgreSQL — `FOR UPDATE SKIP LOCKED`）

```sql
BEGIN;
WITH cte AS (
  SELECT id
  FROM jobs
  WHERE status = 'pending'
    AND next_run_at <= now()
  ORDER BY priority ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs j
SET status = 'running',
    locked_at = now(),
    locked_by = $workerId,
    updated_at = now()
FROM cte
WHERE j.id = cte.id
RETURNING j.*;
COMMIT;
```

- **`SKIP LOCKED`**：并发 claim（多 worker 或 reclaim 竞态）不阻塞，跳过已被锁行。
- v1 仍部署**单个** worker 容器；SQL 形态允许日后水平扩展。
- Claim 与后续 X HTTP **不要**长占同一事务：claim 提交后持有 lease；成功/失败再开短 TX 写图谱。

#### 4.4 Reclaim loop（每 15s）

```sql
UPDATE jobs
SET status = 'pending',
    locked_at = NULL,
    locked_by = NULL,
    next_run_at = now(),
    last_error = 'lease_expired',
    updated_at = now()
WHERE status = 'running'
  AND locked_at < now() - make_interval(secs => $lease_ttl_sec);
```

**不**增加 `attempts`（避免 worker 被 OOM 杀导致任务快速 dead）。可选：连续 reclaim >3 次再 +attempts（v1.1）。Reclaim 后可 `PERFORM pg_notify('auto_x_events', ...)` 推 `job.updated`。

#### 4.5 状态机

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> running: atomic claim
  pending --> cancelled: API cancel
  running --> done: X success or already-following reconcile
  running --> pending: retryable (429/5xx/network)\n attempts++ next_run_at backoff
  running --> dead: attempts >= max after retryable failure
  running --> pending: lease reclaim (no attempts++)
  running --> cancelled: cooperative cancel flag checked pre-HTTP
  done --> [*]
  dead --> [*]
  cancelled --> [*]
```

**取消**：API 仅将 `pending → cancelled`。对 `running`：设 `cancel_requested = TRUE`（BOOLEAN 列）；executor 在发起 X HTTP **前**检查，若已请求则 `cancelled` 并释 lease；**不**中途 abort 已发出的 HTTP（避免半未知状态）；若 HTTP 已成功则仍走 success 事务（以 X 真相为准）。

**429**：`pending` + `next_run_at = reset_at || now+backoff`；**不是** status=`retry`。

### 5. 同步：Full vs Cheap Refresh（Issue 1 — 关键修正）

X API v2 follows 列表的 `pagination_token` / `next_token` **仅用于完整列表分页**，不是 “since T 的增量游标”。错误地把 partial walk 的 `seen` 做 soft-delete 会导致**大规模误删边**。

| 模式 | 触发 | 行为 | soft-delete (`lost_at`) |
|------|------|------|-------------------------|
| **full_sync** | 默认每 6h；手动 Sync Now；bootstrap 后首次 | 从 cursor=null 或存档 resume **走完所有页**；每页 flush 时写 `sync_gen=walk_gen`；全部完成后按 gen 标记 lost | **仅当**本 run `completed=true` |
| **cheap_refresh** | 可选，默认每 15–30min | 只拉**前 N 页**；upsert 边。若该 stream **full_in_progress** → 必须盖 `sync_gen=walk_gen`；若 idle → **不**改 `sync_gen` | **禁止** |

#### 5.1 Soft-delete 代际方案 `sync_gen`（规范，必须实现）

**禁止**用 `last_seen_at < sync_start` 做 soft-delete：cheap_refresh 与 executor 会更新 `last_seen_at`，导致 full walk 误删/漏删。

**规范列（DDL）**

| 表.列 | 类型 | 含义 |
|-------|------|------|
| `followers.sync_gen` / `following.sync_gen` | `INTEGER NOT NULL DEFAULT 0` | 边在对应 stream 上最近一次被 **本 walk 盖章** 的代际（见并发规则） |
| `sync_cursors.walk_gen` | `INTEGER NOT NULL DEFAULT 0` | 当前或最近一次 full walk 的代际号 |
| `sync_cursors.last_completed_walk_gen` | `INTEGER NOT NULL DEFAULT 0` | 最近一次**成功完成** full walk 的代际（用于审计） |

**共享辅助（所有写边路径必须调用）**

```ts
/** Stream: 'followers' | 'following' */
function edgeSyncGenForUpsert(db, accountId, stream: Stream): number | null {
  const row = db.getSyncCursor(accountId, stream);
  // null => caller MUST omit sync_gen from UPDATE (leave column unchanged)
  // number => caller MUST set sync_gen = that value
  if (row?.phase === 'full_in_progress') return row.walk_gen;
  return null;
}
```

**规则**

1. **开始新 full walk**（`phase` 从 `idle` → `full_in_progress` 且 cursor 从 null 起扫，或显式 Sync Now 重置）：
   ```sql
   UPDATE sync_cursors
   SET walk_gen = walk_gen + 1,
       phase = 'full_in_progress',
       cursor = NULL,
       pages_done = 0,
       updated_at = now()
   WHERE account_id = :a AND stream = :s;
   -- 记下 :walk_gen = 新值，本 run 全程使用同一 walk_gen
   ```
2. **Resume** 已中断的 full（`phase=full_in_progress` 且 cursor 非终态）：**不**再 `walk_gen++`，继续用现有 `walk_gen`。
3. **Full 页 upsert**（WriteBuffer flush）：**同批** upsert `x_users`（K26：`id`/`username`/`name`/`verified`/metrics）+ 边行。边始终 `sync_gen = :walk_gen`，`lost_at = NULL`：
   ```sql
   -- identity first (every user object from X)
   INSERT INTO x_users (id, username, name, verified, protected, followers_count, following_count, tweet_count, raw_json, last_seen_at)
   VALUES ($id, $username, $name, $verified, $protected, $fc, $fgc, $tc, $raw, now())
   ON CONFLICT (id) DO UPDATE SET
     username = EXCLUDED.username,       -- rename overwrite
     name = EXCLUDED.name,
     verified = EXCLUDED.verified,
     protected = EXCLUDED.protected,
     followers_count = EXCLUDED.followers_count,
     following_count = EXCLUDED.following_count,
     tweet_count = EXCLUDED.tweet_count,
     raw_json = EXCLUDED.raw_json,
     last_seen_at = EXCLUDED.last_seen_at;

   INSERT INTO followers (account_id, user_id, connected_at, last_seen_at, lost_at, sync_gen)
   VALUES ($a, $u, now(), now(), NULL, $walk_gen)
   ON CONFLICT (account_id, user_id) DO UPDATE SET
     last_seen_at = EXCLUDED.last_seen_at,
     lost_at = NULL,
     sync_gen = EXCLUDED.sync_gen;
   ```
4. **Cheap refresh / executor 写边 — 并发盖章（K21，防误删）**：
   - 永远可：`last_seen_at`、`lost_at=NULL`（复活）、`pending_follow`、`source`
   - **`walk_gen` 仅由 full start 递增**；cheap/executor **永不** `walk_gen++`
   - **若** 对应 stream `phase = full_in_progress`：该 stream 上的边 upsert **必须** `sync_gen = walk_gen`（与 full 页同一代际）。理由：mid-walk 由本系统确认存在的边（新 follow、cheap 见到的粉丝）若保持 `sync_gen=0`，完成时 `sync_gen < walk_gen` 会 **误 mark lost**（即使不在剩余分页里）。
   - **若** 对应 stream `phase = idle`（或 `cheap_in_progress` 且无并行 full）：**不得**改 `sync_gen`（`UPDATE` 省略该列；INSERT 新边用默认 `0`）。下次 full 会盖章；若全程未再出现且完成 full 时仍 `< walk_gen` → mark lost（正确：本 walk 未确认）。
   - Stream 映射：executor **follow/unfollow** 只写 `following` 边 → 读 `sync_cursors(stream='following')`；cheap/full followers → `followers` 表 + `stream='followers'`。
   - 示例 SQL（executor follow，following full 进行中）：
     ```sql
     -- gen = SELECT walk_gen FROM sync_cursors WHERE ... stream='following' AND phase='full_in_progress'
     INSERT INTO following (..., sync_gen) VALUES (..., :gen)
     ON CONFLICT DO UPDATE SET lost_at=NULL, last_seen_at=..., source=..., pending_follow=...,
       sync_gen = COALESCE(:gen, following.sync_gen);
     -- 当 idle 时绑定 :gen = NULL，COALESCE 保持旧 sync_gen
     ```
5. **Full 完成（无 nextToken，全部页已 flush）** 才执行：
   ```sql
   UPDATE followers
   SET lost_at = now()
   WHERE account_id = :a
     AND lost_at IS NULL
     AND sync_gen < :walk_gen;   -- 本 walk 从未盖章的活跃边 → 丢失

   UPDATE sync_cursors SET
     phase = 'idle',
     cursor = NULL,
     full_sync_completed = TRUE,
     last_full_sync_at = now(),
     last_completed_walk_gen = :walk_gen,
     updated_at = now()
   WHERE account_id = :a AND stream = :s;
   ```
6. **未完成 full 禁止** `sync_gen < walk_gen` 的 mark-lost。
7. **观察/互关** 用 `lost_at IS NULL`，不依赖 `sync_gen`。Unfollow 成功设 `lost_at` 即可；不必清零 `sync_gen`。
8. **不采用**的备选（记录以免实现分叉）：跳过 full 期间的 cheap；或用 `connected_at < walk_started_at` 谓词——v1 **统一用规则 4 盖章**，实现更简单且允许 cheap 与 full 并行。
`sync_cursors` 完整列：

```sql
CREATE TABLE sync_cursors (
  account_id              TEXT NOT NULL,
  stream                  TEXT NOT NULL,  -- followers | following
  cursor                  TEXT,
  phase                   TEXT NOT NULL DEFAULT 'idle',
    -- idle | full_in_progress | cheap_in_progress
  pages_done              INTEGER NOT NULL DEFAULT 0,
  walk_gen                INTEGER NOT NULL DEFAULT 0,
  last_completed_walk_gen INTEGER NOT NULL DEFAULT 0,
  full_sync_completed     BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_sync_at       TIMESTAMPTZ,
  last_cheap_at           TIMESTAMPTZ,
  last_error              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, stream)
);
```

`runtime_state` 同步门闩（供 Observer / Unfollow）：

```text
followers_sync_ok     -- 最近一次 full_sync followers 成功
following_sync_ok
last_full_sync_at     -- min of both streams' last_full_sync_at when both ok
graph_consistent      -- followers_sync_ok AND following_sync_ok
```

**调用量粗算**（maxResults≈1000/页时；实际以账号档位 header 为准）：

| 图谱规模 | Full 页数（单侧） | 两侧 full | 备注 |
|----------|-------------------|-----------|------|
| 5k | ~5 | ~10 | 在 15 req/15min 档可能需跨多个窗口 |
| 50k | ~50 | ~100 | 必须多小时/多窗口；full 间隔应 ≥ 完成时间 |

实现必须：**budget 不足时挂起 full_sync（phase 保持 full_in_progress + cursor 已 flush 位置 + 同一 walk_gen）**，下次续跑，**绝不**在未完成时 soft-delete。

Goals §2 表述更正：删除模糊「增量同步游标」；改为「pagination cursor 用于 full walk 续跑 + cheap refresh 仅前 N 页」。

### 6. Bootstrap 首启流程（Issue 12）+ Schema 迁移所有权（K25）

#### 6.0 唯一 Migrator（冻结 — 禁止双跑）

| 角色 | 是否跑 `pnpm db:migrate` / drizzle-kit | 说明 |
|------|----------------------------------------|------|
| **`migrate` compose 服务** | **是 — 唯一** | `restart: "no"`；`command: pnpm db:migrate`；退出 0 = schema 就绪 |
| **`api`** | **否** | boot 只 `pg.Pool` connect + 业务；schema 缺失则 crash/ready=false |
| **`worker`** | **否** | 同上；**禁止** worker 内 `drizzle migrate` |
| **`start.sh`** | 可选包装 | `docker compose up` 依赖 compose 的 migrate 顺序；**不要**再手搓第二套 migrate 除非本地 dev 无 compose |

顺序：`postgres` healthy → **`migrate` completed successfully** → `api` / `worker` 启动。

```mermaid
sequenceDiagram
  participant M as migrate (one-shot)
  participant W as Worker
  participant A as API
  participant X as X API / Mock
  participant DB as PostgreSQL

  Note over M,DB: Compose: postgres healthy first
  M->>DB: pnpm db:migrate (drizzle-kit) once
  M-->>M: exit 0
  Note over W,A: depends_on migrate completed
  W->>DB: pool connect (NO migrate)
  A->>DB: pool connect (NO migrate)
  alt X_CLIENT_MODE=mock
    W->>DB: upsert account id=mock-1, default config/runtime
  else live
    W->>X: getMe()
    alt success
      X-->>W: user
      W->>DB: upsert accounts + x_users (id, username, name, verified)
      W->>DB: INSERT ... ON CONFLICT DO NOTHING app_config, runtime_state
      W->>DB: set capabilities from probe
    else fail
      W->>DB: runtime_state.last_error
      Note over W: scanners no-op; /me returns needs_bootstrap
    end
  end
  W->>X: optional lightweight follows probe (1 page or 403 detect)
  W->>DB: capabilities.followsLookup / followWrite
```

- **单账号**：`accounts` 仅一行；更换密钥导致不同 user id → 文档要求停服清库或显式数据迁移（v1 不自动多账号）。Schema 变更只经 `migrate` 服务 / `pnpm db:migrate`。
- **API `GET /me`**：
  - 无 account：`503` + `{ "code": "needs_bootstrap", "action": "set env credentials and start worker / POST control/sync-now" }`
  - 有 account：返回缓存用户（含 **username handle**）+ sync flags + capabilities。
- **PUT `/config`**：若无 account，先 bootstrap 或返回同一 `needs_bootstrap`（禁止孤儿 config 行）。默认 config 在 account 创建时 `INSERT … ON CONFLICT DO NOTHING`。

### 7. Worker 循环

| Loop | 周期 | 职责 |
|------|------|------|
| **Bootstrap/Probe** | 启动时 + 每 1h | getMe、capability 探测 |
| **SyncProducer** | full 6h / cheap 可选 15–30min | full/cheap 见 §5 |
| **FollowBackScanner** | 60s | 新粉丝 → follow jobs（无 block 列表） |
| **ObserverScanner** | 60s | 观察状态机；**要求 graph_consistent** 才 enqueue unfollow |
| **MutualExpander** | 日预算驱动 | FOAF-overlap 采样写 candidates（模块独立） |
| **CandidatePromoter** | 60s 或日配额 | pending/approved → follow jobs（模块独立） |
| **WriteExecutor** | 持续 | claim → rate → X → **graph TX** |
| **LeaseReclaim** | 15s | 见 §4.4 |
| **Retention** | 每日 | purge event_log / 归档旧 jobs |

控制：worker **轮询** `runtime_state.automation_enabled`（≤2s）。`false` 时 executor 停止 claim；sync 可按配置仍允许只读同步。

#### 7.1 Follow-back 规则（v1 无 blocked）

```ts
function planFollowBacks(ctx: GraphSnapshot, cfg: Config): JobDraft[] {
  const out: JobDraft[] = [];
  for (const f of ctx.activeFollowers) { // lost_at IS NULL
    if (ctx.activeFollowing.has(f.id)) continue;
    if (ctx.pendingFollowJobs.has(f.id)) continue;
    if (wasUnfollowedRecently(f.id, cfg.unfollowCooldownDays)) continue; // via jobs
    if (f.protected && !cfg.followProtected) continue;
    out.push({ type: 'follow', targetUserId: f.id, source: 'follow_back', priority: 10 });
  }
  return out;
}
```

#### 7.2 Observation 状态机（Issue 3 — 专节）

**表 `observations.status`**：

| status | 含义 |
|--------|------|
| `watching` | 观察中，`expires_at` 有效 |
| `promoted_unfollow` | 已创建 unfollow job（防重复 promote） |
| `cleared_mutual` | 已变为互关而关闭 |
| `cleared_unfollowed` | 本地已不 following（系统或外部取关） |
| `cancelled` | 人工取消 |

**PRIMARY KEY `(account_id, user_id)`** 保留一行历史；重入观察时 **UPDATE** 新 `entered_at`/`expires_at`/`status='watching'`（覆盖旧终态）。可选 `observation_events` 审计（v1.1）；v1 用 `event_log`。

**互关定义**：`user_id ∈ activeFollowers ∧ user_id ∈ activeFollowing`（两侧 `lost_at IS NULL`）。粉丝 `lost_at` 已设但仍 following → **非互关**。

| 事件 | 动作 |
|------|------|
| active following ∧ ¬mutual ∧ 无 watching 行 | INSERT watching；`entered_at=now`；`expires_at=now+observation_days` |
| watching ∧ mutual | → `cleared_mutual` |
| watching ∧ ¬仍 active following | → `cleared_unfollowed` |
| watching ∧ now≥expires_at ∧ ¬mutual ∧ **graph_consistent** | **单事务**：INSERT unfollow job + status `promoted_unfollow` |
| watching ∧ now≥expires_at ∧ ¬graph_consistent | **不** unfollow；记 metric `unfollow_deferred_incomplete_sync` |
| 配置 `observation_days` 变更（PUT） | **重算所有 watching 的 `expires_at = entered_at + new_days`**（不改 entered_at） |
| 系统 unfollow 成功（executor） | following 软删；observation → `cleared_unfollowed` |
| 外部 unfollow（下次 full sync lost） | Observer：¬active following → `cleared_unfollowed` |
| 再次 follow 同一人（executor 或 sync） | 若 ¬mutual → **新窗口** watching（重置 entered_at） |
| mutual 后再次非 mutual | **重新进入** watching（新窗口）。策略名：`reobserve_on_non_mutual=true`（默认 true） |
| follow API 返回 `pendingFollow: true` | following 边写入 `pending_follow=TRUE`（列）；**不**进入观察（还不算稳定 following）；pending 变正式后由 sync/executor 清标志再观察 |
| 受保护账号 pending | 同上 |
| **`promoted_unfollow` 恢复**（见下） | 防 job dead/cancelled 后永久卡住 |

`following` 表增加：

```sql
pending_follow BOOLEAN NOT NULL DEFAULT FALSE  -- true = 发出请求但未确认 following
```

##### 7.2.1 `promoted_unfollow` 恢复（防永久卡住）

**Promote 必须单事务**（ObserverScanner）：

```sql
BEGIN;
-- 1) 插入 job（依赖 partial unique：若已有 pending|running unfollow 则失败并回滚/跳过）
INSERT INTO jobs (account_id, type, target_user_id, source, priority, status, next_run_at, ...)
VALUES ($a, 'unfollow', $u, 'observe', 20, 'pending', now(), ...);
-- 2) 仅当 job 插入成功
UPDATE observations SET status = 'promoted_unfollow', updated_at = now()
WHERE account_id = $a AND user_id = $u AND status = 'watching';
COMMIT;
-- 3) 可选: SELECT pg_notify('auto_x_events', payload_json);
```

禁止先改 status 再插 job（崩溃会留下无 job 的 `promoted_unfollow`）。

**每个 Observer 周期**对 `status='promoted_unfollow'` 行执行恢复扫描：

```
hasActive = EXISTS job type=unfollow target=u status IN ('pending','running')
hasDone   = EXISTS recent done unfollow（可选，executor 应已清 observation）

if hasActive: no-op
else if observation still active-following ∧ ¬mutual:
  if graph_consistent ∧ (now >= expires_at OR always retry):
    -- 重新入队：同一事务 INSERT job + 保持 promoted_unfollow
    -- 若 job dead/cancelled：允许新 job（partial unique 仅挡 pending|running）
    re-INSERT unfollow job (source=observe_retry)
  else if ¬graph_consistent:
    -- 可选：revert watching 保持 entered_at/expires_at，等图一致
    SET status='watching'  -- 保留 entered_at/expires_at
else if ¬active following:
  SET status='cleared_unfollowed'
else if mutual:
  SET status='cleared_mutual'
```

| From | Predicate | To | Side effects |
|------|-----------|-----|--------------|
| watching | due ∧ gate OK | promoted_unfollow | **TX**: insert unfollow job |
| promoted_unfollow | job done (executor) | cleared_unfollowed | following.lost_at |
| promoted_unfollow | no active job ∧ still due ∧ ¬mutual ∧ graph_consistent | promoted_unfollow | **TX**: re-insert unfollow job |
| promoted_unfollow | no active job ∧ ¬graph_consistent | watching | keep entered_at/expires_at |
| promoted_unfollow | no active job ∧ mutual | cleared_mutual | |
| promoted_unfollow | no active job ∧ ¬following | cleared_unfollowed | |

PR4/PR6b 必须有表驱动测试：job → dead、job → cancelled、status 翻转后进程崩溃（靠 TX 原子性）。

#### 7.3 邻域扩张算法（Issue 6）— FOAF Overlap

**正式名称**：`foaf_overlap_expand`（朋友的关注列表与我的粉丝集合重叠打分）。**不是**严格“粉丝的双向互关集合”的完整计算（那需要每个 seed 的 followers∩following，成本更高）。若配置 `expand_mode=seed_mutuals`，则对 seed 拉 following 与 followers 各有限页做交集（双倍读成本）—— **v1 默认 `foaf_following_overlap`**。

**算法 `foaf_following_overlap`**

```
每日预算: max_seeds (default 5), max_pages_per_seed (default 1),
          stop if remaining read_pages budget < 10% of daily cap

seeds = 我的 active followers 中筛选:
  followers_count ∈ [minF, maxF] (default 50..50000)
  排除 protected（可选）
  按 last_seen / 随机采样，取 max_seeds

for seed in seeds:
  pages = 0
  while pages < max_pages_per_seed and budget_ok:
    page = getFollowing(seed.id)  // 有限页
    flush users
    for u in page:
      if u.id == me: continue
      if u in my_active_following: continue
      if u in my_active_followers: score += 3  // already fan — optional skip follow
      if wasUnfollowedRecently(u): continue
      # overlap 信号：u 出现在 seed 的 following 中即基础分
      score[u] += 1
      reason[u].seeds.add(seed.id)
    pages++

# 可选增强：若 u ∈ my_followers，提高分（更可能回关）
# 产品偏好：蓝 V / verified 可加权（x_users.verified from API field verified_type/legacy verified）
final_score(u) = score[u]
  + (u in my_followers ? 2 : 0)
  + (u.verified ? 1 : 0)   -- optional; config expand_prefer_verified default true

# flush: always upsert x_users for every sampled user (id, username, name, verified)
UPSERT follow_candidates (pending) ON CONFLICT update score=max(old,new), merge reason JSON
```

**reason JSON schema（zod）**：

```ts
{ "algo": "foaf_following_overlap", "seeds": string[], "overlap": number }
```

**CandidatePromoter**（独立模块，可同时序调度）：

- 若 `candidate_manual`：仅 `status=approved` 晋升。
- 否则按 `score DESC` 取当日剩余 follow 配额的 M 人 → follow jobs `source=mutual_expand`。
- 默认 `MUTUAL_EXPAND_ENABLED=false`，`candidate_manual=true`。

### 8. WriteExecutor 本地图一致性（Issue 11 + 计数幂等）

**Claim 前配额检查**（pending 仍保持；不足则 `next_run_at = 下一小时/日界`，不改 attempts）：

- `daily_counters` 与 **`hourly_counters`** 的剩余 follows/unfollows 均 > 0  
- 全局 write min-interval 令牌可用  

**成功 follow 事务（单 BEGIN）** — 计数条件见 K22（**v1 冻结，与 附录 F / PR6a 验收一致**）：

```
edgeBefore = SELECT lost_at, pending_follow FROM following WHERE ...  -- may be null

-- Local already represents an issued follow (confirmed OR pending request)
wasLocalActive = edgeBefore exists AND lost_at IS NULL
-- Confirmed-only (for observation / prose); NOT the charge predicate alone
wasConfirmedActive = wasLocalActive AND pending_follow = FALSE

1. UPDATE jobs SET status='done', stats_charged=?, ... WHERE id=? AND status='running'
   -- 若 rows=0（非 running，竞态）→ ROLLBACK 整事务
2. UPSERT following: lost_at=NULL, source, pending_follow from API；
   **`sync_gen` 按 §5.1 规则 4**：若 `following` stream `full_in_progress` 则 `sync_gen=walk_gen`，否则不改 `sync_gen`
3. observations / candidates 副作用（同前）
4. -- Canonical v1 charge (rate-safety):
   -- chargeStats = NOT wasLocalActive
   --   • true  → 新建边 / 复活 lost / 首次成功写（含 API pendingFollow:true 或 confirmed）
   --   • false → 纯 already-following reconcile（本地已 confirmed active）
   --           或本地已 active pending（含 pending→confirmed 二次写）— 不二次 charge
   -- 单 job 单 TX：stats_charged 只写一次；不得在后续 TX 因 pending→confirmed 再 +1
   chargeStats = NOT wasLocalActive
5. if chargeStats:
     UPSERT daily_counters  follows += 1
       -- day = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
     UPSERT hourly_counters follows += 1
       -- hour = date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       --   TIMESTAMPTZ hour bucket (DDL); NOT a YYYY-MM-DDTHH text string
     jobs.stats_charged = TRUE
   else:
     jobs.stats_charged = FALSE
6. event_log (include charged=true/false)
6b. UPSERT x_users if executor received/cached profile for target (at least id; username when known)
```

| 写前本地边 | API 结果（示意） | chargeStats | 说明 |
|------------|------------------|-------------|------|
| 无边 / `lost_at` 已设 | `pendingFollow: true` | **TRUE** | new pending — 计配额 |
| 无边 / `lost_at` 已设 | confirmed following | **TRUE** | new confirmed — 计配额 |
| `lost_at IS NULL`, `pending_follow = TRUE` | confirmed 或仍 pending | **FALSE** | 已发过 follow；pending→confirmed 不双计 |
| `lost_at IS NULL`, `pending_follow = FALSE` | already following | **FALSE** | 纯 already-following reconcile |

**成功 unfollow 事务**（与 follow 对称：仅“本地仍 active → lost”时 charge）：

```
edgeBefore = ...
wasLocalActive = edgeBefore exists AND lost_at IS NULL
  -- 含 pending_follow TRUE|FALSE：取消未确认请求也计 unfollow 配额

1. job running→done
2. following.lost_at = now()
3. observation → cleared_unfollowed
4. if wasLocalActive:
     daily_counters.unfollows += 1
     hourly_counters.unfollows += 1
       -- hour bucket: date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     stats_charged = TRUE
   else:
     stats_charged = FALSE   -- already not following reconcile
5. event_log
```

**X 返回 already following / already not following**：视为成功，走 reconcile；按上表/`wasLocalActive` 判定 — **本地已是目标态时 `stats_charged=FALSE`**。  

**失败可重试**：job → pending + backoff，**不**改图谱、**不**改 counters。  

**失败 dead**：不改图谱；若 observation 为 `promoted_unfollow`，由 §7.2.1 恢复扫描重新入队。

**At-least-once 场景**：X 已成功、DB 提交前崩溃 → reclaim → 再执行 → 若首 TX 未提交则本地仍 non-active → 再 charge 一次且 job 仍会 done（正确：配额与成功写对齐一次提交）；若已提交则 job 为 `done` 不重跑。已 active 上的 already-* reconcile → **`stats_charged=FALSE`**（K22）。

### 9. 全局限流（Issue 10）

```ts
interface RateConfig {
  // 占位默认值；启动后可被响应头/插件覆盖
  readFollows: { capacity: 15; windowMs: 15 * 60_000 }; // 历史常见档位
  writeFollow: { capacity: 1; minIntervalMs: 45_000 };  // 全局串行 + 45s±jitter
  writeUnfollow: { capacity: 1; minIntervalMs: 45_000 };
  usersLookup: { capacity: 100; windowMs: 15 * 60_000 };
  maxFollowsPerDay: 50;
  maxUnfollowsPerDay: 50;
  maxFollowsPerHour: 8;      // 防 5 分钟打满日配额
  maxUnfollowsPerHour: 8;
  maxReadPagesPerDay: 500;
  jitterMs: 15_000;
}
```

- **日界**：UTC（K19）。  
- **Boot `/ready`**：PostgreSQL 可连接且可写；若 live，`getMe` 成功则 ready；follows 权限失败 → ready 仍 true（进程可服务）但 `capabilities.followsLookup=false`，stats 显示降级。  
- **Capability probe**：`getMe`；可选 1 次 followers 第一页；followWrite 以配置档位/试探错误码记录（不在生产对随机用户试 follow）。  
- **429**：读 `x-rate-limit-reset`；指数退避封顶 15min + jitter。

### 10. X Client 抽象

```ts
export interface XUser {
  id: string;
  username: string;      // handle without @
  name?: string;
  verified?: boolean;    // mapped from API verified_type / verified
  protected?: boolean;
  publicMetrics?: { followersCount?: number; followingCount?: number; tweetCount?: number };
  raw?: unknown;
}

export interface XClient {
  getMe(): Promise<XUser>;
  getFollowers(userId: string, opts: { paginationToken?: string; maxResults?: number }): Promise<Page<XUser>>;
  getFollowing(userId: string, opts: { paginationToken?: string; maxResults?: number }): Promise<Page<XUser>>;
  follow(sourceUserId: string, targetUserId: string): Promise<{ following: boolean; pendingFollow?: boolean }>;
  unfollow(sourceUserId: string, targetUserId: string): Promise<{ following: boolean }>;
}
// 无 getBlocks/getMutes（K18）
// 调用方：Page.users 每一项必须进入 x_users upsert（K26）
```

### 11. API 控制面

Base: `http://localhost:3000/api/v1`（**必须**挂在 `/api/v1`，以便 nginx `location ^~ /api/` 原样反代）。  
Auth: `Authorization: Bearer $ADMIN_TOKEN`（`/health` 除外）。

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | liveness |
| GET | `/ready` | PG + 可选 getMe；见 §9 |
| GET | `/me` | 账户/capabilities/bootstrap 状态 |
| GET | `/stats` | 图计数、队列、今日/小时计数、capabilities、sync flags |
| GET/PUT | `/config` | 含 observation_days；PUT 触发 watching expires 重算 + NOTIFY `config.updated` |
| GET | `/jobs` | 筛选；每项 join `x_users` → 含 `username`/`name` |
| POST | `/jobs/:id/cancel` | pending→cancelled；running→cancel_requested + NOTIFY |
| GET | `/candidates` | join `x_users`（username/name/verified） |
| POST | `/candidates/:id/accept\|reject` | |
| GET | `/observations` | join `x_users` |
| POST | `/control/start\|stop` | automation_enabled + NOTIFY `runtime.changed` |
| POST | `/control/sync-now` | 请求 full_sync（flag）+ NOTIFY |
| GET | `/logs` | 历史；实时用 WS `event_log.append` |
| **WS** | **`/api/v1/ws`** | **实时推送（K23）— 必选** |

**API 写所有权**：仅 `app_config`、`runtime_state`、jobs cancel、candidate approve/reject、短 event_log。**禁止** API 批量改 followers/following。  
**Worker 写所有权**：followers/following、jobs 执行、sync_cursors、counters 递增、observations 扫描副作用。

#### 11.1 WebSocket 实时协议（K23 / K24）

**端点**：`ws://localhost:3000/api/v1/ws`（TLS 拓扑下 `wss://host/api/v1/ws`）。  
与 REST 同 origin 前缀，nginx 一条 `location ^~ /api/` 即可 upgrade。

**鉴权（安全默认）**：连接建立后 **3s 内**必须发送首帧：

```json
{ "type": "auth", "token": "<ADMIN_TOKEN>", "ts": "2026-08-05T12:00:00.000Z" }
```

- 校验 `token === ADMIN_TOKEN`（constant-time compare）；失败则 close code `4401`。  
- **不**把 token 放在 query string（避免 access/proxy 日志泄露）。Flutter 在连接建立后立即发 auth。  
- 可选 v1.1：`Sec-WebSocket-Protocol: bearer,<token>`。

**消息信封**（`packages/shared` zod）：

```ts
type WsEnvelope<T = unknown> = {
  v: 1;
  type: string;
  ts: string;            // ISO-8601 UTC
  payload: T;
  requestId?: string;
};
```

**服务端推送类型（最少集合）**：

| `type` | `payload` 要点 | 触发方 |
|--------|----------------|--------|
| `stats.updated` | 今日/小时计数、队列深度、图规模摘要 | worker executor/sync；可 debounce |
| `job.updated` | `{ id, status, type, targetUserId, username?, name?, lastError?, statsCharged? }` | claim/done/dead/cancel/reclaim；**尽量带 handle** |
| `sync.progress` | `{ stream, phase, pagesDone, walkGen, cursorPresent }` | SyncProducer 每页 flush 后 |
| `runtime.changed` | `{ automationEnabled, graphConsistent, lastError?, capabilities? }` | control、probe、sync flags |
| `config.updated` | config 字段快照或 diff | PUT /config |
| `event_log.append` | `{ id, level, category, message, meta? }` | 写 event_log 后 |

**客户端→服务端（v1）**：`auth`；可选 `ping` → 服务端 `pong`。  
**命令不走 WS**：start/stop/config/cancel 仍用 **REST**。

**发布路径（无 Redis，K24）**：

```
业务 TX COMMIT
  → SELECT pg_notify('auto_x_events', json_payload)   -- payload ≤ ~7.5KB 摘要
API 进程：
  → 独立 pg.Client LISTEN auto_x_events
  → notification → WsHub.broadcast(envelope)
  → 同进程 API 写路径可直接 hub.broadcast（免自听）
```

示例 payload：

```json
{
  "v": 1,
  "type": "job.updated",
  "ts": "2026-08-05T12:00:01.000Z",
  "payload": { "id": 42, "status": "done", "type": "follow", "targetUserId": "123" }
}
```

**节流**：`stats.updated` 合并 ≤500ms；`sync.progress` 每页 ≤1 条。  
**掉线**：NOTIFY 不持久化 → 客户端重连后 **REST 全量 refresh**（`/stats`、`/jobs?status=pending,running`）。

**实现**：Hono + Node HTTP server upgrade + `ws` 包；hub 为 `Map<id, WebSocket>`。

### 12. Flutter UI 与 Dev 拓扑（Issue 13）

**页面**：Dashboard、Config、Queues、Account、Control、Logs、**Token 登录屏**（ADMIN_TOKEN 仅内存，**不写 localStorage** MVP）。
队列/观察/候选列表 **必须显示 `@username` + name**（K26），禁止仅数字 id。

**数据流**：

| 数据 | 路径 |
|------|------|
| 登录后快照 | REST `GET /me` `/stats` `/config` `/jobs` |
| 实时增量 | WS 上表事件 |
| 命令 | REST only |
| 重连 | 指数退避 1s→30s + jitter；auth → REST refresh |

**拓扑 A — 本地开发**

- Compose：`postgres` + `migrate` + `api` + `worker`。  
- `API_BASE=http://localhost:3000/api/v1`，`WS_URL=ws://localhost:3000/api/v1/ws`，CORS 按 `CORS_ORIGIN`。

**拓扑 B — nginx TLS**

- 静态 `https://host/` → `nginx/web`；API/WS `https://host/api/` upgrade 到 api:3000。  
- Flutter 相对路径 `/api/v1`；`WS_URL = wss://<host>/api/v1/ws`。

### 13. Docker 与一键运维

主 compose **必须**编排 PostgreSQL + **一次性 migrate** + api + worker：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env_file: .env
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-autox}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-autox}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"   # dev; prod 可去掉 host 映射
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  # K25: EXACTLY ONE migrator — api/worker MUST NOT run migrations on boot
  migrate:
    build: { context: ., dockerfile: docker/Dockerfile.node, args: { APP: migrate } }
    # or reuse node image: command runs packages/db migrate only
    env_file: .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-autox}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-autox}
    command: ["pnpm", "--filter", "@autox/db", "db:migrate"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  api:
    build: { context: ., dockerfile: docker/Dockerfile.node, args: { APP: api } }
    env_file: .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-autox}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-autox}
      PORT: "3000"
      PG_POOL_MAX: "10"
    ports: ["3000:3000"]
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  worker:
    build: { context: ., dockerfile: docker/Dockerfile.node, args: { APP: worker } }
    env_file: .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-autox}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-autox}
      WORKER_ID: worker-1
      PG_POOL_MAX: "10"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

volumes:
  pgdata:
```

**PostgreSQL 并发（K16）+ 迁移（K25）**

- 每进程 `pg.Pool`（`max: PG_POOL_MAX`，默认 10）。  
- API 另开 **1** 条长连接 `LISTEN auto_x_events`（勿与 pool 混用）。  
- 隔离级别默认 `READ COMMITTED`；claim 用 `FOR UPDATE SKIP LOCKED`。  
- Worker 批写 flush ≤100–500 行/TX；soft-delete 分批 LIMIT。  
- **迁移**：仅 `migrate` 服务执行 `pnpm db:migrate`（Drizzle Kit，`packages/db`）。**api 与 worker 源码不得调用 migrate。**  
- 本地无 compose：开发者手动 `pnpm db:migrate` 一次，仍禁止双进程自动 migrate。  
- PG 不可达 → process.exit(1)；schema 缺失（migrate 未跑）→ 查询失败 / `/ready` false。

**`start.sh`**：校验 `.env`（`ADMIN_TOKEN`、`POSTGRES_PASSWORD`）；`docker compose up -d --build`（compose 保证 migrate 先于 api/worker）。

**`stop.sh`**：`docker compose stop`。Worker：停 claim → drain ≤60s → 退出（lease reclaim 恢复）。API：关 WS + LISTEN。

**备份** `scripts/backup-db.sh`：

```bash
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "backups/autox-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

恢复：`pg_restore --clean -U … -d autox file.dump`。

### 14. Nginx 策略（Issue 9 — 完整缺陷清单）

| 项 | 现状 | 修复（PR10） |
|----|------|----------------|
| 根 compose nginx | 错误路径 + depends drogon | **主 compose = postgres+migrate+api+worker；不含 nginx** |
| standalone 卷 | `./nginx/nginx.conf`、`./nginx/certs` | → `./conf/nginx.conf`、`./conf/certs` |
| standalone 端口 | `80:8080`、`443:8443` | → **`80:80`、`443:443`** |
| upstream | `drogon:8080` | → `host.docker.internal:3000` 或 `api:3000` |
| **WebSocket** | 旧 `/ws/` 可能不一致 | **`location ^~ /api/`**：`proxy_http_version 1.1`；`Upgrade`/`Connection` headers；`proxy_read_timeout 3600s`；端点 **`/api/v1/ws`** |
| tools/** | 必须保留 | PR10 **不修改 tools** |
| mTLS | cert 在 | v1 不 enable `ssl_verify_client` |

### 15. 数据清洗、冷却、保留（Issues 4, 16）

| 机制 | 说明 |
|------|------|
| **身份（K26）** | **稳定 PK = X numeric `user_id`（`x_users.id`）**；**展示用 = `username` handle（无 `@`）** + `name`；rename 时 upsert 覆盖 `username`/`name`，历史 `jobs.target_user_id` 不变 |
| 边 vs 身份 | `followers` / `following` **只存** `(account_id, user_id)`；**禁止**在边表复制 username；读路径 **JOIN `x_users`** |
| Upsert | 用户对象 → `x_users` ON CONFLICT；边 → ON CONFLICT 更新 `last_seen_at` / `sync_gen` / `lost_at` |
| Soft-delete | **仅 full sync 完成**后（边 `lost_at`；**不**删 `x_users`） |
| Active job 去重 | partial unique `(account_id,type,target_user_id) WHERE status IN ('pending','running')` |
| Unfollow 冷却 | `wasUnfollowedRecently(id, days=30)`：`SELECT 1 FROM jobs WHERE type='unfollow' AND status='done' AND target_user_id=$1 AND finished_at > now() - interval '30 days'`；索引 `(type, status, target_user_id, finished_at)` |
| Blocks | **无**；不调用 block API |
| event_log 保留 | 默认 30 天，Retention loop DELETE |
| jobs 保留 | `done/cancelled/dead` 超过 90 天删除或归档；**冷却查询依赖 30 天内 unfollow**，purge 阈值 > cooldown |
| candidates reason | zod schema 校验 |

#### 15.1 `x_users` 规范（必须实现 — 存 @username）

**产品要求**：系统必须保存并展示用户的 **@handle**（API `username` 字段，**去掉**前导 `@`），不能只有数字 id。

**写入规则（所有路径）**：

| 路径 | 动作 |
|------|------|
| Sync full/cheap 每页 users[] | WriteBuffer **先** upsert `x_users`，再 upsert 边 |
| Mutual expander 采样 | 每个见到的 user → upsert `x_users` |
| Bootstrap `getMe` | upsert `accounts` + `x_users`（含自己的 handle） |
| Executor follow 目标 | 若本地缺 profile：尽力 upsert；至少保留 id；下次 sync 补全 username |
| Users lookup（若调用） | 同上 |

**字段语义**：

| 列 | 含义 | 来源 |
|----|------|------|
| `id` | X snowflake user id（**PK，不可变**） | `user.id` |
| `username` | **handle，无前导 `@`**（如 `elonmusk`） | `user.username`；入库前 `stripLeadingAt()` |
| `name` | 显示名 | `user.name` |
| `verified` | 是否认证/蓝 V 等 | 映射 X API：优先 `verified_type` 非 null/`"none"` 之外 → TRUE；或 legacy `verified` boolean。实现写清 mapper 注释 |
| `protected` | 保护账号 | `user.protected` |

**Rename**：同一 `id` 再次出现时 **覆盖** `username`/`name`/`verified` 并刷新 `last_seen_at`。按 username 查找仅为 best-effort（`CREATE INDEX idx_x_users_username_lower ON x_users (lower(username))`）——**不能**当唯一身份。

**读路径 / UI / API / WS（强制）**：

- 管理端 jobs / observations / candidates / followers / following 列表项必须包含：
  `{ userId, username, name, verified? }`（JOIN `x_users`；username 缺失时 UI 显示 `@unknown` + id，并触发补全，**禁止**默认只显示 id）。
- REST 响应与 WS `job.updated` 等推送：payload 中带 `targetUserId` 时 **尽量附带** `username`/`name`（或客户端缓存 x_users map + REST 批量 hydrate）。
- Flutter **禁止**人类可读列表仅渲染数字 id。

**扩张打分**：`expand_prefer_verified`（默认 true）时对 `x_users.verified = TRUE` 的候选 `final_score += 1`（见 §7.3）。

### 16. 配置 `.env.example`

```bash
ADMIN_TOKEN=  # required; boot fails if empty or equals 'change-me-to-long-random'
PORT=3000
# PostgreSQL (compose service name: postgres)
POSTGRES_USER=autox
POSTGRES_PASSWORD=  # required; fail-fast if empty
POSTGRES_DB=autox
DATABASE_URL=postgres://autox:${POSTGRES_PASSWORD}@postgres:5432/autox
# local dev without compose network:
# DATABASE_URL=postgres://autox:secret@127.0.0.1:5432/autox
PG_POOL_MAX=10
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:*
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
X_CLIENT_MODE=live   # live | mock
OBSERVATION_DAYS=7
MAX_FOLLOWS_PER_DAY=50
MAX_UNFOLLOWS_PER_DAY=50
MAX_FOLLOWS_PER_HOUR=8
MAX_UNFOLLOWS_PER_HOUR=8
WRITE_MIN_INTERVAL_MS=45000
FOLLOW_BACK_ENABLED=true
MUTUAL_EXPAND_ENABLED=false
CANDIDATE_MANUAL_APPROVAL=true
UNFOLLOW_COOLDOWN_DAYS=30
LEASE_TTL_SEC=120
```

Boot fail-fast：`ADMIN_TOKEN` 长度 < 16 或弱默认；`POSTGRES_PASSWORD` / `DATABASE_URL` 缺失；PG 连不上 → **process.exit(1)**。

---

## Data Model Changes / 数据模型

**引擎**：PostgreSQL 16。  
**访问**：`pg` Pool + **Drizzle ORM**（`packages/db/src/schema.ts` + `drizzle-kit` migrations）。  
**迁移**：仅 compose **`migrate`** 服务 / 开发者手动 `pnpm db:migrate`（K25）；api/worker **不**跑 migrate。  
**时间**：业务时间列统一 `TIMESTAMPTZ`（存 UTC）；日界 `DATE`；小时桶 `date_trunc('hour', …)`。  
**布尔**：`BOOLEAN`（`TRUE`/`FALSE`；禁止用 0/1 表示布尔）。  
**JSON**：`JSONB`（capabilities、reason、meta）。  
**身份**：`x_users` 存 **@handle（username）** + display name + verified；边表仅 FK 到 `user_id`（K26）。

### 核心 DDL（PostgreSQL）

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE x_users (
  id TEXT PRIMARY KEY,                 -- X numeric user id (stable)
  username TEXT NOT NULL,              -- handle WITHOUT leading @
  name TEXT,                          -- display name
  verified BOOLEAN NOT NULL DEFAULT FALSE,  -- blue-V / verified mapper (K26)
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  followers_count INTEGER,
  following_count INTEGER,
  tweet_count INTEGER,
  raw_json JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- best-effort lookup only; username changes over time — id is identity
CREATE INDEX idx_x_users_username_lower ON x_users (lower(username));

CREATE TABLE followers (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,              -- FK logical → x_users.id; no username here
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL,
  lost_at TIMESTAMPTZ,
  sync_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX idx_followers_sync_gen ON followers(account_id, sync_gen) WHERE lost_at IS NULL;

CREATE TABLE following (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,              -- FK logical → x_users.id; no username here
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL,
  lost_at TIMESTAMPTZ,
  source TEXT,
  pending_follow BOOLEAN NOT NULL DEFAULT FALSE,
  sync_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX idx_following_sync_gen ON following(account_id, sync_gen) WHERE lost_at IS NULL;

CREATE TABLE observations (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX idx_obs_due ON observations(status, expires_at);

CREATE TABLE follow_candidates (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason JSONB,  -- foaf_following_overlap
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_user_id TEXT,
  source TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|cancelled|dead
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  stats_charged BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_jobs_claim ON jobs(status, next_run_at, priority, id);
CREATE UNIQUE INDEX ux_jobs_active_pair
  ON jobs(account_id, type, target_user_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX idx_jobs_unfollow_hist
  ON jobs(type, status, target_user_id, finished_at);

CREATE TABLE sync_cursors (
  account_id TEXT NOT NULL,
  stream TEXT NOT NULL,  -- followers | following
  cursor TEXT,
  phase TEXT NOT NULL DEFAULT 'idle',
  pages_done INTEGER NOT NULL DEFAULT 0,
  walk_gen INTEGER NOT NULL DEFAULT 0,
  last_completed_walk_gen INTEGER NOT NULL DEFAULT 0,
  full_sync_completed BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_sync_at TIMESTAMPTZ,
  last_cheap_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, stream)
);

CREATE TABLE app_config (
  account_id TEXT PRIMARY KEY,
  observation_days INTEGER NOT NULL DEFAULT 7,
  max_follows_per_day INTEGER NOT NULL DEFAULT 50,
  max_unfollows_per_day INTEGER NOT NULL DEFAULT 50,
  max_follows_per_hour INTEGER NOT NULL DEFAULT 8,
  max_unfollows_per_hour INTEGER NOT NULL DEFAULT 8,
  unfollow_cooldown_days INTEGER NOT NULL DEFAULT 30,
  follow_back_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mutual_expand_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  candidate_manual BOOLEAN NOT NULL DEFAULT TRUE,
  follow_protected BOOLEAN NOT NULL DEFAULT FALSE,
  reobserve_on_non_mutual BOOLEAN NOT NULL DEFAULT TRUE,
  cheap_refresh_pages INTEGER NOT NULL DEFAULT 2,
  expand_max_seeds INTEGER NOT NULL DEFAULT 5,
  expand_max_pages_per_seed INTEGER NOT NULL DEFAULT 1,
  extra_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runtime_state (
  account_id TEXT PRIMARY KEY,
  automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  followers_sync_ok BOOLEAN NOT NULL DEFAULT FALSE,
  following_sync_ok BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_sync_at TIMESTAMPTZ,
  sync_now_requested BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities_json JSONB, -- {"followsLookup":bool,"followWrite":bool,"probedAt":"..."}
  last_sync_status TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE daily_counters (
  account_id TEXT NOT NULL,
  day DATE NOT NULL,  -- (ts AT TIME ZONE 'UTC')::date
  follows INTEGER NOT NULL DEFAULT 0,
  unfollows INTEGER NOT NULL DEFAULT 0,
  read_pages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE hourly_counters (
  account_id TEXT NOT NULL,
  -- hour bucket: date_trunc('hour', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  -- store TIMESTAMPTZ only; never YYYY-MM-DDTHH text
  hour TIMESTAMPTZ NOT NULL,
  follows INTEGER NOT NULL DEFAULT 0,
  unfollows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, hour)
);

CREATE TABLE event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL,
  category TEXT,
  message TEXT NOT NULL,
  meta_json JSONB
);
```

**Upsert 方言**（示例）：

```sql
INSERT INTO followers AS f (account_id, user_id, connected_at, last_seen_at, lost_at, sync_gen)
VALUES ($1, $2, now(), now(), NULL, $3)
ON CONFLICT (account_id, user_id) DO UPDATE SET
  last_seen_at = EXCLUDED.last_seen_at,
  lost_at = NULL,
  sync_gen = EXCLUDED.sync_gen;
```

**无 `blocks` 表（K18）。**  
**NOTIFY 无表**：频道名 `auto_x_events` 为约定字符串，无需 DDL。

## Alternatives Considered

### A1. SQLite vs PostgreSQL  
**SQLite 否决（rev 4.0）**：无法满足用户要求的 **api + worker 并发写**、连接池与行级锁；文件锁/`busy_timeout` 在双容器下脆弱。  
**PostgreSQL 16 胜出**：Compose 编排、`SKIP LOCKED` claim、`LISTEN/NOTIFY` 实时 fan-out、`pg_dump` 备份。

### A2. BullMQ/Redis vs DB+Memory + NOTIFY  
**Redis 否决（v1）**：jobs lease 在 PG 已够；UI 实时用 PG NOTIFY，避免第二数据面。若 NOTIFY 吞吐成瓶颈再评估（非 v1）。

### A3. 单进程 vs 双进程  
生产双进程；dev 可合并。

### A4. 官方 XDK vs twitter-api-v2  
默认后者；接口隔离。

### A5. React vs Flutter  
Flutter Web（用户环境 + nginx 规则）。

### A6. 浏览器自动化  
**拒绝**：Non-Goals；ToS/脆弱性；只用官方 API。

---

## Security & Privacy

| 威胁 | 缓解 |
|------|------|
| 弱 ADMIN_TOKEN | Boot fail-fast |
| 弱/空 `POSTGRES_PASSWORD` | Boot fail-fast；不提交真实密码 |
| X secret 泄露 | 不下发前端；gitignore |
| WS token 泄露 | **禁止** query-string token；首帧 auth；HTTPS/WSS 拓扑 B |
| PG 暴露 | prod 不映射 5432 到公网；仅 compose 网络 |
| XSS 偷 token | 内存存储 MVP；HTTPS 拓扑 B |
| 自动化封号 | 保守配额；UI 警告 |
| mTLS | v1 不用；资产保留 |

---

## Observability

- **pino** → stdout；`event_log` 30 天；关键写路径附带 WS `event_log.append`。  
- **GET /stats** + WS `stats.updated`：队列、sync flags、capabilities、lease 数、今日/小时计数。  
- **Runbook（README / PR11）**：  
  - stuck `running` → 等 lease TTL 或查 `locked_at`；手动 `UPDATE … pending`  
  - 备份：`scripts/backup-db.sh`（`pg_dump -Fc`）  
  - stop = SIGTERM drain；API 关闭 LISTEN  
  - WS 无推送：查 API LISTEN 连接、PG `pg_notification_queue_usage()`  
- Healthcheck：api `node -e fetch`；postgres `pg_isready`。

---

## Rollout Plan

| 阶段 | 内容 |
|------|------|
| P0 | 清理 + 骨架 + compose(postgres/migrate/api/worker) + health + 弱 token 拒绝 |
| P1 | Drizzle schema + **唯一 migrate 服务** + bootstrap mock + x_users handle |
| P2 | Full/cheap sync 耐久序 + mock 图 + NOTIFY sync.progress |
| P3 | SKIP LOCKED lease executor + 本地图 TX（mock write） |
| P4 | Scanners + observation SM |
| P5 | Expander + promoter |
| P6 | REST + **WS hub** + Flutter（REST+WS） |
| P7 | nginx 路径/端口/**WS upgrade**；live dry-run；单次 test follow |
| P8 | 硬化保留、`pg_dump` runbook |

Feature flags：`follow_back_enabled`、`mutual_expand_enabled`、`candidate_manual`、`automation_enabled`。

回滚：stop → 镜像回退 → DB 备份恢复。

---

## Open Questions

1. 租户 API 是否真有 follows 读/写权限？（启动 probe 暴露；无权限则只读缓存/人工）  
2. 候选是否长期强制人工审批？默认 true。  
3. 是否需要 `seed_mutuals` 双列表模式？默认否。  
4. 是否要桌面 Flutter？  
5. 多账号时间表？  

（日界已定为 UTC — 自 Open Questions 移除。）

---

## References

- 仓库：`/home/lighthouse/auto-x`  
- nginx tools：`nginx/tools/certificates/self_sign_server_client_crt_now`  
- twitter-api-v2、X Developer docs  
- PostgreSQL 16、`pg`、Drizzle ORM  
- Hono + `ws` WebSocket  

---

## PR Plan

### PR1 — 仓库清理 + monorepo + Compose(Postgres + migrate)
- **标题**：`chore: scaffold monorepo with postgres/migrate/api/worker compose`
- **影响**：删除 drogon/massage/redis 遗留；**主 compose：`postgres` + `migrate`（one-shot）+ `api` + `worker`**；volume `pgdata`；api/worker `depends_on: migrate: service_completed_successfully`；**api/worker 镜像不含 boot-migrate**；骨架包；`scripts/*`；**README：tools 保留、风险、PG+WS、唯一 migrator**；弱 token / 空 PG 密码 fail-fast stub
- **依赖**：无
- **验收**：`start.sh` → postgres healthy → migrate exit 0 → api `/health` 200；**并行启 api+worker 不双跑 migrate**；`nginx/tools/**` 未删；无 SQLite 文件 SoT

### PR2 — PostgreSQL schema / Drizzle migrations / repos
- **标题**：`feat(db): drizzle schema — leases, sync_gen, x_users.username/verified, counters`
- **影响**：`packages/db/**` — Pool、Drizzle schema、migrations；`x_users.username/name/verified`；partial unique；`stats_charged` BOOLEAN；`hourly_counters.hour TIMESTAMPTZ`；`db:migrate` CLI **仅**供 migrate 服务/开发者手动
- **依赖**：PR1
- **验收**：`pnpm db:migrate` 幂等；二次 migrate no-op；claim SQL 单测（`SKIP LOCKED`）；**源码 grep 确认 apps/api 与 apps/worker 无 migrate 调用**；无 better-sqlite3

### PR3 — XClient + mock + bootstrap
- **标题**：`feat(x-client): XClient, mock graph, bootstrap getMe + x_users upsert`
- **依赖**：PR1–2
- **验收**：mock 种子 account + **x_users.username** 入 PG；live 无密钥不崩；getMe 写入 handle

### PR4 — Domain 纯规则
- **标题**：`feat(domain): follow-back, observation SM, foaf score pure functions`
- **依赖**：PR2 类型
- **验收**：表驱动测试覆盖 re-follow、mutual flip、expires 重算输入

### PR5 — WriteBuffer + SyncProducer（full/cheap + flush-before-cursor）
- **标题**：`feat(worker): durable sync producer with full/cheap modes`
- **依赖**：PR2–3
- **验收**：
  1. 崩溃模拟 cursor 不超前；未完成 full **不** soft-delete
  2. Idle 时 cheap **不**改 `sync_gen`；full 页始终盖 `walk_gen`
  3. 完成 walk 后仅 `sync_gen < walk_gen` mark lost
  4. **并发必测**：start full following → executor follow U → 完成 walk → U **不得** `lost_at`
  5. **并发必测**：full + cheap 新粉丝不得误删
  6. 每页 flush 后 `pg_notify` → `sync.progress`（可先单测 notify 调用）
  7. 每页 users **必须** upsert `x_users`（username/name/verified）；边行无 username 列

### PR6a — Job claim/lease/reclaim + WriteExecutor + 本地图 TX
- **标题**：`feat(worker): SKIP LOCKED leases and executor graph side effects`
- **依赖**：PR2–3
- **验收**：
  1. kill -9 后 reclaim；无 `retry` 状态；并发 claim 单测（`SKIP LOCKED`）
  2. follow 成功 following 行存在；daily+hourly 预检/递增
  3. **`pendingFollow: true` 首次成功** → `stats_charged=true`，counters +1
  4. **new confirmed 首次成功** → charged
  5. **already-following** → `stats_charged=false`
  6. **本地已 pending 再成功** → 不二次 charge
  7. unfollow 对称 charge 规则
  8. 成功路径 `pg_notify` `job.updated` + `stats.updated`

### PR6b — FollowBack + Observer scanners + daily/hourly caps
- **标题**：`feat(worker): follow-back and observation scanners with sync gate`
- **依赖**：PR4, PR6a
- **验收**：`graph_consistent=false` 不 unfollow；promote 与 insert job 同 TX；`promoted_unfollow` 恢复

### PR7 — Mutual expander + CandidatePromoter
- **标题**：`feat(worker): foaf_following_overlap expander and promoter`
- **依赖**：PR6b
- **验收**：预算熔断；默认关闭；manual approval

### PR8 — Admin REST + WebSocket hub + LISTEN
- **标题**：`feat(api): REST control plane + /api/v1/ws + PG LISTEN fan-out`
- **依赖**：PR2；控制写与 PR6a 可并行收尾
- **影响**：Bearer REST；**WS 鉴权首帧**；hub；独立 Client `LISTEN auto_x_events`；同进程 broadcast；CORS
- **验收**：
  1. 弱 token 拒启动；`/me` needs_bootstrap
  2. WS 无 auth → 3s 内 close 4401
  3. worker `pg_notify` → 已连接客户端收到 `job.updated` / `stats.updated` / `sync.progress`
  4. PUT config → `config.updated`；start/stop → `runtime.changed`
  5. 掉线重连后 REST refresh 不丢一致性

### PR9 — Flutter MVP（REST + WS）
- **标题**：`feat(frontend): Flutter admin — REST commands + WS live updates`
- **依赖**：PR8
- **验收**：拓扑 A CORS；相对 `/api/v1`；WS 连接+auth+重连退避；Dashboard 随 `stats.updated`/`job.updated` 刷新；**不**依赖仅轮询；Jobs/Obs/Candidates **显示 @username**，禁止仅裸 id

### PR10 — Nginx 独立 compose 修正 + WS upgrade
- **标题**：`fix(nginx): volumes, 80:80/443:443, upstream, WebSocket headers`
- **影响**：upstream → API；**upgrade headers** for `/api/`；**不改 tools/**
- **依赖**：API 端口稳定
- **验收**：standalone 起；反代 health；`wss` 长连接不掉；tools diff 空

### PR11 — 硬化、live 门禁、pg_dump runbook
- **标题**：`chore: retention, pg_dump backup, live dry-run checklist`
- **依赖**：PR7–10
- **验收清单（强制）**：  
  1. Mock E2E（含 WS 事件）  
  2. Live dry-run 只读  
  3. Live 测试号单次 follow+unfollow  
  4. reclaim / buffer-cursor / observation gate / WS 重连 回归  
  5. `backup-db.sh`（pg_dump）+ stuck-job runbook  

## 附录 A — Full Sync 算法（耐久序 + sync_gen + 并发盖章）

```
FullSyncFollowers(accountId):
  row = load sync_cursors(accountId, 'followers')
  if row.phase == 'full_in_progress' AND row.cursor is resumable:
    walk_gen = row.walk_gen                 -- resume: DO NOT increment
  else:
    walk_gen = row.walk_gen + 1
    UPDATE sync_cursors SET walk_gen=walk_gen, phase='full_in_progress',
      cursor=NULL, pages_done=0 WHERE ...
  loop:
    page = x.getFollowers(..., token=cursor)
    writeBuffer.enqueue(x_users upserts for each user: id, username, name, verified, metrics)
    writeBuffer.enqueue(follower edges with sync_gen=walk_gen, lost_at=NULL)  -- user_id only
    writeBuffer.flush()
    saveCursor(page.nextToken)             -- only after flush
    pages_done++
    if !page.nextToken: break
    if !rateBudget: return                 -- phase stays full_in_progress; same walk_gen
  UPDATE followers SET lost_at=now()
    WHERE account_id=? AND lost_at IS NULL AND sync_gen < walk_gen
  UPDATE sync_cursors SET phase='idle', cursor=NULL, full_sync_completed = TRUE,
    last_full_sync_at=now, last_completed_walk_gen=walk_gen
  runtime_state.followers_sync_ok=1
  recompute graph_consistent

CheapRefreshFollowers(accountId):
  -- May run concurrent with full on same stream
  row = load sync_cursors(accountId, 'followers')
  stamp = (row.phase == 'full_in_progress') ? row.walk_gen : null
  -- optional: set phase=cheap_in_progress only when was idle; if full_in_progress, leave phase
  token=null
  for i in 1..cheap_refresh_pages:
    page = getFollowers(token)
    flush upserts:
      last_seen_at=now, lost_at=NULL
      if stamp != null: sync_gen = stamp    -- concurrent full: join this walk
      else: do not touch sync_gen
    token = page.nextToken
    if !token: break
  if phase was set to cheap_in_progress: phase=idle
  -- NEVER mark lost; NEVER walk_gen++

-- Executor follow (stream following) uses same stamp rule via edgeSyncGenForUpsert(..., 'following')
```

**并发正确性说明**：mid-walk 盖章 ≠ “声称 X 列表页返回了该用户”，而是 “本进程在本 walk 生命周期内确认边仍活跃，故不得在 walk 结束时当缺失边删除”。Full 页盖章仍覆盖 API 枚举到的全集；本地写路径盖章覆盖 API 分页顺序/滞后导致的假缺失。

## 附录 B — Job 状态机与 Claim SQL（PostgreSQL）

见 §4；规范 claim：

```sql
BEGIN;
WITH cte AS (
  SELECT id
  FROM jobs
  WHERE status = 'pending'
    AND next_run_at <= now()
  ORDER BY priority ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs j
SET status = 'running',
    locked_at = now(),
    locked_by = $1,
    updated_at = now()
FROM cte
WHERE j.id = cte.id
RETURNING j.*;
COMMIT;
```

Reclaim 见 §4.4。Claim 提交后勿在同一事务内挂起等待 X HTTP。

## 附录 C — Observation 转换表

| From | Predicate | To | Side effects |
|------|-----------|-----|--------------|
| (none) | following ∧ ¬mutual ∧ ¬pending_follow | watching | entered_at=now, expires_at=+days |
| watching | mutual | cleared_mutual | |
| watching | ¬following | cleared_unfollowed | |
| watching | due ∧ ¬mutual ∧ graph_consistent | promoted_unfollow | **same TX** insert unfollow job |
| watching | due ∧ ¬graph_consistent | watching | defer |
| any terminal | re-follow ∧ ¬mutual ∧ reobserve | watching | **new** entered_at |
| watching | config days change | watching | expires_at recomputed |
| promoted_unfollow | unfollow job done | cleared_unfollowed | following.lost_at |
| promoted_unfollow | no active unfollow job ∧ still due ∧ ¬mutual ∧ graph_consistent | promoted_unfollow | **same TX** re-insert job |
| promoted_unfollow | no active job ∧ ¬graph_consistent | watching | keep entered_at/expires_at |
| promoted_unfollow | no active job ∧ mutual | cleared_mutual | |
| promoted_unfollow | no active job ∧ ¬following | cleared_unfollowed | |

## 附录 D — 遗留 compose 清理表

| 遗留项 | 动作 |
|--------|------|
| drogon / massage-postgres / redis / paddleocr | **删除**；新建 **autox** 专用 `postgres:16` 服务（非 massage DB） |
| 根 nginx 服务 | 删除（改独立）；主 compose = **postgres + api + worker** |
| standalone 卷/端口错误 | PR10 修 |
| upstream drogon | → host.docker.internal:3000 或 `api:3000` |
| SQLite / `DATABASE_PATH` | **删除**；统一 `DATABASE_URL` |
| tools/** | **保留** |

## 附录 E — 速率占位与 Override

默认见 §9；运行时 `twitter-api-v2` rate limit plugin 缓存 headers，覆盖 capacity/window。写路径额外强制 `minIntervalMs + U(0,jitter)`。

## 附录 F — Executor 成功事务伪代码（含 hourly + 幂等 charge）

**与 §8 / K22 同一公式（v1 冻结）——禁止另写 “simplify” 变体。**

```ts
db.transaction(() => {
  const edge = following.get(job.targetUserId);
  // Active = issued follow still present (confirmed OR pending request)
  const wasLocalActive = !!edge && edge.lost_at == null;
  // Confirmed-only helper (observations / debugging); not the charge predicate
  const wasConfirmedActive =
    wasLocalActive && edge!.pending_follow === false;

  // Must be running→done; else abort (lease reclaim race)
  if (!jobs.markDoneIfRunning(job.id)) throw new AbortTx();

  if (job.type === 'follow') {
    following.upsertActive(job.targetUserId, {
      source: job.source,
      pendingFollow: !!result.pendingFollow,
      // sync_gen: edgeSyncGenForUpsert(db, accountId, 'following')
      //   if full_in_progress → stamp walk_gen; else leave unchanged
      syncGen: edgeSyncGenForUpsert(db, accountId, 'following'),
    });
    if (!result.pendingFollow) {
      observations.ensureWatchingIfNonMutual(job.targetUserId);
    }
    candidates.markFollowed(job.targetUserId);

    // K22 / §8 canonical v1 (rate-safety):
    // chargeStats = !wasLocalActive
    //   charge: new/revived edge, including pendingFollow:true first success
    //   no charge: already-following reconcile OR local already active pending
    //              (pending→confirmed must not double-count)
    const chargeStats = !wasLocalActive;
    if (chargeStats) {
      counters.incFollowDaily(utcDay());
      counters.incFollowHourly(hourBucketUtc()); // date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      jobs.setStatsCharged(job.id, true);
    } else {
      jobs.setStatsCharged(job.id, false);
    }
  } else if (job.type === 'unfollow') {
    following.markLost(job.targetUserId); // does not touch sync_gen meaningfully
    observations.markClearedUnfollowed(job.targetUserId);
    // Symmetric: charge only when local was still active (pending or confirmed)
    if (wasLocalActive) {
      counters.incUnfollowDaily(utcDay());
      counters.incUnfollowHourly(hourBucketUtc());
      jobs.setStatsCharged(job.id, true);
    } else {
      jobs.setStatsCharged(job.id, false);
    }
  }
  // after COMMIT:
  await notify('auto_x_events', {
    v: 1,
    type: job.type === 'follow' ? 'job.updated' : 'job.updated',
    ts: new Date().toISOString(),
    payload: { id: job.id, status: 'done', type: job.type, targetUserId: job.targetUserId },
  });
  await notify('auto_x_events', {
    v: 1,
    type: 'stats.updated',
    ts: new Date().toISOString(),
    payload: { /* optional thin hint; clients may re-fetch */ },
  });
})();

// Pre-claim / pre-HTTP (outside or before TX):
// require daily remaining AND hourly remaining for job.type
// Driver: pg Pool + drizzle transaction (PostgreSQL), not better-sqlite3
```

## 附录 G — WebSocket / NOTIFY 速查

| 项 | 值 |
|----|-----|
| WS path | `/api/v1/ws` |
| Auth | first message `{ type: "auth", token }` within 3s |
| PG channel | `auto_x_events` |
| Envelope | `{ v:1, type, ts, payload }` |
| Push types | `stats.updated`, `job.updated`, `sync.progress`, `runtime.changed`, `config.updated`, `event_log.append` |
| Commands | REST only |
| Client reconnect | backoff + REST snapshot |

---

*文档结束 — Draft rev 4.1 — migrate ownership + x_users @handle — 2026-08-05*
