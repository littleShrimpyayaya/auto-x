import type pg from "pg";
import { getPool, query, withClient } from "./pool.js";

export type XUserRow = {
  id: string;
  username: string;
  name: string | null;
  verified: boolean;
  protected: boolean;
};

export function stripAt(u: string): string {
  return u.replace(/^@+/, "").trim();
}

export async function upsertXUser(
  u: {
    id: string;
    username: string;
    name?: string | null;
    verified?: boolean;
    protected?: boolean;
    followers_count?: number | null;
    following_count?: number | null;
    tweet_count?: number | null;
    raw_json?: unknown;
  },
  client?: pg.PoolClient,
): Promise<void> {
  const q = client ?? getPool();
  await q.query(
    `INSERT INTO x_users (id, username, name, verified, protected, followers_count, following_count, tweet_count, raw_json, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       name = EXCLUDED.name,
       verified = EXCLUDED.verified,
       protected = EXCLUDED.protected,
       followers_count = COALESCE(EXCLUDED.followers_count, x_users.followers_count),
       following_count = COALESCE(EXCLUDED.following_count, x_users.following_count),
       tweet_count = COALESCE(EXCLUDED.tweet_count, x_users.tweet_count),
       raw_json = COALESCE(EXCLUDED.raw_json, x_users.raw_json),
       last_seen_at = now()`,
    [
      u.id,
      stripAt(u.username),
      u.name ?? null,
      u.verified ?? false,
      u.protected ?? false,
      u.followers_count ?? null,
      u.following_count ?? null,
      u.tweet_count ?? null,
      u.raw_json ? JSON.stringify(u.raw_json) : null,
    ],
  );
}

export async function upsertAccount(a: { id: string; username: string; name?: string | null }) {
  await query(
    `INSERT INTO accounts (id, username, name, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name, updated_at=now()`,
    [a.id, stripAt(a.username), a.name ?? null],
  );
}

export async function upsertEdge(
  table: "followers" | "following",
  accountId: string,
  userId: string,
  opts: { syncGen?: number | null; source?: string; pendingFollow?: boolean } = {},
  client?: pg.PoolClient,
) {
  const q = client ?? getPool();
  if (table === "followers") {
    if (opts.syncGen != null) {
      await q.query(
        `INSERT INTO followers (account_id, user_id, connected_at, last_seen_at, lost_at, sync_gen)
         VALUES ($1,$2,now(),now(),NULL,$3)
         ON CONFLICT (account_id, user_id) DO UPDATE SET
           last_seen_at=now(), lost_at=NULL, sync_gen=EXCLUDED.sync_gen`,
        [accountId, userId, opts.syncGen],
      );
    } else {
      await q.query(
        `INSERT INTO followers (account_id, user_id, connected_at, last_seen_at, lost_at, sync_gen)
         VALUES ($1,$2,now(),now(),NULL,0)
         ON CONFLICT (account_id, user_id) DO UPDATE SET
           last_seen_at=now(), lost_at=NULL`,
        [accountId, userId],
      );
    }
  } else {
    if (opts.syncGen != null) {
      await q.query(
        `INSERT INTO following (account_id, user_id, connected_at, last_seen_at, lost_at, source, pending_follow, sync_gen)
         VALUES ($1,$2,now(),now(),NULL,$3,$4,$5)
         ON CONFLICT (account_id, user_id) DO UPDATE SET
           last_seen_at=now(), lost_at=NULL, source=COALESCE(EXCLUDED.source, following.source),
           pending_follow=EXCLUDED.pending_follow, sync_gen=EXCLUDED.sync_gen`,
        [accountId, userId, opts.source ?? null, opts.pendingFollow ?? false, opts.syncGen],
      );
    } else {
      await q.query(
        `INSERT INTO following (account_id, user_id, connected_at, last_seen_at, lost_at, source, pending_follow, sync_gen)
         VALUES ($1,$2,now(),now(),NULL,$3,$4,0)
         ON CONFLICT (account_id, user_id) DO UPDATE SET
           last_seen_at=now(), lost_at=NULL, source=COALESCE(EXCLUDED.source, following.source),
           pending_follow=EXCLUDED.pending_follow`,
        [accountId, userId, opts.source ?? null, opts.pendingFollow ?? false],
      );
    }
  }
}

export async function edgeSyncGenForUpsert(
  accountId: string,
  stream: "followers" | "following",
): Promise<number | null> {
  const r = await query<{ phase: string; walk_gen: number }>(
    `SELECT phase, walk_gen FROM sync_cursors WHERE account_id=$1 AND stream=$2`,
    [accountId, stream],
  );
  const row = r.rows[0];
  if (row?.phase === "full_in_progress") return row.walk_gen;
  return null;
}

