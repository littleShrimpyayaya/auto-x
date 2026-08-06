import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskManager } from './task-manager.js';
import { XClient } from './x-client.js';
import { Service } from './service.js';
import { saveXConfig, getXConfigStatus, loadConfig } from './config.js';

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

  return app;
}
