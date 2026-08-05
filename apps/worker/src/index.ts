/**
 * Worker: live X automation — bootstrap, sync, follow-back, observer, expander, executor.
 * Does NOT run migrations.
 */
import {
  claimJob,
  completeFullWalk,
  edgeSyncGenForUpsert,
  enqueueJobSafe,
  demoteMockAccount,
  getPool,
  getPrimaryAccount,
  getRuntime,
  logEvent,
  pgNotify,
  query,
  reclaimStaleJobs,
  setRuntime,
  startFullWalk,
  stats,
  upsertAccount,
  upsertEdge,
  upsertXUser,
  withClient,
} from "@autox/db";
import { chargeFollow, chargeUnfollow, foafScore, shouldFollowBack } from "@autox/domain";
import { envelope, settingsFromEnv, WS_CHANNEL } from "@autox/shared";
import { createXClient, type XCapabilities, XApiError } from "@autox/x-client";

const workerId = process.env.WORKER_ID ?? "worker-1";
const settings = settingsFromEnv();
const x = createXClient();

let lastWriteAt = 0;
let stopping = false;
let caps: XCapabilities | null = null;
let lastProbeAt = 0;
let lastRatePush = 0;

/** Wire rate-budget into runtime/WS — throttle hard to avoid UI freeze. */
function wireRateVisibility() {
  if (!x.onRateEvent) return;
  x.onRateEvent((ev) => {
    // Ignore routine acquire/header; only surface wait/429 occasionally
    if (ev.type === "acquire" || ev.type === "header_sync") return;
    const now = Date.now();
    if (now - lastRatePush < 3000 && ev.type === "wait") return;
    lastRatePush = now;

    const budgets = x.rateSnapshots?.() ?? [];
    const waiting = budgets.filter((b) => b.nextAllowedInSec > 0);
    const nextRetry = waiting.length
      ? waiting.reduce((a, b) =>
          (a.nextAllowedInSec ?? 0) <= (b.nextAllowedInSec ?? 0) ? a : b,
        )
      : null;

    const payload = {
      type: ev.type,
      bucket: ev.bucket,
      message: ev.message,
      waitMs: ev.waitMs,
      retryAt: ev.retryAt ?? ev.snapshot.nextAllowedAt,
      retryInSec: ev.retryInSec ?? ev.snapshot.nextAllowedInSec,
      snapshot: ev.snapshot,
      budgets,
      nextRetryAt: nextRetry?.nextAllowedAt ?? null,
      nextRetryInSec: nextRetry?.nextAllowedInSec ?? 0,
      nextRetryBucket: nextRetry?.bucket ?? null,
      updatedAt: new Date().toISOString(),
    };

    if (ev.type === "blocked_429") {
      void logEvent("x_rate", ev.message, payload, "warn").catch(() => {});
    }
    void setRuntime({ x_rate: payload }).catch(() => {});
    void pgNotify(WS_CHANNEL, envelope("x.rate", payload)).catch(() => {});
  });
}
wireRateVisibility();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeAndStore() {
  caps = await x.probeCapabilities();
  lastProbeAt = Date.now();
  await setRuntime({
    capabilities: caps,
    last_error: caps.me ? null : caps.errors.me ?? "probe failed",
  });
  await logEvent("probe", `mode=${caps.mode} me=${caps.me} followers=${caps.readFollowers} following=${caps.readFollowing} writes=${caps.writeFollow}`, caps);
  await pgNotify(WS_CHANNEL, envelope("runtime.changed", { capabilities: caps }));
  return caps;
}

