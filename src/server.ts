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

  app.post('/api/post', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) {
        res.status(400).json({ error: 'Post text is required' });
        return;
      }
      if (text.length > 280) {
        res.status(400).json({ error: 'Post exceeds 280 characters' });
        return;
      }
      const result = await taskManager.postNow(text);
      res.json({ ok: result.ok, message: result.ok ? 'Post sent' : 'Post failed' });
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
      };

      savePostConfig(config);
      res.json({ ok: true, message: 'Post config saved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