export async function startFullWalk(accountId: string, stream: "followers" | "following") {
  await query(
    `INSERT INTO sync_cursors (account_id, stream, phase, walk_gen, cursor, pages_done, updated_at)
     VALUES ($1,$2,'full_in_progress',1,NULL,0,now())
     ON CONFLICT (account_id, stream) DO UPDATE SET
       walk_gen = CASE
         WHEN sync_cursors.phase = 'full_in_progress' AND sync_cursors.cursor IS NOT NULL
         THEN sync_cursors.walk_gen
         ELSE sync_cursors.walk_gen + 1
       END,
       phase = 'full_in_progress',
       cursor = CASE
         WHEN sync_cursors.phase = 'full_in_progress' AND sync_cursors.cursor IS NOT NULL
         THEN sync_cursors.cursor
         ELSE NULL
       END,
       pages_done = CASE
         WHEN sync_cursors.phase = 'full_in_progress' AND sync_cursors.cursor IS NOT NULL
         THEN sync_cursors.pages_done
         ELSE 0
       END,
       updated_at = now()`,
    [accountId, stream],
  );
  const r = await query<{ walk_gen: number; cursor: string | null }>(
    `SELECT walk_gen, cursor FROM sync_cursors WHERE account_id=$1 AND stream=$2`,
    [accountId, stream],
  );
  return r.rows[0];
}

export async function completeFullWalk(accountId: string, stream: "followers" | "following", walkGen: number) {
  const table = stream === "followers" ? "followers" : "following";
  await withClient(async (c) => {
    await c.query("BEGIN");
    await c.query(
      `UPDATE ${table} SET lost_at = now()
       WHERE account_id=$1 AND lost_at IS NULL AND sync_gen < $2`,
      [accountId, walkGen],
    );
    await c.query(
      `UPDATE sync_cursors SET phase='idle', cursor=NULL, full_sync_completed=TRUE,
         last_full_sync_at=now(), last_completed_walk_gen=$3, updated_at=now()
       WHERE account_id=$1 AND stream=$2`,
      [accountId, stream, walkGen],
    );
    const f = await c.query(
      `SELECT full_sync_completed FROM sync_cursors WHERE account_id=$1 AND stream='followers'`,
      [accountId],
    );
    const g = await c.query(
      `SELECT full_sync_completed FROM sync_cursors WHERE account_id=$1 AND stream='following'`,
      [accountId],
    );
    const ok = !!(f.rows[0]?.full_sync_completed && g.rows[0]?.full_sync_completed);
    // Control plane always keys runtime_state on 'default' (single-tenant v1)
    await c.query(
      `UPDATE runtime_state SET
         followers_sync_ok = COALESCE((SELECT full_sync_completed FROM sync_cursors WHERE account_id=$1 AND stream='followers'), FALSE),
         following_sync_ok = COALESCE((SELECT full_sync_completed FROM sync_cursors WHERE account_id=$1 AND stream='following'), FALSE),
         graph_consistent = $2,
         updated_at = now()
       WHERE account_id = 'default'`,
      [accountId, ok],
    );
    await c.query("COMMIT");
  });
}

export async function enqueueJob(opts: {
  accountId: string;
  type: "follow" | "unfollow";
  targetUserId: string;
  source: string;
  priority?: number;
}) {
  await query(
    `INSERT INTO jobs (account_id, type, target_user_id, source, priority, status, next_run_at)
     VALUES ($1,$2,$3,$4,$5,'pending', now())
     ON CONFLICT DO NOTHING`,
    [opts.accountId, opts.type, opts.targetUserId, opts.source, opts.priority ?? 100],
  );
  // partial unique may not fire ON CONFLICT without constraint name — use WHERE NOT EXISTS
}

export async function enqueueJobSafe(opts: {
  accountId: string;
  type: "follow" | "unfollow";
  targetUserId: string;
  source: string;
  priority?: number;
}) {
  await query(
    `INSERT INTO jobs (account_id, type, target_user_id, source, priority, status, next_run_at)
     SELECT $1,$2,$3,$4,$5,'pending', now()
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs
       WHERE account_id=$1 AND type=$2 AND target_user_id=$3 AND status IN ('pending','running')
     )`,
    [opts.accountId, opts.type, opts.targetUserId, opts.source, opts.priority ?? 100],
  );
}

export async function claimJob(workerId: string, leaseSec: number) {
  return withClient(async (c) => {
    await c.query("BEGIN");
    const r = await c.query(
      `WITH cte AS (
         SELECT id FROM jobs
         WHERE status = 'pending' AND next_run_at <= now() AND cancel_requested = FALSE
         ORDER BY priority ASC, next_run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j SET
         status = 'running',
         locked_at = now(),
         locked_by = $1,
         attempts = attempts + 1,
         updated_at = now()
       FROM cte WHERE j.id = cte.id
       RETURNING j.*`,
      [workerId],
    );
    await c.query("COMMIT");
    return r.rows[0] ?? null;
  });
}

