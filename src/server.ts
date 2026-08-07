import express from 'express';
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
  savePostConfig,
  MIN_FOLLOW_BACK_AUTO_INTERVAL,
  type AutomationConfig,
  type PostConfig,
} from './auto-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(taskManager: TaskManager): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

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

      // 持久化：开关 + 周期 + 当前文案作为模板
      const existing = loadPostConfig();
      const templates = [...(existing.templates || [])];
      if (templates.length === 0) templates.push(postText);
      else templates[0] = postText;

      const config: PostConfig = {
        ...existing,
        templates,
        autoPostEnabled: wantAuto,
        autoPostIntervalMinutes: interval,
        autoPostTemplateIndex: 0,
      };
      savePostConfig(config);

      // 先停旧定时，避免叠加
      taskManager.stopPostSchedule();

      // 立即发当前这条
      const result = await taskManager.postNow(postText);

      // 记录发帖时间到配置上，用于下次重启时计算剩余时间
      if (result.ok) {
        const updated = loadPostConfig();
        updated.lastPostAt = new Date().toISOString();
        savePostConfig(updated);
      }

      // 若开启自动，启动周期（从现在起 interval 后再发）
      if (wantAuto) {
        taskManager.startPostSchedule(interval, postText);
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

      taskManager.stopPostSchedule();

      if (enabled) {
        if (!text) { res.status(400).json({ error: 'Post text is required' }); return; }
        if (!intervalMinutes || intervalMinutes < 5) {
          res.status(400).json({ error: 'Interval must be at least 5 minutes' });
          return;
        }

        const existing = loadPostConfig();
        const templates = [...(existing.templates || [])];
        if (templates.length === 0) templates.push(text);
        else templates[0] = text;
        savePostConfig({
          ...existing,
          templates,
          autoPostEnabled: true,
          autoPostIntervalMinutes: intervalMinutes,
          autoPostTemplateIndex: 0,
        });

        taskManager.startPostSchedule(intervalMinutes, text);
        res.json({ ok: true, message: 'Auto post started', intervalMinutes });
      } else {
        const existing = loadPostConfig();
        savePostConfig({ ...existing, autoPostEnabled: false });
        res.json({ ok: true, message: 'Auto post stopped' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/schedule/start', (req, res) => {
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
      taskManager.startPostSchedule(intervalMinutes, templateText);
      res.json({ ok: true, message: `Auto post started every ${intervalMinutes} min` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/post/schedule/stop', (_req, res) => {
    taskManager.stopPostSchedule();
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

  app.post('/api/post/config', (req, res) => {
    try {
      const body = req.body as Partial<PostConfig>;
      const existing = loadPostConfig();

      const config: PostConfig = {
        templates: body.templates ?? existing.templates,
        autoPostEnabled: body.autoPostEnabled ?? existing.autoPostEnabled,
        autoPostIntervalMinutes: body.autoPostIntervalMinutes ?? existing.autoPostIntervalMinutes,
        autoPostTemplateIndex: body.autoPostTemplateIndex ?? existing.autoPostTemplateIndex,
        lastPostAt: body.lastPostAt ?? existing.lastPostAt,
        postAutoIndex: body.postAutoIndex ?? existing.postAutoIndex,
      };

      savePostConfig(config);
      res.json({ ok: true, message: 'Post config saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
