import crypto from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskManager } from './task-manager.js';
import { XClient } from './x-client.js';
import { Service } from './service.js';
import { saveXConfig, getXConfigStatus, loadConfig } from './config.js';
import {
  loadAutomationConfig,
  saveAutomationConfig,
  loadPostConfig,
  updatePostConfig,
  ensureComposerTask,
  COMPOSER_TASK_ID,
  getComposerTask,
  MIN_FOLLOW_BACK_AUTO_INTERVAL,
  type AutomationConfig,
  type PostConfig,
} from './auto-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cookie 名：通过后写入，用于后续请求鉴权 */
const ACCESS_COOKIE = 'auto_x_access';
const ACCESS_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function getWebAccessKey(): string {
  return (process.env.WEB_ACCESS_KEY || '').trim();
}

function isAccessKeyEnabled(): boolean {
  return getWebAccessKey().length > 0;
}

/** 用访问密钥派生无状态 session token（改密钥后旧 cookie 全部失效） */
function deriveSessionToken(key: string): string {
  return crypto.createHmac('sha256', key).update('auto-x-web-access-v1').digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function isAuthenticated(req: Request): boolean {
  if (!isAccessKeyEnabled()) return true;
  const key = getWebAccessKey();
  const expected = deriveSessionToken(key);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[ACCESS_COOKIE] || '';
  return token.length > 0 && safeEqualHex(token, expected);
}

function setAccessCookie(res: Response, token: string): void {
  const secure = process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true';
  const parts = [
    `${ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ACCESS_COOKIE_MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAccessCookie(res: Response): void {
  const secure = process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true';
  const parts = [
    `${ACCESS_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function accessAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAccessKeyEnabled()) {
    next();
    return;
  }
  // 鉴权接口本身放行
  if (req.path === '/api/auth/status' || req.path === '/api/auth/login' || req.path === '/api/auth/logout') {
    next();
    return;
  }
  // 页面本身可访问（前端用遮罩锁），静态资源同理；API 必须登录
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: '需要访问密钥', needAuth: true });
}

