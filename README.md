# auto-x

X (Twitter) single-account relationship automation: cache followers/following in **PostgreSQL**, run follow-back / observation unfollow / FOAF expansion jobs via a **worker**, expose a **Hono API** (REST + future WebSocket) for a Flutter admin UI.

## Product risk

> **Critical.** X API terms and product capabilities change. Follows lookup and write endpoints may require paid tiers or may be restricted. Automating follow/unfollow can violate X automation policies and risk account limits or suspension. This project assumes the operator has valid API credentials with the needed endpoints and uses conservative rate limits. A mock client mode is planned for development without hitting live X.

Use at your own risk. Prefer `X_CLIENT_MODE=mock` until credentials and quotas are confirmed.

## Topology (PR1)

Main Docker Compose stack (network `autox`):

| Service    | Role                                                                 |
|------------|----------------------------------------------------------------------|
| `postgres` | PostgreSQL 16 (`autox` user/db), volume `pgdata`, port 5432          |
| `migrate`  | One-shot (`restart: "no"`) runs `pnpm db:migrate` then exits         |
| `api`      | Node Hono on port **3000** — `GET /health` → `{ "ok": true }`        |
| `worker`   | Node background process (stub logs “worker started”, stays alive)    |

- **Not** in main compose: redis, drogon, massage, paddleocr, nginx.
- `api` and `worker` wait for `postgres` healthy **and** `migrate` `service_completed_successfully`.
- **Neither api nor worker runs migrations on boot** — only the `migrate` service (or manual `pnpm db:migrate`).

PR1 migrate is a **no-op stub** that prints `PR1: no migrations yet` and exits 0. Real Drizzle schema/migrations land in a later PR.

### Future: WebSocket + PG NOTIFY

Admin UI will use REST for commands and **WebSocket** (`/api/v1/ws`) for live stats/jobs/sync. Cross-process fan-out uses Postgres `LISTEN`/`NOTIFY` (channel `auto_x_events`) — **no Redis**.

## Preserve nginx tools

- **`nginx/tools/`** (certificate helpers, e.g. `self_sign_server_client_crt_now`) must **not** be deleted or rewritten.
- Nginx is **optional / independent** for PR1 (`nginx/docker-compose.yml`). Main compose does not start nginx.
- Design doc: [`docs/design-auto-x.md`](docs/design-auto-x.md).

## Prerequisites

- Docker + Docker Compose v2
- Node 20+ and **pnpm 9** (e.g. `corepack enable` or install under `~/.local/bin`)
- Copy env: `cp .env.example .env` and set secrets

Required in `.env`:

- `ADMIN_TOKEN` — length ≥ 16; not empty; not `change-me-to-long-random` (API fail-fast)
- `POSTGRES_PASSWORD` — non-empty

## Quick start (Docker)

```bash
cp .env.example .env
# edit ADMIN_TOKEN and POSTGRES_PASSWORD

./scripts/start.sh
# or: make up

curl -s http://localhost:3000/health
# {"ok":true}

./scripts/logs.sh
./scripts/stop.sh
# or: make down / make logs
```

## Local dev (without full compose)

```bash
export PATH="$HOME/.local/bin:$PATH"
pnpm install

# Optional: only postgres via compose
# docker compose up -d postgres
# pnpm db:migrate   # PR1 stub

export ADMIN_TOKEN="local-dev-token-16chars-min"
export PORT=3000
pnpm --filter @autox/api start
# other terminal:
pnpm --filter @autox/worker start
```

## Monorepo layout

```
apps/api          Hono API
apps/worker       Worker process
packages/db       DB + migrate CLI (stub in PR1)
packages/shared   Shared types
packages/config   Config / ADMIN_TOKEN checks
packages/x-client X API client (stub)
packages/domain   Domain pure logic (stub)
docker/           Dockerfile.node
scripts/          start.sh stop.sh logs.sh
nginx/            Optional edge; tools/ preserved
docs/             design-auto-x.md
```

## Makefile

| Target     | Action                          |
|------------|---------------------------------|
| `make up`  | `./scripts/start.sh`            |
| `make down`| `./scripts/stop.sh`             |
| `make logs`| `./scripts/logs.sh`             |
| `make build` | `docker compose build`        |
| `make install` | `pnpm install`              |
| `make migrate` | `pnpm db:migrate`           |
| `make config`  | `docker compose config`     |

## License / status

Internal scaffold. See design doc for architecture decisions (K1–K26).