async function ensureBootstrap() {
  if (!caps || Date.now() - lastProbeAt > 30 * 60_000) {
    await probeAndStore();
  }
  if (!caps?.me) {
    throw new Error(`X API getMe failed: ${caps?.errors.me ?? "unknown"} — check OAuth credentials`);
  }

  const me = caps.meUser ?? (await x.getMe());
  let account = await getPrimaryAccount();
  const switched = !account || String(account.id) !== String(me.id);

  await upsertXUser(me);
  await upsertAccount({ id: me.id, username: me.username, name: me.name });
  await demoteMockAccount(me.id);

  const listBlocked = !caps.readFollowers && !caps.readFollowing;
  await setRuntime({
    needs_bootstrap: false,
    ...(switched || listBlocked
      ? {
          graph_consistent: listBlocked ? false : false,
          followers_sync_ok: !!caps.readFollowers,
          following_sync_ok: !!caps.readFollowing,
        }
      : {}),
    last_error: listBlocked
      ? `@${me.username} 已登录。X follows 列表接口 402（需 credits/付费套餐），无法同步粉丝/关注图；互关自动化暂不可用。`
      : null,
  });
  if (switched) {
    await logEvent("bootstrap", `account @${me.username} (${me.id}) mode=${x.mode}`, {
      prev: account?.id,
      readFollowers: caps.readFollowers,
      readFollowing: caps.readFollowing,
    });
  }
  await pgNotify(WS_CHANNEL, envelope("runtime.changed", { needsBootstrap: false, me }));
  return { id: me.id, username: me.username, name: me.name };
}

async function syncStream(accountId: string, stream: "followers" | "following") {
  if (stream === "followers" && caps && !caps.readFollowers) {
    await logEvent("sync", `skip followers — capability denied: ${caps.errors.readFollowers}`, {}, "warn");
    return;
  }
  if (stream === "following" && caps && !caps.readFollowing) {
    await logEvent("sync", `skip following — capability denied: ${caps.errors.readFollowing}`, {}, "warn");
    return;
  }

  const started = await startFullWalk(accountId, stream);
  const walkGen = started.walk_gen as number;
  let token: string | null = started.cursor ?? null;
  const cur = await query(
    `SELECT pages_done FROM sync_cursors WHERE account_id=$1 AND stream=$2`,
    [accountId, stream],
  );
  let pages = started.cursor ? Number(cur.rows[0]?.pages_done ?? 0) : 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (stopping) return;
      const page =
        stream === "followers"
          ? await x.getFollowers(accountId, token, settings.syncPageSize)
          : await x.getFollowing(accountId, token, settings.syncPageSize);

      for (const u of page.data) {
        await upsertXUser(u);
        await upsertEdge(stream, accountId, u.id, { syncGen: walkGen });
      }
      pages += 1;
      token = page.nextToken ?? null;
      await query(
        `UPDATE sync_cursors SET cursor=$3, pages_done=$4, updated_at=now()
         WHERE account_id=$1 AND stream=$2`,
        [accountId, stream, token, pages],
      );
      await setRuntime({
        x_progress: {
          stream,
          phase: "full_in_progress",
          pagesDone: pages,
          walkGen,
          cursorPresent: !!token,
          at: new Date().toISOString(),
        },
      });
      await pgNotify(
        WS_CHANNEL,
        envelope("sync.progress", {
          stream,
          phase: "full_in_progress",
          pagesDone: pages,
          walkGen,
          cursorPresent: !!token,
          rate: x.rateSnapshots?.() ?? [],
        }),
      );
      if (!token) break;
      // RateBudget already spaces calls; optional extra delay for live
    }
    await completeFullWalk(accountId, stream, walkGen);
    await logEvent("sync", `full ${stream} walk_gen=${walkGen} pages=${pages}`, { accountId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const xe = e instanceof XApiError ? e : null;
    // leave phase=full_in_progress + cursor for resume; do NOT soft-delete
    await logEvent(
      "sync",
      xe?.kind === "rate_limit"
        ? `同步限流中断 ${stream}: ${msg}（保留游标，窗口恢复后自动续传）`
        : `同步中断 ${stream}: ${msg}`,
      { walkGen, pages, kind: xe?.kind, retryAfterMs: xe?.retryAfterMs },
      "error",
    );
    await setRuntime({
      last_error: `sync ${stream}: ${msg}`,
      x_progress: {
        stream,
        phase: "interrupted",
        pagesDone: pages,
        walkGen,
        error: msg,
        kind: xe?.kind ?? "unknown",
        at: new Date().toISOString(),
      },
    });
    await pgNotify(
      WS_CHANNEL,
      envelope("x.error", {
        source: "sync",
        stream,
        message: msg,
        kind: xe?.kind,
        retryAfterMs: xe?.retryAfterMs,
      }),
    );
    if (xe?.kind === "rate_limit" && xe.retryAfterMs) {
      await sleep(Math.min(xe.retryAfterMs, 300_000));
    }
    throw e;
  }
}

