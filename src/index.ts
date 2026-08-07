import { loadConfig, getMode } from './config.js';
import { loadAutomationConfig } from './auto-config.js';
import { createPool, initSchema } from './db.js';
import { XClient } from './x-client.js';
import { BrowserClient } from './browser-client.js';
import { UserRepository } from './user-repository.js';
import { Service } from './service.js';
import { TaskManager } from './task-manager.js';
import { createServer } from './server.js';

// ── 全局日志时间戳（强制北京时间，容器多为 UTC）────────
const LOG_TZ = 'Asia/Shanghai';
const ts = () =>
  new Date().toLocaleString('zh-CN', {
    timeZone: LOG_TZ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
const _log = console.log, _warn = console.warn, _error = console.error;
console.log = (...a: any[]) => _log(`[${ts()}]`, ...a);
console.warn = (...a: any[]) => _warn(`[${ts()}]`, ...a);
console.error = (...a: any[]) => _error(`[${ts()}]`, ...a);

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const config = loadConfig();
  const mode = getMode();

  const pool = createPool(config.db);
  await initSchema(pool);

  const repo = new UserRepository(pool);

  const isBrowser = mode === 'browser';

  const client = isBrowser
    ? new BrowserClient(loadAutomationConfig())
    : new XClient({
        bearerToken: config.x.bearerToken,
        accessToken: config.x.accessToken,
      });

  if (isBrowser) {
    console.log('[启动] 使用浏览器自动化模式');
    const browserClient = client as BrowserClient;
    const autoConfig = loadAutomationConfig();

    if (!autoConfig.authToken) {
      console.warn('[启动] 未配置 auth_token，浏览器将无法登录。请在 Web UI 中配置。');
    } else {
      try {
        await browserClient.init();
      } catch (err) {
        console.warn('浏览器启动失败:', (err as Error).message);
      }
    }
  } else {
    console.log('[启动] 使用 X API 模式');
  }

  // 尝试登录并获取用户信息
  let me = null;
  try {
    me = await client.getMyUser();
    console.log(`Logged in as: @${me.username} (${me.id})`);
  } catch (err) {
    const label = isBrowser ? '浏览器登录' : 'X API login';
    console.warn(`${label} 失败:`, (err as Error).message);
    if (isBrowser) {
      console.warn('请通过 Web UI 更新 auth_token 后重启服务');
    } else {
      console.warn('请通过 Web UI 配置 API tokens');
    }
  }

  const service = new Service(client as any, repo);
  const taskManager = new TaskManager(client as any, service, repo);

  if (me) {
    taskManager.setMe(me);
  }

  // 若配置里已开启自动发推，重启后恢复定时（不立刻发）
  try {
    taskManager.restorePostScheduleFromConfig();
  } catch (err) {
    console.warn('[Post] 恢复自动发推失败:', (err as Error).message);
  }

  // 若配置里已开启自动扫描回关，重启后恢复（关 UI 也继续）
  try {
    taskManager.restoreFollowBackAutoFromConfig();
  } catch (err) {
    console.warn('[AutoFollowBack] 恢复失败:', (err as Error).message);
  }

  const app = createServer(taskManager);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

// 防止未捕获异常导致进程退出
process.on('unhandledRejection', (reason) => {
  console.error('[进程] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[进程] uncaughtException:', err);
  if (err.message?.includes('EADDRINUSE')) process.exit(1);
});
process.on('SIGTERM', () => {
  console.log('[进程] 收到 SIGTERM，优雅退出');
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
