/**
 * API: REST control plane + WebSocket hub + PG LISTEN fan-out.
 * Does NOT run migrations.
 */
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer, WebSocket } from "ws";
import pg from "pg";
import { isAdminTokenWeak } from "@autox/config";
import {
  getPool,
  getPrimaryAccount,
  getRuntime,
  logEvent,
  pgNotify,
  query,
  setConfig,
  setRuntime,
  stats,
  getConfigMap,
} from "@autox/db";
import { envelope, settingsFromEnv, WS_CHANNEL } from "@autox/shared";

function assertAdminToken(): string {
  const token = process.env.ADMIN_TOKEN;
  if (isAdminTokenWeak(token)) {
    console.error(
      "FATAL: ADMIN_TOKEN is missing, too short (<16), or equals the weak placeholder.",
    );
    process.exit(1);
  }
  return token!.trim();
}

const ADMIN = assertAdminToken();
const settings = settingsFromEnv();

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

app.get("/health", (c) => c.json({ ok: true as const }));

// Serve admin UI (also copied under nginx/web for topology B)
app.get("/", async (c) => {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // apps/api/src -> ../public/index.html
    const root = join(dirname(fileURLToPath(import.meta.url)), "../public/index.html");
    const html = await readFile(root, "utf8");
    return c.html(html);
  } catch {
    return c.text("admin UI missing", 404);
  }
});

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") || c.req.header("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7).trim();
}

app.use("/api/v1/*", async (c, next) => {
  const t = bearer(c);
  if (t !== ADMIN) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/api/v1/me", async (c) => {
  const account = await getPrimaryAccount();
  const rt = await getRuntime();
  return c.json({
    account: account
      ? { id: account.id, username: account.username, name: account.name }
      : null,
    runtime: rt,
    needsBootstrap: rt?.needs_bootstrap ?? true,
  });
});

app.get("/api/v1/stats", async (c) => {
  const account = await getPrimaryAccount();
  if (!account) return c.json({ empty: true });
  return c.json(await stats(account.id));
});

app.get("/api/v1/config", async (c) => {
  const dbCfg = await getConfigMap();
  return c.json({ env: settings, db: dbCfg });
});

app.put("/api/v1/config", async (c) => {
  const body = await c.req.json<{ key: string; value: unknown }>();
  if (!body?.key) return c.json({ error: "key required" }, 400);
  await setConfig(body.key, body.value);
  await pgNotify(WS_CHANNEL, envelope("config.updated", { key: body.key, value: body.value }));
  return c.json({ ok: true });
});

app.get("/api/v1/jobs", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const params: unknown[] = [];
  let sql = `SELECT j.*, u.username, u.name, u.verified
    FROM jobs j
    LEFT JOIN x_users u ON u.id = j.target_user_id`;
  if (status) {
    params.push(status.split(","));
    sql += ` WHERE j.status = ANY($1)`;
  }
  sql += ` ORDER BY j.id DESC LIMIT ${limit}`;
  const r = await query(sql, params);
  return c.json({
    jobs: r.rows.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      targetUserId: j.target_user_id,
      username: j.username,
      name: j.name,
      verified: j.verified,
      source: j.source,
      lastError: j.last_error,
      statsCharged: j.stats_charged,
      createdAt: j.created_at,
      finishedAt: j.finished_at,
    })),
  });
});

app.post("/api/v1/jobs/:id/cancel", async (c) => {
  const id = c.req.param("id");
  await query(
    `UPDATE jobs SET cancel_requested=TRUE,
       status = CASE WHEN status='pending' THEN 'cancelled' ELSE status END,
       finished_at = CASE WHEN status='pending' THEN now() ELSE finished_at END,
       updated_at=now()
     WHERE id=$1`,
    [id],
  );
  await pgNotify(WS_CHANNEL, envelope("job.updated", { id: Number(id), status: "cancel_requested" }));
  return c.json({ ok: true });
});