async function runSync(accountId: string) {
  if (caps && !caps.readFollowers && !caps.readFollowing) {
    const msg =
      "无法同步关系图：X 返回 402/无 Follows lookup 权限。请在开发者控制台充值 credits 或升级含 follows 列表的套餐。getMe 已正常。";
    await setRuntime({
      last_error: msg,
      graph_consistent: false,
      x_progress: {
        phase: "blocked",
        error: msg,
        kind: "payment_required",
        at: new Date().toISOString(),
      },
    });
    await logEvent("sync", msg, caps.errors, "warn");
    await pgNotify(WS_CHANNEL, envelope("x.error", { source: "sync", message: msg, kind: "payment_required" }));
    // Don't tight-loop hammering 402
    await sleep(60_000);
    return;
  }
  try {
    await syncStream(accountId, "followers");
    await syncStream(accountId, "following");
  } catch (e) {
    const xe = e instanceof XApiError ? e : null;
    if (xe?.kind === "payment_required") {
      await sleep(60_000);
      return;
    }
    // partial progress kept; will retry next loop
  }
  await pgNotify(WS_CHANNEL, envelope("runtime.changed", await getRuntime()));
  await pgNotify(WS_CHANNEL, envelope("stats.updated", await stats(accountId)));
}

async function followBackScan(accountId: string) {
  if (!settings.followBackEnabled) return;
  if (caps && !caps.writeFollow) {
    await logEvent("follow_back", "skipped — writeFollow capability false", {}, "warn");
    return;
  }
  const r = await query(
    `SELECT f.user_id, u.username, u.name, u.verified
     FROM followers f
     JOIN x_users u ON u.id = f.user_id
     LEFT JOIN following g ON g.account_id = f.account_id AND g.user_id = f.user_id AND g.lost_at IS NULL
     WHERE f.account_id=$1 AND f.lost_at IS NULL AND g.user_id IS NULL`,
    [accountId],
  );
  for (const row of r.rows) {
    if (
      shouldFollowBack({
        isFollower: true,
        isFollowing: false,
        followBackEnabled: true,
      })
    ) {
      await enqueueJobSafe({
        accountId,
        type: "follow",
        targetUserId: row.user_id,
        source: "follow_back",
        priority: 50,
      });
    }
  }
}