export function createServer(taskManager: TaskManager): express.Express {
  const app = express();
  app.use(express.json());

  // 访问密钥中间件（WEB_ACCESS_KEY 未配置时不生效）
  app.use(accessAuthMiddleware);

  // ── 访问密钥鉴权 ────────────────────────────────────
  app.get('/api/auth/status', (req, res) => {
    const required = isAccessKeyEnabled();
    res.json({
      required,
      authenticated: !required || isAuthenticated(req),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isAccessKeyEnabled()) {
      res.json({ ok: true, message: '未启用访问密钥' });
      return;
    }
    const key = String((req.body && req.body.key) || '');
    const expected = getWebAccessKey();
    // 哈希后再比，避免密钥长度不同时直接暴露长度信息
    const a = crypto.createHash('sha256').update(key, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    if (!key || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ ok: false, error: '访问密钥错误' });
      return;
    }
    setAccessCookie(res, deriveSessionToken(expected));
    res.json({ ok: true, message: '已解锁' });
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearAccessCookie(res);
    res.json({ ok: true, message: '已锁定' });
  });

  // index.html 禁止缓存，避免部署后浏览器仍用旧 UI
  app.get(['/', '/index.html'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    },
  }));

  app.get('/api/status', async (_req, res) => {
    try {
      const status = await taskManager.getStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/config', (_req, res) => {
    const status = getXConfigStatus();
    res.json(status);
  });

  app.post('/api/config', async (req, res) => {
    const { bearerToken, accessToken } = req.body;
    if (!bearerToken && !accessToken) {
      res.status(400).json({ error: 'Provide at least one token' });
      return;
    }

    try {
      saveXConfig(bearerToken, accessToken);

      const config = loadConfig();
      const newXClient = new XClient({
        bearerToken: config.x.bearerToken,
        accessToken: config.x.accessToken,
      });
      const newService = new Service(newXClient, (taskManager as any).repo);
      const me = await taskManager.reconnect(newXClient, newService);

      res.json({ ok: true, message: `Connected as @${me.username}`, username: me.username });
    } catch (err: any) {
      res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
  });

  app.post('/api/sync-followers', (_req, res) => {
    try {
      taskManager.startSyncFollowers();
      res.json({ ok: true, message: 'Syncing followers started' });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  app.post('/api/sync-following', (_req, res) => {
    try {
      taskManager.startSyncFollowing();
      res.json({ ok: true, message: 'Syncing following started' });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  app.post('/api/auto-follow', (_req, res) => {
    try {
      taskManager.startAutoFollow();
      res.json({ ok: true, message: 'Auto follow started' });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  app.post('/api/auto-follow/start', (req, res) => {
    const { interval } = req.body;
    if (!interval || interval < 10) {
      res.status(400).json({ error: 'Interval must be at least 10 seconds' });
      return;
    }
    taskManager.startAutoFollowSchedule(interval);
    res.json({ ok: true, message: `Auto follow scheduled every ${interval}s` });
  });

  app.post('/api/auto-follow/stop', (_req, res) => {
    taskManager.stopAutoFollowSchedule();
    res.json({ ok: true, message: 'Auto follow schedule stopped' });
  });

  app.post('/api/stop', (_req, res) => {
    taskManager.stopCurrentTask();
    res.json({ ok: true, message: 'Stop signal sent' });
  });

  app.get('/api/pending/stats', async (_req, res) => {
    try {
      const status = await taskManager.getStatus();
      res.json(status.pending);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/process-follow', (_req, res) => {
    try {
      taskManager.startProcessFollowOnce();
      res.json({ ok: true, message: 'Processing one pending follow' });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  app.post('/api/process-follow/start', (req, res) => {
    const { interval } = req.body;
    if (!interval || interval < 5) {
      res.status(400).json({ error: 'Interval must be at least 5 seconds' });
      return;
    }
    taskManager.startProcessFollowSchedule(interval);
    res.json({ ok: true, message: `Auto process-follow scheduled every ${interval}s` });
  });

  app.post('/api/process-follow/stop', (_req, res) => {
    taskManager.stopProcessFollowSchedule();
    res.json({ ok: true, message: 'Auto process-follow stopped' });
  });

  app.post('/api/process-unfollow', (_req, res) => {
    try {
      taskManager.startProcessUnfollowOnce();
      res.json({ ok: true, message: 'Processing one pending unfollow' });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  app.post('/api/process-unfollow/start', (req, res) => {
    const { interval } = req.body;
    if (!interval || interval < 5) {
      res.status(400).json({ error: 'Interval must be at least 5 seconds' });
      return;
    }
    taskManager.startProcessUnfollowSchedule(interval);
    res.json({ ok: true, message: `Auto process-unfollow scheduled every ${interval}s` });
  });

  app.post('/api/process-unfollow/stop', (_req, res) => {
    taskManager.stopProcessUnfollowSchedule();
    res.json({ ok: true, message: 'Auto process-unfollow stopped' });
  });

  // ── 计算队列 + 批量操作 ────────────────────────────

  app.post('/api/compute-follow-back', async (_req, res) => {
    try {
      taskManager.startComputeFollowBack();
      res.json({ ok: true, message: '扫描已启动，完成后结果自动刷新', scanning: true });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // ── 自动扫描回关 启停（持久化，关 UI 仍运行）──────────

  app.post('/api/follow-back-auto/start', (req, res) => {
    try {
      const body = req.body || {};
      const existing = loadAutomationConfig();
      let interval = Number(body.intervalMinutes ?? existing.followBackAutoIntervalMinutes ?? 30);
      if (!interval || interval < MIN_FOLLOW_BACK_AUTO_INTERVAL) {
        res.status(400).json({
          error: `扫描周期至少 ${MIN_FOLLOW_BACK_AUTO_INTERVAL} 分钟`,
        });
        return;
      }
      taskManager.startFollowBackAuto(interval);
      res.json({
        ok: true,
        message: `自动扫描回关已开启，每 ${interval} 分钟一轮`,
        intervalMinutes: interval,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/follow-back-auto/stop', (_req, res) => {
    try {
      taskManager.stopFollowBackAuto(true);
      res.json({ ok: true, message: '自动扫描回关已关闭' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/compute-unfollow', async (_req, res) => {
    try {
      const list = await taskManager.computeUnfollow();
      res.json({ ok: true, users: list, count: list.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/batch-follow', async (req, res) => {
    try {
      // 自动化开启时禁止手动回关（自动周期直接调 service，不走本接口）
      if (taskManager.isFollowBackAutoEnabled()) {
        res.status(409).json({ error: '自动扫描回关已开启，请先关闭自动化后再手动回关' });
        return;
      }
      const { userIds, users } = req.body as {
        userIds?: string[];
        users?: Array<{ userId: string; username?: string }>;
      };
      // 优先 users（带 username），兼容旧的 userIds
      let targets: Array<string | { userId: string; username?: string }> = [];
      if (Array.isArray(users) && users.length > 0) {
        targets = users.filter((u) => u && u.userId);
      } else if (Array.isArray(userIds) && userIds.length > 0) {
        targets = userIds;
      }
      if (targets.length === 0) {
        res.status(400).json({ error: 'users 或 userIds 数组必填' });
        return;
      }
      const result = await taskManager.batchFollow(targets);
      // 成功的从内存扫描列表剔除，并记入会话成功列表（前端成功区可同步）
      const okResults = (result.results || []).filter((r) => r.ok);
      const okIds = okResults.map((r) => r.userId);
      taskManager.recordFollowBackSuccesses(okResults);
      taskManager.removeFromFollowBackScan(okIds);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/batch-unfollow', async (req, res) => {
    try {
      const { userIds } = req.body;
      if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        res.status(400).json({ error: 'userIds array is required' });
        return;
      }
      const result = await taskManager.batchUnfollow(userIds);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 重连 ────────────────────────────────────────────

  app.post('/api/reconnect', async (req, res) => {
    try {
      const { authToken, ct0 } = req.body;
      if (!authToken) {
        res.status(400).json({ error: 'auth_token is required' });
        return;
      }
      const result = await taskManager.reconnectBrowser(authToken, ct0 || '');
      if (result.ok) {
        res.json({ ok: true, message: `Connected as @${result.username}`, username: result.username });
      } else {
        res.status(400).json({ ok: false, error: result.error || 'Connection failed' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 自动化配置 ──────────────────────────────────────

  app.get('/api/auto-config', (_req, res) => {
    try {
      const config = loadAutomationConfig();
      // 不返回敏感 cookie 的完整值，只返回是否存在
      res.json({
        ...config,
        authToken: config.authToken ? '••••••••' : '',
        ct0: config.ct0 ? '••••••••' : '',
        hasAuthToken: !!config.authToken,
        hasCt0: !!config.ct0,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auto-config', (req, res) => {
    try {
      const body = req.body as Partial<AutomationConfig> & { authToken?: string; ct0?: string };

      // 加载现有配置（保留敏感字段如果传入了占位符）
      const existing = loadAutomationConfig();

      const start = body.activeHoursStart ?? existing.activeHoursStart;
      const end = body.activeHoursEnd ?? existing.activeHoursEnd;
      if (start < 0 || start > 23 || end < 0 || end > 24) {
        res.status(400).json({ error: 'activeHoursStart 0-23, activeHoursEnd 0-24' });
        return;
      }

      let autoInterval =
        body.followBackAutoIntervalMinutes ?? existing.followBackAutoIntervalMinutes ?? 30;
      autoInterval = Math.floor(Number(autoInterval) || 30);
      if (autoInterval < MIN_FOLLOW_BACK_AUTO_INTERVAL) {
        res.status(400).json({
          error: `自动扫描周期至少 ${MIN_FOLLOW_BACK_AUTO_INTERVAL} 分钟`,
        });
        return;
      }

      const autoEnabled =
        typeof body.followBackAutoEnabled === 'boolean'
          ? body.followBackAutoEnabled
          : existing.followBackAutoEnabled;

      const config: AutomationConfig = {
        batchSizeMin: body.batchSizeMin ?? existing.batchSizeMin,
        batchSizeMax: body.batchSizeMax ?? existing.batchSizeMax,
        batchIntervalMinMinutes: body.batchIntervalMinMinutes ?? existing.batchIntervalMinMinutes,
        batchIntervalMaxMinutes: body.batchIntervalMaxMinutes ?? existing.batchIntervalMaxMinutes,
        actionIntervalMinSeconds: body.actionIntervalMinSeconds ?? existing.actionIntervalMinSeconds,
        actionIntervalMaxSeconds: body.actionIntervalMaxSeconds ?? existing.actionIntervalMaxSeconds,
        dailyLimit: body.dailyLimit ?? existing.dailyLimit,
        activeHoursStart: start,
        activeHoursEnd: end,
        timezone: body.timezone || existing.timezone || 'Asia/Shanghai',
        followBackAutoEnabled: autoEnabled,
        followBackAutoIntervalMinutes: autoInterval,
        lastFollowBackAutoAt: existing.lastFollowBackAutoAt,
        // 只有传入非占位符值时才更新 cookie
        authToken: (body.authToken && body.authToken !== '••••••••') ? body.authToken : existing.authToken,
        ct0: (body.ct0 && body.ct0 !== '••••••••') ? body.ct0 : existing.ct0,
      };

      saveAutomationConfig(config);
      // 立即刷新浏览器客户端内存中的活跃时段，无需重启
      taskManager.reloadAutomationConfig();

      // 按开关启停服务端定时任务（关 UI 也继续）
      if (config.followBackAutoEnabled) {
        taskManager.startFollowBackAuto(config.followBackAutoIntervalMinutes);
      } else {
        taskManager.stopFollowBackAuto(true);
      }

      res.json({
        ok: true,
        message: config.followBackAutoEnabled
          ? `自动化已开启：每 ${config.followBackAutoIntervalMinutes} 分钟扫描并回关`
          : '自动化已关闭；配置已保存',
        followBackAutoEnabled: config.followBackAutoEnabled,
        followBackAutoIntervalMinutes: config.followBackAutoIntervalMinutes,
        activeHoursStart: start,
        activeHoursEnd: end,
        timezone: config.timezone,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 头像/图片代理（绕过浏览器直连 pbs.twimg.com 失败）──

  const ALLOWED_IMG_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com', 'pbs.twitter.com', 'abs.twitter.com']);

  app.get('/api/proxy-image', async (req, res) => {
    try {
      const raw = String(req.query.url || '');
      if (!raw) {
        res.status(400).json({ error: 'url required' });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        res.status(400).json({ error: 'invalid url' });
        return;
      }
      if (parsed.protocol !== 'https:' || !ALLOWED_IMG_HOSTS.has(parsed.hostname)) {
        res.status(400).json({ error: 'host not allowed' });
        return;
      }

      const upstream = await fetch(parsed.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: 'https://x.com/',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/')) {
        res.status(502).json({ error: 'not an image' });
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (err: any) {
      res.status(502).json({ error: err.message || 'proxy failed' });
    }
  });

  // ── 同步 Account 数据 ──────────────────────────────

  app.post('/api/account/refresh', async (_req, res) => {
    try {
      const me = await taskManager.refreshMe();
      if (me) {
        res.json({ ok: true, message: 'Account refreshed', user: { username: me.username, publicMetrics: me.publicMetrics } });
      } else {
        res.status(400).json({ ok: false, error: 'Not connected or not in browser mode' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 发帖 ────────────────────────────────────────────

  /**
   * Post Now 唯一入口：
   * 1. 立即发送 text
   * 2. 将 autoPostEnabled + intervalMinutes + 模板文案写入配置
   * 3. 勾选自动 → 启动/刷新定时；未勾选 → 停止定时
   * （勾选框本身不应单独调接口启停）
   */
  app.post('/api/post', async (req, res) => {
    try {
      const { text, autoPostEnabled, intervalMinutes } = req.body as {
        text?: string;
        autoPostEnabled?: boolean;
        intervalMinutes?: number;
      };

      if (!text || !String(text).trim()) {
        res.status(400).json({ error: 'Post text is required' });
        return;
      }
      const postText = String(text).trim();
      if (postText.length > 280) {
        res.status(400).json({ error: 'Post exceeds 280 characters' });
        return;
      }

      const wantAuto = !!autoPostEnabled;
      let interval = Number(intervalMinutes);
      if (wantAuto) {
        if (!interval || interval < 5) {
          res.status(400).json({ error: 'Interval must be at least 5 minutes' });
          return;
        }
      } else {
        interval = interval && interval >= 5 ? interval : (loadPostConfig().autoPostIntervalMinutes || 60);
      }

      // 持久化：composer 任务 + legacy dual-write（composer-first，无 lift）
      await updatePostConfig((cfg) =>
        ensureComposerTask(cfg, {
          content: postText,
          enabled: wantAuto,
          intervalMinutes: interval,
        }),
      );

      // 仅停/启 composer 定时，不影响其他任务
      if (!wantAuto) {
        taskManager.stopPostTaskSchedule(COMPOSER_TASK_ID);
      }

      // 立即发当前这条（force，不受活跃时段限制）
      const result = await taskManager.postNow(postText);

      // 记录发帖时间到 composer（两边 dual-write）
      if (result.ok) {
        const now = new Date().toISOString();
        await updatePostConfig((cfg) => {
          const t = getComposerTask(cfg);
          if (t) {
            t.lastPostAt = now;
            t.postCount = (t.postCount || 0) + 1;
            t.lastResult = 'ok';
            t.lastError = null;
            t.updatedAt = now;
          }
        });
      }

      // 若开启自动，启动周期（从现在起 interval 后再发）
      if (wantAuto) {
        await taskManager.startPostSchedule(interval, postText);
      }

      res.json({
        ok: true,
        posted: result.ok,
        autoPostEnabled: wantAuto,
        intervalMinutes: interval,
        message: wantAuto
          ? (result.ok
            ? `Post sent; auto every ${interval} min`
            : `Post failed; auto schedule started every ${interval} min`)
          : (result.ok ? 'Post sent' : 'Post failed'),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 兼容旧接口：仅启停定时（不建议前端再单独依赖勾选触发）
  app.post('/api/post/schedule', async (req, res) => {
    try {
      const { enabled, text, intervalMinutes } = req.body;

      // 仅操作 composer，绝不 stop-all
      if (enabled) {
        if (!text) { res.status(400).json({ error: 'Post text is required' }); return; }
        if (!intervalMinutes || intervalMinutes < 5) {
          res.status(400).json({ error: 'Interval must be at least 5 minutes' });
          return;
        }

        await updatePostConfig((cfg) =>
          ensureComposerTask(cfg, {
            content: text,
            enabled: true,
            intervalMinutes,
          }),
        );

        await taskManager.startPostSchedule(intervalMinutes, text);
        res.json({ ok: true, message: 'Auto post started', intervalMinutes });
      } else {
        await taskManager.stopPostSchedule();
        res.json({ ok: true, message: 'Auto post stopped' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/schedule/start', async (req, res) => {
    try {
      const { intervalMinutes, templateText } = req.body;
      if (!intervalMinutes || intervalMinutes < 5) {
        res.status(400).json({ error: 'Interval must be at least 5 minutes' });
        return;
      }
      if (!templateText) {
        res.status(400).json({ error: 'Template text is required' });
        return;
      }
      await taskManager.startPostSchedule(intervalMinutes, templateText);
      res.json({ ok: true, message: `Auto post started every ${intervalMinutes} min` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/schedule/stop', async (_req, res) => {
    await taskManager.stopPostSchedule();
    res.json({ ok: true, message: 'Auto post stopped' });
  });

  app.get('/api/post/config', (_req, res) => {
    try {
      const config = loadPostConfig();
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/config', async (req, res) => {
    try {
      const body = req.body as Partial<PostConfig> & Record<string, any>;
      // Composer-first: update composer task fields; mirror legacy. No bare wipe of tasks.
      await updatePostConfig((cfg) => {
        const content =
          body.templates?.[body.autoPostTemplateIndex ?? 0] ??
          body.templates?.[0] ??
          getComposerTask(cfg)?.content ??
          cfg.templates?.[0] ??
          '';
        const enabled =
          body.autoPostEnabled !== undefined
            ? !!body.autoPostEnabled
            : !!getComposerTask(cfg)?.enabled;
        const interval =
          body.autoPostIntervalMinutes !== undefined
            ? Number(body.autoPostIntervalMinutes)
            : getComposerTask(cfg)?.intervalMinutes || cfg.autoPostIntervalMinutes;
        return ensureComposerTask(cfg, {
          content: String(content),
          enabled,
          intervalMinutes: interval,
        });
      });
      res.json({ ok: true, message: 'Post config saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 多任务 CRUD（额外任务；composer 仍走 /api/post）────

  app.get('/api/post/tasks', (_req, res) => {
    try {
      res.json({ ok: true, tasks: taskManager.listPostTasks() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/tasks', async (req, res) => {
    try {
      const body = req.body || {};
      const task = await taskManager.createPostTask({
        name: body.name,
        content: body.content,
        intervalMinutes: body.intervalMinutes,
        enabled: body.enabled,
        contentMode: body.contentMode === 'ai' ? 'ai' : 'static',
      });
      res.json({ ok: true, task });
    } catch (err: any) {
      const msg = err.message || String(err);
      const code = msg.includes('最多') ? 400 : 400;
      res.status(code).json({ error: msg });
    }
  });

  app.get('/api/post/tasks/:id', (req, res) => {
    try {
      const task = taskManager.getPostTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: '任务不存在' });
        return;
      }
      res.json({ ok: true, task });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/post/tasks/:id', async (req, res) => {
    try {
      const body = req.body || {};
      const task = await taskManager.updatePostTask(req.params.id, {
        name: body.name,
        content: body.content,
        intervalMinutes: body.intervalMinutes,
        enabled: body.enabled,
        contentMode: body.contentMode,
      });
      res.json({ ok: true, task });
    } catch (err: any) {
      const msg = err.message || String(err);
      const status = msg.includes('不存在') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  app.delete('/api/post/tasks/:id', async (req, res) => {
    try {
      await taskManager.deletePostTask(req.params.id);
      res.json({ ok: true, message: '已删除' });
    } catch (err: any) {
      const msg = err.message || String(err);
      const status = msg.includes('composer') || msg.includes('Cannot delete')
        ? 400
        : msg.includes('不存在')
          ? 404
          : 400;
      res.status(status).json({ error: msg });
    }
  });

  app.post('/api/post/tasks/:id/enable', async (req, res) => {
    try {
      const enabled = !!(req.body && req.body.enabled);
      const task = await taskManager.setPostTaskEnabled(req.params.id, enabled);
      res.json({ ok: true, task });
    } catch (err: any) {
      const msg = err.message || String(err);
      res.status(msg.includes('不存在') ? 404 : 400).json({ error: msg });
    }
  });

  app.post('/api/post/tasks/:id/run', async (req, res) => {
    try {
      const result = await taskManager.runPostTaskOnce(req.params.id);
      res.json({
        ok: true,
        posted: result.ok,
        skipped: result.skipped,
        message: result.ok ? '已发送' : result.skipped ? '已跳过' : '发送失败',
      });
    } catch (err: any) {
      const msg = err.message || String(err);
      res.status(msg.includes('不存在') ? 404 : 400).json({ error: msg });
    }
  });

  return app;
}
