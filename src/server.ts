import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskManager } from './task-manager.js';
import { XClient } from './x-client.js';
import { Service } from './service.js';
import { saveXConfig, getXConfigStatus, loadConfig } from './config.js';
import { loadAutomationConfig, saveAutomationConfig, loadPostConfig, savePostConfig, type AutomationConfig, type PostConfig } from './auto-config.js';

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
      const { userIds } = req.body;
      if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        res.status(400).json({ error: 'userIds array is required' });
        return;
      }
      const result = await taskManager.batchFollow(userIds);
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

      const config: AutomationConfig = {
        batchSizeMin: body.batchSizeMin ?? existing.batchSizeMin,
        batchSizeMax: body.batchSizeMax ?? existing.batchSizeMax,
        batchIntervalMinMinutes: body.batchIntervalMinMinutes ?? existing.batchIntervalMinMinutes,
        batchIntervalMaxMinutes: body.batchIntervalMaxMinutes ?? existing.batchIntervalMaxMinutes,
        actionIntervalMinSeconds: body.actionIntervalMinSeconds ?? existing.actionIntervalMinSeconds,
        actionIntervalMaxSeconds: body.actionIntervalMaxSeconds ?? existing.actionIntervalMaxSeconds,
        dailyLimit: body.dailyLimit ?? existing.dailyLimit,
        activeHoursStart: body.activeHoursStart ?? existing.activeHoursStart,
        activeHoursEnd: body.activeHoursEnd ?? existing.activeHoursEnd,
        // 只有传入非占位符值时才更新 cookie
        authToken: (body.authToken && body.authToken !== '••••••••') ? body.authToken : existing.authToken,
        ct0: (body.ct0 && body.ct0 !== '••••••••') ? body.ct0 : existing.ct0,
      };

      saveAutomationConfig(config);
      res.json({ ok: true, message: 'Automation settings saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