async function observerScan(accountId: string) {
  const rt = await getRuntime();
  if (!rt?.graph_consistent) return;
  if (caps && !caps.writeUnfollow) return;

  const following = await query(
    `SELECT g.user_id FROM following g
     LEFT JOIN followers f ON f.account_id=g.account_id AND f.user_id=g.user_id AND f.lost_at IS NULL
     WHERE g.account_id=$1 AND g.lost_at IS NULL AND f.user_id IS NULL`,
    [accountId],
  );
  for (const row of following.rows) {
    await query(
      `INSERT INTO observations (account_id, user_id, entered_at, expires_at, status, updated_at)
       VALUES ($1,$2,now(), now() + ($3 || ' days')::interval, 'watching', now())
       ON CONFLICT (account_id, user_id) DO UPDATE SET
         status = CASE WHEN observations.status IN ('cleared_mutual','cleared_unfollowed') THEN 'watching' ELSE observations.status END,
         entered_at = CASE WHEN observations.status IN ('cleared_mutual','cleared_unfollowed') THEN now() ELSE observations.entered_at END,
         expires_at = CASE WHEN observations.status IN ('cleared_mutual','cleared_unfollowed') THEN now() + ($3 || ' days')::interval ELSE observations.expires_at END,
         updated_at = now()`,
      [accountId, row.user_id, String(settings.observationDays)],
    );
  }

  await query(
    `UPDATE observations o SET status='cleared_mutual', updated_at=now()
     FROM followers f, following g
     WHERE o.account_id=$1 AND o.status='watching'
       AND f.account_id=o.account_id AND f.user_id=o.user_id AND f.lost_at IS NULL
       AND g.account_id=o.account_id AND g.user_id=o.user_id AND g.lost_at IS NULL`,
    [accountId],
  );

  const due = await query(
    `SELECT o.user_id FROM observations o
     WHERE o.account_id=$1 AND o.status='watching' AND o.expires_at <= now()`,
    [accountId],
  );
  for (const row of due.rows) {
    const cool = await query(
      `SELECT 1 FROM jobs WHERE type='unfollow' AND status='done' AND target_user_id=$1
         AND finished_at > now() - ($2 || ' days')::interval LIMIT 1`,
      [row.user_id, String(settings.unfollowCooldownDays)],
    );
    if (cool.rowCount) continue;
    await withClient(async (c) => {
      await c.query("BEGIN");
      await c.query(
        `UPDATE observations SET status='promoted_unfollow', updated_at=now()
         WHERE account_id=$1 AND user_id=$2 AND status='watching'`,
        [accountId, row.user_id],
      );
      await c.query(
        `INSERT INTO jobs (account_id, type, target_user_id, source, priority, status, next_run_at)
         SELECT $1,'unfollow',$2,'observation',40,'pending',now()
         WHERE NOT EXISTS (
           SELECT 1 FROM jobs WHERE account_id=$1 AND type='unfollow' AND target_user_id=$2
             AND status IN ('pending','running')
         )`,
        [accountId, row.user_id],
      );
      await c.query("COMMIT");
    });
  }

  await query(
    `UPDATE observations o SET status='watching', updated_at=now()
     WHERE o.account_id=$1 AND o.status='promoted_unfollow'
       AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.account_id=o.account_id AND j.type='unfollow'
           AND j.target_user_id=o.user_id AND j.status IN ('pending','running')
       )`,
    [accountId],
  );
}

async function expandScan(accountId: string) {
  if (!settings.mutualExpandEnabled) return;
  if (caps && !caps.readFollowing) return;

  const seeds = await query(
    `SELECT f.user_id FROM followers f
     JOIN x_users u ON u.id=f.user_id
     WHERE f.account_id=$1 AND f.lost_at IS NULL
     ORDER BY u.verified DESC LIMIT 3`,
    [accountId],
  );
  const overlap = new Map<string, { count: number; verified: boolean; username: string; name: string | null }>();
  for (const s of seeds.rows) {
    try {
      const page = await x.getFollowing(s.user_id, null, 20);
      if (x.mode === "live") await sleep(1200);
      for (const u of page.data) {
        if (u.id === accountId) continue;
        await upsertXUser(u);
        const cur = overlap.get(u.id) ?? {
          count: 0,
          verified: !!u.verified,
          username: u.username,
          name: u.name ?? null,
        };
        cur.count += 1;
        cur.verified = cur.verified || !!u.verified;
        overlap.set(u.id, cur);
      }
    } catch (e) {
      await logEvent("expand", `seed ${s.user_id}: ${e}`, {}, "warn");
    }
  }
  for (const [uid, info] of overlap) {
    const exists = await query(
      `SELECT 1 FROM following WHERE account_id=$1 AND user_id=$2 AND lost_at IS NULL
       UNION ALL
       SELECT 1 FROM followers WHERE account_id=$1 AND user_id=$2 AND lost_at IS NULL
       LIMIT 1`,
      [accountId, uid],
    );
    if (exists.rowCount) continue;
    const score = foafScore(info.count, info.verified, settings.expandPreferVerified);
    await query(
      `INSERT INTO follow_candidates (account_id, user_id, score, reason, status)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, user_id) DO UPDATE SET score=EXCLUDED.score, reason=EXCLUDED.reason, updated_at=now()`,
      [
        accountId,
        uid,
        score,
        JSON.stringify({ foaf_following_overlap: info.count, verified: info.verified }),
        settings.candidateManualApproval ? "pending" : "approved",
      ],
    );
    if (!settings.candidateManualApproval && caps?.writeFollow) {
      await enqueueJobSafe({
        accountId,
        type: "follow",
        targetUserId: uid,
        source: "foaf_expand",
        priority: 80,
      });
    }
  }
}