app.get("/api/v1/followers", async (c) => {
  const account = await getPrimaryAccount();
  if (!account) return c.json({ items: [] });
  const r = await query(
    `SELECT f.user_id, u.username, u.name, u.verified
     FROM followers f JOIN x_users u ON u.id=f.user_id
     WHERE f.account_id=$1 AND f.lost_at IS NULL
     ORDER BY u.username LIMIT 200`,
    [account.id],
  );
  return c.json({
    items: r.rows.map((x) => ({
      userId: x.user_id,
      username: x.username,
      name: x.name,
      verified: x.verified,
    })),
  });
});

app.get("/api/v1/following", async (c) => {
  const account = await getPrimaryAccount();
  if (!account) return c.json({ items: [] });
  const r = await query(
    `SELECT g.user_id, g.pending_follow, u.username, u.name, u.verified
     FROM following g JOIN x_users u ON u.id=g.user_id
     WHERE g.account_id=$1 AND g.lost_at IS NULL
     ORDER BY u.username LIMIT 200`,
    [account.id],
  );
  return c.json({
    items: r.rows.map((x) => ({
      userId: x.user_id,
      username: x.username,
      name: x.name,
      verified: x.verified,
      pendingFollow: x.pending_follow,
    })),
  });
});

app.get("/api/v1/observations", async (c) => {
  const account = await getPrimaryAccount();
  if (!account) return c.json({ items: [] });
  const r = await query(
    `SELECT o.*, u.username, u.name, u.verified
     FROM observations o JOIN x_users u ON u.id=o.user_id
     WHERE o.account_id=$1 ORDER BY o.expires_at ASC LIMIT 200`,
    [account.id],
  );
  return c.json({
    items: r.rows.map((x) => ({
      userId: x.user_id,
      username: x.username,
      name: x.name,
      verified: x.verified,
      status: x.status,
      expiresAt: x.expires_at,
    })),
  });
});

app.get("/api/v1/candidates", async (c) => {
  const account = await getPrimaryAccount();
  if (!account) return c.json({ items: [] });
  const r = await query(
    `SELECT c.*, u.username, u.name, u.verified
     FROM follow_candidates c JOIN x_users u ON u.id=c.user_id
     WHERE c.account_id=$1 ORDER BY c.score DESC LIMIT 100`,
    [account.id],
  );
  return c.json({
    items: r.rows.map((x) => ({
      id: x.id,
      userId: x.user_id,
      username: x.username,
      name: x.name,
      verified: x.verified,
      score: x.score,
      status: x.status,
      reason: x.reason,
    })),
  });
});