export async function reclaimStaleJobs(leaseSec: number) {
  await query(
    `UPDATE jobs SET status='pending', locked_at=NULL, locked_by=NULL, updated_at=now()
     WHERE status='running' AND locked_at < now() - ($1 || ' seconds')::interval`,
    [String(leaseSec)],
  );
}

export async function pgNotify(channel: string, payload: object) {
  const body = JSON.stringify(payload);
  // PG notify payload limit ~8KB
  const trimmed = body.length > 7500 ? body.slice(0, 7500) : body;
  await query(`SELECT pg_notify($1, $2)`, [channel, trimmed]);
}

export async function logEvent(
  category: string,
  message: string,
  meta?: object,
  level = "info",
  accountId: string | null = "default",
) {
  await query(
    `INSERT INTO event_log (account_id, level, category, message, meta) VALUES ($1,$2,$3,$4,$5)`,
    [accountId, level, category, message, meta ? JSON.stringify(meta) : null],
  );
}

const RUNTIME_COLS = new Set([
  "automation_enabled",
  "graph_consistent",
  "followers_sync_ok",
  "following_sync_ok",
  "needs_bootstrap",
  "last_error",
  "capabilities",
]);

export async function getRuntime(accountId = "default") {
  const r = await query(`SELECT * FROM runtime_state WHERE account_id=$1`, [accountId]);
  const row = r.rows[0];
  if (!row) return null;
  const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>;
  // flatten meta for callers (x_rate, x_progress, …)
  return { ...row, ...meta, meta };
}

export async function setRuntime(patch: Record<string, unknown>, accountId = "default") {
  const cols: Record<string, unknown> = {};
  const metaPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (RUNTIME_COLS.has(k)) cols[k] = v;
    else if (k !== "meta") metaPatch[k] = v;
  }
  if (Object.keys(cols).length) {
    const keys = Object.keys(cols);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await query(
      `UPDATE runtime_state SET ${sets}, updated_at=now() WHERE account_id=$1`,
      [accountId, ...keys.map((k) => cols[k])],
    );
  }
  if (Object.keys(metaPatch).length) {
    await query(
      `UPDATE runtime_state
       SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb, updated_at=now()
       WHERE account_id=$1`,
      [accountId, JSON.stringify(metaPatch)],
    );
  }
}

export async function getConfigMap(accountId = "default"): Promise<Record<string, unknown>> {
  const r = await query(`SELECT key, value FROM app_config WHERE account_id=$1`, [accountId]);
  const out: Record<string, unknown> = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

export async function setConfig(key: string, value: unknown, accountId = "default") {
  await query(
    `INSERT INTO app_config (account_id, key, value, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (account_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [accountId, key, JSON.stringify(value)],
  );
}

export async function getPrimaryAccount() {
  // Prefer most recently updated (live bootstrap overwrites mock seed)
  const r = await query(`SELECT * FROM accounts ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`);
  return r.rows[0] ?? null;
}

/** Remove legacy mock seed account if a real live account is present. */
export async function demoteMockAccount(liveId: string) {
  if (!liveId || liveId === "100") return;
  await query(`DELETE FROM accounts WHERE id = '100'`);
}

export async function stats(accountId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const hour = await query(`SELECT date_trunc('hour', now() AT TIME ZONE 'UTC') AS h`);
  const h = hour.rows[0].h;
  const [d, hr, followers, following, jobs, obs] = await Promise.all([
    query(`SELECT follows, unfollows FROM daily_counters WHERE account_id=$1 AND day=$2::date`, [
      accountId,
      day,
    ]),
    query(
      `SELECT follows, unfollows FROM hourly_counters WHERE account_id=$1 AND hour=$2`,
      [accountId, h],
    ),
    query(
      `SELECT count(*)::int AS c FROM followers WHERE account_id=$1 AND lost_at IS NULL`,
      [accountId],
    ),
    query(
      `SELECT count(*)::int AS c FROM following WHERE account_id=$1 AND lost_at IS NULL`,
      [accountId],
    ),
    query(
      `SELECT status, count(*)::int AS c FROM jobs WHERE account_id=$1 GROUP BY status`,
      [accountId],
    ),
    query(
      `SELECT count(*)::int AS c FROM observations WHERE account_id=$1 AND status='watching'`,
      [accountId],
    ),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of jobs.rows) byStatus[row.status] = row.c;
  return {
    day,
    dailyFollows: d.rows[0]?.follows ?? 0,
    dailyUnfollows: d.rows[0]?.unfollows ?? 0,
    hourlyFollows: hr.rows[0]?.follows ?? 0,
    hourlyUnfollows: hr.rows[0]?.unfollows ?? 0,
    followers: followers.rows[0]?.c ?? 0,
    following: following.rows[0]?.c ?? 0,
    watching: obs.rows[0]?.c ?? 0,
    jobs: byStatus,
  };
}