async function quotaOk(accountId: string, type: "follow" | "unfollow") {
  const st = await stats(accountId);
  if (type === "follow") {
    return st.dailyFollows < settings.maxFollowsPerDay && st.hourlyFollows < settings.maxFollowsPerHour;
  }
  return st.dailyUnfollows < settings.maxUnfollowsPerDay && st.hourlyUnfollows < settings.maxUnfollowsPerHour;
}

async function executeOne(accountId: string) {
  await reclaimStaleJobs(settings.leaseTtlSec);
  const job = await claimJob(workerId, settings.leaseTtlSec);
  if (!job) return false;

  if (job.cancel_requested) {
    await query(
      `UPDATE jobs SET status='cancelled', finished_at=now(), updated_at=now() WHERE id=$1`,
      [job.id],
    );
    return true;
  }

  const type = job.type as "follow" | "unfollow";
  if (type === "follow" && caps && !caps.writeFollow) {
    await query(
      `UPDATE jobs SET status='dead', last_error='writeFollow not available on this API tier', finished_at=now(), updated_at=now() WHERE id=$1`,
      [job.id],
    );
    return true;
  }
  if (type === "unfollow" && caps && !caps.writeUnfollow) {
    await query(
      `UPDATE jobs SET status='dead', last_error='writeUnfollow not available', finished_at=now(), updated_at=now() WHERE id=$1`,
      [job.id],
    );
    return true;
  }

  if (!(await quotaOk(accountId, type))) {
    await query(
      `UPDATE jobs SET status='pending', locked_at=NULL, locked_by=NULL,
         next_run_at = now() + interval '15 minutes', attempts = GREATEST(attempts-1,0), updated_at=now()
       WHERE id=$1`,
      [job.id],
    );
    return true;
  }

  const wait = settings.writeMinIntervalMs - (Date.now() - lastWriteAt);
  if (wait > 0) await sleep(wait);

  try {
    if (type === "follow") {
      const edge = await query(
        `SELECT lost_at, pending_follow FROM following WHERE account_id=$1 AND user_id=$2`,
        [accountId, job.target_user_id],
      );
      const wasLocalActive = !!(edge.rows[0] && edge.rows[0].lost_at == null);
      const result = await x.follow(accountId, job.target_user_id);
      lastWriteAt = Date.now();
      const syncGen = await edgeSyncGenForUpsert(accountId, "following");
      const doCharge = chargeFollow(wasLocalActive) && !result.alreadyFollowing;

      await withClient(async (c) => {
        await c.query("BEGIN");
        const done = await c.query(
          `UPDATE jobs SET status='done', stats_charged=$2, finished_at=now(), updated_at=now(), locked_at=NULL, locked_by=NULL
           WHERE id=$1 AND status='running' RETURNING id`,
          [job.id, doCharge],
        );
        if (!done.rowCount) {
          await c.query("ROLLBACK");
          return;
        }
        if (syncGen != null) {
          await c.query(
            `INSERT INTO following (account_id, user_id, connected_at, last_seen_at, lost_at, source, pending_follow, sync_gen)
             VALUES ($1,$2,now(),now(),NULL,$3,$4,$5)
             ON CONFLICT (account_id, user_id) DO UPDATE SET
               last_seen_at=now(), lost_at=NULL, source=EXCLUDED.source,
               pending_follow=EXCLUDED.pending_follow, sync_gen=EXCLUDED.sync_gen`,
            [accountId, job.target_user_id, job.source, result.pendingFollow, syncGen],
          );
        } else {
          await c.query(
            `INSERT INTO following (account_id, user_id, connected_at, last_seen_at, lost_at, source, pending_follow, sync_gen)
             VALUES ($1,$2,now(),now(),NULL,$3,$4,0)
             ON CONFLICT (account_id, user_id) DO UPDATE SET
               last_seen_at=now(), lost_at=NULL, source=EXCLUDED.source,
               pending_follow=EXCLUDED.pending_follow`,
            [accountId, job.target_user_id, job.source, result.pendingFollow],
          );
        }
        if (!result.pendingFollow) {
          await c.query(
            `INSERT INTO observations (account_id, user_id, entered_at, expires_at, status, updated_at)
             SELECT $1,$2,now(), now() + ($3 || ' days')::interval, 'watching', now()
             WHERE NOT EXISTS (
               SELECT 1 FROM followers WHERE account_id=$1 AND user_id=$2 AND lost_at IS NULL
             )
             ON CONFLICT (account_id, user_id) DO NOTHING`,
            [accountId, job.target_user_id, String(settings.observationDays)],
          );
        }
        if (doCharge) {
          await c.query(
            `INSERT INTO daily_counters (account_id, day, follows) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
             ON CONFLICT (account_id, day) DO UPDATE SET follows = daily_counters.follows + 1`,
            [accountId],
          );
          await c.query(
            `INSERT INTO hourly_counters (account_id, hour, follows)
             VALUES ($1, date_trunc('hour', now() AT TIME ZONE 'UTC'), 1)
             ON CONFLICT (account_id, hour) DO UPDATE SET follows = hourly_counters.follows + 1`,
            [accountId],
          );
        }
        await c.query("COMMIT");
      });
    } else {
      const edge = await query(
        `SELECT lost_at FROM following WHERE account_id=$1 AND user_id=$2`,
        [accountId, job.target_user_id],
      );
      const wasLocalActive = !!(edge.rows[0] && edge.rows[0].lost_at == null);
      await x.unfollow(accountId, job.target_user_id);
      lastWriteAt = Date.now();
      const doCharge = chargeUnfollow(wasLocalActive);
      await withClient(async (c) => {
        await c.query("BEGIN");
        await c.query(
          `UPDATE jobs SET status='done', stats_charged=$2, finished_at=now(), updated_at=now(), locked_at=NULL, locked_by=NULL
           WHERE id=$1 AND status='running'`,
          [job.id, doCharge],
        );
        await c.query(
          `UPDATE following SET lost_at=now(), last_seen_at=now() WHERE account_id=$1 AND user_id=$2`,
          [accountId, job.target_user_id],
        );
        await c.query(
          `UPDATE observations SET status='cleared_unfollowed', updated_at=now()
           WHERE account_id=$1 AND user_id=$2`,
          [accountId, job.target_user_id],
        );
        if (doCharge) {
          await c.query(
            `INSERT INTO daily_counters (account_id, day, unfollows) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
             ON CONFLICT (account_id, day) DO UPDATE SET unfollows = daily_counters.unfollows + 1`,
            [accountId],
          );
          await c.query(
            `INSERT INTO hourly_counters (account_id, hour, unfollows)
             VALUES ($1, date_trunc('hour', now() AT TIME ZONE 'UTC'), 1)
             ON CONFLICT (account_id, hour) DO UPDATE SET unfollows = hourly_counters.unfollows + 1`,
            [accountId],
          );
        }
        await c.query("COMMIT");
      });
    }

    const u = await query(`SELECT username, name FROM x_users WHERE id=$1`, [job.target_user_id]);
    await pgNotify(
      WS_CHANNEL,
      envelope("job.updated", {
        id: job.id,
        status: "done",
        type: job.type,
        targetUserId: job.target_user_id,
        username: u.rows[0]?.username,
        name: u.rows[0]?.name,
      }),
    );
    await pgNotify(WS_CHANNEL, envelope("stats.updated", await stats(accountId)));
    await logEvent("executor", `${type} ok ${job.target_user_id} @${u.rows[0]?.username ?? "?"}`);
  } catch (e) {
    const xe = e instanceof XApiError ? e : null;
    const msg = e instanceof Error ? e.message : String(e);
    if (xe?.kind === "rate_limit") {
      await query(
        `UPDATE jobs SET status='pending', locked_at=NULL, locked_by=NULL,
           attempts = GREATEST(attempts-1,0),
           next_run_at = now() + ($2 || ' milliseconds')::interval,
           last_error=$3, updated_at=now()
         WHERE id=$1`,
        [job.id, String(xe.retryAfterMs ?? 60_000), msg],
      );
      await logEvent("executor", `任务 #${job.id} 限流，将自动重试: ${msg}`, {
        kind: "rate_limit",
        retryAfterMs: xe.retryAfterMs,
      }, "warn");
      {
        const retryAt = new Date(Date.now() + (xe.retryAfterMs ?? 60_000)).toISOString();
        await pgNotify(
          WS_CHANNEL,
          envelope("x.error", {
            source: "executor",
            jobId: job.id,
            type: job.type,
            message: msg,
            kind: "rate_limit",
            retryAfterMs: xe.retryAfterMs,
            retryAt,
            retryInSec: Math.ceil((xe.retryAfterMs ?? 60_000) / 1000),
          }),
        );
        await setRuntime({
          last_error: `job #${job.id} 限流，计划 ${retryAt} 重试`,
          x_rate: {
            lastEvent: `任务 #${job.id} 限流`,
            lastType: "blocked_429",
            lastBucket: job.type === "unfollow" ? "unfollow" : "follow",
            retryAt,
            retryInSec: Math.ceil((xe.retryAfterMs ?? 60_000) / 1000),
            nextRetryAt: retryAt,
            nextRetryInSec: Math.ceil((xe.retryAfterMs ?? 60_000) / 1000),
            budgets: x.rateSnapshots?.() ?? [],
            updatedAt: new Date().toISOString(),
          },
        });
      }
      await sleep(Math.min(xe.retryAfterMs ?? 60_000, 120_000));
      return true;
    }
    const dead = job.attempts >= job.max_attempts || xe?.kind === "auth" || xe?.kind === "forbidden";
    await query(
      `UPDATE jobs SET status=$2, last_error=$3, locked_at=NULL, locked_by=NULL,
         next_run_at = CASE WHEN $2='pending' THEN now() + interval '10 minutes' ELSE next_run_at END,
         finished_at = CASE WHEN $2='dead' THEN now() ELSE NULL END,
         updated_at=now()
       WHERE id=$1`,
      [job.id, dead ? "dead" : "pending", msg],
    );
    await logEvent(
      "executor",
      xe?.kind === "rate_limit"
        ? `任务 #${job.id} 限流，将自动重试: ${msg}`
        : `任务 #${job.id} 失败: ${msg}`,
      { kind: xe?.kind, type: job.type, target: job.target_user_id },
      "error",
    );
    await pgNotify(
      WS_CHANNEL,
      envelope("x.error", {
        source: "executor",
        jobId: job.id,
        type: job.type,
        targetUserId: job.target_user_id,
        message: msg,
        kind: xe?.kind,
        retryAfterMs: xe?.retryAfterMs,
      }),
    );
  }
  return true;
}