app.post("/api/v1/candidates/:id/approve", async (c) => {
  const id = c.req.param("id");
  const account = await getPrimaryAccount();
  if (!account) return c.json({ error: "no account" }, 400);
  const r = await query(
    `UPDATE follow_candidates SET status='approved', updated_at=now() WHERE id=$1 RETURNING *`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  await query(
    `INSERT INTO jobs (account_id, type, target_user_id, source, priority, status, next_run_at)
     SELECT $1,'follow',$2,'foaf_expand',80,'pending',now()
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs WHERE account_id=$1 AND type='follow' AND target_user_id=$2
         AND status IN ('pending','running')
     )`,
    [account.id, row.user_id],
  );
  return c.json({ ok: true });
});

app.get("/api/v1/events", async (c) => {
  const r = await query(
    `SELECT id, level, category, message, meta, created_at FROM event_log ORDER BY id DESC LIMIT 100`,
  );
  return c.json({ events: r.rows });
});

app.post("/api/v1/control/start", async (c) => {
  await setRuntime({ automation_enabled: true, last_error: null });
  await logEvent("control", "automation started");
  await pgNotify(WS_CHANNEL, envelope("runtime.changed", { automationEnabled: true }));
  return c.json({ ok: true });
});

app.post("/api/v1/control/stop", async (c) => {
  await setRuntime({ automation_enabled: false });
  await logEvent("control", "automation stopped");
  await pgNotify(WS_CHANNEL, envelope("runtime.changed", { automationEnabled: false }));
  return c.json({ ok: true });
});

app.post("/api/v1/control/sync", async (c) => {
  await setRuntime({
    graph_consistent: false,
    followers_sync_ok: false,
    following_sync_ok: false,
  });
  await query(
    `UPDATE sync_cursors SET phase='idle', cursor=NULL, full_sync_completed=FALSE, updated_at=now()`,
  );
  await logEvent("control", "sync requested");
  await pgNotify(
    WS_CHANNEL,
    envelope("runtime.changed", { graphConsistent: false, syncRequested: true }),
  );
  return c.json({ ok: true });
});

/** Run live/mock capability probe immediately (worker also probes on boot). */
app.post("/api/v1/control/probe", async (c) => {
  const { createXClient, resetXClientForTests } = await import("@autox/x-client");
  try {
    // re-resolve mode/credentials each probe (env may be fixed without restart in dev)
    resetXClientForTests();
    const client = createXClient();
    const capabilities = await client.probeCapabilities();
    await setRuntime({
      capabilities,
      last_error: capabilities.me ? null : capabilities.errors.me ?? "probe failed",
    });
    if (capabilities.meUser) {
      const { upsertAccount, upsertXUser } = await import("@autox/db");
      await upsertXUser(capabilities.meUser);
      await upsertAccount({
        id: capabilities.meUser.id,
        username: capabilities.meUser.username,
        name: capabilities.meUser.name,
      });
      await setRuntime({ needs_bootstrap: false });
    }
    await logEvent("probe", `api probe mode=${capabilities.mode}`, capabilities);
    await pgNotify(WS_CHANNEL, envelope("runtime.changed", { capabilities }));
    return c.json({ ok: true, capabilities });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRuntime({ last_error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

app.get("/api/v1/capabilities", async (c) => {
  const rt = await getRuntime();
  const { resolveXClientMode, hasLiveCredentials } = await import("@autox/x-client");
  return c.json({
    mode: resolveXClientMode(),
    credentialsConfigured: hasLiveCredentials(),
    capabilities: rt?.capabilities ?? null,
  });
});

/** Official X rate budgets + last wait/429 (worker updates runtime.x_rate). */
app.get("/api/v1/rate-limits", async (c) => {
  const rt = await getRuntime();
  return c.json({
    /** Docs: https://docs.x.com/x-api/fundamentals/rate-limits */
    official: {
      window: "15 minutes (unless noted)",
      perUser: {
        "GET /2/users/me": "75/15min",
        "GET /2/users/:id/followers": "300/15min",
        "GET /2/users/:id/following": "300/15min",
        "POST /2/users/:id/following": "50/15min",
        "DELETE following": "50/15min",
      },
      strategy:
        "Preemptive sliding window at 85% of official limit + min spacing; honor x-rate-limit-* headers; on 429 wait until reset.",
    },
    live: rt?.x_rate ?? null,
    progress: rt?.x_progress ?? null,
    lastError: rt?.last_error ?? null,
  });
});

// --- HTTP + WS on same port ---
const port = Number(process.env.PORT ?? 3000);
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL required");
  process.exit(1);
}
getPool();

const server = createServer(getRequestListener(app.fetch));
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

server.on("upgrade", (req: IncomingMessage, socket, head) => {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "", `http://${host}`);
  if (url.pathname !== "/api/v1/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let authed = false;
  const timer = setTimeout(() => {
    if (!authed) ws.close(4401, "auth timeout");
  }, 3000);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.type === "auth" && msg.token === ADMIN) {
        authed = true;
        clearTimeout(timer);
        clients.add(ws);
        ws.send(JSON.stringify(envelope("runtime.changed", { authenticated: true })));
        return;
      }
      if (msg?.type === "ping") {
        ws.send(JSON.stringify(envelope("pong", {})));
      }
    } catch {
      /* ignore */
    }
  });

  ws.on("close", () => {
    clearTimeout(timer);
    clients.delete(ws);
  });
});

function broadcast(raw: string) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

const listenClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
listenClient
  .connect()
  .then(async () => {
    await listenClient.query(`LISTEN ${WS_CHANNEL}`);
    listenClient.on("notification", (n) => {
      if (n.payload) broadcast(n.payload);
    });
    console.log(`LISTEN ${WS_CHANNEL}`);
  })
  .catch((e) => {
    console.error("LISTEN failed", e);
    process.exit(1);
  });

server.listen(port, "0.0.0.0", () => {
  console.log(`api listening on http://0.0.0.0:${port}`);
});

process.on("SIGTERM", () => {
  void listenClient.end().finally(() => process.exit(0));
});