async function mainLoop() {
  console.log(`worker ${workerId} started x.mode=${x.mode}`);
  getPool();

  try {
    await probeAndStore();
  } catch (e) {
    console.error("initial probe failed", e);
  }

  while (!stopping) {
    try {
      const rt = await getRuntime();
      const account = await ensureBootstrap();
      const accountId = account.id as string;

      if (rt?.automation_enabled) {
        if (!rt.graph_consistent) {
          await runSync(accountId);
        }
        await followBackScan(accountId);
        await observerScan(accountId);
        await expandScan(accountId);
        // live: fewer jobs per tick to respect write interval
        const budget = x.mode === "live" ? 2 : 5;
        for (let i = 0; i < budget; i++) {
          const did = await executeOne(accountId);
          if (!did) break;
        }
      } else {
        await reclaimStaleJobs(settings.leaseTtlSec);
      }
    } catch (e) {
      console.error("worker loop error", e);
      await logEvent("worker", String(e), {}, "error").catch(() => {});
      await setRuntime({ last_error: String(e) }).catch(() => {});
      await sleep(5000);
    }
    await sleep(x.mode === "live" ? 5000 : 2000);
  }
  console.log("worker draining exit");
  process.exit(0);
}

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

mainLoop().catch((e) => {
  console.error(e);
  process.exit(1);
});
